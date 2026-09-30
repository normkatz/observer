import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfig, assertLocalServer } from '../src/config/database.js';

test('rejects production TCP configuration and arbitrary schemas', () => {
  for (const env of [{ DB_HOST: '127.0.0.1' }, { DB_PORT: '3307' }, { DB_NAME: 'civicrm' },
    { DB_SOCKET_PATH: '/tmp/mysql.sock' }, { DATABASE_URL: 'mysql://example' }]) {
    assert.throws(() => databaseConfig(env));
  }
});
test('rejects an unexpected server before migrations can run', () => {
  const row = { port: 3308, data_directory: '/opt/homebrew/var/mariadb/', version: '10.6.28-MariaDB', schema_name: 'observer' };
  assert.doesNotThrow(() => assertLocalServer(row, 'observer'));
  for (const changed of [{ port: 3307 }, { data_directory: '/usr/local/var/mysql/' }, { schema_name: 'civicrm' }]) {
    assert.throws(() => assertLocalServer({ ...row, ...changed }, 'observer'));
  }
});
