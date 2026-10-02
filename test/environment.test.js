import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvironment } from '../scripts/start.mjs';

test('loader reports fallback without values and preserves shell > alternate > local precedence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observer-env-'));
  try {
    const alternate = path.join(root, 'alternate.env');
    const messages = [];
    await writeFile(alternate, 'DB_NAME=observer\nPASSWORD="do-not-print"\n');
    const env = {};
    await loadEnvironment({ root, alternate, env, log: message => messages.push(message) });
    assert.equal(env.DB_NAME, 'observer');
    assert.match(messages[0], /not found in project root.*Checking alternate location/);
    assert.ok(messages.includes(`Loaded configuration: ${alternate}`));
    assert.ok(!messages.join('\n').includes('do-not-print'));
    await writeFile(path.join(root, '.env'), 'DB_NAME=local\nLOCAL_ONLY=yes\nSHELL_VALUE=file\n');
    const inherited = { SHELL_VALUE: 'shell' };
    await loadEnvironment({ root, alternate, env: inherited, log() {} });
    assert.equal(inherited.DB_NAME, 'observer');
    assert.equal(inherited.LOCAL_ONLY, 'yes');
    assert.equal(inherited.SHELL_VALUE, 'shell');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('loader tolerates absent files but fails on unreadable configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observer-env-'));
  try {
    const alternate = path.join(root, 'missing');
    const messages = [];
    await loadEnvironment({ root, alternate, env: {}, log: message => messages.push(message) });
    assert.match(messages.at(-1), /No configuration file loaded/);
    await mkdir(path.join(root, '.env'));
    await assert.rejects(loadEnvironment({ root, alternate, env: {}, log() {} }), /Cannot read configuration/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
