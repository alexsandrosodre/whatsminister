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

function normalizeList(list) {
  const set = new Set();
  (Array.isArray(list) ? list : []).forEach((v) => {
    const u = String(v || '').trim();
    if (u) set.add(u);
  });
  return Array.from(set);
}

module.exports = async (req, res) => {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  const defaultThreadId = await ensureDefaultThread();
  await sql`
    INSERT INTO chat_thread_members (thread_id, username)
    SELECT ${defaultThreadId}, username FROM users
    ON CONFLICT DO NOTHING;
  `;

  if (req.method === 'GET') {
    const me = String(user.username);
    const result = await sql`
      SELECT
        t.id,
        t.type,
        t.name,
        COALESCE(unread.count, 0)::int AS unread_count,
        lm.text AS last_text,
        lm.created_at AS last_at,
        other.username AS other_username,
        COALESCE(other.profile_photo, '') AS other_photo
      FROM chat_threads t
      JOIN chat_thread_members tm ON tm.thread_id = t.id AND tm.username = ${me}
      LEFT JOIN LATERAL (
        SELECT m.text, m.created_at
        FROM chat_thread_messages m
        WHERE m.thread_id = t.id
        ORDER BY m.id DESC
        LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT u.username, u.profile_photo
        FROM chat_thread_members tm2
        JOIN users u ON u.username = tm2.username
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
      ORDER BY COALESCE(lm.created_at, t.created_at) DESC;
    `;

    const threads = result.rows.map((r) => ({
      id: Number(r.id),
      type: String(r.type || ''),
      name: String(r.name || ''),
      unreadCount: Number(r.unread_count) || 0,
      lastText: r.last_text ? String(r.last_text) : '',
      lastAt: r.last_at || null,
      otherUsername: r.other_username ? String(r.other_username) : '',
      otherPhoto: r.other_photo ? String(r.other_photo) : ''
    }));

    const totalUnread = threads.reduce((acc, t) => acc + (Number(t.unreadCount) || 0), 0);

    return sendJson(res, 200, { ok: true, defaultThreadId, totalUnread, threads });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const type = String(body.type || '').trim();

    if (type === 'group') {
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing_name' });
      const members = normalizeList(body.members);
      const me = String(user.username);
      if (!members.includes(me)) members.push(me);

      const usersResult = await sql`SELECT username FROM users WHERE username = ANY(${members});`;
      const existing = new Set(usersResult.rows.map((r) => String(r.username)));
      const finalMembers = members.filter((u) => existing.has(u));
      if (finalMembers.length < 2) return sendJson(res, 400, { ok: false, error: 'not_enough_members' });

      const created = await sql`
        INSERT INTO chat_threads (type, name, created_by)
        VALUES ('group', ${name}, ${me})
        RETURNING id;
      `;
      const threadId = Number(created.rows[0].id);

      await sql`
        INSERT INTO chat_thread_members (thread_id, username)
        SELECT ${threadId}, u FROM unnest(${finalMembers}) AS u
        ON CONFLICT DO NOTHING;
      `;

      return sendJson(res, 200, { ok: true, threadId });
    }

    if (type === 'dm') {
      const other = String(body.otherUsername || '').trim();
      if (!other) return sendJson(res, 400, { ok: false, error: 'missing_other' });
      const me = String(user.username);

      const existsOther = await sql`SELECT username FROM users WHERE username = ${other} LIMIT 1;`;
      if (!existsOther.rows[0]) return sendJson(res, 404, { ok: false, error: 'user_not_found' });

      const found = await sql`
        SELECT t.id
        FROM chat_threads t
        JOIN chat_thread_members m1 ON m1.thread_id = t.id AND m1.username = ${me}
        JOIN chat_thread_members m2 ON m2.thread_id = t.id AND m2.username = ${other}
        WHERE t.type = 'dm'
          AND (SELECT COUNT(*) FROM chat_thread_members mm WHERE mm.thread_id = t.id) = 2
        ORDER BY t.id ASC
        LIMIT 1;
      `;
      if (found.rows[0]) return sendJson(res, 200, { ok: true, threadId: Number(found.rows[0].id) });

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

    return sendJson(res, 400, { ok: false, error: 'invalid_type' });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
};
