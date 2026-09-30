export function databaseConfig(env = process.env) {
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
