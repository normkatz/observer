import { openDatabase } from './database.js';
import { withMigrator } from './migrations.js';
const command = process.argv[2];
let db;
try {
  if (!['check', 'status', 'up'].includes(command)) throw new Error('Expected check, status, or up.');
  const env = command === 'up' && process.env.DB_MIGRATION_SECRET_ARN
    ? { ...process.env, DB_SECRET_ARN: process.env.DB_MIGRATION_SECRET_ARN }
    : process.env;
  db = await openDatabase(env);
  console.log(db.identity);
  if (command === 'check') {
    const tables = await db.pool.query("SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME");
    console.table(tables);
    console.log('Database connection and identity verified; no changes made.');
  } else if (command === 'status') {
    // Status is read-only, including before migration infrastructure exists.
    const rows = await db.pool.query(`SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'`);
    console.table(rows.length ? await db.pool.query('SELECT name, applied_at FROM schema_migrations ORDER BY name') : []);
  } else {
    await withMigrator(db.pool, db.database, migrator => migrator.up());
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { if (db) await db.pool.end(); }
