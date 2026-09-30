import { openDatabase } from './storage/database.js';
let db;
try {
  db = await openDatabase();
  const incidents = await db.pool.query(`SELECT id,host,started_at,recovered_at,status,summary FROM incidents ORDER BY id DESC LIMIT 5`);
  if (!incidents.length) console.log('No incidents recorded.');
  for (const row of incidents) {
    console.log(`\nIncident ${row.id} — ${row.status} — ${row.host}`);
    console.log(`Started: ${row.started_at.toISOString()}${row.recovered_at ? `; recovered: ${row.recovered_at.toISOString()}` : ''}`);
    console.log(row.summary);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (db) await db.pool.end(); }
