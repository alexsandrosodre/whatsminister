const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

function normalizeUsername(value) {
  return String(value || '').trim();
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
    const me = String(user.username);
    const result = await sql`
      SELECT
        t.id,
        t.type,
        t.name,
        COALESCE(unread.count, 0)::int AS unread_count,
        other.username AS other_username,
        COALESCE(other.profile_photo, '') AS other_photo
      FROM chat_threads t
      JOIN chat_thread_members tm ON tm.thread_id = t.id AND LOWER(tm.username) = LOWER(${me})
      LEFT JOIN LATERAL (
        SELECT u.username, u.profile_photo
        FROM chat_thread_members tm2
        JOIN users u ON LOWER(u.username) = LOWER(tm2.username)
        WHERE tm2.thread_id = t.id AND LOWER(tm2.username) <> LOWER(${me})
        ORDER BY u.username ASC
        LIMIT 1
      ) other ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS count
        FROM chat_thread_messages m
        WHERE m.thread_id = t.id
          AND LOWER(m.sender_username) <> LOWER(${me})
          AND NOT EXISTS (
            SELECT 1 FROM chat_thread_reads r
            WHERE r.message_id = m.id AND LOWER(r.username) = LOWER(${me})
          )
      ) unread ON true
      ORDER BY t.id DESC;
    `;

    const threads = result.rows.map((r) => ({
      id: Number(r.id),
      type: String(r.type || ''),
      name: String(r.name || ''),
      unreadCount: Number(r.unread_count) || 0,
      otherUsername: r.other_username ? String(r.other_username) : '',
      otherPhoto: r.other_photo ? String(r.other_photo) : ''
    }));

    const totalUnread = threads.reduce((acc, t) => acc + (Number(t.unreadCount) || 0), 0);

    return sendJson(res, 200, { ok: true, totalUnread, threads });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const type = String(body.type || '').trim();

    if (type !== 'dm') return sendJson(res, 400, { ok: false, error: 'invalid_type' });

    const me = String(user.username);
    const other = normalizeUsername(body.otherUsername);
    if (!other) return sendJson(res, 400, { ok: false, error: 'missing_other' });
    if (String(other).toLowerCase() === me.toLowerCase()) return sendJson(res, 400, { ok: false, error: 'invalid_other' });

    const existsOther = await sql`SELECT username FROM users WHERE LOWER(username) = LOWER(${other}) LIMIT 1;`;
    if (!existsOther.rows[0]) return sendJson(res, 404, { ok: false, error: 'user_not_found' });

    const found = await sql`
      SELECT t.id
      FROM chat_threads t
      JOIN chat_thread_members m1 ON m1.thread_id = t.id AND LOWER(m1.username) = LOWER(${me})
      JOIN chat_thread_members m2 ON m2.thread_id = t.id AND LOWER(m2.username) = LOWER(${other})
      WHERE t.type = 'dm'
        AND (SELECT COUNT(*) FROM chat_thread_members mm WHERE mm.thread_id = t.id) = 2
      ORDER BY t.id ASC
      LIMIT 1;
    `;

    if (found.rows[0]) {
      const threadId = Number(found.rows[0].id);
      const ok = await isMember(threadId, me);
      if (!ok) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      return sendJson(res, 200, { ok: true, threadId });
    }

    const created = await sql`
      INSERT INTO chat_threads (type, name, created_by)
      VALUES ('dm', '', ${me})
      RETURNING id;
    `;
    const threadId = Number(created.rows[0].id);

    await sql`
      INSERT INTO chat_thread_members (thread_id, username)
      VALUES (${threadId}, ${me}), (${threadId}, ${other})
      ON CONFLICT DO NOTHING;
    `;

    return sendJson(res, 200, { ok: true, threadId });
  }

  if (req.method === 'DELETE') {
    const u = new URL(req.url, 'http://localhost');
    const threadId = Number(u.searchParams.get('threadId'));
    if (!Number.isFinite(threadId) || threadId <= 0) return sendJson(res, 400, { ok: false, error: 'missing_thread_id' });

    const me = String(user.username);
    const ok = await isMember(Math.trunc(threadId), me);
    if (!ok) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    await sql`
      DELETE FROM chat_thread_members
      WHERE thread_id = ${Math.trunc(threadId)} AND LOWER(username) = LOWER(${me});
    `;

    return sendJson(res, 200, { ok: true });
  }

  return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
};

