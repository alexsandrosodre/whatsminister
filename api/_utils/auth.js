const { ensureSchema, sql } = require('./db');
const { parseCookies, verifySessionToken } = require('./security');

async function getUserByUsername(username) {
  await ensureSchema();
  const normalized = String(username || '').trim().toLowerCase();
  const result = await sql`
    SELECT id, username, is_admin, must_change_password
    FROM users
    WHERE LOWER(username) = ${normalized}
    ORDER BY id DESC
    LIMIT 1;
  `;
  return result.rows[0] || null;
}

async function requireAuth(req) {
  const cookies = parseCookies(req);
  const token = cookies.wm_session;
  const session = verifySessionToken(token);
  if (!session) return null;
  const user = await getUserByUsername(session.username);
  if (!user) return null;
  return { username: user.username, isAdmin: Boolean(user.is_admin), mustChangePassword: Boolean(user.must_change_password) };
}

async function requireAdmin(req) {
  const user = await requireAuth(req);
  if (!user) return null;
  if (!user.isAdmin) return null;
  return user;
}

module.exports = { requireAuth, requireAdmin };
