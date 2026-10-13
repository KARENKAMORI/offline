import base64
import uuid
from datetime import timedelta
from decimal import Decimal

from automerge.core import ROOT, Document, Message, ObjType, ScalarType, SyncState, extract
from django.test import SimpleTestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from . import duplicates
from .identity import normalize_name, normalize_phone
from .models import Patient, PatientDocument, PossibleDuplicate, Visit


class Device:
    """An offline device: holds Automerge docs locally and syncs over HTTP."""

    def __init__(self, client):
        self.client = client
        self.docs = {}
        self.round_trips = 0

    def register(self, **fields):
        patient_uuid = str(uuid.uuid4())
        doc = Document()
        with doc.transaction() as tx:
            patient = tx.put_object(ROOT, 'patient', ObjType.Map)
            tx.put_object(ROOT, 'visits', ObjType.Map)
            for key, value in fields.items():
                kind = ScalarType.Boolean if isinstance(value, bool) else ScalarType.Str
                tx.put(patient, key, kind, value)
        self.docs[patient_uuid] = doc
        return patient_uuid

    def set(self, patient_uuid, key, value):
        doc = self.docs[patient_uuid]
        with doc.transaction() as tx:
            tx.put(tx.get(ROOT, 'patient')[1], key, ScalarType.Str, value)

    def add_visit(self, patient_uuid, visit_type, timestamp='2026-10-08T09:00:00+00:00', **extra):
        visit_uuid = str(uuid.uuid4())
        doc = self.docs[patient_uuid]
        with doc.transaction() as tx:
            visit = tx.put_object(tx.get(ROOT, 'visits')[1], visit_uuid, ObjType.Map)
            tx.put(visit, 'visit_type', ScalarType.Str, visit_type)
            tx.put(visit, 'timestamp', ScalarType.Str, timestamp)
            for key, value in extra.items():
                tx.put(visit, key, ScalarType.Str, value)
        return visit_uuid

    def set_visit(self, patient_uuid, visit_uuid, key, value):
        doc = self.docs[patient_uuid]
        with doc.transaction() as tx:
            visit = tx.get(tx.get(ROOT, 'visits')[1], visit_uuid)[1]
            tx.put(visit, key, ScalarType.Str, value)

    def sync(self):
        manifest = self.client.get('/api/sync/manifest/').json()['docs']
        for patient_uuid, heads in manifest.items():
            doc = self.docs.get(patient_uuid)
            if doc is None or sorted(h.hex() for h in doc.get_heads()) != heads:
                self.docs.setdefault(patient_uuid, Document())
        states = {key: SyncState() for key in self.docs}
        problems, last_sent = {}, {}
        pending = set(self.docs)
        while pending:
            outgoing = {}
            for key in pending:
                message = self.docs[key].generate_sync_message(states[key])
                encoded = base64.b64encode(message.encode()).decode() if message is not None else None
                # The server drops changes it had to queue; a repeated message
                # means this side thinks it sent them. Start a fresh session.
                if encoded is not None and last_sent.get(key) == encoded:
                    states[key] = SyncState()
                    message = self.docs[key].generate_sync_message(states[key])
                    encoded = base64.b64encode(message.encode()).decode() if message is not None else None
                if encoded is not None:
                    outgoing[key] = last_sent[key] = encoded
            if not outgoing:
                break
            response = self.client.post('/api/sync/', {'docs': outgoing}, format='json').json()
            self.round_trips += 1
            problems.update(response['problems'])
            for key, reply in response['docs'].items():
                if reply is not None:
                    self.docs[key].receive_sync_message(states[key], Message.decode(base64.b64decode(reply)))
            pending = set(outgoing)
        return problems

    def state(self, patient_uuid):
        return extract(self.docs[patient_uuid])


