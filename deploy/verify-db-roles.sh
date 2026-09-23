#!/usr/bin/env bash
set -u
: "${DATABASE_URL_BOOTSTRAP:?set DATABASE_URL_BOOTSTRAP}"
: "${DATABASE_URL_MIGRATOR:?set DATABASE_URL_MIGRATOR}"
: "${DATABASE_URL_APP:?set DATABASE_URL_APP}"
: "${DATABASE_URL_WORKER:?set DATABASE_URL_WORKER}"
: "${DATABASE_URL_QUEUE:?set DATABASE_URL_QUEUE}"

pass=0; fail=0; skip=0
# A fifth argument is a guard: a boolean SQL expression saying whether this check can be asked of this database yet.
# It answers false where the migration behind the check has not run, and the check then prints SKIP rather than FAIL —
# psql's stderr is discarded below, so a question that errors would otherwise read as a failed answer.
check_sql() { local name="$1" url="$2" sql="$3" expected="$4" guard="${5:-}"; local actual
  if [ -n "$guard" ] && [ "$(psql "$url" -AtX -v ON_ERROR_STOP=1 -c "SELECT ($guard)::int" 2>/dev/null || true)" != "1" ]; then printf 'SKIP %s\n' "$name"; skip=$((skip+1)); return; fi
  actual="$(psql "$url" -AtX -v ON_ERROR_STOP=1 -c "$sql" 2>/dev/null || true)"; if [ "$actual" = "$expected" ]; then printf 'PASS %s\n' "$name"; pass=$((pass+1)); else printf 'FAIL %s\n' "$name"; fail=$((fail+1)); fi; }
# 0020 is applied by Deploy B. Between Deploy A and Deploy B this is false and the two checks it guards are skipped.
round_clock="EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.ocr_batches') AND attname = 'round_opened_at' AND NOT attisdropped)"
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
check_sql "worker:no-select-extraction-jobs" "$DATABASE_URL_WORKER" "SELECT has_any_column_privilege(current_user,'public.extraction_jobs','SELECT')::int" 0
check_sql "worker:no-delete-documents" "$DATABASE_URL_WORKER" "SELECT has_table_privilege(current_user,'public.documents','DELETE')::int" 0
# 0019: only the web runtime touches staff accounts, sessions and the append-only audit log. Every role is named
# explicitly (not current_user), so one bootstrap connection answers for all of them and deploy/sql/verify-release2-grants.sql
# can ask the same questions inside the database container, with no role password and no host-reachable DSN.
check_sql "app:select-users" "$DATABASE_URL_BOOTSTRAP" "SELECT has_table_privilege('ocr_app','public.users','SELECT')::int" 1
check_sql "app:no-delete-users" "$DATABASE_URL_BOOTSTRAP" "SELECT has_table_privilege('ocr_app','public.users','DELETE')::int" 0
check_sql "app:no-delete-auth-sessions" "$DATABASE_URL_BOOTSTRAP" "SELECT has_table_privilege('ocr_app','public.auth_sessions','DELETE')::int" 0
check_sql "app:no-delete-audit" "$DATABASE_URL_BOOTSTRAP" "SELECT has_table_privilege('ocr_app','public.audit_events','DELETE')::int" 0
check_sql "app:no-update-users-org" "$DATABASE_URL_BOOTSTRAP" "SELECT has_column_privilege('ocr_app','public.users','organization_id','UPDATE')::int" 0
check_sql "app:no-update-users-username" "$DATABASE_URL_BOOTSTRAP" "SELECT has_column_privilege('ocr_app','public.users','username','UPDATE')::int" 0
check_sql "app:no-update-audit" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_app','public.audit_events','UPDATE')::int" 0
check_sql "app:no-update-session-identity" "$DATABASE_URL_BOOTSTRAP" "SELECT bool_or(has_column_privilege('ocr_app','public.auth_sessions',c,'UPDATE'))::int FROM unnest(ARRAY['token_hash','user_id','expires_at','organization_id']) c" 0
check_sql "worker:no-select-users" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_worker','public.users','SELECT')::int" 0
check_sql "worker:no-select-sessions" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_worker','public.auth_sessions','SELECT')::int" 0
check_sql "worker:no-select-audit" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_worker','public.audit_events','SELECT')::int" 0
check_sql "queue:no-select-users" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_queue','public.users','SELECT')::int" 0
check_sql "queue:no-select-sessions" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_queue','public.auth_sessions','SELECT')::int" 0
check_sql "queue:no-select-audit" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_queue','public.audit_events','SELECT')::int" 0
# ocr_queue_definer is the one BYPASSRLS role: a grant drifting onto it would make hashes, sessions and audit rows
# readable across tenants through a SECURITY DEFINER function, and nothing else in production would notice.
check_sql "definer:no-users" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_queue_definer','public.users','SELECT')::int" 0
check_sql "definer:no-sessions" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_queue_definer','public.auth_sessions','SELECT')::int" 0
check_sql "definer:no-audit" "$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege('ocr_queue_definer','public.audit_events','SELECT')::int" 0
check_sql "force-rls:release2" "$DATABASE_URL_BOOTSTRAP" "SELECT bool_and(relforcerowsecurity) FROM pg_class WHERE relname IN ('users','auth_sessions','audit_events')" t
# 0020: round_opened_at is the only column of ocr_batches the web runtime may change (the batch clock). The label and
# the capacity stay as they were created, so a compromised web process can neither relabel nor resize a batch. Both
# are guarded on 0020: has_column_privilege() raises 42703 for a column that is not there, and the empty result would
# be a FAIL — and a non-zero exit out of deploy/go-live-check.sh — on the schema production carries until Deploy B.
check_sql "app:update-batch-round" "$DATABASE_URL_BOOTSTRAP" "SELECT has_column_privilege('ocr_app','public.ocr_batches','round_opened_at','UPDATE')::int" 1 "$round_clock"
check_sql "app:no-update-batch-label" "$DATABASE_URL_BOOTSTRAP" "SELECT has_column_privilege('ocr_app','public.ocr_batches','label','UPDATE')::int" 0 "$round_clock"
printf 'SUMMARY PASS=%s SKIP=%s FAIL=%s\n' "$pass" "$skip" "$fail"
[ "$fail" -eq 0 ]
