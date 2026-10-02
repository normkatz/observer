export function advance(previous, sample, thresholds) {
  const state = { high: 0, low: 0, incidentId: null, peakRate: 0, ...previous };
  const value = sample.busyPercent ?? sample.usedPercent ?? sample.maxCpuPercent;
  if (sample.status !== 'ok' || !Number.isFinite(value)) {
    state.high = 0; state.low = 0;
    return { state, event: null };
  }
  const high = value >= thresholds.high_percent;
  state.high = high ? state.high + 1 : 0;
  state.low = sample.complete && value <= thresholds.recovery_percent ? state.low + 1 : 0;
  if (!state.incidentId && !high) state.peakRate = 0;
  if ((high || state.incidentId) && value >= state.peakRate) {
    state.peakRate = value;
    state.peakProcesses = (sample.metric ?? sample.kind) === 'memory'
      ? sample.processSnapshot?.topMemory ?? []
      : sample.processSnapshot?.topCpu ?? sample.topCpu ?? [];
  }
  if (!state.incidentId && state.high >= thresholds.trigger_samples) return { state, event: 'start' };
  if (state.incidentId && state.low >= thresholds.recovery_samples) return { state, event: 'recovery' };
  return { state, event: null };
}
export function summary(state, sample, recovered = false) {
  const kind = sample.metric ?? sample.kind;
  const label = { cpu: 'Host CPU utilization', memory: 'Memory use (based on available RAM)', processes: 'Largest process CPU share of host capacity' }[kind];
  const top = state.peakProcesses?.slice(0, 3).map(p => `${p.command} PID ${p.pid} (` +
    (kind === 'memory' ? `${Math.round(p.rssBytes / 1048576)} MiB RSS` : `${p.cpuPercent}% host CPU`) + ')').join(', ');
  return `${label} ${recovered ? 'recovered' : 'exceeded threshold'}. Peak: ${state.peakRate.toFixed(1)}%.` +
    (top ? ` Processes at peak: ${top}.` : '') + ' These measurements show resource pressure, not a proven outage cause.';
}
