# Python 3.12: automerge 1.0.0rc1 ships prebuilt wheels only up to cp312.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
# Static files need a settings import but no database or real secret.
RUN DJANGO_SECRET_KEY=collectstatic python manage.py collectstatic --noinput

RUN useradd --create-home app
USER app

# Cloud Run gives 1 vCPU by default. Sync requests are CPU-bound (Automerge),
# so a few threads per worker are enough; the timeout matches Cloud Run's 300 s.
CMD exec gunicorn HMIS.wsgi:application \
    --bind 0.0.0.0:$PORT --workers 2 --threads 4 --timeout 300
