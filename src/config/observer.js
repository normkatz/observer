import os from 'node:os';
import path from 'node:path';

export function integer(value, fallback, name, min = 1, max = 86400) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
  return value === 'true';
}
export function apacheThresholds(overrides = {}, defaults = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Apache thresholds must be a JSON object');
  const allowed = ['request_rate', 'recovery_rate', 'trigger_samples', 'recovery_samples'];
  for (const key of Object.keys(overrides)) if (!allowed.includes(key)) throw new Error(`Unknown Apache threshold: ${key}`);
  const result = { request_rate: 5, recovery_rate: 2, trigger_samples: 2, recovery_samples: 2, ...defaults, ...overrides };
  for (const key of ['request_rate', 'recovery_rate']) {
    if (!Number.isFinite(result[key]) || result[key] < 0 || result[key] > 1000000) throw new Error(`Invalid ${key}`);
  }
  if (result.request_rate <= 0 || result.recovery_rate >= result.request_rate) throw new Error('Recovery rate must be below the positive request threshold');
  for (const key of ['trigger_samples', 'recovery_samples']) result[key] = integer(result[key], 2, key, 1, 100);
  return result;
}
export function observerConfig(env = process.env) {
  if (boolean(env.NOTIFICATIONS_ENABLED, false, 'NOTIFICATIONS_ENABLED')) throw new Error('Email delivery is not implemented in the Apache milestone; leave NOTIFICATIONS_ENABLED=false');
  const sampleSeconds = integer(env.SAMPLE_INTERVAL_SECONDS, 15, 'SAMPLE_INTERVAL_SECONDS', 1, 3600);
  const config = {
    host: env.OBSERVER_HOST || os.hostname(),
    enabled: boolean(env.OBSERVER_APACHE_ENABLED, false, 'OBSERVER_APACHE_ENABLED'),
    logPath: env.APACHE_LOG_PATH || '/var/log/apache2/wordpress_access.log',
    stateDirectory: path.resolve(env.STATE_DIRECTORY || 'var/state'),
    logDirectory: path.resolve(env.LOG_DIRECTORY || 'var/log'),
    sampleSeconds,
    retentionSeconds: integer(env.OBSERVATION_RETENTION_SECONDS, 3600, 'OBSERVATION_RETENTION_SECONDS', 60, 604800),
    incidentDays: integer(env.INCIDENT_RETENTION_DAYS, 7, 'INCIDENT_RETENTION_DAYS', 1, 365),
    maxReadBytes: integer(env.APACHE_MAX_READ_BYTES, 1048576, 'APACHE_MAX_READ_BYTES', 1024, 8388608),
    queueLimit: integer(env.PENDING_SAMPLE_LIMIT, 240, 'PENDING_SAMPLE_LIMIT', 1, 3600),
    thresholds: apacheThresholds({}, {
      request_rate: Number(env.APACHE_REQUEST_RATE_THRESHOLD ?? 5),
      recovery_rate: Number(env.APACHE_RECOVERY_RATE_THRESHOLD ?? 2),
      trigger_samples: integer(env.APACHE_TRIGGER_SAMPLES, 2, 'APACHE_TRIGGER_SAMPLES', 1, 100),
      recovery_samples: integer(env.APACHE_RECOVERY_SAMPLES, 2, 'APACHE_RECOVERY_SAMPLES', 1, 100),
    }),
  };
  if (!config.host || config.host.length > 255) throw new Error('OBSERVER_HOST must be 1–255 characters');
  return config;
}
