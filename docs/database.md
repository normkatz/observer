# Local database development

This milestone supports only the dedicated local MariaDB 10.6 instance:

- Socket: `/opt/homebrew/var/mariadb/mariadb.sock`
- Port: 3308 (verified on the server, not used to connect)
- Data directory: `/opt/homebrew/var/mariadb/`
- Account: `norm`, using Unix socket authentication
- Schema: `observer`

No password, SSH tunnel, or production login-path is used. The Node connector
supports this socket authentication directly. TCP settings and unexpected
server identities are rejected before migration writes. Production credential
retrieval and deployment are future work; do not bypass the local guard.

## Commands

Use Node 26.4.0. Run `npm ci` after checkout, and copy `.env.example` to `.env`
if local overrides are needed. No secrets belong in either file. Package
lifecycle scripts are disabled in `.npmrc`; review any dependency requiring them.

- `npm run db:check`: verify identity and read metrics.
- `npm run db:status`: read applied migration history (does not create tables).
- `npm run db:migrate`: explicitly apply pending migrations.
- `npm test`: configuration and destination guard tests.
- `npm run test:integration`: create random `observer_test_*` schemas locally,
  exercise migrations and constraints, then drop only those test schemas.

The first migration creates metrics on a fresh database or verifies the existing
six-column definition without changing records. It refuses incompatible tables.
The storage migration creates observations, incidents, incident_evidence, and
notification_outbox. Evidence is a snapshot, not a foreign key to expiring
observations. All new tables use InnoDB and utf8mb4_unicode_ci. Times are UTC.
Big integer IDs returned by the connector are JavaScript BigInt values; callers
must explicitly serialize them as strings when producing JSON reports.

Migration history is stored in schema_migrations. A MariaDB advisory lock on the
same connection serializes migration runs. Migrations never run automatically
at service startup. Existing migration files must not be edited after deployment;
add new forward migrations instead.

MariaDB DDL auto-commits. A failed migration may leave completed DDL in place even
though no history entry was written. Stop and inspect the failure; do not blindly
rerun, drop tables, or mark it applied. There is intentionally no automatic down
command. Repair through a reviewed plan, preserving data. Take a backup first.

## Apache milestone

Migration 003 adds observation retry identifiers and persistent detector state.
The Apache observer now implements sampling, thresholds, enable switches,
retention, and summaries; see [Apache testing](apache-testing.md). Other collectors
and email delivery remain unimplemented. Nonsecret settings are documented in
.env.example. Routine samples default to a 15-second interval and one-hour
retention; incident retention is seven days. An observer will require both its
.env switch and metrics.active to be enabled. WordPress and CiviCRM will be
independently switchable. The Apache metric is seeded disabled on fresh databases; existing settings are preserved.

Local diagnostic files will use var/log (Git-ignored). Production diagnostics
will use journald, with bounded fallback evidence in /var/lib/observer. The
outbox schema provides event deduplication and retry fields, but email delivery
is not exactly-once: a crash after SES accepts a message can result in a retry.
