const measurements = {
  apache_access_log: ['requests', 'requestsPerSecond'],
  cpu: ['busyPercent'],
  processes: ['maxCpuPercent'],
  memory: ['usedPercent'],
};

export function normalizeSample(metric, sample) {
  if (!Object.hasOwn(measurements, metric)) throw new Error(`Unknown sample metric: ${metric}`);
  const { kind: _legacyKind, metric: _metric, status, complete, ...details } = sample;
  return { metric, status: status ?? 'unavailable', complete: complete === true, ...details };
}

export function logSample(logger, sample) {
  const { metric, status, complete } = sample;
  const fields = { metric, status, complete };
  for (const key of measurements[metric]) fields[key] = sample[key] ?? null;
  logger.info(fields, 'Observer sample');
}
