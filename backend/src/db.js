const { Pool, types } = require('pg');
const config = require('./config');
const log = require('./logger');

// Return NUMERIC (1700) and BIGINT (20) as JS numbers instead of strings.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (err) => log.error({ err }, 'postgres pool error'));

const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const many = async (text, params) => (await pool.query(text, params)).rows;

// Run fn(client) inside BEGIN/COMMIT; roll back on any error.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function ping() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

module.exports = { pool, query, one, many, tx, ping };
