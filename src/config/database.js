export function databaseConfig(env = process.env) {
  if (env.DB_MODE === 'rds') return rdsConfig(env);
  if (env.DB_MODE && env.DB_MODE !== 'local') throw new Error('DB_MODE must be local or rds.');
  if (env.DB_ENDPOINT || env.DB_SECRET_ARN) throw new Error('Set DB_MODE=rds explicitly for production.');
  const socketPath = env.DB_SOCKET_PATH || '/opt/homebrew/var/mariadb/mariadb.sock';
  const database = env.DB_NAME || 'observer';
  if (env.DB_HOST || env.DB_PORT || env.DB_PASSWORD || env.DATABASE_URL) {
    throw new Error('This milestone supports local socket authentication only; remove TCP/password settings.');
  }
  if (socketPath !== '/opt/homebrew/var/mariadb/mariadb.sock') {
    throw new Error('Only the dedicated local MariaDB socket is allowed.');
  }
  if (!/^(observer|observer_test_[a-z0-9_]+)$/.test(database)) {
    throw new Error('Only observer or observer_test_* schemas are allowed.');
  }
  return {
    socketPath, database, user: env.DB_USER || 'norm',
    charset: 'utf8mb4', connectionLimit: 2, connectTimeout: 5000,
    acquireTimeout: 10000, queryTimeout: 10000, timezone: '+00:00',
    multipleStatements: false,
  };
}

export function assertLocalServer(row, database) {
  if (Number(row.port) !== 3308 || row.data_directory !== '/opt/homebrew/var/mariadb/' ||
      !row.version.startsWith('10.6.') || !row.version.includes('MariaDB') || row.schema_name !== database) {
    throw new Error('Database identity does not match the approved local MariaDB instance.');
  }
}

function rdsConfig(env) {
  if (env.DB_SOCKET_PATH || env.DB_PASSWORD || env.DATABASE_URL || env.DB_HOST || env.DB_USER) {
    throw new Error('RDS mode requires DB_ENDPOINT and secret credentials; remove local/socket/password settings.');
  }
  if (env.DB_NAME !== 'observer') throw new Error('RDS mode permits only the observer schema.');
  if (env.AWS_REGION !== 'us-east-1') throw new Error('RDS mode requires AWS_REGION=us-east-1.');
  if (!/^[a-z0-9-]+\.[a-z0-9-]+\.us-east-1\.rds\.amazonaws\.com$/.test(env.DB_ENDPOINT || '')) {
    throw new Error('DB_ENDPOINT must be an RDS instance hostname in us-east-1.');
  }
  if (!/^arn:aws:secretsmanager:us-east-1:\d{12}:secret:.+-[A-Za-z0-9]{6}$/.test(env.DB_SECRET_ARN || '')) {
    throw new Error('DB_SECRET_ARN must be a complete Secrets Manager ARN in us-east-1.');
  }
  if (!env.DB_TLS_CA_FILE?.startsWith('/')) throw new Error('DB_TLS_CA_FILE must be an absolute path to the RDS CA bundle.');
  const port = Number(env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DB_PORT.');
  return { host: env.DB_ENDPOINT, port, database: 'observer',
    charset: 'utf8mb4', connectionLimit: 2, connectTimeout: 5000,
    acquireTimeout: 10000, queryTimeout: 10000, timezone: '+00:00', multipleStatements: false };
}

export function assertRdsServer(row, config) {
  if (row.schema_name !== 'observer' || Number(row.port) !== config.port ||
      !row.version.startsWith('10.6.') || !row.version.includes('MariaDB')) {
    throw new Error('RDS database must be MariaDB 10.6 using the observer schema and configured port.');
  }
}
