const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { hashPassword, verifyPassword, setCookie, isSecureEnv, createSessionToken } = require('./_utils/security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();

    if (!username || !password) return sendJson(res, 400, { ok: false, error: 'missing_credentials' });

    await ensureSchema();

    const existing = await sql`SELECT id, username, password_salt, password_hash, is_admin FROM users WHERE username = ${username} LIMIT 1;`;
    const user = existing.rows[0];

    if (!user) {
      const adminUser = String(process.env.ADMIN_USER || '').trim();
      const adminPass = String(process.env.ADMIN_PASS || '').trim();

      if (adminUser && adminPass && username === adminUser && password === adminPass) {
        const { salt, hash } = hashPassword(password);
        const created = await sql`
          INSERT INTO users (username, password_salt, password_hash, is_admin)
          VALUES (${username}, ${salt}, ${hash}, TRUE)
          RETURNING username, is_admin;
        `;
        const createdUser = created.rows[0];
        const token = createSessionToken({ username: createdUser.username, isAdmin: true });
        setCookie(res, 'wm_session', token, { httpOnly: true, sameSite: 'Lax', secure: isSecureEnv(), maxAge: 60 * 60 * 24 * 7 });
        return sendJson(res, 200, { ok: true, user: { username: createdUser.username, isAdmin: true } });
      }

      return sendJson(res, 401, { ok: false, error: 'invalid_credentials' });
    }

    const valid = verifyPassword(password, user.password_salt, user.password_hash);
    if (!valid) return sendJson(res, 401, { ok: false, error: 'invalid_credentials' });

    const isAdmin = Boolean(user.is_admin);
    const token = createSessionToken({ username: user.username, isAdmin });
    setCookie(res, 'wm_session', token, { httpOnly: true, sameSite: 'Lax', secure: isSecureEnv(), maxAge: 60 * 60 * 24 * 7 });
    return sendJson(res, 200, { ok: true, user: { username: user.username, isAdmin } });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: 'server_error' });
  }
};

