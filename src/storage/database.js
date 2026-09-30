import mariadb from 'mariadb';
import { databaseConfig, assertLocalServer } from '../config/database.js';

export async function openDatabase(env = process.env) {
  const config = databaseConfig(env);
  const pool = mariadb.createPool(config);
  try {
    const connection = await pool.getConnection();
    try {
      const [identity] = await connection.query(`SELECT VERSION() AS version, @@port AS port,
        @@datadir AS data_directory, DATABASE() AS schema_name, CURRENT_USER() AS account`);
      assertLocalServer(identity, config.database);
      return { pool, identity, database: config.database };
    } finally { connection.release(); }
  } catch (error) { await pool.end(); throw error; }
}
