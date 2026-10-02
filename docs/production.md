# Production connection check

Use Node 26.4.0 and `npm ci` in `/opt/observer` after pulling this update.
Do not copy the Mac's .env to production. Use `deploy/observer.env.example`
as the list of nonsecret settings in `/etc/observer/.env`.
Preserve any values you have already entered. Remove DB_SOCKET_PATH and DB_USER;
username and password come exclusively from the secret. DB_ARN is unused.
For runtime operation, `DB_SECRET_ARN` points to the least-privileged observer
account. Set `DB_MIGRATION_SECRET_ARN` to a separate migration account secret;
the `up` command selects it automatically, while `check` and `status` continue
using the runtime account.

The database must be MariaDB 10.6 with an existing `observer` schema. EC2 must
reach its RDS endpoint on port 3306 and Secrets Manager over HTTPS (through an
internet/NAT route or a Secrets Manager VPC endpoint). No AWS CLI is required.
The SDK explicitly uses EC2 instance metadata credentials, not local AWS profiles
or access keys. The instance role needs GetSecretValue on the exact secret ARN.
Use IMDSv2 on EC2. A customer-managed encryption key additionally needs kms:Decrypt.
The secret must be a JSON object with nonempty `username` and `password` strings.

Install the public AWS RDS CA bundle (not a secret):

```bash
sudo install -d -m 0755 /etc/observer
sudo curl --fail --show-error --silent --location \
  https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem \
  -o /etc/observer/rds-ca.pem
```

Edit configuration with `sudo vim /etc/observer/.env`. Then run as ubuntu:

```bash
cd /opt/observer
npm run db:check
npm run db:status
```

These commands make no database changes. Check verifies secret retrieval,
certificate-verified TLS, database version/schema, and lists table collations.
It never prints credentials. The secret is fetched once per process startup;
restart after credential rotation. Metadata and secret requests are bounded.
The live EC2 role/network/TLS path must be verified with this check; local tests
use a fake Secrets Manager response and cannot verify your AWS configuration.

## Migrations — separate from the connection check

Back up only the observer schema using your existing database administration
workflow. Review existing tables and migration history before applying changes.
Migration 001 requires metrics to match the local baseline, including
utf8mb4_unicode_ci defaults. An older production metrics table may need a
separately reviewed adjustment; changing database defaults alone does not change
existing tables. Do not bypass this check or mark migrations applied manually.
No migrations run during check or service startup.

After confirming the baseline and backup:

```bash
npm run db:migrate
npm run db:status
```

These npm commands load a project `.env` followed by `/etc/observer/.env` if present.
The project-owned `scripts/start.mjs` launcher reports each loaded file, or an
explicit alternate-location message when the project file is missing. It never
prints configuration values. Unreadable files cause an error instead of being
silently skipped. Integration tests keep their separate local-only configuration.
Keep configuration files untracked. Grant
the migration secret to the EC2 role only while migrations are needed, then
remove that resource from the IAM policy if migrations are controlled manually.
Do not use both configuration files with conflicting values. Exported shell
variables take precedence over env-file values.

DDL auto-commits in MariaDB. On migration failure, inspect what completed before
retrying. Do not sync local test data or migration history into production.
Restrict database grants to observer.*; separate migration DDL permissions from
the runtime account when deploying the service. Never use the RDS admin account.

Apache, CPU, processes and memory collection are implemented; see
[system observers](system-observers.md) for the new migration and enable switches.
Production currently runs in the foreground as ubuntu. A systemd unit and email
delivery remain separate deployment work.