class SyncTests(APITestCase):
    def setUp(self):
        self.amina = dict(name='Amina Wanjiru', location='Kibera', status='active', phone='0700000001')

    def test_patient_registered_offline_is_projected_into_rows(self):
        device = Device(self.client)
        patient_uuid = device.register(**self.amina, head_of_household=True)
        visit_uuid = device.add_visit(patient_uuid, 'home_visit')

        self.assertEqual(device.sync(), {})

        patient = Patient.objects.get(uuid=patient_uuid)
        self.assertEqual(patient.name, 'Amina Wanjiru')
        self.assertTrue(patient.head_of_household)
        self.assertEqual(patient.visits.get().uuid, uuid.UUID(visit_uuid))
        self.assertTrue(PatientDocument.objects.filter(pk=patient_uuid).exists())

    def test_concurrent_offline_edits_converge_and_keep_both_visits(self):
        chv, clinic = Device(self.client), Device(self.client)
        patient_uuid = chv.register(**self.amina)
        chv.sync()
        clinic.sync()

        # Both devices go offline and edit the same patient.
        chv.set(patient_uuid, 'status', 'inactive')
        chv.set(patient_uuid, 'phone', '0711111111')
        chv.add_visit(patient_uuid, 'home_visit')
        clinic.set(patient_uuid, 'status', 'suspended')
        clinic.add_visit(patient_uuid, 'outpatient')

        chv.sync()
        clinic.sync()
        chv.sync()

        server_state = extract(Document.load(bytes(PatientDocument.objects.get(pk=patient_uuid).data)))
        self.assertEqual(chv.state(patient_uuid), clinic.state(patient_uuid))
        self.assertEqual(chv.state(patient_uuid), server_state)
        # Different fields both survive; the same field resolves to one winner.
        self.assertEqual(server_state['patient']['phone'], '0711111111')
        self.assertIn(server_state['patient']['status'], {'inactive', 'suspended'})
        self.assertEqual(len(server_state['visits']), 2)
        patient = Patient.objects.get(uuid=patient_uuid)
        self.assertEqual(patient.status, server_state['patient']['status'])
        self.assertEqual(sorted(patient.visits.values_list('visit_type', flat=True)), ['home_visit', 'outpatient'])

    def test_rest_edit_reaches_device_on_next_sync(self):
        device = Device(self.client)
        patient_uuid = device.register(**self.amina)
        device.sync()
        patient = Patient.objects.get(uuid=patient_uuid)

        response = self.client.patch(f'/api/patients/{patient.pk}/', {'status': 'inactive'}, format='json')
        self.assertEqual(response.status_code, 200)
        response = self.client.post('/api/patients/visits/',
                                    {'patient': patient.pk, 'visit_type': 'follow_up'}, format='json')
        self.assertEqual(response.status_code, 201)

        device.sync()
        state = device.state(patient_uuid)
        self.assertEqual(state['patient']['status'], 'inactive')
        self.assertEqual([v['visit_type'] for v in state['visits'].values()], ['follow_up'])

    def test_rest_created_patient_reaches_device(self):
        response = self.client.post('/api/patients/', {'name': 'Otieno', 'location': 'Kisumu'}, format='json')
        self.assertEqual(response.status_code, 201)
        device = Device(self.client)
        device.sync()
        self.assertEqual(device.state(response.json()['uuid'])['patient']['name'], 'Otieno')

    def test_invalid_value_is_reported_and_not_projected(self):
        device = Device(self.client)
        patient_uuid = device.register(**self.amina)
        device.sync()
        device.set(patient_uuid, 'status', 'deceased')

        problems = device.sync()

        self.assertIn('patient.status', problems[patient_uuid][0])
        self.assertEqual(Patient.objects.get(uuid=patient_uuid).status, 'active')

    def test_bad_message_fails_alone(self):
        device = Device(self.client)
        good = device.register(**self.amina)
        message = device.docs[good].generate_sync_message(SyncState())
        response = self.client.post('/api/sync/', {'docs': {
            good: base64.b64encode(message.encode()).decode(),
            str(uuid.uuid4()): 'not base64!',
            'not-a-uuid': base64.b64encode(b'x').decode(),
        }}, format='json').json()
        self.assertIsNotNone(response['docs'][good])
        self.assertEqual(len(response['problems']), 2)

    def test_manifest_since_returns_recent_docs_with_overlap(self):
        device = Device(self.client)
        recent = device.register(**self.amina)
        stale = device.register(name='Otieno', location='Kisumu')
        device.sync()
        PatientDocument.objects.filter(pk=stale).update(updated_at=timezone.now() - timedelta(hours=1))
        server_time = self.client.get('/api/sync/manifest/').json()['server_time']

        docs = self.client.get('/api/sync/manifest/', {'since': server_time}).json()['docs']

        # Written just before server_time, but inside the overlap window.
        self.assertEqual(list(docs), [recent])


