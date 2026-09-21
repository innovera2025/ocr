# OCR Go-Live Checklist

## Deployment and secrets

- [ ] Application VPS provisioned separately from Local AI VPS
- [ ] `DATABASE_URL_BOOTSTRAP` supplied only for one-time role provisioning
- [ ] `DATABASE_URL_MIGRATOR`, `DATABASE_URL_APP`, `DATABASE_URL_WORKER`, `DATABASE_URL_QUEUE` injected by secret manager
- [ ] `AUTH_JWT_SECRETS`, issuer, and audience configured for production
- [ ] `OCR_API_BASE_URL=https://ai.innoveraappcenter.com/ocr`
- [ ] No secrets committed, baked into images, or printed by `docker inspect`

## Runtime

- [ ] Migrations apply with no checksum error and rerun returns no pending versions
- [ ] Web and worker use the correct DB roles
- [ ] ClamAV healthy with signatures loaded
- [ ] Worker restart/recovery verified
- [ ] Web `/health/live` and `/health/ready` verified

## Monitoring and operations

- [ ] Prometheus scrapes web `/metrics`
- [ ] Worker metrics are exported through the selected collector
- [ ] Alerts enabled for HTTP/OCR failures, queue/outbox backlog, DB, ClamAV, disk, and worker heartbeat
- [ ] `innovera-ocr-cleanup.timer` enabled and dry-run completed
- [ ] Backup schedule and restore test recorded

## Security and network

- [ ] Application VPS exposes only the reverse proxy/application ports required
- [ ] PostgreSQL and ClamAV are internal-only
- [ ] Local AI VPS exposes only HTTPS 443 publicly
- [ ] Ollama 11434, OCR internal 5000, LiteLLM 4000 are firewall-restricted
- [ ] TLS certificate renewal tested
- [ ] Tenant isolation and invalid JWT cases verified

## Evidence from this validation

- 38 tests passed; typecheck and lint passed
- PostgreSQL restart and ClamAV outage/recovery passed locally
- Backup: 47 KiB, 0.32 s; restore: 0.28 s on local fixture
- ClamAV clean/EICAR checks passed
- PostgreSQL restore verified documents, jobs, OCR results, corrections, and outbox rows

Production traffic remains **NO-GO** until real bootstrap credentials, production monitoring, scheduler installation, TLS/firewall evidence, and final authenticated E2E evidence are attached to this checklist.
