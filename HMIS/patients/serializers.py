from rest_framework import serializers 
from .identity import normalize_phone
from .models import Patient, Visit

class PatientSerializer(serializers.ModelSerializer):
    merged_into = serializers.SlugRelatedField(slug_field='uuid', read_only=True)

    class Meta:
        model = Patient
        fields = ['id', 'uuid', 'name', 'phone', 'status', 'location', 'head_of_household', 'registered_at',
                  'merged_into']
        read_only_fields = ['id', 'uuid', 'registered_at']

    def validate_phone(self, value):
        return normalize_phone(value)

class VisitSerializer(serializers.ModelSerializer):
    class Meta:
        model = Visit
        fields = ['id', 'uuid', 'patient', 'visit_type', 'timestamp', 'reason',
                  'temperature_c', 'pulse_bpm', 'systolic_mmhg', 'diastolic_mmhg',
                  'respiratory_rate', 'spo2_pct', 'weight_kg', 'deleted_at']
        # Delete and restore have their own endpoints.
        read_only_fields = ['id', 'uuid', 'deleted_at']

    def validate_patient(self, value):
        # A visit lives inside its patient's CRDT document; moving it would
        # mean deleting from one document and recreating in another.
        if self.instance and value != self.instance.patient:
            raise serializers.ValidationError('A visit cannot be moved to another patient.')
        # A new visit for a merged patient belongs on the record it was merged into.
        return value if self.instance else value.canonical()