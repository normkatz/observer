import { Umzug } from 'umzug';
import { fileURLToPath } from 'node:url';

export async function withMigrator(pool, database, action) {
  const connection = await pool.getConnection();
  const lockName = `${database}:schema-migrations`;
  let locked = false;
  try {
    const [result] = await connection.query('SELECT GET_LOCK(?, 5) AS acquired', [lockName]);
    if (Number(result.acquired) !== 1) throw new Error('Another migration process holds the schema lock.');
    locked = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const migrator = new Umzug({
      migrations: { glob: ['*.js', { cwd: fileURLToPath(new URL('../../migrations/', import.meta.url)) }] },
      context: connection,
      storage: {
        async executed() {
          return (await connection.query('SELECT name FROM schema_migrations ORDER BY name')).map(row => row.name);
        },
        async logMigration({ name }) {
          await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [name]);
        },
        async unlogMigration() { throw new Error('Automatic rollback is disabled; use a reviewed forward migration.'); },
      },
      logger: console,
    });
    return await action(migrator);
  } finally {
    try { if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); }
    finally { connection.release(); }
  }
}
