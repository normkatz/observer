import crypto from 'node:crypto';
import { integer } from './config/observer.js';
import { systemConfig, systemKinds, systemThresholds } from './config/system.js';
import { SystemObserver } from './observers/system.js';

export class SystemRuntime {
  constructor(config, { env = process.env, sampler } = {}) {
    this.config = config; this.env = env; this.options = systemConfig(env);
    this.sampler = sampler || new SystemObserver(this.options);
    this.entries = new Map(); this.latestProcesses = null;
    this.runId = crypto.randomUUID();
  }
  async settings(pool) {
    if (!systemKinds.some(kind => this.options.enabled[kind])) return;
    const rows = await pool.query("SELECT * FROM metrics WHERE metric IN ('cpu','processes','memory')");
    for (const kind of systemKinds) {
      if (!this.options.enabled[kind]) continue;
      const matches = rows.filter(row => row.metric === kind);
      if (matches.length !== 1) throw new Error(`Expected one ${kind} metric; apply migration 004`);
      const row = matches[0];
      const thresholds = systemThresholds(kind, typeof row.thresholds === 'string' ? JSON.parse(row.thresholds) : row.thresholds || {}, this.env);
      const interval = integer(row.sampling_interval_seconds ?? this.config.sampleSeconds, 15, `${kind} interval`, 1, 3600) * 1000;
      let entry = this.entries.get(kind);
      if (!entry) entry = { sequence: 0, due: performance.now(), enabled: false };
      const enabled = Boolean(row.active);
      if (entry.enabled !== enabled || entry.interval !== interval) {
        this.sampler.reset(kind); entry.sequence++; entry.due = performance.now();
        if (kind === 'processes') this.latestProcesses = null;
      }
      Object.assign(entry, { enabled, interval, metricId: row.id, thresholds });
      this.entries.set(kind, entry);
    }
  }
  nextDelay() {
    return Math.max(1, Math.min(Infinity, ...[...this.entries.values()].filter(e => e.enabled).map(e => e.due - performance.now())));
  }
  processSnapshot() {
    const entry = this.entries.get('processes');
    if (!entry?.enabled || !this.latestProcesses || Date.now() - Date.parse(this.latestProcesses.observedAt) > entry.interval * 2) return null;
    return this.latestProcesses;
  }
  async collect(queue, logger, settingsCached = false) {
    // Processes first so simultaneous CPU/memory samples retain the same process evidence.
    for (const kind of ['processes', 'cpu', 'memory']) {
      const entry = this.entries.get(kind);
      if (!entry?.enabled || entry.due > performance.now()) continue;
      const started = performance.now();
      const observedAt = new Date().toISOString();
      const sample = { ...await this.sampler.sample(kind), kind, settingsCached };
      // A delayed loop must not turn sparse samples into a sustained threshold breach.
      if (started - entry.due > entry.interval) entry.sequence++;
      entry.due = performance.now() + entry.interval;
      if (kind === 'processes') this.latestProcesses = { ...sample, observedAt };
      else sample.processSnapshot = this.processSnapshot();
      const dropped = await queue.add({ key: crypto.randomUUID(), kind, runId: this.runId, sequence: ++entry.sequence,
        metricId: entry.metricId, host: this.config.host, observedAt, sample, thresholds: entry.thresholds });
      if (dropped) logger.warn({ dropped }, 'Pending sample limit reached; oldest samples discarded');
      logger.info({ metric: kind, status: sample.status, complete: sample.complete,
        percent: sample.busyPercent ?? sample.usedPercent ?? sample.maxCpuPercent }, 'System sample');
    }
  }
}
