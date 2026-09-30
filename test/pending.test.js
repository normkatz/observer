import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PendingSamples } from '../src/storage/pending.js';
test('pending samples survive restart, enforce limits and retry only the uncommitted suffix', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'observer-pending-'));
  try {
    const queue = new PendingSamples(directory, { limit: 2 }); await queue.load();
    for (const key of ['a', 'b', 'c']) await queue.add({ key, sample: {}, observedAt: new Date().toISOString() });
    const restarted = new PendingSamples(directory, { limit: 2 }); await restarted.load();
    assert.deepEqual(restarted.items.map(i => i.key), ['b', 'c']);
    await assert.rejects(restarted.flush(async item => { if (item.key === 'c') throw new Error('DB down'); }));
    const again = new PendingSamples(directory); await again.load();
    assert.deepEqual(again.items.map(i => i.key), ['c']);
    await again.flush(async () => null); assert.equal(again.items.length, 0);
  } finally { await rm(directory, { recursive: true }); }
});
