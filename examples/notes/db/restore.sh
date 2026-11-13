#!/bin/sh
# One-shot database setup for the notes tub.
# - Already set up (marker table exists): do nothing.
# - ./restore holds dumps from an export: load them.
# - Otherwise: a fresh tub, so apply the starting schema.
set -eu

until pg_isready -q; do sleep 1; done

if [ "$(psql -tAc "select to_regclass('_tub.initialized') is not null")" = t ]; then
  echo "restore: database already set up"
  exit 0
fi

if [ -f /restore/app.dump ]; then
  echo "restore: loading export"
  # App tables (structure only), then all rows. auth's structure already
  # exists: GoTrue created it on start, so only its rows are loaded.
  # Triggers (including FK checks) are paused while rows load.
  # The fresh database already has the public schema itself: skip that entry.
  pg_restore -l /restore/app.dump | grep -v ' SCHEMA - public ' > /tmp/app.list
  pg_restore --exit-on-error --schema-only -L /tmp/app.list -d "$PGDATABASE" /restore/app.dump
  pg_restore --exit-on-error --data-only --disable-triggers -d "$PGDATABASE" /restore/auth-data.dump
  pg_restore --exit-on-error --data-only --disable-triggers -d "$PGDATABASE" /restore/app.dump
else
  echo "restore: fresh tub, applying schema"
  psql -v ON_ERROR_STOP=1 -f /tub/schema.sql
fi

psql -v ON_ERROR_STOP=1 -c "create schema _tub; create table _tub.initialized (at timestamptz default now()); insert into _tub.initialized default values;"
echo "restore: done"
