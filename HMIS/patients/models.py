import uuid
from decimal import Decimal

from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone

from .identity import normalize_phone

# Patient model
class Patient(models.Model):
    class Status(models.TextChoices):
        ACTIVE = 'active', 'Active'
        INACTIVE = 'inactive', 'Inactive'
        SUSPENDED = 'suspended', 'Suspended'

    # Offline devices cannot get an auto-increment id from the server, so every
    # record also carries a client-generated UUID. It is the CRDT document id.
    uuid = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    name = models.CharField(max_length=200)
    phone = models.CharField(max_length=20, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    location = models.CharField(max_length=200)
    head_of_household = models.BooleanField(default=False)
    registered_at = models.DateTimeField(auto_now_add=True)
    # Duplicate detection compares this, so 0712111222 and +254712111222 match.
    phone_normalized = models.CharField(max_length=20, blank=True, db_index=True, editable=False)
    # Set when this record was merged into another registration of the same
    # patient; it then stays hidden and its visits live on the other record.
    merged_into = models.ForeignKey('self', null=True, blank=True, on_delete=models.PROTECT,
                                    related_name='merged_patients')
    # The duplicate's visits as last copied into merged_into, so a later sync
    # copies only what changed on the duplicate (see duplicates.py).
    merge_snapshot = models.JSONField(default=dict, blank=True, editable=False)

    def save(self, *args, **kwargs):
        self.phone_normalized = normalize_phone(self.phone)
        if kwargs.get('update_fields') is not None and 'phone' in kwargs['update_fields']:
            kwargs['update_fields'] = {*kwargs['update_fields'], 'phone_normalized'}
        super().save(*args, **kwargs)

    def canonical(self):
        """The record this patient now lives on: itself unless it was merged."""
        patient = self
        while patient.merged_into_id:
            patient = patient.merged_into
        return patient

    def __str__(self):
        return self.name


class PossibleDuplicate(models.Model):
    """Two patients with the same phone but different names, for a person to review.

    Households often share one phone, so these are never merged automatically.
    """
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name='+')
    other = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    # Set by "Not a duplicate" in the admin; the pair is then not flagged again.
    dismissed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['patient', 'other'], name='unique_possible_duplicate'),
            # Store each pair once, lower id first.
            models.CheckConstraint(condition=models.Q(patient__lt=models.F('other')),
                                   name='possible_duplicate_ordered'),
        ]

    def __str__(self):
        return f'{self.patient} / {self.other}'

class Visit(models.Model):
    class VisitType(models.TextChoices):
        OUTPATIENT = 'outpatient', 'Outpatient'
        INPATIENT = 'inpatient', 'Inpatient'
        FOLLOW_UP = 'follow_up', 'Follow-up'
        HOME_VISIT = 'home_visit', 'Home visit'

    uuid = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name='visits')
    visit_type = models.CharField(max_length=20, choices=VisitType.choices)
    timestamp = models.DateTimeField(default=timezone.now)
    reason = models.CharField(max_length=200, blank=True, default='')
    # Vitals are optional; ranges reject typos, not clinically unusual values.
    temperature_c = models.DecimalField(
        max_digits=4, decimal_places=1, null=True, blank=True,
        validators=[MinValueValidator(Decimal('30.0')), MaxValueValidator(Decimal('45.0'))])
    pulse_bpm = models.PositiveSmallIntegerField(
        null=True, blank=True, validators=[MinValueValidator(20), MaxValueValidator(250)])
    systolic_mmhg = models.PositiveSmallIntegerField(
        null=True, blank=True, validators=[MinValueValidator(50), MaxValueValidator(260)])
    diastolic_mmhg = models.PositiveSmallIntegerField(
        null=True, blank=True, validators=[MinValueValidator(30), MaxValueValidator(160)])
    respiratory_rate = models.PositiveSmallIntegerField(
        null=True, blank=True, validators=[MinValueValidator(5), MaxValueValidator(80)])
    spo2_pct = models.PositiveSmallIntegerField(
        null=True, blank=True, validators=[MinValueValidator(50), MaxValueValidator(100)])
    weight_kg = models.DecimalField(
        max_digits=5, decimal_places=1, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.5')), MaxValueValidator(Decimal('400'))])
    # Visits are soft-deleted: the record stays, and a concurrent edit on
    # another device is not lost.
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-timestamp']

    def __str__(self):
        return f"{self.patient} - {self.visit_type} - {self.timestamp: %Y-%m-%d %H:%M}"


class PatientDocument(models.Model):
    """Automerge document for one patient: the source of truth for synced data.

    Patient and Visit rows are a projection of this document, rebuilt after
    every merge, so the existing REST API, admin and reports keep working.
    """
    patient_uuid = models.UUIDField(primary_key=True)
    data = models.BinaryField()
    # Hex-encoded change hashes; lets a device skip docs it already has.
    heads = models.JSONField(default=list)
    updated_at = models.DateTimeField(auto_now=True, db_index=True)

    def __str__(self):
        return str(self.patient_uuid)