class VisitFieldTests(APITestCase):
    def setUp(self):
        self.device = Device(self.client)
        self.patient_uuid = self.device.register(name='Peter Otieno', location='Kibera', status='active')

    def test_reason_and_vitals_registered_offline_are_projected(self):
        visit_uuid = self.device.add_visit(
            self.patient_uuid, 'outpatient', reason='Malaria test', temperature_c='38.4', pulse_bpm='96',
            systolic_mmhg='120', diastolic_mmhg='80', respiratory_rate='18', spo2_pct='97', weight_kg='64.5')

        self.assertEqual(self.device.sync(), {})

        visit = Visit.objects.get(uuid=visit_uuid)
        self.assertEqual(visit.reason, 'Malaria test')
        self.assertEqual(visit.temperature_c, Decimal('38.4'))
        self.assertEqual((visit.pulse_bpm, visit.systolic_mmhg, visit.diastolic_mmhg), (96, 120, 80))
        self.assertEqual((visit.respiratory_rate, visit.spo2_pct), (18, 97))
        self.assertEqual(visit.weight_kg, Decimal('64.5'))
        self.assertIsNone(visit.deleted_at)

    def test_invalid_vital_is_reported_and_rest_of_visit_projects(self):
        visit_uuid = self.device.add_visit(self.patient_uuid, 'outpatient', temperature_c='37.0', pulse_bpm='80')
        self.device.sync()
        self.device.set_visit(self.patient_uuid, visit_uuid, 'temperature_c', '384')
        self.device.set_visit(self.patient_uuid, visit_uuid, 'pulse_bpm', '88')

        problems = self.device.sync()

        self.assertEqual(len(problems[self.patient_uuid]), 1)
        self.assertIn(f'visits.{visit_uuid}.temperature_c', problems[self.patient_uuid][0])
        visit = Visit.objects.get(uuid=visit_uuid)
        self.assertEqual(visit.temperature_c, Decimal('37.0'))  # kept the last valid value
        self.assertEqual(visit.pulse_bpm, 88)

    def test_empty_string_clears_a_vital(self):
        visit_uuid = self.device.add_visit(self.patient_uuid, 'outpatient', spo2_pct='95')
        self.device.sync()
        self.device.set_visit(self.patient_uuid, visit_uuid, 'spo2_pct', '')

        self.assertEqual(self.device.sync(), {})
        self.assertIsNone(Visit.objects.get(uuid=visit_uuid).spo2_pct)

    def test_visit_without_new_keys_still_projects(self):
        visit_uuid = self.device.add_visit(self.patient_uuid, 'home_visit')

        self.assertEqual(self.device.sync(), {})

        visit = Visit.objects.get(uuid=visit_uuid)
        self.assertEqual(visit.reason, '')
        self.assertIsNone(visit.temperature_c)
        self.assertIsNone(visit.deleted_at)

    def test_deleted_at_from_a_device_soft_deletes_and_can_be_cleared(self):
        visit_uuid = self.device.add_visit(self.patient_uuid, 'outpatient')
        self.device.sync()

        self.device.set_visit(self.patient_uuid, visit_uuid, 'deleted_at', '2026-10-09T10:48:00+00:00')
        self.assertEqual(self.device.sync(), {})
        self.assertIsNotNone(Visit.objects.get(uuid=visit_uuid).deleted_at)

        self.device.set_visit(self.patient_uuid, visit_uuid, 'deleted_at', '')
        self.assertEqual(self.device.sync(), {})
        self.assertIsNone(Visit.objects.get(uuid=visit_uuid).deleted_at)

    def test_rest_delete_soft_deletes_hides_from_list_and_reaches_device(self):
        visit_uuid = self.device.add_visit(self.patient_uuid, 'outpatient', reason='Duplicate')
        self.device.sync()
        visit = Visit.objects.get(uuid=visit_uuid)

        response = self.client.delete(f'/api/patients/visits/{visit.pk}/')

        self.assertEqual(response.status_code, 204)
        visit.refresh_from_db()
        self.assertIsNotNone(visit.deleted_at)
        listed = [v['uuid'] for v in self.client.get('/api/patients/visits/').json()]
        self.assertNotIn(visit_uuid, listed)
        listed = [v['uuid'] for v in self.client.get('/api/patients/visits/?include_deleted=true').json()]
        self.assertIn(visit_uuid, listed)
        self.device.sync()
        state = self.device.state(self.patient_uuid)['visits'][visit_uuid]
        self.assertNotEqual(state['deleted_at'], '')
        self.assertEqual(state['reason'], 'Duplicate')

        response = self.client.post(f'/api/patients/visits/{visit.pk}/restore/')

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()['deleted_at'])
        self.device.sync()
        self.assertEqual(self.device.state(self.patient_uuid)['visits'][visit_uuid]['deleted_at'], '')

    def test_rest_save_does_not_rewrite_equal_number_from_device(self):
        visit_uuid = self.device.add_visit(self.patient_uuid, 'outpatient', temperature_c='38')
        self.device.sync()
        visit = Visit.objects.get(uuid=visit_uuid)
        doc = PatientDocument.objects.get(pk=self.patient_uuid)
        heads_before = doc.heads

        response = self.client.patch(f'/api/patients/visits/{visit.pk}/', {'reason': 'Fever'}, format='json')

        self.assertEqual(response.status_code, 200)
        self.device.sync()
        state = self.device.state(self.patient_uuid)['visits'][visit_uuid]
        self.assertEqual(state['temperature_c'], '38')
        self.assertEqual(state['reason'], 'Fever')
        self.assertNotEqual(PatientDocument.objects.get(pk=self.patient_uuid).heads, heads_before)


