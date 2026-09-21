# Failure drill procedure

Run only against a production-like stack with traffic disabled. Destructive commands require `ALLOW_DESTRUCTIVE_DRILL=true` and an operator review.

| Drill | Command | Expected evidence |
| --- | --- | --- |
| Worker kill | `ALLOW_DESTRUCTIVE_DRILL=true ./deploy/failure-drill.sh worker-kill` | leased job recovers after lease expiry; one final result |
| PostgreSQL restart | `ALLOW_DESTRUCTIVE_DRILL=true ./deploy/failure-drill.sh postgres-restart` | readiness fails during restart, then queue/result queries recover |
| OCR outage | `./deploy/failure-drill.sh ocr-outage-check` | retry count/last error and no lost job |
| Confirm outage | `./deploy/failure-drill.sh confirm-outage-check` | correction remains, outbox becomes `RETRY`, later `SUCCEEDED` |
| ClamAV outage | `ALLOW_DESTRUCTIVE_DRILL=true ./deploy/failure-drill.sh clamav-restart` | scan fails closed and no OCR queue row is created |
| Storage failure | operator remounts a disposable storage path read-only | upload fails without orphan DB state |

Capture timestamps, document/job IDs, queue/outbox rows, readiness responses, and recovery duration for each drill. Never run the destructive commands against an unknown environment.
