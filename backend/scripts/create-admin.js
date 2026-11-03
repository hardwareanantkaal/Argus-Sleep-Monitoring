// Create the first staff account (or promote an existing one) with a role,
// Owner by default. The very first admin can't be invited, so this is how
// it is made.
//   ARGUS_ADMIN_PASSWORD='...' node scripts/create-admin.js --name "Devam Gandhi" --phone +919898011223 --country IN
//   options: --role Owner (any staff_roles.name)
// The password is read from ARGUS_ADMIN_PASSWORD, not from the command line,
// so it never lands in shell history. If the phone already has an account it
// keeps its password and just gets the role.
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const config = require('../src/config');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const fullName = arg('name');
  const phone = arg('phone');
  const country = (arg('country', 'IN') || '').toUpperCase();
  const roleName = arg('role', 'Owner');
  const password = process.env.ARGUS_ADMIN_PASSWORD || '';

  if (!fullName || !/^\+[1-9][0-9]{7,14}$/.test(phone || '')) {
    throw new Error('need --name "Full Name" and --phone in E.164 format, e.g. +919898011223');
  }
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('--country must be a 2-letter code, e.g. IN');

  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const role = (await client.query('SELECT id FROM staff_roles WHERE name = $1', [roleName])).rows[0];
    if (!role) throw new Error(`no staff role named "${roleName}"`);

    const existing = (await client.query(
      'SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL', [phone])).rows[0];
    let userId;
    if (existing) {
      userId = existing.id;
      await client.query('UPDATE users SET staff_role_id = $2 WHERE id = $1', [userId, role.id]);
      console.log(`existing account ${phone} now has role ${roleName}`);
    } else {
      if (password.length < 8) throw new Error('set ARGUS_ADMIN_PASSWORD (at least 8 characters) for a new account');
      userId = (await client.query(
        `INSERT INTO users (full_name, phone, country, password_hash, staff_role_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [fullName, phone, country, await bcrypt.hash(password, 11), role.id])).rows[0].id;
      console.log(`created ${roleName} account ${phone}`);
    }
    await client.query(
      `INSERT INTO audit_log (actor_name, action, target_type, target_id, target_label, detail)
       VALUES ('create-admin script', 'team.create_admin', 'user', $1, $2, $3)`,
      [userId, phone, `role ${roleName}`]);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('create-admin failed:', err.message);
  process.exit(1);
});
