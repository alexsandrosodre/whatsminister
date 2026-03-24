const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

async function isMember(threadId, username) {
  const result = await sql`
    SELECT 1
    FROM chat_thread_members
    WHERE thread_id = ${threadId} AND LOWER(username) = LOWER(${username})
    LIMIT 1;
  `;
  return Boolean(result.rows[0]);
}

module.exports = async (req, res) => {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  await ensureSchema();

  try {
    const body = await readJsonBody(req);
    const threadId = Number(body.threadId);
    const lastId = Number(body.lastId);
    if (!Number.isFinite(threadId) || threadId <= 0) return sendJson(res, 400, { ok: false, error: 'missing_thread_id' });
    if (!Number.isFinite(lastId)) return sendJson(res, 400, { ok: false, error: 'missing_last_id' });

    const ok = await isMember(Math.trunc(threadId), user.username);
    if (!ok) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    await sql`
      INSERT INTO chat_thread_reads (message_id, username)
      SELECT id, ${user.username}
      FROM chat_thread_messages
      WHERE thread_id = ${Math.trunc(threadId)} AND id <= ${Math.trunc(lastId)}
      ON CONFLICT DO NOTHING;
    `;

    return sendJson(res, 200, { ok: true, threadId: Math.trunc(threadId) });
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid_request' });
  }
};

