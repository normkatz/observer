export async function up({ context: db }) {
  await db.query(`ALTER TABLE observations ADD COLUMN sample_key CHAR(36) NULL,
    ADD UNIQUE KEY uq_observation_sample (sample_key)`);
  await db.query(`CREATE TABLE detector_states (
    metric_id INT NOT NULL,
    host VARCHAR(255) NOT NULL,
    state JSON NOT NULL,
    PRIMARY KEY (metric_id, host),
    CONSTRAINT fk_detector_metric FOREIGN KEY (metric_id) REFERENCES metrics(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // Do not toggle an existing metric or overwrite its user-supplied thresholds.
  await db.query(`INSERT INTO metrics (metric, active, description)
    SELECT 'apache_access_log', 0, 'Completed Apache requests, status counts and top paths'
    WHERE NOT EXISTS (SELECT 1 FROM metrics WHERE metric = 'apache_access_log')`);
}
