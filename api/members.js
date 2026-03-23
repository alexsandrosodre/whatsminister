const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAdmin } = require('./_utils/auth');

module.exports = async (req, res) => {
  const admin = await requireAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  if (req.method === 'GET') {
    const result = await sql`SELECT id, name, active, created_at FROM members ORDER BY id DESC;`;
    return sendJson(res, 200, { ok: true, members: result.rows });
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing_name' });
      const created = await sql`INSERT INTO members (name) VALUES (${name}) RETURNING id, name, active, created_at;`;
      return sendJson(res, 200, { ok: true, member: created.rows[0] });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const id = Number(body.id);
      const name = typeof body.name === 'string' ? body.name.trim() : null;
      const active = typeof body.active === 'boolean' ? body.active : null;
      if (!Number.isFinite(id)) return sendJson(res, 400, { ok: false, error: 'missing_id' });

      const updated = await sql`
        UPDATE members
        SET
          name = COALESCE(${name}, name),
          active = COALESCE(${active}, active)
        WHERE id = ${id}
        RETURNING id, name, active, created_at;
      `;
      if (updated.rows.length === 0) return sendJson(res, 404, { ok: false, error: 'not_found' });
      return sendJson(res, 200, { ok: true, member: updated.rows[0] });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
};

