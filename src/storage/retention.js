export async function cleanup(pool, config) {
  const sampleCutoff = new Date(Date.now() - config.retentionSeconds * 1000);
  const incidentCutoff = new Date(Date.now() - config.incidentDays * 86400000);
  // Bound each sweep; slow cleanup catches up over subsequent minutes.
  await pool.query('DELETE FROM observations WHERE observed_at<? ORDER BY observed_at LIMIT 1000', [sampleCutoff]);
  await pool.query("DELETE FROM incidents WHERE status='resolved' AND recovered_at<? ORDER BY recovered_at LIMIT 20", [incidentCutoff]);
}
