// Applies database/migrations/*.sql in filename order, once each.
// Each file contains its own BEGIN/COMMIT. Applied files are recorded in
// schema_migrations. Never edit an applied file; add NNN_name.sql instead.
//   node scripts/migrate.js           apply pending migrations
//   node scripts/migrate.js --status  list applied / pending
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../src/config');

async function main() {
  const statusOnly = process.argv.includes('--status');
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    const applied = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));
    const files = fs.readdirSync(config.migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

    for (const file of files) {
      if (applied.has(file)) {
        if (statusOnly) console.log(`applied  ${file}`);
        continue;
      }
      if (statusOnly) {
        console.log(`pending  ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
      console.log(`applying ${file}`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    }
    if (!statusOnly) console.log('migrations up to date');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
