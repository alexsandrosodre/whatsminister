const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
}

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

  await ensureSchema();

  if (req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://localhost');
      const sinceId = clampInt(u.searchParams.get('sinceId'), 0, Number.MAX_SAFE_INTEGER);
      const limit = clampInt(u.searchParams.get('limit'), 1, 200) || 60;
      const requestedThreadId = clampInt(u.searchParams.get('threadId'), 1, Number.MAX_SAFE_INTEGER);

      const defaultThreadId = await ensureDefaultThread();
      await sql`
        INSERT INTO chat_thread_members (thread_id, username)
        SELECT ${defaultThreadId}, username FROM users
        ON CONFLICT DO NOTHING;
      `;

      const threadId = requestedThreadId || defaultThreadId;
      const isMember = await requireThreadMember(threadId, user.username);
      if (!isMember) return sendJson(res, 403, { ok: false, error: 'forbidden' });

      const participantsResult = await sql`
        SELECT u.username, u.profile_photo
        FROM chat_thread_members tm
        JOIN users u ON u.username = tm.username
        WHERE tm.thread_id = ${threadId}
        ORDER BY u.username ASC;
      `;
      const participants = participantsResult.rows.map((r) => ({ username: String(r.username), photo: String(r.profile_photo || '') }));

      let messages = [];
      if (sinceId && sinceId > 0) {
        const result = await sql`
          SELECT
            m.id,
            m.sender_username,
            COALESCE(u.profile_photo, '') AS sender_photo,
            m.text,
            m.created_at,
            COALESCE(array_remove(array_agg(r.username), NULL), '{}'::text[]) AS read_by
          FROM chat_thread_messages m
          LEFT JOIN users u ON u.username = m.sender_username
          LEFT JOIN chat_thread_reads r ON r.message_id = m.id
          WHERE m.thread_id = ${threadId} AND m.id > ${sinceId}
          GROUP BY m.id, u.profile_photo
          ORDER BY m.id ASC
          LIMIT ${limit};
        `;
        messages = result.rows;
      } else {
        const result = await sql`
          SELECT
            m.id,
            m.sender_username,
            COALESCE(u.profile_photo, '') AS sender_photo,
            m.text,
            m.created_at,
            COALESCE(array_remove(array_agg(r.username), NULL), '{}'::text[]) AS read_by
          FROM chat_thread_messages m
          LEFT JOIN users u ON u.username = m.sender_username
          LEFT JOIN chat_thread_reads r ON r.message_id = m.id
          WHERE m.thread_id = ${threadId}
          GROUP BY m.id, u.profile_photo
          ORDER BY m.id DESC
          LIMIT ${limit};
        `;
        messages = result.rows.slice().reverse();
      }

      const unread = await sql`
        SELECT COUNT(*)::int AS count
        FROM chat_thread_messages m
        WHERE m.thread_id = ${threadId}
          AND LOWER(m.sender_username) <> LOWER(${user.username})
          AND NOT EXISTS (
            SELECT 1 FROM chat_thread_reads r
            WHERE r.message_id = m.id AND LOWER(r.username) = LOWER(${user.username})
          );
      `;
      const unreadCount = unread.rows[0] ? Number(unread.rows[0].count) : 0;

      return sendJson(res, 200, {
        ok: true,
        threadId,
        participants,
        unreadCount,
        messages: messages.map((m) => ({
          id: Number(m.id),
          sender: String(m.sender_username || ''),
          senderPhoto: String(m.sender_photo || ''),
          text: String(m.text || ''),
          createdAt: m.created_at,
          readBy: Array.isArray(m.read_by) ? m.read_by.map((x) => String(x)) : []
        }))
      });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: 'missing_text' });
      if (text.length > 2000) return sendJson(res, 400, { ok: false, error: 'text_too_long' });
      const requestedThreadId = clampInt(body.threadId, 1, Number.MAX_SAFE_INTEGER);

      const defaultThreadId = await ensureDefaultThread();
      await sql`
        INSERT INTO chat_thread_members (thread_id, username)
        SELECT ${defaultThreadId}, username FROM users
        ON CONFLICT DO NOTHING;
      `;
      const threadId = requestedThreadId || defaultThreadId;
      const isMember = await requireThreadMember(threadId, user.username);
      if (!isMember) return sendJson(res, 403, { ok: false, error: 'forbidden' });

      const created = await sql`
        INSERT INTO chat_thread_messages (thread_id, sender_username, text)
        VALUES (${threadId}, ${user.username}, ${text})
        RETURNING id, sender_username, text, created_at;
      `;
      const row = created.rows[0];
      const senderPhotoResult = await sql`SELECT profile_photo FROM users WHERE username = ${user.username} LIMIT 1;`;
      const senderPhoto = senderPhotoResult.rows[0] ? String(senderPhotoResult.rows[0].profile_photo || '') : '';
      await sql`
        INSERT INTO chat_thread_reads (message_id, username)
        VALUES (${Number(row.id)}, ${user.username})
        ON CONFLICT DO NOTHING;
      `;
      return sendJson(res, 200, {
        ok: true,
        message: { id: Number(row.id), threadId, sender: String(row.sender_username), senderPhoto, text: String(row.text), createdAt: row.created_at, readBy: [user.username] }
      });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST']);
};
