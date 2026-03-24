const { neon } = require('@neondatabase/serverless');

let _sql = null;

function initSql() {
  if (_sql) return _sql;
  const raw =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL;
  if (!raw) throw new Error('Missing DATABASE_URL');
  let cleaned = raw;
  try {
    const u = new URL(raw);
    u.searchParams.delete('channel_binding');
    cleaned = u.toString();
  } catch {}
  _sql = neon(cleaned);
  return _sql;
}

function sql(strings, ...values) {
  return initSql()(strings, ...values).then((rows) => ({ rows }));
}

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      profile_photo TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT NOT NULL DEFAULT '';`;

  await sql`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS repertoire (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      link TEXT NOT NULL,
      lyrics TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`ALTER TABLE repertoire ADD COLUMN IF NOT EXISTS lyrics TEXT NOT NULL DEFAULT '';`;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      sender_username TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_reads (
      message_id INT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, username)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_thread_members (
      thread_id INT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (thread_id, username)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_thread_messages (
      id SERIAL PRIMARY KEY,
      thread_id INT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      sender_username TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_thread_reads (
      message_id INT NOT NULL REFERENCES chat_thread_messages(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, username)
    );
  `;
}

module.exports = { sql, ensureSchema };
