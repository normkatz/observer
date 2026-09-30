export function advance(previous, sample, thresholds) {
  const state = { high: 0, low: 0, incidentId: null, peakRate: 0, ...previous };
  const rate = sample.requestsPerSecond;
  if (sample.status !== 'ok' || !Number.isFinite(rate)) {
    state.high = 0; state.low = 0;
    return { state, event: null };
  }
  const high = rate >= thresholds.request_rate;
  // An incomplete read is a lower bound, enough to trigger but never recover.
  const low = sample.complete && rate <= thresholds.recovery_rate;
  state.high = high ? state.high + 1 : 0;
  state.low = low ? state.low + 1 : 0;
  if ((high || state.incidentId) && rate >= state.peakRate) {
    state.peakRate = rate; state.peakPaths = sample.topPaths || [];
  }
  if (!state.incidentId && !high) state.peakRate = 0;
  if (!state.incidentId && state.high >= thresholds.trigger_samples) return { state, event: 'start' };
  if (state.incidentId && state.low >= thresholds.recovery_samples) return { state, event: 'recovery' };
  return { state, event: null };
}
export function summary(state, sample, recovered = false) {
  const end = recovered ? 'Traffic returned below the recovery threshold.' : 'Apache completed-request traffic exceeded the configured threshold.';
  const paths = state.peakPaths?.map(p => `${p.path} (${p.count})`).join(', ');
  return `${end} Peak observed rate: ${state.peakRate.toFixed(1)} requests/sec.` +
    (paths ? ` Top paths at peak: ${paths}.` : '') +
    ' Access-log evidence alone does not establish CPU saturation or the cause of an outage.';
}
