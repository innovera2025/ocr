-- Release 2 grant check (plan §3 A2). Read-only: it reads catalogues and changes nothing.
-- Run it inside the database container, where no role password, no host psql and no host-reachable DSN are needed:
--   docker compose ... exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -f - < deploy/sql/verify-release2-grants.sql
-- Every role is named explicitly, so one connection answers for all of them. The last line must read FAIL=0.
-- `ok` is three-valued: true prints PASS, false prints FAIL, NULL prints SKIP — a check whose migration is not
-- applied to THIS database yet. A skip is not a pass: it says the question could not be asked.
WITH applied(round_clock) AS (
  SELECT EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid = to_regclass('public.ocr_batches') AND attname = 'round_opened_at' AND NOT attisdropped)
), checks(seq, name, ok) AS (
  SELECT * FROM (VALUES
    -- The web runtime reads and appends; it never deletes, and it cannot move a user between tenants or rename one.
    ( 1, 'app:select-users',               has_table_privilege('ocr_app','public.users','SELECT')),
    ( 2, 'app:no-delete-users',            NOT has_table_privilege('ocr_app','public.users','DELETE')),
    ( 3, 'app:no-delete-auth-sessions',    NOT has_table_privilege('ocr_app','public.auth_sessions','DELETE')),
    ( 4, 'app:no-delete-audit',            NOT has_table_privilege('ocr_app','public.audit_events','DELETE')),
    ( 5, 'app:no-update-users-org',        NOT has_column_privilege('ocr_app','public.users','organization_id','UPDATE')),
    ( 6, 'app:no-update-users-username',   NOT has_column_privilege('ocr_app','public.users','username','UPDATE')),
    ( 7, 'app:no-update-audit',            NOT has_any_column_privilege('ocr_app','public.audit_events','UPDATE')),
    -- Session identity: the granted UPDATE list is last_seen_at, revoked_at and revoked_reason, and nothing else.
    ( 8, 'app:no-update-session-identity', NOT (SELECT bool_or(has_column_privilege('ocr_app','public.auth_sessions',c,'UPDATE'))
                                                FROM unnest(ARRAY['token_hash','user_id','expires_at','organization_id']) c)),
    ( 9, 'worker:no-select-users',         NOT has_any_column_privilege('ocr_worker','public.users','SELECT')),
    (10, 'worker:no-select-sessions',      NOT has_any_column_privilege('ocr_worker','public.auth_sessions','SELECT')),
    (11, 'worker:no-select-audit',         NOT has_any_column_privilege('ocr_worker','public.audit_events','SELECT')),
    (12, 'queue:no-select-users',          NOT has_any_column_privilege('ocr_queue','public.users','SELECT')),
    (13, 'queue:no-select-sessions',       NOT has_any_column_privilege('ocr_queue','public.auth_sessions','SELECT')),
    (14, 'queue:no-select-audit',          NOT has_any_column_privilege('ocr_queue','public.audit_events','SELECT')),
    -- ocr_queue_definer is the one BYPASSRLS role: a grant drifting onto it would make hashes, sessions and audit rows
    -- readable across tenants through a SECURITY DEFINER function, and nothing else in production would notice.
    (15, 'definer:no-users',               NOT has_any_column_privilege('ocr_queue_definer','public.users','SELECT')),
    (16, 'definer:no-sessions',            NOT has_any_column_privilege('ocr_queue_definer','public.auth_sessions','SELECT')),
    (17, 'definer:no-audit',               NOT has_any_column_privilege('ocr_queue_definer','public.audit_events','SELECT')),
    -- FORCE RLS on the three new tables is machine-checked, not eyeballed.
    (18, 'force-rls:release2',             (SELECT bool_and(relforcerowsecurity) FROM pg_class WHERE relname IN ('users','auth_sessions','audit_events')))
  ) v(seq, name, ok)
  UNION ALL
  -- 0020: the batch clock. round_opened_at is the only column of ocr_batches the web runtime may change; the label
  -- and the capacity stay as they were created. Both rows SKIP until 0020 is applied (Deploy B): asking
  -- has_column_privilege() about a column that is not there raises 42703, and one error aborts the WHOLE statement —
  -- unguarded, these two would leave Deploy A's gate printing no PASS line and no SUMMARY at all on the schema
  -- production carries between the two deploys.
  SELECT 19, 'app:update-batch-round',
         CASE WHEN round_clock THEN has_column_privilege('ocr_app','public.ocr_batches','round_opened_at','UPDATE') END
  FROM applied
  UNION ALL
  SELECT 20, 'app:no-update-batch-label',
         CASE WHEN round_clock THEN NOT has_column_privilege('ocr_app','public.ocr_batches','label','UPDATE') END
  FROM applied
)
SELECT line FROM (
  SELECT seq, (CASE WHEN ok THEN 'PASS ' WHEN ok IS NULL THEN 'SKIP ' ELSE 'FAIL ' END) || name AS line FROM checks
  UNION ALL
  SELECT 9999, 'SUMMARY PASS=' || count(*) FILTER (WHERE ok)
             || ' SKIP=' || count(*) FILTER (WHERE ok IS NULL)
             || ' FAIL=' || count(*) FILTER (WHERE ok IS FALSE) FROM checks
) ordered ORDER BY seq;
