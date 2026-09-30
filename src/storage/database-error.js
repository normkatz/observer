// Only fixed explanations leave this boundary; driver messages may contain secrets.
const hints = new Map([
  ['ER_ACCESS_DENIED_ERROR', 'Database login rejected; check the secret credentials and database user host grants.'],
  ['ER_DBACCESS_DENIED_ERROR', 'Database account lacks access to the observer schema.'],
  ['ER_BAD_DB_ERROR', 'The observer schema does not exist on this endpoint.'],
  ['ENOTFOUND', 'RDS hostname could not be resolved. Check DB_ENDPOINT.'],
  ['EAI_AGAIN', 'DNS lookup temporarily failed.'],
  ['ECONNREFUSED', 'Database connection was refused. Check endpoint and port.'],
  ['ETIMEDOUT', 'Connection timed out. Check routing, security groups, and port.'],
  ['ER_CONNECTION_TIMEOUT', 'Connection timed out. Check routing, security groups, and port.'],
  ['ER_GET_CONNECTION_TIMEOUT', 'Connection pool timed out; no database connection became available.'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS hostname verification failed. Check DB_ENDPOINT.'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS certificate chain could not be verified. Check the RDS CA bundle.'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS certificate chain is not trusted. Check the RDS CA bundle.'],
  ['CERT_HAS_EXPIRED', 'A TLS certificate has expired. Check the server certificate and CA bundle.'],
  ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'TLS issuer is not trusted. Check the RDS CA bundle.'],
]);
export function databaseFailure(error, stage) {
  const reasons = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current) && seen.size < 8; current = current.cause) {
    seen.add(current);
    if (hints.has(current.code)) reasons.push(`${current.code}: ${hints.get(current.code)}`);
  }
  return new Error(`RDS check failed during ${stage}. ${reasons.join(' ') || 'No recognized error code; raw error details suppressed.'}`);
}
