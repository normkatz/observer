# Apache observer and controlled burst test

This milestone runs locally on the Mac, using the existing Homebrew Apache and
local MariaDB. It does not connect to production RDS, start Linux collectors,
modify Apache, or send email. The Unix socket destination guard remains enabled.

## Start and inspect

Use Node 26.4.0, `npm ci`, and `npm run db:migrate`. In your Git-ignored `.env`:

```ini
OBSERVER_APACHE_ENABLED=true
APACHE_LOG_PATH=/opt/homebrew/var/log/httpd/access_log
SAMPLE_INTERVAL_SECONDS=15
OBSERVATION_RETENTION_SECONDS=3600
INCIDENT_RETENTION_DAYS=7
APACHE_REQUEST_RATE_THRESHOLD=5
APACHE_RECOVERY_RATE_THRESHOLD=2
APACHE_TRIGGER_SAMPLES=2
APACHE_RECOVERY_SAMPLES=2
NOTIFICATIONS_ENABLED=false
```

The local `metrics` row must also have `active=1`. This was enabled during setup.
Both switches must permit sampling. `.env` changes require a restart; database
settings reload each cycle. A nullable `sampling_interval_seconds` overrides the
global interval. Optional `thresholds` JSON accepts only these keys:

```json
{"request_rate":5,"recovery_rate":2,"trigger_samples":2,"recovery_samples":2}
```

Run in a terminal on the Mac:

```bash
npm start
```

Leave it running during the EC2 test. Ctrl-C or SIGTERM stops it gracefully.
This milestone does not install an automatically starting observer service.
The loop never overlaps samples. Rates use actual elapsed monotonic time, so
slow persistence does not inflate them. `MAX_SAMPLES=12 npm start` stops after
12 cycles. Other observer flags in `.env.example` are placeholders for later
collectors. Enabling notifications currently fails explicitly because SES
transport has not been implemented or configured.

In another Mac terminal:

```bash
npm run report
```

This prints the latest five incidents with summaries. Raw aggregated samples
are available in `observations.payload` and `incident_evidence.payload` in
DataGrip. No raw request lines or bodies are stored. A useful inspection query:

```sql
SELECT observed_at,
       JSON_VALUE(payload, '$.requests') AS requests,
       JSON_VALUE(payload, '$.requestsPerSecond') AS requests_per_second,
       JSON_VALUE(payload, '$.complete') AS complete
FROM observations
ORDER BY observed_at DESC
LIMIT 20;
```

Diagnostic JSON logs go to stdout and `var/log/observer.jsonl`, rotating at 5 MB
with three archives. Pending samples go to a schema/host subdirectory under
`var/state`, retained for at most one hour, 240 entries, or 4 MiB by default.
Dropped entries are reported. Keep the same state directory across restarts.
A process lock prevents two runners using the same state directory concurrently.
At initial startup, the database must be reachable to verify its identity and
load configuration. After startup, failed writes are retried from the bounded
local queue. Database failure delays incident reporting but does not require
re-reading logs. Atomic queue-file replacement protects ordinary process restarts;
this is not a guarantee against disk failure or a machine power loss.

## How incidents work

The observer starts at EOF and counts only new completed log entries. It accepts
Apache common and combined formats. Other formats are counted as malformed, not
silently treated as valid. Requests at or above 5/sec for two consecutive samples
open one incident. Two complete samples at or below 2/sec resolve it. At the
15-second default, expect roughly 30 seconds of sustained activity to trigger,
with boundary alignment potentially adding another interval.

Unavailable logs or incomplete reads never count as evidence of recovery.
Rotation drains the old file before reading the replacement; copytruncate is
detected using file size and a short offset marker. Truncation, malformed input,
or capped reads flag the sample as incomplete. Late writes to an already-closed
rotated file and extremely rapid repeated rotations may be missed. A restarted
observer skips log entries written while it was stopped and resets consecutive
sample counters; it does not silently declare an existing incident recovered.

The read budget is 1 MiB per cycle by default, lines are bounded at 16 KiB, and
path counting tracks at most 100 distinct paths per sample and retains the top
five of those. This is an approximate bounded summary under very high cardinality.
Query strings, fragments, IPs, referrers, and user agents are not retained; URL
paths themselves can still contain identifiers. Use controlled test URLs.

Incidents retain up to 20 preceding observations within five minutes plus their
subsequent samples. Evidence survives routine sample deletion. Resolved incidents
and their evidence expire after seven days; open incidents remain available.
Cleanup uses bounded batches once per minute, so expiration is approximate.

Access-log rates reflect when completed entries are read, not incoming TCP
requests. Log buffering and disk backlog can bunch entries. This static-page
test validates traffic detection, not CPU saturation or WordPress performance.
CPU, PHP, database-query and availability correlations remain later work.

## EC2 load generator

Copy only `scripts/burst.mjs` to the chosen EC2 instance (no `.env`, database
credentials, or dependencies). It needs Node 20.3 or newer; Node 26.4 is fine.
While `npm start` is running on the Mac, execute on EC2:

```bash
node burst.mjs --url http://norm-observer.duckdns.org:8080/ --rps 10 --seconds 60 --concurrency 4
```

This sends at most 600 GET requests over a minute. After it ends, leave the
observer running for another 45 seconds and run `npm run report` on the Mac.
Expect an open incident followed by recovery. The generator prints completed
requests, HTTP status counts, and failures; connection failures should be
investigated before increasing load.

Hard limits: 50 requests/sec, 120 seconds, 10 simultaneous requests, 5-second
request deadline, and 64 KiB response bodies. It never follows redirects and
allows only the configured Mac DDNS hostname or loopback targets. It sends no
credentials and does not store response bodies. Ctrl-C cancels outstanding work.
The Mac must remain awake, and router forwarding must remain configured. The
load generator must run on EC2 for a real external test; a Mac loopback smoke
test has been completed separately.
