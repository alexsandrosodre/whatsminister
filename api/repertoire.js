const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

module.exports = async (req, res) => {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  if (req.method === 'GET') {
    const result = await sql`SELECT id, name, link, lyrics, created_at, updated_at FROM repertoire ORDER BY id DESC;`;
    return sendJson(res, 200, { ok: true, items: result.rows });
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const link = String(body.link || '').trim();
      const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim() : '';
      if (!name || !link) return sendJson(res, 400, { ok: false, error: 'missing_fields' });
      const created = await sql`
        INSERT INTO repertoire (name, link, lyrics)
        VALUES (${name}, ${link}, ${lyrics})
        RETURNING id, name, link, lyrics, created_at, updated_at;
      `;
      return sendJson(res, 200, { ok: true, item: created.rows[0] });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const id = Number(body.id);
      const name = typeof body.name === 'string' ? body.name.trim() : null;
      const link = typeof body.link === 'string' ? body.link.trim() : null;
      const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim() : null;
      if (!Number.isFinite(id)) return sendJson(res, 400, { ok: false, error: 'missing_id' });

      const updated = await sql`
        UPDATE repertoire
        SET
          name = COALESCE(${name}, name),
          link = COALESCE(${link}, link),
          lyrics = COALESCE(${lyrics}, lyrics),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING id, name, link, lyrics, created_at, updated_at;
      `;
      if (updated.rows.length === 0) return sendJson(res, 404, { ok: false, error: 'not_found' });
      return sendJson(res, 200, { ok: true, item: updated.rows[0] });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
};
