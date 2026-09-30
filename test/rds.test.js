import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfig, assertRdsServer } from '../src/config/database.js';
import { parseDatabaseSecret, prepareRdsConfig, rdsCredentials } from '../src/storage/secret.js';
const env = { DB_MODE: 'rds', DB_NAME: 'observer', AWS_REGION: 'us-east-1',
  DB_ENDPOINT: 'observer.abcdef.us-east-1.rds.amazonaws.com',
  DB_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:observer/database-AbCdEf',
  DB_TLS_CA_FILE: '/etc/observer/rds-ca.pem' };

test('RDS mode is explicit and restricts destination/schema and credential sources', () => {
  const config = databaseConfig(env);
  assert.equal(config.host, env.DB_ENDPOINT);
  assert.equal(config.port, 3306);
  for (const change of [{ DB_MODE: '' }, { DB_NAME: 'wordpress' }, { DB_ENDPOINT: 'localhost' },
    { DB_SECRET_ARN: 'arn:aws:rds:wrong' }, { DB_PASSWORD: 'secret' }, { DB_SOCKET_PATH: '/tmp/db' },
    { DB_TLS_CA_FILE: '' }, { AWS_REGION: 'us-west-2' }, { DB_PORT: 'NaN' }]) {
    assert.throws(() => databaseConfig({ ...env, ...change }));
  }
  const row = { version: '10.6.25-MariaDB-log', port: 3306, schema_name: 'observer' };
  assert.doesNotThrow(() => assertRdsServer(row, config));
  assert.throws(() => assertRdsServer({ ...row, schema_name: 'wordpress' }, config));
  assert.throws(() => assertRdsServer({ ...row, version: '8.0-MySQL' }, config));
});

test('secret parsing rejects invalid data without echoing it', () => {
  for (const value of ['sensitive-invalid-json', 'null', '{}', '{"username":"x","password":4}']) {
    assert.throws(() => parseDatabaseSecret(value), error => !error.message.includes(value));
  }
  assert.deepEqual(parseDatabaseSecret('{"username":"observer","password":"example","host":"evil"}'),
    { user: 'observer', password: 'example' });
});

test('RDS preparation fetches exact secret and requires verified TLS', async () => {
  let calls = 0;
  const client = { async send(command, options) {
    calls++;
    assert.equal(command.input.SecretId, env.DB_SECRET_ARN);
    assert.ok(options.abortSignal);
    return { SecretString: '{"username":"observer","password":"example","database":"wordpress"}' };
  } };
  const config = await prepareRdsConfig(databaseConfig(env), env, { client, readFile: async () => 'certificate' });
  assert.equal(calls, 1);
  assert.equal(config.database, 'observer');
  assert.equal(config.user, 'observer');
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.minVersion, 'TLSv1.2');
  await assert.rejects(rdsCredentials(env, { send: async () => { throw new Error('PASSWORD_SENTINEL'); } }),
    error => !error.message.includes('PASSWORD_SENTINEL'));
});
