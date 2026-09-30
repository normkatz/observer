#!/usr/bin/env node
// Standalone Node >=20.3 script; no packages or credentials needed on EC2.
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: node burst.mjs --url http://norm-observer.duckdns.org:8080/ [--rps 10] [--seconds 60] [--concurrency 4]');
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--url', '--rps', '--seconds', '--concurrency'].includes(args[i]) || !args[i + 1] || options[args[i]] !== undefined) {
    console.error('Invalid or duplicate argument. Use --help.'); process.exit(1);
  }
  options[args[i]] = args[i + 1];
}
function number(key, fallback, max) {
  const value = Number(options[key] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${key} must be 1–${max}`);
  return value;
}
try {
  const url = new URL(options['--url']);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !['localhost', '127.0.0.1', '[::1]', 'norm-observer.duckdns.org'].includes(url.hostname)) {
    throw new Error('Use the approved Mac hostname or loopback, without credentials or query strings.');
  }
  const rps = number('--rps', 10, 50), seconds = number('--seconds', 60, 120), concurrency = number('--concurrency', 4, 10);
  const transport = url.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: concurrency });
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  const results = { target: url.origin + url.pathname, requestedRps: rps, durationSeconds: seconds, concurrency, sent: 0, completed: 0, failures: 0, skipped: 0, statuses: {} };
  const active = new Set();
  function send() {
    results.sent++;
    let pending;
    pending = new Promise(resolve => {
      let done = false;
      const finish = success => {
        if (done) return; done = true;
        results[success ? 'completed' : 'failures']++; resolve();
      };
      const request = transport.get(url, { agent, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        headers: { 'User-Agent': 'observer-controlled-burst/1.0' } }, response => {
        results.statuses[response.statusCode] = (results.statuses[response.statusCode] || 0) + 1;
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 65536) request.destroy(new Error('Response exceeds 64 KiB test limit'));
        });
        response.on('end', () => finish(true));
        response.on('error', () => finish(false));
        // No redirects are followed, and no response bodies are stored.
      });
      request.on('error', () => finish(false));
    }).finally(() => active.delete(pending));
    active.add(pending);
  }
  const start = performance.now(), stop = start + seconds * 1000;
  const maxRequests = rps * seconds;
  console.error(`Bounded test: ${rps} requests/sec, ${seconds}s, at most ${maxRequests} requests to ${results.target}`);
  let next = start;
  while (performance.now() < stop && results.sent < maxRequests && !abort.signal.aborted) {
    if (active.size < concurrency) send(); else results.skipped++;
    next = Math.max(next + 1000 / rps, performance.now());
    await delay(Math.max(1, Math.min(next, stop) - performance.now()));
  }
  await Promise.allSettled([...active]);
  agent.destroy();
  results.elapsedSeconds = Number(((performance.now() - start) / 1000).toFixed(2));
  console.log(JSON.stringify(results, null, 2));
  if (results.failures || Object.keys(results.statuses).some(code => Number(code) >= 400)) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
