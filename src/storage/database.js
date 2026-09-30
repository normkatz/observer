import mariadb from 'mariadb';
import { databaseConfig, assertLocalServer, assertRdsServer } from '../config/database.js';

import { databaseFailure } from './database-error.js';
import { prepareRdsConfig } from './secret.js';

export async function openDatabase(env = process.env) {
  let config = databaseConfig(env);
  const production = env.DB_MODE === 'rds';
  if (production) config = await prepareRdsConfig(config, env);
  const pool = mariadb.createPool(config);
  let stage = 'database connection (secret retrieval succeeded)';
  try {
    const connection = await pool.getConnection();
    try {
      stage = 'server identity query';
      const [identity] = await connection.query(`SELECT VERSION() AS version, @@port AS port,
        @@datadir AS data_directory, DATABASE() AS schema_name, CURRENT_USER() AS account`);
      if (production) {
        stage = 'identity validation: MariaDB 10.6, observer schema, configured port';
        assertRdsServer(identity, config);
        stage = 'TLS session verification';
        const rows = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
        if (!rows[0]?.Value) throw new Error('RDS connection requires TLS.');
        identity.tls = true;
      } else assertLocalServer(identity, config.database);
      return { pool, identity, database: config.database };
    } finally { connection.release(); }
  } catch (error) {
    await pool.end();
    if (production) {
      throw databaseFailure(error, stage);
    }
    throw error;
  }
}
