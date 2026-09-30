import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LogTail, parseAccessLine } from '../src/observers/apache.js';
import { advance } from '../src/incidents/apache.js';
import { apacheThresholds } from '../src/config/observer.js';
const line = (target = '/') => `127.0.0.1 - - [29/Sep/2026:20:00:00 -0700] "GET ${target} HTTP/1.1" 200 191`;
async function fixture(fn, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'observer-tail-'));
  const file = path.join(directory, 'access.log');
  await writeFile(file, line('/old') + '\n');
  const tail = new LogTail(file, options);
  try { await tail.prime(); await fn(tail, file); }
  finally { await tail.close(); await rm(directory, { recursive: true }); }
}
test('parses common and combined format without retaining query strings or user data', () => {
  assert.deepEqual(parseAccessLine(line('/?token=secret')), { path: '/', status: 200, bytes: 191 });
  assert.equal(parseAccessLine(line('/a') + ' "https://private.example" "Secret Agent"').path, '/a');
  assert.equal(parseAccessLine('not an access entry'), null);
  assert.equal(parseAccessLine(line('http://example.com/a?q=secret')).path, '/a');
});
test('starts at EOF and assembles partial lines exactly once', async () => {
  await fixture(async (tail, file) => {
    assert.equal((await tail.read()).lines.length, 0);
    const text = line('/new');
    await appendFile(file, text.slice(0, 20));
    assert.equal((await tail.read()).lines.length, 0);
    await appendFile(file, text.slice(20) + '\n');
    assert.deepEqual((await tail.read()).lines, [text]);
    assert.equal((await tail.read()).lines.length, 0);
  });
});
test('drains renamed file and reads replacement without merging partial lines', async () => {
  await fixture(async (tail, file) => {
    const text = line('/old-final');
    await appendFile(file, text.slice(0, 30)); await tail.read();
    await appendFile(file, text.slice(30) + '\n');
    await rename(file, file + '.1'); await writeFile(file, line('/replacement') + '\n');
    const batch = await tail.read();
    assert.deepEqual(batch.lines, [text, line('/replacement')]);
    assert.equal(batch.complete, false);
    assert.equal((await tail.read()).complete, true);
  });
});
test('detects copytruncate even after regrowth past the previous offset', async () => {
  await fixture(async (tail, file) => {
    await writeFile(file, line('/longer-new-request-than-the-original') + '\n');
    const batch = await tail.read();
    assert.equal(batch.lines.length, 1); assert.equal(batch.reset, true);
    assert.equal(batch.complete, false);
  });
});
test('bounded reads flag backlog and oversized lines are discarded', async () => {
  await fixture(async (tail, file) => {
    await appendFile(file, 'x'.repeat(300) + '\n' + line('/next') + '\n');
    let lines = [], skipped = 0, sawIncomplete = false;
    for (let i = 0; i < 10; i++) {
      const batch = await tail.read(); lines.push(...batch.lines); skipped += batch.skippedLines;
      sawIncomplete ||= !batch.complete;
    }
    assert.deepEqual(lines, [line('/next')]); assert.equal(skipped, 1); assert.equal(sawIncomplete, true);
  }, { maxReadBytes: 64, maxLineBytes: 128 });
});
test('sustained breach, hysteresis and incomplete reads do not falsely recover', () => {
  const thresholds = apacheThresholds();
  const sample = rate => ({ status: 'ok', complete: true, requestsPerSecond: rate, topPaths: [{ path: '/', count: 100 }] });
  let result = advance({}, sample(10), thresholds);
  assert.equal(result.event, null);
  result = advance(result.state, sample(12), thresholds);
  assert.equal(result.event, 'start'); result.state.incidentId = '1';
  result = advance(result.state, { ...sample(0), complete: false }, thresholds);
  assert.equal(result.event, null); assert.equal(result.state.low, 0);
  result = advance(result.state, sample(0), thresholds); assert.equal(result.event, null);
  result = advance(result.state, { status: 'unavailable' }, thresholds); assert.equal(result.state.low, 0);
  result = advance(result.state, sample(0), thresholds); assert.equal(result.event, null);
  result = advance(result.state, sample(0), thresholds); assert.equal(result.event, 'recovery');
  assert.equal(result.state.peakRate, 12);
});
test('rejects misspelled and contradictory threshold configuration', () => {
  assert.throws(() => apacheThresholds({ requestRate: 5 }));
  assert.throws(() => apacheThresholds({ recovery_rate: 6 }));
});
