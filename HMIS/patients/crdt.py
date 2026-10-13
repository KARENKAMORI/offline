"""Automerge documents for patients, and their projection into Patient/Visit rows.

One Automerge document per patient:

    {
      "patient": {"name", "phone", "status", "location",
                  "head_of_household", "registered_at"},
      "visits":  {"<visit uuid>": {"visit_type", "timestamp", "reason",
                                   "temperature_c", "pulse_bpm", ...,
                                   "deleted_at"}}
    }

DOCUMENT_SCHEMA.md (next to manage.py) is the full contract shared with
HMISWeb and HMISMobile: every key, its range, and why vitals are flat keys
stored as decimal strings. Visits are soft-deleted through "deleted_at",
never removed from the map.

Timestamps are ISO-8601 strings so the JS (Angular), Rust/Dart (Flutter) and
Python sides read them the same way. Visits are a map keyed by UUID, not a
list, so two devices recording visits offline never collide on a list index.

The server never initialises an empty document for an incoming sync: it starts
from a blank Document and lets the device's changes create the "patient" and
"visits" maps. If two replicas each created those maps, they would be two
different objects and one would silently win.
"""
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation

from automerge.core import ROOT, Document, Message, ObjType, ScalarType, SyncState, extract
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils.dateparse import parse_datetime

from .models import Patient, PatientDocument, Visit

PATIENT_FIELDS = ('name', 'phone', 'status', 'location', 'head_of_household', 'registered_at')
REQUIRED_VISIT_FIELDS = ('visit_type', 'timestamp')
# Older documents lack these keys; a missing key reads as "not recorded".
OPTIONAL_VISIT_FIELDS = ('reason', 'temperature_c', 'pulse_bpm', 'systolic_mmhg', 'diastolic_mmhg',
                         'respiratory_rate', 'spo2_pct', 'weight_kg', 'deleted_at')
VISIT_FIELDS = REQUIRED_VISIT_FIELDS + OPTIONAL_VISIT_FIELDS
DATETIME_FIELDS = ('registered_at', 'timestamp', 'deleted_at')


def _scalar(value):
    if isinstance(value, bool):
        return ScalarType.Boolean, value
    if isinstance(value, datetime):
        return ScalarType.Str, value.isoformat()
    if isinstance(value, Decimal):
        # "38.4", not "3.84E+1"; trailing zeros are kept as the row has them.
        return ScalarType.Str, format(value, 'f')
    return ScalarType.Str, '' if value is None else str(value)


def _child(tx, obj, key):
    found = tx.get(obj, key)
    return found[1] if found and isinstance(found[0], ObjType) else None


def _put_fields(tx, obj, values):
    for key, value in values.items():
        scalar_type, scalar = _scalar(value)
        current = tx.get(obj, key)
        # Skip unchanged values so a REST save doesn't add no-op history.
        if current is not None and (current[0] == (scalar_type, scalar) or _same_number(current[0], value)):
            continue
        tx.put(obj, key, scalar_type, scalar)


def _same_number(current, value):
    """True when a device wrote "38" and the row holds Decimal("38.0"): same reading, no edit."""
    if (not isinstance(value, (Decimal, int)) or isinstance(value, bool)
            or not isinstance(current, tuple) or current[0] != ScalarType.Str):
        return False
    try:
        return Decimal(current[1]) == value
    except InvalidOperation:
        return False


def heads_hex(doc):
    return sorted(h.hex() for h in doc.get_heads())


def load(patient_uuid):
    """Load a document, row-locked. Call inside transaction.atomic()."""
    row = PatientDocument.objects.select_for_update().filter(pk=patient_uuid).first()
    return Document.load(bytes(row.data)) if row else None


def store(patient_uuid, doc):
    PatientDocument.objects.update_or_create(
        pk=patient_uuid, defaults={'data': doc.save(), 'heads': heads_hex(doc)}
    )


def write_patient(patient):
    """Mirror a REST write of a Patient into its document."""
    with transaction.atomic():
        doc = load(patient.uuid)
        if doc is None:
            doc = Document()
            with doc.transaction() as tx:
                tx.put_object(ROOT, 'patient', ObjType.Map)
                visits = tx.put_object(ROOT, 'visits', ObjType.Map)
                for visit in patient.visits.all():
                    _put_fields(tx, tx.put_object(visits, str(visit.uuid), ObjType.Map),
                                {f: getattr(visit, f) for f in VISIT_FIELDS})
        with doc.transaction() as tx:
            _put_fields(tx, _child(tx, ROOT, 'patient'),
                        {f: getattr(patient, f) for f in PATIENT_FIELDS})
        store(patient.uuid, doc)
    return doc


