import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../../src/storage/database.js';
import { withMigrator } from '../../src/storage/migrations.js';
import { up as baseline } from '../../migrations/001-metrics-baseline.js';

async function isolatedDatabase(callback) {
  const admin = await openDatabase(); // Guard the server identity before creating anything.
  const name = `observer_test_${randomBytes(8).toString('hex')}`;
  let db;
  try {
    await admin.pool.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    db = await openDatabase({ ...process.env, DB_NAME: name });
    await callback(db);
  } finally {
    if (db) await db.pool.end();
    try { await admin.pool.query(`DROP DATABASE IF EXISTS ${name}`); }
    finally { await admin.pool.end(); }
  }
}

for (const existing of [false, true]) {
  test(`migrations: ${existing ? 'existing metrics baseline' : 'fresh database'}`, async () => {
    await isolatedDatabase(async db => {
      if (existing) {
        await baseline({ context: db.pool });
        await db.pool.query("INSERT INTO metrics(metric,active) VALUES ('apache_access_log',0)");
      }
      await withMigrator(db.pool, db.database, runner => runner.up());
      const repeated = await withMigrator(db.pool, db.database, runner => runner.up());
      assert.equal(repeated.length, 0);
      if (existing) {
        const [row] = await db.pool.query('SELECT * FROM metrics');
        assert.equal(row.active, 0);
        assert.equal(row.metric, 'apache_access_log');
      }
      const metric = await db.pool.query("INSERT INTO metrics(metric) VALUES ('test')");
      await assert.rejects(db.pool.query('UPDATE metrics SET sampling_interval_seconds=0 WHERE id=?', [metric.insertId]));
      await assert.rejects(db.pool.query('UPDATE metrics SET thresholds=? WHERE id=?', ['invalid json', metric.insertId]));
      await assert.rejects(db.pool.query("INSERT INTO observations(metric_id,observed_at,host,payload) VALUES (-1,UTC_TIMESTAMP(3),'test','{}')"));
      await db.pool.query("INSERT INTO observations(metric_id,observed_at,host,payload) VALUES (?,UTC_TIMESTAMP(3),'test',?)", [metric.insertId, JSON.stringify({ message: 'Unicode 🔎' })]);
      const incident = await db.pool.query("INSERT INTO incidents(host,started_at,severity) VALUES ('test',UTC_TIMESTAMP(3),'warning')");
      await db.pool.query("INSERT INTO incident_evidence(incident_id,metric_id,observed_at,payload) VALUES (?,?,UTC_TIMESTAMP(3),'{}')", [incident.insertId, metric.insertId]);
      await db.pool.query('DELETE FROM observations');
      const [evidence] = await db.pool.query('SELECT COUNT(*) AS count FROM incident_evidence');
      assert.equal(Number(evidence.count), 1, 'incident evidence survives routine sample deletion');
      await db.pool.query("INSERT INTO notification_outbox(incident_id,event_key,payload) VALUES (?,'start:1','{}')", [incident.insertId]);
      await assert.rejects(db.pool.query("INSERT INTO notification_outbox(incident_id,event_key,payload) VALUES (?,'start:1','{}')", [incident.insertId]));
    });
  });
}
test('baseline refuses an incompatible existing table', async () => {
  await isolatedDatabase(async db => {
    await db.pool.query('CREATE TABLE metrics(id INT)');
    await assert.rejects(withMigrator(db.pool, db.database, runner => runner.up()), /baseline/);
    const [row] = await db.pool.query('SELECT COUNT(*) AS count FROM schema_migrations');
    assert.equal(Number(row.count), 0);
  });
});
