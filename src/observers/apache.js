import { open, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Common/combined formats. Extra combined fields are accepted but not retained.
const linePattern = /^\S+ \S+ \S+ \[[^\]]+\] "((?:[^"\\]|\\.)*)" (\d{3}) (\d+|-)(?:\s|$)/;
export function parseAccessLine(line) {
  const match = linePattern.exec(line);
  if (!match) return null;
  const request = /^(\S+) (\S+) HTTP\/\S+$/.exec(match[1]);
  if (!request) return null;
  let target = request[2];
  if (/^https?:\/\//i.test(target)) {
    try { target = new URL(target).pathname; } catch { return null; }
  }
  // Do not retain query strings, fragments, client IPs, referrers or user agents.
  const pathname = target.split(/[?#]/, 1)[0].slice(0, 160);
  return { path: pathname, status: Number(match[2]), bytes: match[3] === '-' ? 0 : Number(match[3]) };
}

export class LogTail {
  constructor(file, { maxReadBytes = 1048576, maxLineBytes = 16384 } = {}) {
    Object.assign(this, { file, maxReadBytes, maxLineBytes });
    this.offset = 0; this.partial = Buffer.alloc(0); this.marker = Buffer.alloc(0);
    this.discardLine = false; this.handle = null; this.started = false;
  }
  async attach(atEnd) {
    const handle = await open(this.file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) { await handle.close(); throw new Error('Apache log is not a regular file'); }
    this.handle = handle; this.identity = `${info.dev}:${info.ino}`;
    this.offset = atEnd ? info.size : 0; this.partial = Buffer.alloc(0); this.discardLine = false;
    await this.rememberMarker();
    if (atEnd && this.marker.length && this.marker.at(-1) !== 10) this.discardLine = true;
  }
  async rememberMarker() {
    const length = Math.min(64, this.offset);
    this.marker = Buffer.alloc(length);
    if (length) await this.handle.read(this.marker, 0, length, this.offset - length);
  }
  async prime() { await this.attach(true); this.started = true; }
  async read() {
    if (!this.handle) { await this.prime(); return { lines: [], skippedLines: 0, bytesRead: 0, complete: false, reset: true }; }
    let info = await this.handle.stat();
    let reset = false;
    if (this.marker.length) {
      const check = Buffer.alloc(this.marker.length);
      const { bytesRead } = await this.handle.read(check, 0, check.length, Math.max(0, this.offset - check.length));
      // Detect copytruncate even if it regrew past the previous offset.
      if (info.size < this.offset || bytesRead !== check.length || !check.equals(this.marker)) {
        this.offset = 0; this.partial = Buffer.alloc(0); this.discardLine = false; reset = true;
      }
    }
    const pathname = await stat(this.file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const rotated = pathname && `${pathname.dev}:${pathname.ino}` !== this.identity;
    const partialBeforeRead = this.partial;
    const discardBeforeRead = this.discardLine;
    const chunks = [];
    let budget = this.maxReadBytes;
    let complete = Boolean(pathname) && !rotated;
    for (let pass = 0; pass < 2; pass++) {
      info = await this.handle.stat();
      const length = Math.min(budget, Math.max(0, info.size - this.offset));
      if (length) {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await this.handle.read(buffer, 0, length, this.offset);
        this.offset += bytesRead; budget -= bytesRead; chunks.push(buffer.subarray(0, bytesRead));
      }
      if (this.offset < info.size) { complete = false; break; }
      if (pass === 0 && rotated) {
        // Drain the renamed descriptor before opening its replacement.
        // A leftover unterminated old line cannot be joined to the new file.
        chunks.push(Buffer.from('\n'));
        await this.handle.close(); this.handle = null;
        await this.attach(false);
        if (!budget) { complete = false; break; }
      } else break;
    }
    await this.rememberMarker();
    this.discardLine = discardBeforeRead;
    const buffer = Buffer.concat([partialBeforeRead, ...chunks]);
    const lines = [];
    let start = 0, skippedLines = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 10) continue;
      const length = i - start;
      if (this.discardLine || length > this.maxLineBytes) { skippedLines++; this.discardLine = false; }
      else if (length) lines.push(buffer.subarray(start, i).toString('utf8').replace(/\r$/, ''));
      start = i + 1;
    }
    const rest = buffer.subarray(start);
    if (rest.length > this.maxLineBytes || this.discardLine) {
      this.partial = Buffer.alloc(0); this.discardLine = true;
    } else this.partial = Buffer.from(rest);
    return { lines, skippedLines, bytesRead: this.maxReadBytes - budget, complete: complete && !reset, reset };
  }
  async close() { if (this.handle) await this.handle.close(); this.handle = null; }
}

export class ApacheObserver {
  constructor(file, options) { this.tail = new LogTail(file, options); this.last = null; }
  async prime() { await this.tail.prime(); this.last = performance.now(); }
  async sample() {
    const now = performance.now();
    const elapsedSeconds = this.last === null ? 0 : (now - this.last) / 1000;
    const batch = await this.tail.read(); this.last = now;
    let requests = 0, malformed = batch.skippedLines, errors4xx = 0, errors5xx = 0;
    const paths = new Map();
    let otherPaths = 0;
    for (const line of batch.lines) {
      const parsed = parseAccessLine(line);
      if (!parsed) { malformed++; continue; }
      requests++;
      if (parsed.status >= 400 && parsed.status < 500) errors4xx++;
      if (parsed.status >= 500) errors5xx++;
      if (paths.has(parsed.path) || paths.size < 100) paths.set(parsed.path, (paths.get(parsed.path) || 0) + 1);
      else otherPaths++;
    }
    return {
      status: 'ok', requests, elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      requestsPerSecond: elapsedSeconds > 0 ? Number((requests / elapsedSeconds).toFixed(3)) : null,
      errors4xx, errors5xx, malformedLines: malformed, bytesRead: batch.bytesRead,
      complete: batch.complete && malformed === 0 && elapsedSeconds > 0,
      rotationOrTruncationGap: batch.reset,
      topPaths: [...paths].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([path, count]) => ({ path, count })),
      otherPathRequests: otherPaths,
    };
  }
  async close() { await this.tail.close(); }
}
