import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pino from 'pino';
import { createLogger } from './logging.js';
import lockfile from 'proper-lockfile';
import { observerConfig, apacheThresholds, integer } from './config/observer.js';
import { openDatabase } from './storage/database.js';
import { ApacheObserver } from './observers/apache.js';
import { loadApacheMetric, saveSample, cleanup } from './storage/apache.js';
import { PendingSamples } from './storage/pending.js';
import { SystemRuntime } from './system-runtime.js';

let logger = pino({ level: 'info', base: undefined });
let db, release, observer, logOutput;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
try {
  const config = observerConfig();
  const maxSamples = process.env.MAX_SAMPLES ? integer(process.env.MAX_SAMPLES, 0, 'MAX_SAMPLES', 1, 1000000) : Infinity;
  db = await openDatabase();
  const migrations = await db.pool.query("SELECT name FROM schema_migrations WHERE name='003-apache-runtime.js'");
  if (!migrations.length) throw new Error('Run npm run db:migrate before starting the Apache observer');
  const stateDirectory = path.join(config.stateDirectory, db.database, config.host.replace(/[^a-zA-Z0-9_.-]/g, '_'));
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  release = await lockfile.lock(stateDirectory, { retries: 0, stale: 30000 });
  logOutput = await createLogger(config.logDirectory); logger = logOutput.logger;
  const queue = new PendingSamples(stateDirectory, { limit: config.queueLimit, retentionSeconds: config.retentionSeconds });
  const system = new SystemRuntime(config);
  await system.settings(db.pool);
  const expired = await queue.load();
  if (expired) logger.warn({ dropped: expired }, 'Expired pending samples discarded');
  let metric = await loadApacheMetric(db.pool);
  let thresholds = apacheThresholds(metric.thresholds, config.thresholds);
  let sampleSeconds = integer(metric.sampling_interval_seconds ?? config.sampleSeconds, 15, 'sampling interval', 1, 3600);
  let running = false, lastCleanup = 0, settingsKnown = true;
  let sequence = 0, apacheSequence = 0, nextApache = Infinity;
  const runId = crypto.randomUUID();
  logger.info({ host: config.host, log: config.logPath, database: db.database, sampleSeconds }, 'Observer starting; no email will be sent');
  while (!abort.signal.aborted && sequence < maxSamples) {
    try {
      metric = await loadApacheMetric(db.pool);
      await system.settings(db.pool);
      settingsKnown = true;
    } catch (error) {
      settingsKnown = false;
      logger.warn({ error: error.message }, 'Metric settings unavailable; using last valid settings');
    }
    thresholds = apacheThresholds(metric.thresholds, config.thresholds);
    sampleSeconds = integer(metric.sampling_interval_seconds ?? config.sampleSeconds, 15, 'sampling interval', 1, 3600);
    const enabled = config.enabled && Boolean(metric.active);
    if (!enabled) {
      if (observer) await observer.close();
      observer = null;
      nextApache = Infinity;
      if (running) logger.info('Apache observer disabled; open incidents will not be declared recovered');
      running = false;
    } else if (!observer) {
      observer = new ApacheObserver(config.logPath, { maxReadBytes: config.maxReadBytes });
      apacheSequence++;
      nextApache = performance.now() + sampleSeconds * 1000;
      try { await observer.prime(); }
      catch (error) { logger.warn({ code: error.code }, 'Apache log unavailable; will retry'); }
      running = true;
      logger.info({ enabled: true }, 'Apache observer enabled; historical log content skipped');
    }
    const waitMs = Math.max(1, Math.min(config.sampleSeconds * 1000, nextApache - performance.now(), system.nextDelay()));
    try { await delay(waitMs, undefined, { signal: abort.signal }); }
    catch (error) { if (error.name === 'AbortError') break; throw error; }
    sequence++;
    await system.collect(queue, logger, !settingsKnown);
    if (enabled && performance.now() >= nextApache) {
      if (performance.now() - nextApache > sampleSeconds * 1000) apacheSequence++;
      nextApache = performance.now() + sampleSeconds * 1000;
      let sample;
      try { sample = await observer.sample(); }
      catch (error) {
        sample = { status: 'unavailable', complete: false, requestsPerSecond: null, errorCode: error.code || 'READ_ERROR' };
        logger.warn({ code: sample.errorCode }, 'Apache log sample unavailable');
      }
      sample.settingsCached = !settingsKnown;
      sample.processSnapshot = system.processSnapshot();
      const dropped = await queue.add({ key: crypto.randomUUID(), runId, sequence: ++apacheSequence, metricId: metric.id,
        host: config.host, observedAt: new Date().toISOString(), sample, thresholds });
      if (dropped) logger.warn({ dropped }, 'Pending sample limit reached; oldest samples discarded');
      logger.info({ requests: sample.requests, rate: sample.requestsPerSecond, complete: sample.complete }, 'Apache sample');
    }
    try {
      await queue.flush(item => saveSample(db.pool, item), event => logger.warn(event, 'Observer incident'));
      if (Date.now() - lastCleanup >= 60000) { await cleanup(db.pool, config); lastCleanup = Date.now(); }
    } catch (error) { logger.error({ error: error.message, pending: queue.items.length }, 'Database persistence failed; bounded samples retained locally'); }
  }
} catch (error) { logger.error({ error: error.message }, 'Observer stopped'); process.exitCode = 1; }
finally {
  if (observer) await observer.close();
  if (release) await release();
  if (db) await db.pool.end();
  logger.info('Observer shutdown complete');
  if (logOutput) await logOutput.close();
}