def write_visit(visit):
    """Mirror a REST write of a Visit into its patient's document."""
    with transaction.atomic():
        doc = load(visit.patient.uuid) or write_patient(visit.patient)
        with doc.transaction() as tx:
            visits = _child(tx, ROOT, 'visits')
            obj = _child(tx, visits, str(visit.uuid)) or tx.put_object(visits, str(visit.uuid), ObjType.Map)
            _put_fields(tx, obj, {f: getattr(visit, f) for f in VISIT_FIELDS})
        store(visit.patient.uuid, doc)


def _clean(model, field_name, value, problems, label):
    field = model._meta.get_field(field_name)
    if field_name in OPTIONAL_VISIT_FIELDS and value in (None, ''):
        return '' if field_name == 'reason' else None
    if field_name in DATETIME_FIELDS:
        value = parse_datetime(value) if isinstance(value, str) else None
        if value is None:
            problems.append(f'{label}.{field_name}: not an ISO-8601 datetime')
            raise ValidationError('bad datetime')
    try:
        return field.clean(value, None)
    except ValidationError as exc:
        problems.append(f'{label}.{field_name}: {"; ".join(exc.messages)}')
        raise


def project(patient_uuid, doc):
    """Rebuild the Patient and Visit rows from the merged document.

    A CRDT cannot reject a change after it has merged: the change is already in
    every replica's history. Invalid values are left out of the relational
    projection and reported back to the device instead.
    """
    state = extract(doc)
    problems = []
    data = state.get('patient') if isinstance(state.get('patient'), dict) else {}

    patient = Patient.objects.filter(uuid=patient_uuid).first()
    values = {}
    for name in PATIENT_FIELDS:
        if name in data:
            try:
                values[name] = _clean(Patient, name, data[name], problems, 'patient')
            except ValidationError:
                pass
    registered_at = values.pop('registered_at', None)
    if patient is None:
        missing = [f for f in ('name', 'location') if f not in values]
        if missing:
            problems.append(f'patient: cannot create, missing {", ".join(missing)}')
            return problems
        patient = Patient.objects.create(uuid=patient_uuid, **values)
    else:
        for name, value in values.items():
            setattr(patient, name, value)
        patient.save()
    if registered_at:
        # auto_now_add ignores supplied values, so set the device's time directly.
        Patient.objects.filter(pk=patient.pk).update(registered_at=registered_at)
    if patient.merged_into_id:
        # The visits were copied into the canonical record and project from there.
        return problems

    visits = state.get('visits') if isinstance(state.get('visits'), dict) else {}
    for key, visit in visits.items():
        try:
            visit_uuid = uuid.UUID(key)
            fields = {f: _clean(Visit, f, visit.get(f), problems, f'visits.{key}')
                      for f in REQUIRED_VISIT_FIELDS}
        except (ValueError, ValidationError, AttributeError):
            if not any(p.startswith(f'visits.{key}') for p in problems):
                problems.append(f'visits.{key}: invalid visit')
            continue
        # An invalid optional value is reported and left as it was on the row;
        # the rest of the visit still projects.
        for name in OPTIONAL_VISIT_FIELDS:
            try:
                fields[name] = _clean(Visit, name, visit.get(name), problems, f'visits.{key}')
            except ValidationError:
                pass
        Visit.objects.update_or_create(uuid=visit_uuid, defaults={'patient': patient, **fields})
    return problems


def receive(patient_uuid, message_bytes):
    """Run one server-side round of the Automerge sync protocol for a document.

    Returns (reply bytes or None, projection problems, heads the reply was
    built from). The Python binding
    cannot serialise SyncState, so each request starts a fresh one and reloads
    the doc. Changes that arrive before their dependencies are queued in memory
    and lost when the request ends, while the client has marked them as sent.
    Clients must detect the resulting repeated message and reset their sync
    state for that doc (see benchmarks/client/device.mjs).
    """
    with transaction.atomic():
        doc = load(patient_uuid) or Document()
        before = doc.get_heads()
        state = SyncState()
        doc.receive_sync_message(state, Message.decode(message_bytes))
        problems = []
        if set(doc.get_heads()) != set(before):
            store(patient_uuid, doc)
            problems = project(patient_uuid, doc)
            # Imported here: duplicates builds on this module.
            from . import duplicates
            duplicates.resolve(patient_uuid, doc)
        # After resolve, so a merge's "merged_into" reaches the device this sync.
        reply = doc.generate_sync_message(state)
    return (reply.encode() if reply is not None else None), problems, heads_hex(doc)
