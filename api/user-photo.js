const { ensureSchema, sql } = require('./_utils/db');
const { sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAdmin } = require('./_utils/auth');

module.exports = async (req, res) => {
  const admin = await requireAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  await ensureSchema();

  try {
    const u = new URL(req.url, 'http://localhost');
    const id = Number(u.searchParams.get('id'));
    if (!Number.isFinite(id)) return sendJson(res, 400, { ok: false, error: 'missing_id' });

    const result = await sql`SELECT id, username, profile_photo FROM users WHERE id = ${id} LIMIT 1;`;
    const row = result.rows[0];
    if (!row) return sendJson(res, 404, { ok: false, error: 'not_found' });

    return sendJson(res, 200, { ok: true, user: { id: row.id, username: row.username, photo: row.profile_photo || '' } });
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid_request' });
  }
};

