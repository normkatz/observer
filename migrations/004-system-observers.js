export async function up({ context: db }) {
  for (const [metric, description] of [
    ['cpu', 'Linux interval CPU usage, load, I/O wait and steal time'],
    ['processes', 'Linux top processes by interval CPU share and resident memory'],
    ['memory', 'Linux available memory and swap utilization'],
  ]) {
    await db.query(`INSERT INTO metrics(metric, active, description)
      SELECT ?, 0, ? WHERE NOT EXISTS (SELECT 1 FROM metrics WHERE metric=?)`,
    [metric, description, metric]);
  }
}
