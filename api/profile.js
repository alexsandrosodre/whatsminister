const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

module.exports = async (req, res) => {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  if (req.method === 'GET') {
    const existing = await sql`
      SELECT username, profile_photo
      FROM users
      WHERE LOWER(username) = ${String(user.username || '').trim().toLowerCase()}
      ORDER BY id DESC
      LIMIT 1;
    `;
    const row = existing.rows[0] || null;
    return sendJson(res, 200, { ok: true, profile: { username: user.username, photo: row ? row.profile_photo : '' } });
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const photo = typeof body.photo === 'string' ? body.photo.trim() : '';
      if (photo && !photo.startsWith('data:image/')) return sendJson(res, 400, { ok: false, error: 'invalid_photo' });
      if (photo.length > 600_000) return sendJson(res, 400, { ok: false, error: 'photo_too_large' });

      await sql`
        UPDATE users
        SET profile_photo = ${photo}
        WHERE LOWER(username) = ${String(user.username || '').trim().toLowerCase()};
      `;

      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'PUT']);
};

