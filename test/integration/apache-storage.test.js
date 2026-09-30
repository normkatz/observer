import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/storage/database.js';
import { withMigrator } from '../../src/storage/migrations.js';
import { saveSample, cleanup } from '../../src/storage/apache.js';
import { apacheThresholds } from '../../src/config/observer.js';

test('Apache incidents persist across reconnects, deduplicate retries and retain evidence', async () => {
  const admin = await openDatabase();
  const name = `observer_test_${randomBytes(8).toString('hex')}`;
  let db;
  try {
    await admin.pool.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    db = await openDatabase({ ...process.env, DB_NAME: name });
    await withMigrator(db.pool, name, runner => runner.up());
    const [metric] = await db.pool.query("SELECT id FROM metrics WHERE metric='apache_access_log'");
    const item = (sequence, rate, runId = 'run-one') => ({ key: randomUUID(), runId, sequence, metricId: metric.id, host: 'test',
      observedAt: new Date(Date.now() - (20 - sequence) * 1000).toISOString(), thresholds: apacheThresholds(),
      sample: { status: 'ok', complete: true, requestsPerSecond: rate, topPaths: [{ path: '/', count: 10 }] } });
    assert.equal(await saveSample(db.pool, item(1, 10)), null);
    const second = item(2, 12);
    const opened = await saveSample(db.pool, second); assert.equal(opened.event, 'start');
    assert.equal(await saveSample(db.pool, second), null);
    await db.pool.end(); db = await openDatabase({ ...process.env, DB_NAME: name });
    assert.equal(await saveSample(db.pool, item(3, 0, 'run-two')), null);
    const recovered = await saveSample(db.pool, item(4, 0, 'run-two'));
    assert.equal(recovered.event, 'recovery'); assert.equal(recovered.incidentId, opened.incidentId);
    const [incident] = await db.pool.query('SELECT * FROM incidents');
    assert.equal(incident.status, 'resolved'); assert.match(incident.summary, /12.0 requests/); assert.match(incident.summary, /Top paths at peak: \//);
    const [count] = await db.pool.query('SELECT COUNT(*) AS n FROM observations'); assert.equal(Number(count.n), 4);
    await cleanup(db.pool, { retentionSeconds: 1, incidentDays: 7 });
    const [remaining] = await db.pool.query('SELECT COUNT(*) AS n FROM observations'); assert.equal(Number(remaining.n), 0);
    const [evidence] = await db.pool.query('SELECT COUNT(*) AS n FROM incident_evidence'); assert.equal(Number(evidence.n), 4);
    const [state] = await db.pool.query('SELECT state FROM detector_states');
    const decoded = typeof state.state === 'string' ? JSON.parse(state.state) : state.state;
    assert.equal(decoded.incidentId, null);
    // A new process after recovery must allocate a new database incident ID.
    await db.pool.end(); db = await openDatabase({ ...process.env, DB_NAME: name });
    assert.equal(await saveSample(db.pool, item(1, 10, 'run-three')), null);
    const next = await saveSample(db.pool, item(2, 11, 'run-three'));
    assert.equal(next.event, 'start');
    assert.ok(BigInt(next.incidentId) > BigInt(opened.incidentId));
    assert.equal(await saveSample(db.pool, item(3, 0, 'run-three')), null);
    const nextRecovery = await saveSample(db.pool, item(4, 0, 'run-three'));
    assert.equal(nextRecovery.event, 'recovery');
    assert.equal(nextRecovery.incidentId, next.incidentId);
    const all = await db.pool.query('SELECT id,status FROM incidents ORDER BY id');
    assert.equal(all.length, 2);
    assert.ok(all.every(row => row.status === 'resolved'));
  } finally {
    if (db) await db.pool.end();
    try { await admin.pool.query(`DROP DATABASE IF EXISTS ${name}`); } finally { await admin.pool.end(); }
  }
});
