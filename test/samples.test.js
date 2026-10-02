import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSample, logSample } from '../src/samples.js';

test('all sample logs share identifiers, status, completeness and measurement names with payloads', () => {
  for (const [metric, measurement, value] of [
    ['apache_access_log', 'requestsPerSecond', 0.4], ['cpu', 'busyPercent', 90],
    ['processes', 'maxCpuPercent', 1.7], ['memory', 'usedPercent', 50],
  ]) {
    const payload = normalizeSample(metric, { status: 'ok', [measurement]: value, complete: true, kind: metric });
    assert.deepEqual(Object.keys(payload).slice(0, 3), ['metric', 'status', 'complete']);
    assert.equal('kind' in payload, false);
    let output, message;
    logSample({ info(fields, msg) { output = fields; message = msg; } }, payload);
    assert.deepEqual(Object.keys(output).slice(0, 3), ['metric', 'status', 'complete']);
    assert.equal(output[measurement], payload[measurement]);
    assert.equal(output.metric, metric);
    assert.equal(message, 'Observer sample');
    assert.equal('rate' in output || 'percent' in output, false);
  }
});

test('warming, unsupported, unavailable and partial samples remain explicit without fabricated values', () => {
  for (const status of ['warming', 'unsupported', 'unavailable', 'ok']) {
    const sample = normalizeSample('processes', { status, complete: false, errorCode: 'EXAMPLE' });
    logSample({ info(fields) {
      assert.equal(fields.status, status);
      assert.equal(fields.complete, false);
      assert.equal(fields.maxCpuPercent, null);
    } }, sample);
    assert.equal(sample.errorCode, 'EXAMPLE');
  }
});
