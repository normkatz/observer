const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

export async function loadApacheMetric(pool) {
  const rows = await pool.query("SELECT * FROM metrics WHERE metric='apache_access_log'");
  if (rows.length !== 1) throw new Error('Expected exactly one apache_access_log metric; run migrations or remove duplicate definitions');
  return { ...rows[0], thresholds: rows[0].thresholds === null ? {} : decode(rows[0].thresholds) };
}
