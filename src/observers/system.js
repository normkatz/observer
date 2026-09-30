import { open, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const clean = text => text.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 80);
const round = n => Math.round(n * 100) / 100;
async function readBounded(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw new Error('PROC_FILE_TOO_LARGE');
    return buffer.toString('utf8', 0, bytesRead);
  } finally { await handle.close(); }
}
export function parseCpu(text) {
  const line = text.split('\n').find(line => line.startsWith('cpu '));
  const ticks = line?.trim().split(/\s+/).slice(1, 9).map(Number);
  if (ticks?.length !== 8 || ticks.some(n => !Number.isFinite(n) || n < 0)) throw new Error('INVALID_CPU_COUNTERS');
  return { ticks, cores: text.split('\n').filter(line => /^cpu\d+\s/.test(line)).length };
}
export function cpuDelta(before, after) {
  if (!before || before.cores !== after.cores) return null;
  const delta = after.ticks.map((n, i) => n - before.ticks[i]);
  // Guest ticks are already included in user/nice; only the first eight fields count.
  if (delta.some(n => n < 0)) return null;
  const total = delta.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return { total, busyPercent: round(100 * (delta[0] + delta[1] + delta[2] + delta[5] + delta[6]) / total),
    iowaitPercent: round(100 * delta[4] / total), stealPercent: round(100 * delta[7] / total), cores: after.cores };
}
export function parseMemory(text) {
  const fields = Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+) kB$/gm)].map(m => [m[1], Number(m[2]) * 1024]));
  for (const key of ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']) if (!Number.isFinite(fields[key])) throw new Error('INVALID_MEMORY_COUNTERS');
  if (fields.MemTotal <= 0 || fields.MemAvailable > fields.MemTotal || fields.SwapFree > fields.SwapTotal) throw new Error('INVALID_MEMORY_COUNTERS');
  return { status: 'ok', complete: true, totalBytes: fields.MemTotal, availableBytes: fields.MemAvailable,
    usedPercent: round(100 * (1 - fields.MemAvailable / fields.MemTotal)),
    swapTotalBytes: fields.SwapTotal, swapUsedBytes: fields.SwapTotal - fields.SwapFree,
    swapUsedPercent: fields.SwapTotal ? round(100 * (1 - fields.SwapFree / fields.SwapTotal)) : 0 };
}
export function parseProcess(text, pageSize) {
  const left = text.indexOf('('), right = text.lastIndexOf(')');
  if (left < 1 || right < left) throw new Error('INVALID_PROCESS_STAT');
  const fields = text.slice(right + 2).trim().split(/\s+/);
  const result = { pid: Number(text.slice(0, left).trim()), command: clean(text.slice(left + 1, right)),
    state: fields[0], ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]),
    startTicks: fields[19], rssBytes: Math.max(0, Number(fields[21])) * pageSize };
  if (![result.pid, result.ppid, result.ticks, result.rssBytes].every(Number.isFinite) || !/^\d+$/.test(result.startTicks || '')) throw new Error('INVALID_PROCESS_STAT');
  return result;
}
export function rankProcesses(previous, current, total, top) {
  let comparable = 0;
  const rows = [...current.values()].map(row => {
    const old = previous?.get(row.pid);
    const matched = old && old.startTicks === row.startTicks && row.ticks >= old.ticks && total > 0;
    if (matched) comparable++;
    return { pid: row.pid, ppid: row.ppid, command: row.command, state: row.state, startTicks: row.startTicks,
      parentCommand: current.get(row.ppid)?.command ?? null, rssBytes: row.rssBytes,
      cpuPercent: matched ? round(Math.min(100, 100 * (row.ticks - old.ticks) / total)) : null };
  });
  return { topCpu: rows.filter(row => row.cpuPercent !== null).sort((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid).slice(0, top),
    topMemory: rows.sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid).slice(0, top), comparable };
}

export class SystemObserver {
  constructor(config, { root = '/proc', platform = process.platform, read = readBounded, list = readdir, pageSize } = {}) {
    Object.assign(this, { config, root, platform, read, list, pageSize });
    this.previous = {};
  }
  reset(kind) { delete this.previous[kind]; }
  async sample(kind) {
    if (this.platform !== 'linux') return { status: 'unsupported', complete: false, reason: 'Linux /proc required' };
    try {
      if (kind === 'memory') return parseMemory(await this.read(path.join(this.root, 'meminfo')));
      const cpu = parseCpu(await this.read(path.join(this.root, 'stat')));
      const before = this.previous[kind];
      const delta = cpuDelta(before?.cpu, cpu);
      if (kind === 'cpu') {
        this.previous[kind] = { cpu };
        const load = (await this.read(path.join(this.root, 'loadavg'))).trim().split(/\s+/);
        return delta ? { status: 'ok', complete: true, ...delta, loadAverage: load.slice(0, 3).map(Number), runnable: Number(load[3]?.split('/')[0]) }
          : { status: 'warming', complete: false };
      }
      if (!this.pageSize) {
        const result = await promisify(execFile)('/usr/bin/getconf', ['PAGESIZE'], { timeout: 2000, maxBuffer: 1024 });
        this.pageSize = Number(result.stdout.trim());
        if (!Number.isInteger(this.pageSize) || this.pageSize < 1024) throw new Error('INVALID_PAGE_SIZE');
      }
      const start = performance.now();
      const pids = (await this.list(this.root)).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b));
      const current = new Map();
      let denied = 0, vanished = 0, failed = 0, visited = 0;
      for (const pid of pids.slice(0, this.config.maxProcesses)) {
        if (performance.now() - start >= this.config.scanMs) break;
        visited++;
        try {
          const row = parseProcess(await this.read(path.join(this.root, pid, 'stat')), this.pageSize);
          current.set(row.pid, row);
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') vanished++;
          else if (error.code === 'EACCES' || error.code === 'EPERM') denied++;
          else failed++;
        }
      }
      this.previous[kind] = { cpu, processes: current };
      const ranked = rankProcesses(before?.processes, current, delta?.total, this.config.top);
      const complete = visited === pids.length && !denied && !failed && ranked.comparable === current.size;
      return { status: delta && ranked.comparable ? 'ok' : 'warming', complete,
        ...ranked, maxCpuPercent: ranked.topCpu[0]?.cpuPercent ?? null,
        processCount: pids.length, scanned: current.size, denied, vanished, failed,
        truncated: visited < pids.length, scanMilliseconds: round(performance.now() - start),
        cpuScale: 'percent of total host CPU capacity' };
    } catch (error) {
      this.reset(kind);
      return { status: 'unavailable', complete: false, errorCode: ['EACCES', 'ENOENT', 'EPERM'].includes(error.code) ? error.code : 'PROC_READ_FAILED' };
    }
  }
}
