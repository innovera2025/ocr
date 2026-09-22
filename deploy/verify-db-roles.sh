#!/usr/bin/env bash
set -u
: "${DATABASE_URL_BOOTSTRAP:?set DATABASE_URL_BOOTSTRAP}"
: "${DATABASE_URL_MIGRATOR:?set DATABASE_URL_MIGRATOR}"
: "${DATABASE_URL_APP:?set DATABASE_URL_APP}"
: "${DATABASE_URL_WORKER:?set DATABASE_URL_WORKER}"
: "${DATABASE_URL_QUEUE:?set DATABASE_URL_QUEUE}"

pass=0; fail=0
check_sql() { local name="$1" url="$2" sql="$3" expected="$4"; local actual; actual="$(psql "$url" -AtX -v ON_ERROR_STOP=1 -c "$sql" 2>/dev/null || true)"; if [ "$actual" = "$expected" ]; then printf 'PASS %s\n' "$name"; pass=$((pass+1)); else printf 'FAIL %s\n' "$name"; fail=$((fail+1)); fi; }
check_sql "app:not-superuser" "$DATABASE_URL_APP" "SELECT rolsuper::int FROM pg_roles WHERE rolname=current_user" 0
check_sql "worker:not-superuser" "$DATABASE_URL_WORKER" "SELECT rolsuper::int FROM pg_roles WHERE rolname=current_user" 0
check_sql "queue:not-superuser" "$DATABASE_URL_QUEUE" "SELECT rolsuper::int FROM pg_roles WHERE rolname=current_user" 0
check_sql "migrator:not-superuser" "$DATABASE_URL_MIGRATOR" "SELECT rolsuper::int FROM pg_roles WHERE rolname=current_user" 0
check_sql "queue:no-table-select" "$DATABASE_URL_QUEUE" "SELECT has_table_privilege(current_user,'public.extraction_jobs','SELECT')::int" 0
check_sql "queue:claim-function" "$DATABASE_URL_QUEUE" "SELECT has_function_privilege(current_user,'ocr_claim_v1(timestamptz)','EXECUTE')::int" 1
check_sql "app:no-create-schema" "$DATABASE_URL_APP" "SELECT has_schema_privilege(current_user,'public','CREATE')::int" 0
if psql "$DATABASE_URL_APP" -AtX -v ON_ERROR_STOP=1 -c 'CREATE TABLE public.__ocr_privilege_probe(id integer)' >/dev/null 2>&1; then printf 'FAIL app:cannot-create-table\n'; psql "$DATABASE_URL_APP" -c 'DROP TABLE IF EXISTS public.__ocr_privilege_probe' >/dev/null 2>&1 || true; fail=$((fail+1)); else printf 'PASS app:cannot-create-table\n'; pass=$((pass+1)); fi
if psql "$DATABASE_URL_WORKER" -AtX -v ON_ERROR_STOP=1 -c 'CREATE TABLE public.__ocr_privilege_probe(id integer)' >/dev/null 2>&1; then printf 'FAIL worker:cannot-create-table\n'; psql "$DATABASE_URL_WORKER" -c 'DROP TABLE IF EXISTS public.__ocr_privilege_probe' >/dev/null 2>&1 || true; fail=$((fail+1)); else printf 'PASS worker:cannot-create-table\n'; pass=$((pass+1)); fi
check_sql "worker:no-migration-table" "$DATABASE_URL_WORKER" "SELECT has_table_privilege(current_user,'public.schema_migrations','INSERT')::int" 0
# 0018: the worker creates page documents, their runs and their OCR jobs (tenant RLS applies), and nothing more.
check_sql "worker:insert-documents" "$DATABASE_URL_WORKER" "SELECT has_table_privilege(current_user,'public.documents','INSERT')::int" 1
check_sql "worker:insert-extraction-jobs" "$DATABASE_URL_WORKER" "SELECT has_table_privilege(current_user,'public.extraction_jobs','INSERT')::int" 1
check_sql "worker:no-update-extraction-jobs" "$DATABASE_URL_WORKER" "SELECT has_table_privilege(current_user,'public.extraction_jobs','UPDATE')::int" 0
check_sql "worker:no-delete-documents" "$DATABASE_URL_WORKER" "SELECT has_table_privilege(current_user,'public.documents','DELETE')::int" 0
printf 'SUMMARY PASS=%s FAIL=%s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
