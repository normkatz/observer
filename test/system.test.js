import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCpu, cpuDelta, parseMemory, parseProcess, rankProcesses, SystemObserver } from '../src/observers/system.js';
import { systemConfig, systemThresholds } from '../src/config/system.js';
import { advance, summary } from '../src/incidents/system.js';
import { SystemRuntime } from '../src/system-runtime.js';

const cpu = (user, idle, extra = '') => `cpu  ${user} 0 0 ${idle} 0 0 0 0 999 999\ncpu0 0\ncpu1 0\n${extra}`;
const stat = (pid, name, ticks, start = 10, rss = 4) => {
  const f = Array(22).fill('0');
  f[0] = 'S'; f[1] = '1'; f[11] = String(ticks); f[19] = String(start); f[21] = String(rss);
  return `${pid} (${name}) ${f.join(' ')}`;
};
test('CPU deltas exclude double-counted guest ticks and separate wait and steal', () => {
  const before = parseCpu(cpu(100, 100));
  assert.equal(cpuDelta(before, parseCpu(cpu(150, 150))).busyPercent, 50);
  assert.equal(cpuDelta(null, before), null);
  assert.equal(cpuDelta(before, parseCpu(cpu(90, 200))), null);
  const result = cpuDelta(before, parseCpu('cpu 120 0 0 150 20 0 0 10\ncpu0 0\ncpu1 0'));
  assert.equal(result.busyPercent, 20);
  assert.equal(result.iowaitPercent, 20);
  assert.equal(result.stealPercent, 10);
  assert.equal(cpuDelta(before, parseCpu('cpu 120 0 0 150 0 0 0 0\ncpu0 0')), null);
});
test('memory uses available memory, distinguishes no swap, and rejects missing data', () => {
  const sample = parseMemory('MemTotal: 1000 kB\nMemFree: 1 kB\nMemAvailable: 600 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
  assert.equal(sample.usedPercent, 40);
  assert.equal(sample.availableBytes, 614400);
  assert.equal(sample.swapUsedPercent, 0);
  assert.throws(() => parseMemory('MemTotal: 1000 kB'));
});
test('process parsing handles spaces/parentheses and PID reuse without false CPU spikes', () => {
  const before = parseProcess(stat(5, 'worker (test)', 100), 4096);
  assert.equal(before.command, 'worker (test)');
  assert.equal(before.rssBytes, 16384);
  const after = parseProcess(stat(5, 'worker (test)', 150), 4096);
  const old = new Map([[5, before]]);
  assert.equal(rankProcesses(old, new Map([[5, after]]), 200, 10).topCpu[0].cpuPercent, 25);
  after.startTicks = '20';
  const reused = rankProcesses(old, new Map([[5, after]]), 200, 10);
  assert.equal(reused.topCpu.length, 0);
  assert.equal(reused.topMemory[0].cpuPercent, null);
});
test('Linux sampler handles warmup, missing processes, permission denial, bounded scans and read failure', async () => {
  let ticks = 100, denied = false, fail = false;
  const sampler = new SystemObserver({ top: 2, maxProcesses: 2, scanMs: 1000 }, {
    platform: 'linux', root: '/fixture', pageSize: 4096,
    list: async () => ['1', '2', '3', 'not-a-pid'],
    read: async file => {
      if (fail) throw new Error('test');
      if (file.endsWith('/stat') && file === '/fixture/stat') return cpu(ticks, ticks);
      if (file === '/fixture/1/stat') return stat(1, 'php-fpm', ticks);
      throw Object.assign(new Error('not readable'), { code: denied ? 'EACCES' : 'ENOENT' });
    },
  });
  assert.equal((await sampler.sample('processes')).status, 'warming');
  ticks += 100;
  const sample = await sampler.sample('processes');
  assert.equal(sample.maxCpuPercent, 50);
  assert.equal(sample.truncated, true);
  assert.equal(sample.complete, false);
  assert.equal(sample.vanished, 1);
  denied = true; ticks += 100;
  assert.equal((await sampler.sample('processes')).denied, 1);
  fail = true;
  assert.equal((await sampler.sample('cpu')).status, 'unavailable');
  assert.equal((await new SystemObserver({}, { platform: 'darwin' }).sample('memory')).status, 'unsupported');
});
test('resource detectors require sustained thresholds and cannot recover from partial/unavailable samples', () => {
  const thresholds = systemThresholds('cpu', {}, {});
  const high = { kind: 'cpu', status: 'ok', complete: true, busyPercent: 95,
    processSnapshot: { topCpu: [{ command: 'backup', pid: 42, cpuPercent: 90 }] } };
  let result = advance({}, high, thresholds);
  assert.equal(result.event, null);
  result = advance(result.state, high, thresholds);
  assert.equal(result.event, 'start');
  result.state.incidentId = '1';
  result = advance(result.state, { ...high, complete: false, busyPercent: 0 }, thresholds);
  assert.equal(result.state.low, 0);
  result = advance(result.state, { status: 'unavailable' }, thresholds);
  assert.equal(result.event, null);
  result = advance(result.state, { ...high, busyPercent: 10 }, thresholds);
  result = advance(result.state, { ...high, busyPercent: 10 }, thresholds);
  assert.equal(result.event, 'recovery');
  assert.match(summary(result.state, high, true), /backup PID 42/);
  assert.throws(() => systemThresholds('cpu', { high_percent: 80, recovery_percent: 90 }, {}));
  assert.equal(systemConfig({}).enabled.cpu, false);
  assert.throws(() => systemConfig({ OBSERVER_MEMORY_ENABLED: 'yes' }));
});
test('runtime respects independent gates, intervals, and resets on disable/re-enable', async () => {
  const rows = ['cpu', 'processes', 'memory'].map((metric, i) => ({ id: i + 1, metric, active: 1, thresholds: null, sampling_interval_seconds: i + 1 }));
  const calls = [], resets = [], items = [];
  const runtime = new SystemRuntime({ host: 'test', sampleSeconds: 15 }, {
    env: { OBSERVER_CPU_ENABLED: 'true', OBSERVER_PROCESSES_ENABLED: 'true', OBSERVER_MEMORY_ENABLED: 'false' },
    sampler: { reset: kind => resets.push(kind), sample: async kind => { calls.push(kind); return { status: 'ok', complete: true, busyPercent: 20, topCpu: [] }; } },
  });
  const pool = { query: async () => rows };
  const queue = { add: async item => { items.push(item); return 0; } };
  const log = { info() {}, warn() {} };
  await runtime.settings(pool); await runtime.collect(queue, log);
  assert.deepEqual(calls, ['processes', 'cpu']);
  assert.ok(items[1].sample.processSnapshot.observedAt);
  await runtime.collect(queue, log); assert.equal(items.length, 2);
  rows[0].active = 0; rows[1].active = 0;
  await runtime.settings(pool); assert.equal(runtime.nextDelay(), Infinity);
  assert.equal(runtime.processSnapshot(), null);
  const seq = items[1].sequence;
  rows[0].active = 1; await runtime.settings(pool); await runtime.collect(queue, log);
  assert.ok(items.at(-1).sequence > seq + 1, 'disabled time breaks detector continuity');
  assert.equal(items.at(-1).sample.processSnapshot, null);
  assert.ok(resets.includes('cpu'));
});
