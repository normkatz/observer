import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
const run = args => new Promise(resolve => {
  const child = spawn(process.execPath, ['scripts/burst.mjs', ...args]);
  let output = '', errors = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => errors += data);
  child.on('close', code => resolve({ code, output, errors }));
});
test('burst generator enforces limits and does not follow redirects', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.writeHead(302, { Location: 'http://example.com/' }); res.end('redirect'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const rejected = await run(['--url', url, '--rps', '51']); assert.equal(rejected.code, 1); assert.equal(requests, 0);
    const result = await run(['--url', url, '--rps', '2', '--seconds', '1', '--concurrency', '1']);
    assert.equal(result.code, 0, result.errors);
    const report = JSON.parse(result.output);
    assert.equal(report.sent, 2); assert.equal(report.completed, 2); assert.equal(report.statuses['302'], 2);
    assert.equal(requests, 2);
    const forbidden = await run(['--url', 'https://fjmc.org/']); assert.equal(forbidden.code, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
