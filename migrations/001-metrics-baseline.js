export async function up({ context: db }) {
  const tables = await db.query(`SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metrics'`);
  if (!tables.length) {
    await db.query(`CREATE TABLE metrics (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      metric VARCHAR(255) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT 1,
      description VARCHAR(500) NULL,
      sampling_interval_seconds INT UNSIGNED NULL,
      thresholds JSON NULL,
      CONSTRAINT chk_metrics_sampling_interval CHECK
        (sampling_interval_seconds IS NULL OR sampling_interval_seconds > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  const columns = await db.query('SHOW FULL COLUMNS FROM metrics');
  const expected = [
    ['id', 'int(11)', 'NO', 'PRI', null, 'auto_increment'],
    ['metric', 'varchar(255)', 'NO', '', null, ''],
    ['active', 'tinyint(1)', 'NO', '', '1', ''],
    ['description', 'varchar(500)', 'YES', '', 'NULL', ''],
    ['sampling_interval_seconds', 'int(10) unsigned', 'YES', '', 'NULL', ''],
    ['thresholds', 'longtext', 'YES', '', 'NULL', ''],
  ];
  const actual = columns.map(c => [c.Field, c.Type, c.Null, c.Key, c.Default, c.Extra]);
  // MariaDB drivers may represent SQL NULL defaults as null or the string NULL.
  const normalize = rows => rows.map(row => row.map(value => value === 'NULL' ? null : value));
  if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
    throw new Error('metrics does not match the baseline; refusing to overwrite existing structure.');
  }
  const [ddl] = await db.query('SHOW CREATE TABLE metrics');
  const sql = ddl['Create Table'];
  if (!sql.includes('json_valid(`thresholds`)') ||
      !sql.includes('`sampling_interval_seconds` is null or `sampling_interval_seconds` > 0') ||
      !sql.includes('ENGINE=InnoDB') || !sql.includes('DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')) {
    throw new Error('metrics constraints or table defaults do not match the baseline.');
  }
}
