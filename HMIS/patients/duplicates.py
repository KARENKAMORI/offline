"""Recognise two registrations of the same patient and merge them.

Two devices offline can each register the same person, giving two documents
with different UUIDs. After a document changes, the server looks for other
patients with the same normalised phone:

- same normalised name too: the newer record is merged into the one the
  server already had (lowest id), automatically;
- different name: the pair is flagged as a PossibleDuplicate for a person to
  review, because households often share one phone.

Merging cannot combine the two Automerge documents into one: they are separate
objects, and joining them would silently drop one device's edits (see
DOCUMENT_SCHEMA.md). Instead the server copies the duplicate's visits into the
canonical document and writes "merged_into" into the duplicate's document, so
devices hide it on their next sync. A device that was still offline may keep
adding visits to the duplicate; each later sync of it copies what changed.
"""
from automerge.core import ROOT, ObjType, extract
from django.db import transaction

from . import crdt
from .identity import normalize_name
from .models import Patient, PossibleDuplicate

def resolve(patient_uuid, doc):
    """Run after a patient's document changed and was projected. Call inside transaction.atomic()."""
    patient = Patient.objects.filter(uuid=patient_uuid).first()
    if patient is None:
        return
    if patient.merged_into_id:
        # Changes a device made to the duplicate after the merge.
        _copy_into(patient, doc, patient.canonical())
        return
    if not patient.phone_normalized:
        return
    others = (Patient.objects.filter(phone_normalized=patient.phone_normalized, merged_into__isnull=True)
              .exclude(pk=patient.pk).order_by('pk'))
    name = normalize_name(patient.name)
    same = [other for other in others if normalize_name(other.name) == name]
    if same:
        canonical, *duplicates = sorted([patient, *same], key=lambda p: p.pk)
        for duplicate in duplicates:
            merge(duplicate, canonical, doc if duplicate == patient else None)
        patient = canonical
    for other in others:
        if other not in same:
            _flag(patient, other)


def merge(duplicate, canonical, duplicate_doc=None):
    """Merge duplicate into canonical. Also used by the admin for flagged pairs."""
    with transaction.atomic():
        duplicate_doc = duplicate_doc or crdt.load(duplicate.uuid)
        if duplicate_doc is None:
            duplicate_doc = crdt.write_patient(duplicate)
        _copy_into(duplicate, duplicate_doc, canonical)
        with duplicate_doc.transaction() as tx:
            crdt._put_fields(tx, crdt._child(tx, ROOT, 'patient'), {'merged_into': str(canonical.uuid)})
        crdt.store(duplicate.uuid, duplicate_doc)
        duplicate.merged_into = canonical
        duplicate.save(update_fields=['merged_into'])
        # Records merged into the duplicate earlier now point at the canonical.
        for earlier in duplicate.merged_patients.all():
            earlier_doc = crdt.load(earlier.uuid)
            with earlier_doc.transaction() as tx:
                crdt._put_fields(tx, crdt._child(tx, ROOT, 'patient'), {'merged_into': str(canonical.uuid)})
            crdt.store(earlier.uuid, earlier_doc)
            earlier.merged_into = canonical
            earlier.save(update_fields=['merged_into'])
        PossibleDuplicate.objects.filter(dismissed_at__isnull=True).filter(
            patient__in=[duplicate, canonical], other__in=[duplicate, canonical]).delete()


def _copy_into(duplicate, duplicate_doc, canonical):
    """Copy the duplicate's visit fields that changed since the last copy."""
    state = extract(duplicate_doc)
    visits = state.get('visits') if isinstance(state.get('visits'), dict) else {}
    snapshot = duplicate.merge_snapshot or {}

    canonical_doc = crdt.load(canonical.uuid) or crdt.write_patient(canonical)
    with canonical_doc.transaction() as tx:
        canonical_visits = crdt._child(tx, ROOT, 'visits')
        for key, visit in visits.items():
            if not isinstance(visit, dict):
                continue
            copied = snapshot.get(key, {})
            # Only fields the duplicate changed, so an edit made directly on
            # the canonical record is not overwritten by an older value.
            changed = {f: visit[f] for f in crdt.VISIT_FIELDS if f in visit and visit[f] != copied.get(f)}
            if changed:
                obj = (crdt._child(tx, canonical_visits, key)
                       or tx.put_object(canonical_visits, key, ObjType.Map))
                crdt._put_fields(tx, obj, changed)
    crdt.store(canonical.uuid, canonical_doc)
    crdt.project(canonical.uuid, canonical_doc)

    duplicate.merge_snapshot = {
        key: {f: visit[f] for f in crdt.VISIT_FIELDS if f in visit}
        for key, visit in visits.items() if isinstance(visit, dict)
    }
    duplicate.save(update_fields=['merge_snapshot'])


def _flag(patient, other):
    first, second = sorted([patient, other], key=lambda p: p.pk)
    PossibleDuplicate.objects.get_or_create(patient=first, other=second)
