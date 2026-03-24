const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

async function ensureDefaultThread() {
  const existing = await sql`SELECT id FROM chat_threads WHERE type = 'group' AND name = 'Geral' ORDER BY id ASC LIMIT 1;`;
  const threadId = existing.rows[0]
    ? Number(existing.rows[0].id)
    : Number(
        (
          await sql`
            INSERT INTO chat_threads (type, name, created_by)
            VALUES ('group', 'Geral', '')
            RETURNING id;
          `
        ).rows[0].id
      );

  const already = await sql`SELECT 1 FROM chat_thread_messages WHERE thread_id = ${threadId} LIMIT 1;`;
  if (!already.rows[0]) {
    const legacy = await sql`SELECT 1 FROM chat_messages LIMIT 1;`;
    if (legacy.rows[0]) {
      await sql`
        INSERT INTO chat_thread_messages (thread_id, sender_username, text, created_at)
        SELECT ${threadId}, sender_username, text, created_at
        FROM chat_messages
        ORDER BY id ASC;
      `;
      await sql`
        INSERT INTO chat_thread_reads (message_id, username, read_at)
        SELECT m.id, u.username, NOW()
        FROM chat_thread_messages m
        CROSS JOIN users u
        WHERE m.thread_id = ${threadId}
        ON CONFLICT DO NOTHING;
      `;
    }
  }

  return threadId;
}

async function requireThreadMember(threadId, username) {
  const result = await sql`
    SELECT 1 FROM chat_thread_members
    WHERE thread_id = ${threadId} AND username = ${username}
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
    const lastId = Number(body.lastId);
    if (!Number.isFinite(lastId)) return sendJson(res, 400, { ok: false, error: 'missing_last_id' });
    const requestedThreadId = Number(body.threadId);

    const defaultThreadId = await ensureDefaultThread();
    await sql`
      INSERT INTO chat_thread_members (thread_id, username)
      SELECT ${defaultThreadId}, username FROM users
      ON CONFLICT DO NOTHING;
    `;

    const threadId = Number.isFinite(requestedThreadId) ? Math.trunc(requestedThreadId) : defaultThreadId;
    const isMember = await requireThreadMember(threadId, user.username);
    if (!isMember) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    await sql`
      INSERT INTO chat_thread_reads (message_id, username)
      SELECT id, ${user.username}
      FROM chat_thread_messages
      WHERE thread_id = ${threadId} AND id <= ${Math.trunc(lastId)}
      ON CONFLICT DO NOTHING;
    `;

    return sendJson(res, 200, { ok: true, threadId });
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid_request' });
  }
};
