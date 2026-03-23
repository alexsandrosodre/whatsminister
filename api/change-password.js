const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');
const { verifyPassword, hashPassword } = require('./_utils/security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  try {
    const body = await readJsonBody(req);
    const currentPassword = String(body.currentPassword || '').trim();
    const newPassword = String(body.newPassword || '').trim();
    if (!currentPassword || !newPassword) return sendJson(res, 400, { ok: false, error: 'missing_fields' });
    if (newPassword.length < 6) return sendJson(res, 400, { ok: false, error: 'weak_password' });

    await ensureSchema();
    const existing = await sql`SELECT id, username, password_salt, password_hash FROM users WHERE username = ${user.username} LIMIT 1;`;
    const row = existing.rows[0];
    if (!row) return sendJson(res, 404, { ok: false, error: 'not_found' });

    const valid = verifyPassword(currentPassword, row.password_salt, row.password_hash);
    if (!valid) return sendJson(res, 401, { ok: false, error: 'invalid_credentials' });

    const { salt, hash } = hashPassword(newPassword);
    await sql`
      UPDATE users
      SET
        password_salt = ${salt},
        password_hash = ${hash},
        must_change_password = FALSE
      WHERE id = ${row.id};
    `;

    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: 'server_error', detail: String(e && e.message ? e.message : e) });
  }
};

