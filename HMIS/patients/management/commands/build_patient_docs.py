from django.core.management.base import BaseCommand

from patients import crdt
from patients.models import Patient, PatientDocument


class Command(BaseCommand):
    help = 'Create Automerge documents for patients that do not have one yet.'

    def handle(self, *args, **options):
        existing = PatientDocument.objects.values_list('patient_uuid', flat=True)
        missing = Patient.objects.exclude(uuid__in=existing).prefetch_related('visits')
        count = 0
        for patient in missing.iterator(chunk_size=500):
            crdt.write_patient(patient)
            count += 1
        self.stdout.write(self.style.SUCCESS(f'Created {count} patient documents.'))
