const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
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

      const usersResult = await sql`SELECT username FROM users ORDER BY id ASC;`;
      const participants = usersResult.rows.map((r) => String(r.username));

      let messages = [];
      if (sinceId && sinceId > 0) {
        const result = await sql`
          SELECT
            m.id,
            m.sender_username,
            m.text,
            m.created_at,
            COALESCE(array_remove(array_agg(r.username), NULL), '{}'::text[]) AS read_by
          FROM chat_messages m
          LEFT JOIN chat_reads r ON r.message_id = m.id
          WHERE m.id > ${sinceId}
          GROUP BY m.id
          ORDER BY m.id ASC
          LIMIT ${limit};
        `;
        messages = result.rows;
      } else {
        const result = await sql`
          SELECT
            m.id,
            m.sender_username,
            m.text,
            m.created_at,
            COALESCE(array_remove(array_agg(r.username), NULL), '{}'::text[]) AS read_by
          FROM chat_messages m
          LEFT JOIN chat_reads r ON r.message_id = m.id
          GROUP BY m.id
          ORDER BY m.id DESC
          LIMIT ${limit};
        `;
        messages = result.rows.slice().reverse();
      }

      const unread = await sql`
        SELECT COUNT(*)::int AS count
        FROM chat_messages m
        WHERE m.sender_username <> ${user.username}
          AND NOT EXISTS (
            SELECT 1 FROM chat_reads r
            WHERE r.message_id = m.id AND r.username = ${user.username}
          );
      `;
      const unreadCount = unread.rows[0] ? Number(unread.rows[0].count) : 0;

      return sendJson(res, 200, {
        ok: true,
        participants,
        unreadCount,
        messages: messages.map((m) => ({
          id: Number(m.id),
          sender: String(m.sender_username || ''),
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

      const created = await sql`
        INSERT INTO chat_messages (sender_username, text)
        VALUES (${user.username}, ${text})
        RETURNING id, sender_username, text, created_at;
      `;
      const row = created.rows[0];
      await sql`
        INSERT INTO chat_reads (message_id, username)
        VALUES (${Number(row.id)}, ${user.username})
        ON CONFLICT DO NOTHING;
      `;
      return sendJson(res, 200, {
        ok: true,
        message: { id: Number(row.id), sender: String(row.sender_username), text: String(row.text), createdAt: row.created_at, readBy: [user.username] }
      });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST']);
};
