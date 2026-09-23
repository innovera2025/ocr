-- Dev / fresh-database only (release2-plan §7 E5b). No migration creates an organizations row, so `assertTenant`
-- fails web startup on an empty database. Production already has its row and must NOT be seeded with this file.
-- Run it as ocr_bootstrap inside the postgres container:
--   docker compose -f deploy/docker-compose.yml exec -T postgres \
--     psql -U ocr_bootstrap -d innovera_ocr -v ON_ERROR_STOP=1 -f - < deploy/sql/seed-dev-tenant.sql
-- The id matches OCR_WEB_TENANT_ID in deploy/docker-compose.dev.yml.
INSERT INTO organizations (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'Local development tenant')
ON CONFLICT (id) DO NOTHING;
