# PostgreSQL backup and restore

Run backups from a trusted operator host with the migrator connection string supplied through the environment. Never put the URL or password in the repository or an image.

```sh
pg_dump --format=custom --no-owner --file="ocr-$(date -u +%Y%m%dT%H%M%SZ).dump" "$DATABASE_URL_MIGRATOR"
```

Restore into an empty database, then run the migration runner. Restore the database before restoring the object-storage volume so database metadata and originals remain consistent:

```sh
createdb "$RESTORE_DATABASE_URL"
pg_restore --exit-on-error --no-owner --dbname="$RESTORE_DATABASE_URL" ocr-YYYYMMDDTHHMMSSZ.dump
COREPACK_HOME=/tmp/ocr-corepack pnpm exec tsx -e "import {createDatabasePool,runMigrationsWithPool} from './packages/db-runtime/src/index.ts'; const p=createDatabasePool(process.env.RESTORE_DATABASE_URL); runMigrationsWithPool(p,'./prisma/migrations').then(()=>p.end())"
```

Verify `schema_migrations`, RLS policies, role grants, queue rows, outbox rows, and a review query under an application role before switching traffic. Keep encrypted daily backups and test a restore at least monthly.
