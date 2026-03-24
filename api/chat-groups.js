const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAdmin } = require('./_utils/auth');

function normalizeList(list) {
  const set = new Set();
  (Array.isArray(list) ? list : []).forEach((v) => {
    const u = String(v || '').trim();
    if (u) set.add(u);
  });
  return Array.from(set);
}

module.exports = async (req, res) => {
  const user = await requireAdmin(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  if (req.method === 'GET') {
    const groups = await sql`
      SELECT id, name, created_by, created_at
      FROM chat_threads
      WHERE type = 'group'
      ORDER BY id DESC;
    `;
    const members = await sql`
      SELECT tm.thread_id, tm.username, COALESCE(u.profile_photo, '') AS photo
      FROM chat_thread_members tm
      LEFT JOIN users u ON u.username = tm.username
      WHERE tm.thread_id = ANY(${groups.rows.map((g) => Number(g.id))});
    `;

    const byThread = new Map();
    members.rows.forEach((r) => {
      const tid = Number(r.thread_id);
      if (!byThread.has(tid)) byThread.set(tid, []);
      byThread.get(tid).push({ username: String(r.username), photo: String(r.photo || '') });
    });

    return sendJson(res, 200, {
      ok: true,
      groups: groups.rows.map((g) => ({
        id: Number(g.id),
        name: String(g.name || ''),
        createdBy: String(g.created_by || ''),
        createdAt: g.created_at,
        members: byThread.get(Number(g.id)) || []
      }))
    });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
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

  return methodNotAllowed(res, ['GET', 'POST']);
};

