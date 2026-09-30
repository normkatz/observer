import { integer } from './observer.js';

export const systemKinds = ['cpu', 'processes', 'memory'];
export function systemThresholds(kind, overrides = {}, env = process.env) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error(`${kind} thresholds must be an object`);
  for (const key of Object.keys(overrides)) {
    if (!['high_percent', 'recovery_percent', 'trigger_samples', 'recovery_samples'].includes(key)) throw new Error(`Unknown ${kind} threshold: ${key}`);
  }
  const prefix = kind.toUpperCase();
  const defaults = kind === 'processes' ? [50, 30] : [90, 80];
  const result = { high_percent: Number(env[`${prefix}_HIGH_PERCENT`] ?? defaults[0]),
    recovery_percent: Number(env[`${prefix}_RECOVERY_PERCENT`] ?? defaults[1]),
    trigger_samples: Number(env.SYSTEM_TRIGGER_SAMPLES ?? 2), recovery_samples: Number(env.SYSTEM_RECOVERY_SAMPLES ?? 2), ...overrides };
  if (!Number.isFinite(result.high_percent) || !Number.isFinite(result.recovery_percent) ||
      result.high_percent <= 0 || result.high_percent > 100 || result.recovery_percent < 0 || result.recovery_percent >= result.high_percent) {
    throw new Error(`${kind} requires 0 <= recovery_percent < high_percent <= 100`);
  }
  for (const key of ['trigger_samples', 'recovery_samples']) result[key] = integer(result[key], 2, key, 1, 100);
  return result;
}
export function systemConfig(env = process.env) {
  const enabled = {};
  for (const kind of systemKinds) {
    const value = env[`OBSERVER_${kind.toUpperCase()}_ENABLED`] ?? 'false';
    if (!['true', 'false'].includes(value)) throw new Error(`Invalid ${kind} enable switch`);
    enabled[kind] = value === 'true';
  }
  return { enabled,
    top: integer(env.PROCESSES_TOP_N, 10, 'PROCESSES_TOP_N', 1, 30),
    maxProcesses: integer(env.PROCESSES_SCAN_LIMIT, 4096, 'PROCESSES_SCAN_LIMIT', 10, 50000),
    scanMs: integer(env.PROCESSES_SCAN_BUDGET_MS, 1000, 'PROCESSES_SCAN_BUDGET_MS', 50, 5000) };
}
