import { advance, summary } from '../incidents/apache.js';
import * as systemDetector from '../incidents/system.js';
import { normalizeSample } from '../samples.js';
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
export async function loadApacheMetric(pool) {
  const rows = await pool.query("SELECT * FROM metrics WHERE metric='apache_access_log'");
  if (rows.length !== 1) throw new Error('Expected exactly one apache_access_log metric; run migrations or remove duplicate definitions');
  return { ...rows[0], thresholds: rows[0].thresholds === null ? {} : decode(rows[0].thresholds) };
}
export async function saveSample(pool, item) {
  // Accept queued samples from before the common metric field was introduced.
  const metric = item.metric || item.kind || item.sample.metric || 'apache_access_log';
  const detector = ['cpu', 'processes', 'memory'].includes(metric) ? systemDetector : { advance, summary };
  const sample = normalizeSample(metric, item.sample);
  const db = await pool.getConnection();
  const observedAt = new Date(item.observedAt);
  try {
    await db.beginTransaction();
    const previous = await db.query('SELECT id FROM observations WHERE sample_key=?', [item.key]);
    if (previous.length) { await db.rollback(); return null; }
    await db.query(`INSERT INTO observations(metric_id, host, observed_at, payload, sample_key)
      VALUES (?,?,?,?,?)`, [item.metricId, item.host, observedAt, JSON.stringify(sample), item.key]);
    await db.query(`INSERT IGNORE INTO detector_states(metric_id,host,state) VALUES (?,?,'{}')`, [item.metricId, item.host]);
    const [saved] = await db.query('SELECT state FROM detector_states WHERE metric_id=? AND host=? FOR UPDATE', [item.metricId, item.host]);
    let before = decode(saved.state);
    // Do not bridge missing time, configuration changes, restarts, or dropped queued samples.
    if (before.runId !== item.runId || before.sequence !== item.sequence - 1 || before.thresholds !== JSON.stringify(item.thresholds)) {
      before = { ...before, high: 0, low: 0 };
    }
    const { state, event } = detector.advance(before, sample, item.thresholds);
    Object.assign(state, { runId: item.runId, sequence: item.sequence, thresholds: JSON.stringify(item.thresholds), lastObservedAt: item.observedAt });
    let text;
    if (event === 'start') {
      text = detector.summary(state, sample);
      const created = await db.query(`INSERT INTO incidents(host,started_at,status,severity,summary)
        VALUES (?,?,'open','warning',?)`, [item.host, observedAt, text]);
      state.incidentId = String(created.insertId);
      state.startedAt = item.observedAt;
      const preceding = await db.query(`SELECT observed_at,payload FROM observations
        WHERE metric_id=? AND host=? AND observed_at>=? AND observed_at<? ORDER BY observed_at DESC LIMIT 20`,
      [item.metricId, item.host, new Date(observedAt.getTime() - 300000), observedAt]);
      for (const row of preceding.reverse()) await db.query(`INSERT INTO incident_evidence(incident_id,metric_id,observed_at,payload) VALUES (?,?,?,?)`,
        [state.incidentId, item.metricId, row.observed_at, JSON.stringify(decode(row.payload))]);
    }
    const incidentId = state.incidentId;
    if (incidentId) {
      await db.query('INSERT INTO incident_evidence(incident_id,metric_id,observed_at,payload) VALUES (?,?,?,?)',
        [incidentId, item.metricId, observedAt, JSON.stringify(sample)]);
      text = detector.summary(state, sample, event === 'recovery');
      if (event === 'recovery') {
        await db.query("UPDATE incidents SET status='resolved',recovered_at=?,summary=? WHERE id=?", [observedAt, text, incidentId]);
        state.incidentId = null; state.high = 0; state.low = 0; state.peakRate = 0;
      } else await db.query('UPDATE incidents SET summary=? WHERE id=?', [text, incidentId]);
    }
    await db.query('UPDATE detector_states SET state=? WHERE metric_id=? AND host=?', [JSON.stringify(state), item.metricId, item.host]);
    await db.commit();
    return event ? { event, incidentId, summary: text, metric } : null;
  } catch (error) {
    await db.rollback().catch(() => {});
    throw error;
  } finally { db.release(); }
}
export async function cleanup(pool, config) {
  const sampleCutoff = new Date(Date.now() - config.retentionSeconds * 1000);
  const incidentCutoff = new Date(Date.now() - config.incidentDays * 86400000);
  // Bound each sweep; slow cleanup catches up over subsequent minutes.
  await pool.query('DELETE FROM observations WHERE observed_at<? ORDER BY observed_at LIMIT 1000', [sampleCutoff]);
  await pool.query("DELETE FROM incidents WHERE status='resolved' AND recovered_at<? ORDER BY recovered_at LIMIT 20", [incidentCutoff]);
}
