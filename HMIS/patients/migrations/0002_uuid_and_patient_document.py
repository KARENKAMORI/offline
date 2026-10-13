import uuid

from django.db import migrations, models


def backfill_uuids(apps, schema_editor):
    # AddField evaluates a callable default once, so existing rows would all
    # share one UUID; give each row its own before adding the unique constraint.
    for model_name in ('Patient', 'Visit'):
        model = apps.get_model('patients', model_name)
        for row in model.objects.filter(uuid__isnull=True):
            row.uuid = uuid.uuid4()
            row.save(update_fields=['uuid'])


class Migration(migrations.Migration):

    dependencies = [
        ('patients', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='patient',
            name='uuid',
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.AddField(
            model_name='visit',
            name='uuid',
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.RunPython(backfill_uuids, migrations.RunPython.noop),
        migrations.AlterField(
            model_name='patient',
            name='uuid',
            field=models.UUIDField(default=uuid.uuid4, editable=False, unique=True),
        ),
        migrations.AlterField(
            model_name='visit',
            name='uuid',
            field=models.UUIDField(default=uuid.uuid4, editable=False, unique=True),
        ),
        migrations.CreateModel(
            name='PatientDocument',
            fields=[
                ('patient_uuid', models.UUIDField(primary_key=True, serialize=False)),
                ('data', models.BinaryField()),
                ('heads', models.JSONField(default=list)),
                ('updated_at', models.DateTimeField(auto_now=True, db_index=True)),
            ],
        ),
    ]