class NormalisationTests(SimpleTestCase):
    def test_kenyan_phone_formats_match(self):
        for raw in ['0712 111-222', '712111222', '254712111222', '+254712111222', '00254712111222']:
            self.assertEqual(normalize_phone(raw), '+254712111222', raw)
        self.assertEqual(normalize_phone('0112345678'), '+254112345678')
        self.assertEqual(normalize_phone('+256772000000'), '+256772000000')
        self.assertEqual(normalize_phone('12345'), '12345')
        self.assertEqual(normalize_phone(''), '')

    def test_name_ignores_case_accents_punctuation_and_order(self):
        self.assertEqual(normalize_name('Njeri-GRACE '), 'grace njeri')
        self.assertEqual(normalize_name('José  Ñúñez'), 'jose nunez')
        self.assertEqual(normalize_name('Grace_Njeri'), 'grace njeri')


class DuplicatePatientTests(APITestCase):
    def setUp(self):
        self.mobile, self.web = Device(self.client), Device(self.client)

    def register_both_offline(self, web_name='Grace Njeri', web_phone='+254712111222'):
        mobile_uuid = self.mobile.register(name='Grace Njeri', phone='0712111222', location='South C',
                                           status='active')
        web_uuid = self.web.register(name=web_name, phone=web_phone, location='Mukuru', status='active')
        return mobile_uuid, web_uuid

    def test_same_patient_registered_offline_on_two_devices_becomes_one(self):
        mobile_uuid, web_uuid = self.register_both_offline()
        mobile_visit = self.mobile.add_visit(mobile_uuid, 'home_visit', reason='Cough')
        web_visit = self.web.add_visit(web_uuid, 'outpatient', temperature_c='38.4')

        self.mobile.sync()
        self.web.sync()
        self.mobile.sync()

        canonical = Patient.objects.get(uuid=mobile_uuid)
        duplicate = Patient.objects.get(uuid=web_uuid)
        self.assertIsNone(canonical.merged_into)
        self.assertEqual(duplicate.merged_into, canonical)
        self.assertEqual(sorted(str(v) for v in canonical.visits.values_list('uuid', flat=True)),
                         sorted([mobile_visit, web_visit]))
        self.assertEqual(canonical.visits.get(uuid=web_visit).temperature_c, Decimal('38.4'))
        self.assertEqual(self.client.get('/api/patients/').json()[0]['uuid'], mobile_uuid)
        self.assertEqual(len(self.client.get('/api/patients/').json()), 1)

        # Both devices hold the merge marker and the combined visits.
        for device in (self.mobile, self.web):
            self.assertEqual(device.state(web_uuid)['patient']['merged_into'], mobile_uuid)
            self.assertEqual(set(device.state(mobile_uuid)['visits']), {mobile_visit, web_visit})

    def test_web_receives_merge_marker_in_the_same_sync(self):
        mobile_uuid, web_uuid = self.register_both_offline()
        self.mobile.sync()
        self.web.sync()
        self.assertEqual(self.web.state(web_uuid)['patient']['merged_into'], mobile_uuid)

    def test_canonical_keeps_its_own_details(self):
        mobile_uuid = self.mobile.register(name='Grace Njeri', phone='0712111222', location='South C',
                                           status='active')
        web_uuid = self.web.register(name='Grace Njeri', phone='0712111222', location='Kibera', status='inactive')
        self.mobile.sync()
        self.web.sync()
        canonical = Patient.objects.get(uuid=mobile_uuid)
        self.assertEqual((canonical.location, canonical.status), ('South C', 'active'))
        self.assertEqual(Patient.objects.get(uuid=web_uuid).merged_into, canonical)

    def test_same_phone_different_name_is_flagged_not_merged(self):
        mobile_uuid, web_uuid = self.register_both_offline(web_name='Baby Wanjiku')
        self.mobile.sync()
        self.web.sync()
        self.assertFalse(Patient.objects.exclude(merged_into=None).exists())
        pair = PossibleDuplicate.objects.get()
        self.assertEqual({pair.patient.uuid, pair.other.uuid}, {uuid.UUID(mobile_uuid), uuid.UUID(web_uuid)})
        self.assertEqual(len(self.client.get('/api/patients/').json()), 2)

    def test_visit_added_to_duplicate_after_merge_reaches_canonical(self):
        mobile_uuid, web_uuid = self.register_both_offline()
        self.mobile.sync()
        # A third device still holds the duplicate and was offline during the merge.
        stale = Device(self.client)
        stale.docs[web_uuid] = self.web.docs[web_uuid].fork()
        self.web.sync()

        late_visit = stale.add_visit(web_uuid, 'follow_up')
        stale.sync()

        visit = Visit.objects.get(uuid=late_visit)
        self.assertEqual(visit.patient.uuid, uuid.UUID(mobile_uuid))

    def test_edit_on_canonical_visit_is_not_overwritten_by_duplicate_resync(self):
        mobile_uuid, web_uuid = self.register_both_offline()
        web_visit = self.web.add_visit(web_uuid, 'outpatient', reason='Fever')
        self.mobile.sync()
        self.web.sync()
        self.mobile.sync()

        self.mobile.set_visit(mobile_uuid, web_visit, 'reason', 'Fever, resolved')
        self.mobile.sync()
        # Web changes another field on its (now merged) copy of the visit.
        self.web.set_visit(web_uuid, web_visit, 'pulse_bpm', '80')
        self.web.sync()

        visit = Visit.objects.get(uuid=web_visit)
        self.assertEqual(visit.reason, 'Fever, resolved')
        self.assertEqual(visit.pulse_bpm, 80)
        self.assertEqual(visit.patient.uuid, uuid.UUID(mobile_uuid))

    def test_rest_registration_with_local_format_merges_into_synced_patient(self):
        mobile_uuid, _ = self.register_both_offline()
        self.mobile.sync()
        response = self.client.post('/api/patients/', {'name': 'njeri grace', 'phone': '0712 111 222',
                                                       'location': 'South C'}, format='json')
        self.assertEqual(response.json()['phone'], '+254712111222')
        created = Patient.objects.get(pk=response.json()['id'])
        self.assertEqual(created.merged_into.uuid, uuid.UUID(mobile_uuid))

    def test_rest_visit_for_merged_patient_goes_to_canonical(self):
        mobile_uuid, web_uuid = self.register_both_offline()
        self.mobile.sync()
        self.web.sync()
        duplicate = Patient.objects.get(uuid=web_uuid)
        response = self.client.post('/api/patients/visits/', {'patient': duplicate.pk, 'visit_type': 'outpatient'},
                                    format='json')
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(Visit.objects.get(pk=response.json()['id']).patient.uuid, uuid.UUID(mobile_uuid))

    def test_admin_merge_of_flagged_pair(self):
        mobile_uuid, web_uuid = self.register_both_offline(web_name='G. Njeri')
        self.mobile.sync()
        web_visit = self.web.add_visit(web_uuid, 'outpatient')
        self.web.sync()
        pair = PossibleDuplicate.objects.get()

        duplicates.merge(pair.other, pair.patient)

        self.assertEqual(Patient.objects.get(uuid=web_uuid).merged_into.uuid, uuid.UUID(mobile_uuid))
        self.assertEqual(Visit.objects.get(uuid=web_visit).patient.uuid, uuid.UUID(mobile_uuid))
        self.assertFalse(PossibleDuplicate.objects.exists())
        self.web.sync()
        self.assertEqual(self.web.state(web_uuid)['patient']['merged_into'], mobile_uuid)

    def test_blank_phone_never_matches(self):
        self.mobile.register(name='Grace Njeri', phone='', location='South C', status='active')
        self.web.register(name='Grace Njeri', phone='', location='South C', status='active')
        self.mobile.sync()
        self.web.sync()
        self.assertFalse(Patient.objects.exclude(merged_into=None).exists())
        self.assertFalse(PossibleDuplicate.objects.exists())
