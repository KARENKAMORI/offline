"""HTTP transport for the Automerge sync protocol.

A device reconnecting after being offline:

1. GET  /api/sync/manifest/?since=<server_time from last sync>
   -> {"server_time": ..., "docs": {"<patient uuid>": ["<head hex>", ...]}}
   The device syncs every doc whose heads differ from its local copy, plus
   every doc it changed locally.

2. POST /api/sync/  {"docs": {"<patient uuid>": "<base64 sync message>"}}
   -> {"docs": {"<patient uuid>": "<base64 reply>" | null},
       "problems": {"<patient uuid>": ["..."]}}
   Repeat with the docs whose generateSyncMessage() is still non-null, until
   none are left. Many docs travel in one request so a device with 200 changed
   patients needs a handful of round trips, not 200.
"""
import base64
import binascii
import uuid
from datetime import timedelta

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from . import crdt
from .models import PatientDocument

MAX_DOCS_PER_REQUEST = 500
# updated_at is stamped before the writing transaction commits, so a doc can
# become visible with a timestamp earlier than a manifest the device already
# read. Re-listing a short overlap window closes that gap; the device compares
# heads and skips docs it already has, so the overlap costs almost nothing.
MANIFEST_OVERLAP = timedelta(minutes=2)


class ManifestView(APIView):
    def get(self, request):
        server_time = timezone.now()
        docs = PatientDocument.objects.all()
        since = request.query_params.get('since')
        if since:
            parsed = parse_datetime(since)
            if parsed is None:
                return Response({'detail': 'since must be an ISO-8601 datetime'},
                                status=status.HTTP_400_BAD_REQUEST)
            docs = docs.filter(updated_at__gte=parsed - MANIFEST_OVERLAP)
        return Response({
            'server_time': server_time.isoformat(),
            'docs': {str(pk): heads for pk, heads in docs.values_list('patient_uuid', 'heads')},
        })


class SyncView(APIView):
    def post(self, request):
        docs = request.data.get('docs')
        if not isinstance(docs, dict):
            return Response({'detail': 'docs must be an object'}, status=status.HTTP_400_BAD_REQUEST)
        if len(docs) > MAX_DOCS_PER_REQUEST:
            return Response({'detail': f'at most {MAX_DOCS_PER_REQUEST} docs per request'},
                            status=status.HTTP_400_BAD_REQUEST)

        replies, problems, answered = {}, {}, {}
        for key, encoded in docs.items():
            try:
                patient_uuid = uuid.UUID(key)
                message = base64.b64decode(encoded, validate=True)
                reply, doc_problems, heads = crdt.receive(patient_uuid, message)
            except (ValueError, TypeError, binascii.Error) as exc:
                # A bad doc fails alone; the rest of the batch still syncs.
                problems[key] = [f'rejected: {exc}']
                replies[key] = None
                continue
            answered[key] = (patient_uuid, message, heads)
            replies[key] = base64.b64encode(reply).decode() if reply is not None else None
            if doc_problems:
                problems[key] = doc_problems

        # A duplicate later in the batch may have been merged into a doc answered
        # earlier. Answer that doc again so the device gets the copied visits now.
        current = dict(PatientDocument.objects.filter(pk__in=[v[0] for v in answered.values()])
                       .values_list('patient_uuid', 'heads'))
        for key, (patient_uuid, message, heads) in answered.items():
            if current.get(patient_uuid, heads) != heads:
                reply, _, _ = crdt.receive(patient_uuid, message)
                replies[key] = base64.b64encode(reply).decode() if reply is not None else None
        return Response({'docs': replies, 'problems': problems})
