// MariaDB DDL auto-commits. Existing tables cause an error rather than
// silently accepting schema drift. Partial failures require reviewed repair.
export async function up({ context: db }) {
  const definitions = [
    ['observations', `
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      metric_id INT NOT NULL,
      observed_at DATETIME(3) NOT NULL,
      host VARCHAR(255) NOT NULL,
      payload JSON NOT NULL,
      INDEX idx_observations_metric_time (metric_id, observed_at),
      INDEX idx_observations_time (observed_at),
      CONSTRAINT fk_observations_metric FOREIGN KEY (metric_id) REFERENCES metrics(id)`],
    ['incidents', `
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      host VARCHAR(255) NOT NULL,
      started_at DATETIME(3) NOT NULL,
      recovered_at DATETIME(3) NULL,
      status ENUM('open','resolved') NOT NULL DEFAULT 'open',
      severity ENUM('warning','critical') NOT NULL,
      summary TEXT NULL,
      INDEX idx_incidents_status_time (status, started_at),
      INDEX idx_incidents_recovery (recovered_at)`],
    ['incident_evidence', `
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      incident_id BIGINT UNSIGNED NOT NULL,
      metric_id INT NULL,
      observed_at DATETIME(3) NOT NULL,
      payload JSON NOT NULL,
      INDEX idx_evidence_incident_time (incident_id, observed_at),
      CONSTRAINT fk_evidence_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
      CONSTRAINT fk_evidence_metric FOREIGN KEY (metric_id) REFERENCES metrics(id)`],
    ['notification_outbox', `
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      incident_id BIGINT UNSIGNED NOT NULL,
      event_key VARCHAR(191) NOT NULL,
      payload JSON NOT NULL,
      status ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      sent_at DATETIME(3) NULL,
      last_error TEXT NULL,
      UNIQUE KEY uq_notification_event (event_key),
      INDEX idx_notification_delivery (status, next_attempt_at),
      CONSTRAINT fk_notification_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE`],
  ];
  for (const [name, definition] of definitions) {
    await db.query(`CREATE TABLE ${name} (${definition})
      ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
}
