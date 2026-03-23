const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { hashPassword, verifyPassword, setCookie, isSecureEnv, createSessionToken } = require('./_utils/security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '').trim();

    if (!username || !password) return sendJson(res, 400, { ok: false, error: 'missing_credentials' });

    await ensureSchema();

    const adminUser = String(process.env.ADMIN_USER || '').trim().toLowerCase();
    const adminPass = String(process.env.ADMIN_PASS || '').trim();

    if (adminUser && adminPass && username === adminUser && password === adminPass) {
      const { salt, hash } = hashPassword(password);
      const upserted = await sql`
        INSERT INTO users (username, password_salt, password_hash, is_admin, must_change_password)
        VALUES (${username}, ${salt}, ${hash}, TRUE, FALSE)
        ON CONFLICT (username) DO UPDATE SET
          password_salt = ${salt},
          password_hash = ${hash},
          is_admin = TRUE,
          must_change_password = FALSE
        RETURNING username, is_admin, must_change_password;
      `;
      const upsertedUser = upserted.rows[0];
      const token = createSessionToken({ username: upsertedUser.username, isAdmin: true });
      setCookie(res, 'wm_session', token, { httpOnly: true, sameSite: 'Lax', secure: isSecureEnv(), maxAge: 60 * 60 * 24 * 7 });
      return sendJson(res, 200, { ok: true, user: { username: upsertedUser.username, isAdmin: true, mustChangePassword: false } });
    }

    const existing = await sql`
      SELECT id, username, password_salt, password_hash, is_admin, must_change_password
      FROM users
      WHERE LOWER(username) = ${username}
      ORDER BY id DESC
      LIMIT 1;
    `;
    const user = existing.rows[0];

    if (!user) {
      return sendJson(res, 401, { ok: false, error: 'invalid_credentials' });
    }

    const valid = verifyPassword(password, user.password_salt, user.password_hash);
    if (!valid) return sendJson(res, 401, { ok: false, error: 'invalid_credentials' });

    const isAdmin = Boolean(user.is_admin);
    let mustChangePassword = Boolean(user.must_change_password);
    if (!isAdmin && password === '123456' && !mustChangePassword) {
      await sql`UPDATE users SET must_change_password = TRUE WHERE id = ${user.id};`;
      mustChangePassword = true;
    }
    const token = createSessionToken({ username: user.username, isAdmin });
    setCookie(res, 'wm_session', token, { httpOnly: true, sameSite: 'Lax', secure: isSecureEnv(), maxAge: 60 * 60 * 24 * 7 });
    return sendJson(res, 200, { ok: true, user: { username: user.username, isAdmin, mustChangePassword } });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: 'server_error', detail: String(e && e.message ? e.message : e) });
  }
};
