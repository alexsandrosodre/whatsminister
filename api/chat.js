const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
}

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

  await ensureSchema();

  if (req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://localhost');
      const threadId = clampInt(u.searchParams.get('threadId'), 1, Number.MAX_SAFE_INTEGER);
      const sinceId = clampInt(u.searchParams.get('sinceId'), 0, Number.MAX_SAFE_INTEGER);
      const limit = clampInt(u.searchParams.get('limit'), 1, 200) || 60;
      if (!threadId) return sendJson(res, 400, { ok: false, error: 'missing_thread_id' });

      const ok = await isMember(threadId, user.username);
      if (!ok) return sendJson(res, 403, { ok: false, error: 'forbidden' });

      const participantsResult = await sql`
        SELECT u.username, u.profile_photo
        FROM chat_thread_members tm
        JOIN users u ON LOWER(u.username) = LOWER(tm.username)
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
          LEFT JOIN users u ON LOWER(u.username) = LOWER(m.sender_username)
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
          LEFT JOIN users u ON LOWER(u.username) = LOWER(m.sender_username)
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
      const threadId = clampInt(body.threadId, 1, Number.MAX_SAFE_INTEGER);
      const text = String(body.text || '').trim();
      if (!threadId) return sendJson(res, 400, { ok: false, error: 'missing_thread_id' });
      if (!text) return sendJson(res, 400, { ok: false, error: 'missing_text' });
      if (text.length > 2000) return sendJson(res, 400, { ok: false, error: 'text_too_long' });

      const ok = await isMember(threadId, user.username);
      if (!ok) return sendJson(res, 403, { ok: false, error: 'forbidden' });

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
        message: {
          id: Number(row.id),
          threadId,
          sender: String(row.sender_username),
          senderPhoto,
          text: String(row.text),
          createdAt: row.created_at,
          readBy: [user.username]
        }
      });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST']);
};
