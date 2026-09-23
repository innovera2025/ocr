-- 0019_user_auth: staff accounts, server-side browser sessions and an append-only audit log.
-- Runs as ocr_migrator inside the runner's single transaction. Defines no function: the queue and confirm-outbox
-- SECURITY DEFINER functions are owned by ocr_queue_definer and must never be created or replaced here.
-- Login runs under the deployment's configured tenant (OCR_WEB_TENANT_ID): the web sets app.current_org before every
-- query on these tables, so FORCE RLS applies unchanged and no cross-tenant lookup path exists.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  username varchar(32) NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  display_name varchar(100) NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 100),
  role varchar(16) NOT NULL CHECK (role IN ('admin','staff')),
  can_export boolean NOT NULL DEFAULT false,
  password_hash varchar(200) NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  must_change_password boolean NOT NULL DEFAULT false,
  password_expires_at timestamptz,                 -- only for temporary passwords
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_logins integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until timestamptz,
  disabled_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, username)              -- usernames are lower-case by CHECK
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_scope ON users;
CREATE POLICY user_scope ON users USING (organization_id::text = current_setting('app.current_org', true));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),   -- sha256 of the cookie token; never the token
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason varchar(24) CHECK (revoked_reason IN ('logout','relogin','password_changed','admin_reset','disabled')),
  UNIQUE (organization_id, token_hash),
  FOREIGN KEY (user_id, organization_id) REFERENCES users(id, organization_id),
  CHECK (expires_at > created_at)
);
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_session_scope ON auth_sessions;
CREATE POLICY auth_session_scope ON auth_sessions USING (organization_id::text = current_setting('app.current_org', true));
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(organization_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,                              -- NULL: CLI bootstrap
  session_id uuid,
  action varchar(48) NOT NULL CHECK (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  outcome varchar(16) NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure','denied')),
  target_type varchar(16) CHECK (target_type IN ('user','document','batch','export')),
  target_id uuid,
  request_id varchar(128),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  FOREIGN KEY (actor_user_id, organization_id) REFERENCES users(id, organization_id)
);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_scope ON audit_events;
CREATE POLICY audit_scope ON audit_events USING (organization_id::text = current_setting('app.current_org', true));
CREATE INDEX IF NOT EXISTS audit_events_org_time_idx ON audit_events(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events(organization_id, target_type, target_id) WHERE target_id IS NOT NULL;

-- Web runtime only; ocr_worker and ocr_queue get nothing. No DELETE anywhere: users are disabled, sessions revoked,
-- audit rows are append-only. Column-level UPDATE: id, organization_id, username and created_at never change.
GRANT SELECT, INSERT ON users, auth_sessions, audit_events TO ocr_app;
GRANT UPDATE (display_name, role, can_export, password_hash, must_change_password, password_expires_at, password_changed_at,
  failed_logins, locked_until, disabled_at, last_login_at, updated_at) ON users TO ocr_app;
GRANT UPDATE (last_seen_at, revoked_at, revoked_reason) ON auth_sessions TO ocr_app;
GRANT REFERENCES ON users TO ocr_app;             -- 0013 convention: DML roles hold REFERENCES for FK checks
