import { readFile } from 'node:fs/promises';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { fromInstanceMetadata } from '@aws-sdk/credential-providers';

export function parseDatabaseSecret(value) {
  let secret;
  try { secret = JSON.parse(value); } catch { throw new Error('Database secret must contain JSON username and password fields.'); }
  if (!secret || typeof secret.username !== 'string' || !secret.username.trim() ||
      typeof secret.password !== 'string' || !secret.password) {
    throw new Error('Database secret must contain nonempty username and password strings.');
  }
  // Never accept host/schema overrides from secret contents.
  return { user: secret.username, password: secret.password };
}

export async function rdsCredentials(env, client) {
  const owned = !client;
  client ??= new SecretsManagerClient({ region: env.AWS_REGION,
    credentials: fromInstanceMetadata({ timeout: 2000, maxRetries: 1, ec2MetadataV1Disabled: true }), maxAttempts: 2 });
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: env.DB_SECRET_ARN }),
      { abortSignal: AbortSignal.timeout(15000) });
    return parseDatabaseSecret(result.SecretString);
  } catch {
    // SDK/JSON errors can contain response content; never forward them to logs.
    throw new Error('Unable to read database credentials. Check EC2 role, secret ARN, network access, and JSON username/password fields.');
  } finally { if (owned) client.destroy(); }
}

export async function prepareRdsConfig(config, env, dependencies = {}) {
  let ca;
  try { ca = await (dependencies.readFile || readFile)(env.DB_TLS_CA_FILE, 'utf8'); }
  catch { throw new Error('Unable to read DB_TLS_CA_FILE. Install the RDS CA bundle first.'); }
  const credentials = await rdsCredentials(env, dependencies.client);
  return { ...config, ...credentials, ssl: { ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' } };
}
