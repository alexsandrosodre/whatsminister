const { ensureSchema, sql } = require('./_utils/db');
const { sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

module.exports = async (req, res) => {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  await ensureSchema();

  const result = await sql`
    SELECT username, profile_photo
    FROM users
    WHERE LOWER(username) <> LOWER(${user.username})
    ORDER BY username ASC;
  `;
  const contacts = result.rows.map((r) => ({ username: String(r.username), photo: String(r.profile_photo || '') }));

  return sendJson(res, 200, { ok: true, contacts });
};

