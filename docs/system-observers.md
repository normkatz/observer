# CPU, process, and memory observers

These observers require Linux `/proc` (Ubuntu 24.04). macOS runs Apache as before;
explicitly enabled system observers report `unsupported`, never fabricated zeros.
No monitoring daemon, package, root privileges, or new Node dependency is needed.
The collector reads kernel files and runs `/usr/bin/getconf PAGESIZE` once when
process sampling starts. It never reads process environments or command arguments.

## Production rollout

Stop a foreground observer with Ctrl-C, pull this update, then run:

```bash
cd /opt/observer
git pull --ff-only
npm run db:migrate
npm run db:status
```

Migration `004-system-observers.js` adds `cpu`, `processes`, and `memory` metrics,
initially disabled. It preserves existing rows, settings, and observations.
The migration command uses DB_MIGRATION_SECRET_ARN. The service uses DB_SECRET_ARN.
If you previously exported the migration ARN as DB_SECRET_ARN in your shell,
run `unset DB_SECRET_ARN` so the runtime uses the value in the configuration file.

Add to `/etc/observer/.env`:

```dotenv
OBSERVER_CPU_ENABLED=true
OBSERVER_PROCESSES_ENABLED=true
OBSERVER_MEMORY_ENABLED=true
CPU_HIGH_PERCENT=90
CPU_RECOVERY_PERCENT=80
MEMORY_HIGH_PERCENT=90
MEMORY_RECOVERY_PERCENT=80
PROCESSES_HIGH_PERCENT=50
PROCESSES_RECOVERY_PERCENT=30
SYSTEM_TRIGGER_SAMPLES=2
SYSTEM_RECOVERY_SAMPLES=2
PROCESSES_TOP_N=10
PROCESSES_SCAN_LIMIT=4096
PROCESSES_SCAN_BUDGET_MS=1000
PENDING_SAMPLE_LIMIT=960
```

Through your database client:

```sql
UPDATE observer.metrics SET active=1
WHERE metric IN ('cpu', 'processes', 'memory');
```

Both the environment switch and metrics.active must be enabled. Database settings
are refreshed during the loop without restarting. Environment changes need restart.
Each metric uses SAMPLE_INTERVAL_SECONDS (default 15) unless its database
sampling_interval_seconds overrides it. Different intervals run independently.
On database settings errors, the last valid settings are used and samples are
marked settingsCached. After a long sampling delay, consecutive counters reset.

Run `npm start` as ubuntu and let it sample for about a minute; then Ctrl-C.
CPU and processes have an initial `warming` sample, followed by interval readings.
Do not generate artificial CPU/memory load on the live website for this check.

```sql
SELECT o.observed_at, m.metric, o.payload
FROM observer.observations o JOIN observer.metrics m ON m.id=o.metric_id
WHERE m.metric IN ('cpu','processes','memory')
ORDER BY o.observed_at DESC LIMIT 12;
```

## What the measurements mean

CPU busyPercent is user + nice + system + IRQ + soft IRQ time as a percentage of
all logical CPUs, measured between reads of /proc/stat. Guest time is not added
again. I/O wait and steal are recorded separately, as are load averages and the
runnable task count. A counter reset, hotplug change, or decrease in I/O wait
starts a new baseline rather than producing an invalid percentage. Cloud CPU
credit depletion is not measured here; that requires AWS metrics.

Memory usedPercent is `(MemTotal - MemAvailable) / MemTotal * 100`; available
memory includes reclaimable cache. Samples include available bytes, swap total,
swap used bytes and percent. Zero swap total means no swap configured. This
version does not collect swap-in/out rates, PSI, or kernel OOM events.

Processes record top N by interval CPU share and top N by RSS, with PID, parent
PID/name, command name, state, and start-time ticks. CPU is percent of **total host
capacity**: one saturated thread on a four-vCPU host is approximately 25%, not
100%. A process incident defaults to one process consuming 50% of host capacity;
aggregate PHP worker pressure is caught by the host CPU observer. RSS can include
shared memory and must not be summed as a unique host memory total.

Linux command names can be truncated (normally 15 bytes); they identify programs
but may not identify a PHP script. Full argv is omitted because it can include
passwords/tokens. PHP slow logs or application logs are needed for script-level
attribution. Processes that exit entirely between samples may be missed. New or
reused PIDs warm up before receiving a CPU rate; PID start-time prevents reuse
from producing a spike. Restricted /proc visibility limits the evidence.

Process scans have a 4,096 PID cap and a one-second soft time budget, checked
between reads. A truncated/denied/failed scan reports partial coverage. Such a
sample can trigger on a known high value but cannot declare recovery. Unknown
CPU values for new processes also prevent recovery for that sample. Defaults can
be tuned after inspecting scanMilliseconds, processCount, denied and truncated.

## Incidents and retention

Each metric independently opens an incident after two high samples and recovers
after two complete low samples. Thresholds can be overridden in metrics.thresholds
using high_percent, recovery_percent, trigger_samples and recovery_samples.
Disable/re-enable, restart, missing readings and dropped samples reset consecutive
counters; open incidents retain their IDs until actual recovery is observed.

With processes enabled, CPU, memory and Apache samples include the most recent
process snapshot and its timestamp, at most two process intervals old. Null means
no enabled/fresh snapshot. CPU/process summaries show top CPU consumers; memory
summaries show top RSS consumers. These are correlations, not proof of causation.
Routine samples live in observations (default one hour); incident_evidence keeps
pre-trigger and ongoing snapshots independently (resolved incident retention seven
days). Open incidents are retained until resolved. The same bounded on-disk retry
queue handles DB outages; 960 samples approximates one hour for four collectors
at 15 seconds, subject to its four-MiB byte cap. Dropped samples are logged.

Incident summaries are available via `npm run report` and operational JSON logs.
Email delivery and systemd installation are still separate work.

Local verification uses fixtures for Linux counters and bounded scans, plus
temporary local MariaDB schemas for migrations, deduplication, recovery and
retained process evidence. Integration tests never load `/etc/observer/.env` and
reject explicit RDS mode. Live Ubuntu verification remains a deployment step.

Counter definitions: [Linux proc documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [process stat fields](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html).
