const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

module.exports = async (req, res) => {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  await ensureSchema();

  try {
    const body = await readJsonBody(req);
    const lastId = Number(body.lastId);
    if (!Number.isFinite(lastId)) return sendJson(res, 400, { ok: false, error: 'missing_last_id' });

    await sql`
      INSERT INTO chat_reads (message_id, username)
      SELECT id, ${user.username}
      FROM chat_messages
      WHERE id <= ${Math.trunc(lastId)}
      ON CONFLICT DO NOTHING;
    `;

    return sendJson(res, 200, { ok: true });
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid_request' });
  }
};

