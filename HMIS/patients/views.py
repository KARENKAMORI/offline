from django.db import transaction
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from . import crdt, duplicates
from .models import Patient, Visit
from .serializers import PatientSerializer, VisitSerializer

class CreateRetrieveUpdateListViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """Create, list, retrieve and update. No delete: deactivate records instead."""
    lookup_value_regex = r'\d+'
    # Writes the row, then mirrors it into the CRDT document so offline
    # devices receive server-side edits on their next sync.
    write_document = None

    def perform_create(self, serializer):
        with transaction.atomic():
            self.write_document(serializer.save())

    def perform_update(self, serializer):
        with transaction.atomic():
            self.write_document(serializer.save())

class PatientViewSet(CreateRetrieveUpdateListViewSet):
    """The list hides patients merged into another record; ?include_merged=true shows them."""
    queryset = Patient.objects.select_related('merged_into')
    serializer_class = PatientSerializer

    @staticmethod
    def write_document(patient):
        duplicates.resolve(patient.uuid, crdt.write_patient(patient))

    def get_queryset(self):
        queryset = super().get_queryset()
        if self.action == 'list' and self.request.query_params.get('include_merged') != 'true':
            queryset = queryset.filter(merged_into__isnull=True)
        return queryset

    # Keeps the original POST /api/patients/register/ URL working
    @action(detail=False, methods=['post'])
    def register(self, request):
        return self.create(request)

class VisitViewSet(CreateRetrieveUpdateListViewSet):
    """DELETE soft-deletes: it sets deleted_at, so the record and its history stay."""
    queryset = Visit.objects.select_related('patient')
    serializer_class = VisitSerializer
    write_document = staticmethod(crdt.write_visit)

    def get_queryset(self):
        queryset = super().get_queryset()
        # Retrieve and restore must still find deleted visits; only the list hides them.
        if self.action == 'list' and self.request.query_params.get('include_deleted') != 'true':
            queryset = queryset.filter(deleted_at__isnull=True)
        return queryset

    def destroy(self, request, *args, **kwargs):
        self._set_deleted_at(self.get_object(), timezone.now())
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'])
    def restore(self, request, pk=None):
        visit = self._set_deleted_at(self.get_object(), None)
        return Response(self.get_serializer(visit).data)

    def _set_deleted_at(self, visit, value):
        with transaction.atomic():
            visit.deleted_at = value
            visit.save(update_fields=['deleted_at'])
            crdt.write_visit(visit)
        return visit
