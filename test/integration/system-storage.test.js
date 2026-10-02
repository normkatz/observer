import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/storage/database.js';
import { withMigrator } from '../../src/storage/migrations.js';
import { saveSample, cleanup } from '../../src/storage/apache.js';
import { systemThresholds } from '../../src/config/system.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('system migration preserves settings; CPU/memory/process incidents persist and retain process evidence', async () => {
  assert.notEqual(process.env.DB_MODE, 'rds', 'Integration tests are local only');
  const admin = await openDatabase();
  const name = `observer_test_${randomBytes(8).toString('hex')}`;
  let db;
  try {
    await admin.pool.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    db = await openDatabase({ ...process.env, DB_NAME: name });
    await withMigrator(db.pool, name, runner => runner.up());
    const rows = await db.pool.query("SELECT * FROM metrics WHERE metric IN ('cpu','processes','memory')");
    assert.equal(rows.length, 3); assert.ok(rows.every(row => row.active === 0));
    const { up } = await import('../../migrations/004-system-observers.js');
    await db.pool.query("UPDATE metrics SET active=1,thresholds=? WHERE metric='cpu'", [JSON.stringify({ high_percent: 95 })]);
    await up({ context: db.pool });
    const [cpu] = await db.pool.query("SELECT active FROM metrics WHERE metric='cpu'");
    assert.equal(cpu.active, 1);
    for (const row of rows) {
      const make = (sequence, value, runId = 'first') => ({ metric: row.metric, key: randomUUID(), sequence, runId,
        metricId: row.id, host: 'test', observedAt: new Date(Date.now() - 20000 + sequence * 1000).toISOString(),
        thresholds: systemThresholds(row.metric, {}, {}),
        sample: { metric: row.metric, status: 'ok', complete: true, [row.metric === 'cpu' ? 'busyPercent' : row.metric === 'memory' ? 'usedPercent' : 'maxCpuPercent']: value,
          processSnapshot: { observedAt: new Date().toISOString(), topCpu: [{ command: 'backup', pid: 42, cpuPercent: 90 }],
            topMemory: [{ command: 'backup', pid: 42, rssBytes: 104857600 }] } } });
      assert.equal(await saveSample(db.pool, make(1, 98)), null);
      const high = make(2, 98);
      const opened = await saveSample(db.pool, high);
      assert.equal(opened.event, 'start');
      assert.equal(await saveSample(db.pool, high), null);
      const [stored] = await db.pool.query('SELECT payload FROM observations WHERE sample_key=?', [high.key]);
      const payload = typeof stored.payload === 'string' ? JSON.parse(stored.payload) : stored.payload;
      assert.equal(payload.metric, row.metric);
      assert.equal('kind' in payload, false);
      // Restart preserves incident identity, but resets consecutive recovery samples.
      const queuedLegacy = make(3, 1, 'second');
      queuedLegacy.kind = queuedLegacy.metric; delete queuedLegacy.metric;
      queuedLegacy.sample.kind = queuedLegacy.sample.metric; delete queuedLegacy.sample.metric;
      assert.equal(await saveSample(db.pool, queuedLegacy), null);
      const closed = await saveSample(db.pool, make(4, 1, 'second'));
      assert.equal(closed.event, 'recovery'); assert.equal(closed.incidentId, opened.incidentId);
      assert.match(closed.summary, /backup PID 42/);
    }
    await cleanup(db.pool, { retentionSeconds: 1, incidentDays: 7 });
    const [observations] = await db.pool.query('SELECT COUNT(*) AS n FROM observations');
    assert.equal(Number(observations.n), 0);
    const [evidence] = await db.pool.query('SELECT COUNT(*) AS n FROM incident_evidence');
    assert.equal(Number(evidence.n), 12);
    // Exercise the real entry point as well as the collectors/storage in isolation.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'observer-system-test-'));
    try {
      await db.pool.query("UPDATE metrics SET active=1 WHERE metric IN ('cpu','processes','memory')");
      const result = await promisify(execFile)(process.execPath, ['src/run.js'], { timeout: 15000,
        env: { ...process.env, DB_NAME: name, OBSERVER_HOST: 'runtime-test',
          STATE_DIRECTORY: path.join(directory, 'state'), LOG_DIRECTORY: path.join(directory, 'log'),
          MAX_SAMPLES: '1', SAMPLE_INTERVAL_SECONDS: '1', NOTIFICATIONS_ENABLED: 'false',
          OBSERVER_APACHE_ENABLED: 'false', OBSERVER_CPU_ENABLED: 'true',
          OBSERVER_PROCESSES_ENABLED: 'true', OBSERVER_MEMORY_ENABLED: 'true' } });
      assert.match(result.stdout, /Observer sample/);
      const collected = await db.pool.query("SELECT metric_id FROM observations WHERE host='runtime-test'");
      assert.equal(collected.length, 3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  } finally {
    if (db) await db.pool.end();
    try { await admin.pool.query(`DROP DATABASE IF EXISTS ${name}`); } finally { await admin.pool.end(); }
  }
});
