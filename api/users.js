const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAdmin } = require('./_utils/auth');
const { hashPassword } = require('./_utils/security');

module.exports = async (req, res) => {
  const admin = await requireAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  if (req.method === 'GET') {
    const result = await sql`SELECT id, username, is_admin, created_at FROM users ORDER BY id DESC;`;
    return sendJson(res, 200, { ok: true, users: result.rows });
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '').trim();
      const isAdmin = Boolean(body.isAdmin);
      if (!username || !password) return sendJson(res, 400, { ok: false, error: 'missing_fields' });

      const { salt, hash } = hashPassword(password);
      const created = await sql`
        INSERT INTO users (username, password_salt, password_hash, is_admin)
        VALUES (${username}, ${salt}, ${hash}, ${isAdmin})
        RETURNING id, username, is_admin, created_at;
      `;
      return sendJson(res, 200, { ok: true, user: created.rows[0] });
    } catch (e) {
      const msg = String(e && e.message ? e.message : '');
      if (msg.includes('duplicate') || msg.includes('unique')) {
        return sendJson(res, 409, { ok: false, error: 'username_taken' });
      }
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST']);
};

