from django.contrib import admin, messages
from django.db import transaction
from django.utils import timezone

from . import duplicates
from .models import Patient, PossibleDuplicate


@admin.register(Patient)
class PatientAdmin(admin.ModelAdmin):
    list_display = ['name', 'phone', 'location', 'status', 'merged_into', 'registered_at']
    list_filter = ['status', ('merged_into', admin.EmptyFieldListFilter)]
    search_fields = ['name', 'phone', 'phone_normalized', 'location']
    readonly_fields = ['uuid', 'phone_normalized', 'merged_into', 'registered_at']


@admin.register(PossibleDuplicate)
class PossibleDuplicateAdmin(admin.ModelAdmin):
    """Same phone, different name: a person decides whether it is one patient."""
    list_display = ['patient', 'other', 'phone', 'created_at', 'dismissed_at']
    list_filter = [('dismissed_at', admin.EmptyFieldListFilter)]
    list_select_related = ['patient', 'other']
    actions = ['merge_pair', 'dismiss']

    @admin.display(description='Phone')
    def phone(self, obj):
        return obj.patient.phone

    def get_queryset(self, request):
        # A pair is moot once either side was merged elsewhere.
        return super().get_queryset(request).filter(
            patient__merged_into__isnull=True, other__merged_into__isnull=True)

    @admin.action(description='Merge: same patient (newer record into older)')
    def merge_pair(self, request, queryset):
        for pair in queryset.filter(dismissed_at__isnull=True):
            with transaction.atomic():
                duplicates.merge(pair.other, pair.patient)
        self.message_user(request, 'Merged. Devices pick this up on their next sync.', messages.SUCCESS)

    @admin.action(description='Not a duplicate: different people')
    def dismiss(self, request, queryset):
        queryset.filter(dismissed_at__isnull=True).update(dismissed_at=timezone.now())
