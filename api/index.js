const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, sendNoContent, methodNotAllowed } = require('./_utils/http');
const { requireAuth, requireAdmin } = require('./_utils/auth');
const { hashPassword, verifyPassword, setCookie, clearCookie, isSecureEnv, createSessionToken } = require('./_utils/security');

function routeFromReq(req) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = String(u.pathname || '');
  if (pathname === '/api/index') {
    const path = String(u.searchParams.get('path') || '').trim();
    return path.startsWith('/') ? path.slice(1) : path;
  }
  if (pathname.startsWith('/api/')) return pathname.slice('/api/'.length);
  return '';
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
}

async function isThreadMember(threadId, username) {
  const result = await sql`
    SELECT 1
    FROM chat_thread_members
    WHERE thread_id = ${threadId} AND LOWER(username) = LOWER(${username})
    LIMIT 1;
  `;
  return Boolean(result.rows[0]);
}

async function handleLogin(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '').trim();

    if (!username || !password) return sendJson(res, 400, { ok: false, error: 'missing_credentials' });

    await ensureSchema();

    const adminUser = String(process.env.ADMIN_USER || '').trim().toLowerCase();
    const adminPass = String(process.env.ADMIN_PASS || '').trim();

    if (adminUser && adminPass && username === adminUser && password === adminPass) {
      const { salt, hash } = hashPassword(password);
      const upserted = await sql`
        INSERT INTO users (username, password_salt, password_hash, is_admin, must_change_password)
        VALUES (${username}, ${salt}, ${hash}, TRUE, FALSE)
        ON CONFLICT (username) DO UPDATE SET
          password_salt = ${salt},
          password_hash = ${hash},
          is_admin = TRUE,
          must_change_password = FALSE
        RETURNING username, is_admin, must_change_password;
      `;
      const upsertedUser = upserted.rows[0];
      const token = createSessionToken({ username: upsertedUser.username, isAdmin: true });
      setCookie(res, 'wm_session', token, { httpOnly: true, sameSite: 'Lax', secure: isSecureEnv(), maxAge: 60 * 60 * 24 * 7 });
      return sendJson(res, 200, { ok: true, user: { username: upsertedUser.username, isAdmin: true, mustChangePassword: false } });
    }

    const existing = await sql`
      SELECT id, username, password_salt, password_hash, is_admin, must_change_password
      FROM users
      WHERE LOWER(username) = ${username}
      ORDER BY id DESC
      LIMIT 1;
    `;
    const user = existing.rows[0];

    if (!user) {
      return sendJson(res, 401, { ok: false, error: 'invalid_credentials' });
    }

    const valid = verifyPassword(password, user.password_salt, user.password_hash);
    if (!valid) return sendJson(res, 401, { ok: false, error: 'invalid_credentials' });

    const isAdmin = Boolean(user.is_admin);
    let mustChangePassword = Boolean(user.must_change_password);
    if (!isAdmin && password === '123456' && !mustChangePassword) {
      await sql`UPDATE users SET must_change_password = TRUE WHERE id = ${user.id};`;
      mustChangePassword = true;
    }
    const token = createSessionToken({ username: user.username, isAdmin });
    setCookie(res, 'wm_session', token, { httpOnly: true, sameSite: 'Lax', secure: isSecureEnv(), maxAge: 60 * 60 * 24 * 7 });
    return sendJson(res, 200, { ok: true, user: { username: user.username, isAdmin, mustChangePassword } });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: 'server_error', detail: String(e && e.message ? e.message : e) });
  }
}

async function handleLogout(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  clearCookie(res, 'wm_session');
  return sendNoContent(res);
}

async function handleMe(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireAuth(req);
    if (!user) return sendJson(res, 200, { ok: true, user: null });
    return sendJson(res, 200, { ok: true, user });
  } catch {
    return sendJson(res, 200, { ok: true, user: null });
  }
}

async function handleUsers(req, res) {
  const admin = await requireAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  if (req.method === 'GET') {
    const result = await sql`SELECT id, username, is_admin, must_change_password, created_at FROM users ORDER BY id DESC;`;
    return sendJson(res, 200, { ok: true, users: result.rows });
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const isAdmin = Boolean(body.isAdmin);
      if (!username) return sendJson(res, 400, { ok: false, error: 'missing_fields' });

      const { salt, hash } = hashPassword('123456');
      const created = await sql`
        INSERT INTO users (username, password_salt, password_hash, is_admin, must_change_password)
        VALUES (${username}, ${salt}, ${hash}, ${isAdmin}, TRUE)
        RETURNING id, username, is_admin, must_change_password, created_at;
      `;
      const createdUser = created.rows[0];

      const existingMember = await sql`
        SELECT id FROM members
        WHERE LOWER(name) = ${username}
        ORDER BY id DESC
        LIMIT 1;
      `;
      if (existingMember.rows.length === 0) {
        await sql`INSERT INTO members (name) VALUES (${username});`;
      }

      return sendJson(res, 200, { ok: true, user: createdUser });
    } catch (e) {
      const msg = String(e && e.message ? e.message : '');
      if (msg.includes('duplicate') || msg.includes('unique')) {
        return sendJson(res, 409, { ok: false, error: 'username_taken' });
      }
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const id = Number(body.id);
      const resetPassword = Boolean(body.resetPassword);
      if (!Number.isFinite(id)) return sendJson(res, 400, { ok: false, error: 'missing_id' });
      if (!resetPassword) return sendJson(res, 400, { ok: false, error: 'invalid_request' });

      const { salt, hash } = hashPassword('123456');
      const updated = await sql`
        UPDATE users
        SET
          password_salt = ${salt},
          password_hash = ${hash},
          must_change_password = TRUE
        WHERE id = ${id}
        RETURNING id, username, is_admin, must_change_password, created_at;
      `;
      if (updated.rows.length === 0) return sendJson(res, 404, { ok: false, error: 'not_found' });
      return sendJson(res, 200, { ok: true, user: updated.rows[0] });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const body = await readJsonBody(req);
      const id = Number(body.id);
      const deleteMember = body.deleteMember !== false;
      if (!Number.isFinite(id)) return sendJson(res, 400, { ok: false, error: 'missing_id' });

      const currentAdmin = await sql`
        SELECT id, username FROM users
        WHERE LOWER(username) = ${String(admin.username || '').trim().toLowerCase()}
        ORDER BY id DESC
        LIMIT 1;
      `;
      const currentAdminId = currentAdmin.rows[0] ? Number(currentAdmin.rows[0].id) : NaN;
      if (Number.isFinite(currentAdminId) && currentAdminId === id) {
        return sendJson(res, 400, { ok: false, error: 'cannot_delete_self' });
      }

      const target = await sql`SELECT id, username, is_admin FROM users WHERE id = ${id} LIMIT 1;`;
      const targetUser = target.rows[0];
      if (!targetUser) return sendJson(res, 404, { ok: false, error: 'not_found' });

      if (Boolean(targetUser.is_admin)) {
        const admins = await sql`SELECT COUNT(*)::int AS count FROM users WHERE is_admin = TRUE;`;
        const count = admins.rows[0] ? Number(admins.rows[0].count) : 0;
        if (count <= 1) return sendJson(res, 400, { ok: false, error: 'cannot_delete_last_admin' });
      }

      await sql`DELETE FROM users WHERE id = ${id};`;

      if (deleteMember) {
        const uname = String(targetUser.username || '').trim().toLowerCase();
        if (uname) {
          await sql`DELETE FROM members WHERE LOWER(name) = ${uname};`;
        }
      }

      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PUT', 'DELETE']);
}

async function handleUserPhoto(req, res) {
  const admin = await requireAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  await ensureSchema();

  try {
    const u = new URL(req.url, 'http://localhost');
    const id = Number(u.searchParams.get('id'));
    if (!Number.isFinite(id)) return sendJson(res, 400, { ok: false, error: 'missing_id' });

    const result = await sql`SELECT id, username, profile_photo FROM users WHERE id = ${id} LIMIT 1;`;
    const row = result.rows[0];
    if (!row) return sendJson(res, 404, { ok: false, error: 'not_found' });

    return sendJson(res, 200, { ok: true, user: { id: row.id, username: row.username, photo: row.profile_photo || '' } });
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid_request' });
  }
}

async function handleProfile(req, res) {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  if (req.method === 'GET') {
    const existing = await sql`
      SELECT username, profile_photo
      FROM users
      WHERE LOWER(username) = ${String(user.username || '').trim().toLowerCase()}
      ORDER BY id DESC
      LIMIT 1;
    `;
    const row = existing.rows[0] || null;
    return sendJson(res, 200, { ok: true, profile: { username: user.username, photo: row ? row.profile_photo : '' } });
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const photo = typeof body.photo === 'string' ? body.photo.trim() : '';
      if (photo && !photo.startsWith('data:image/')) return sendJson(res, 400, { ok: false, error: 'invalid_photo' });
      if (photo.length > 600_000) return sendJson(res, 400, { ok: false, error: 'photo_too_large' });

      await sql`
        UPDATE users
        SET profile_photo = ${photo}
        WHERE LOWER(username) = ${String(user.username || '').trim().toLowerCase()};
      `;

      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'PUT']);
}

async function handleMembers(req, res) {
  const admin = await requireAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  if (req.method === 'GET') {
    const result = await sql`SELECT id, name, active, created_at FROM members ORDER BY id DESC;`;
    return sendJson(res, 200, { ok: true, members: result.rows });
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing_name' });
      const created = await sql`INSERT INTO members (name) VALUES (${name}) RETURNING id, name, active, created_at;`;
      return sendJson(res, 200, { ok: true, member: created.rows[0] });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const id = Number(body.id);
      const name = typeof body.name === 'string' ? body.name.trim() : null;
      const active = typeof body.active === 'boolean' ? body.active : null;
      if (!Number.isFinite(id)) return sendJson(res, 400, { ok: false, error: 'missing_id' });

      const updated = await sql`
        UPDATE members
        SET
          name = COALESCE(${name}, name),
          active = COALESCE(${active}, active)
        WHERE id = ${id}
        RETURNING id, name, active, created_at;
      `;
      if (updated.rows.length === 0) return sendJson(res, 404, { ok: false, error: 'not_found' });
      return sendJson(res, 200, { ok: true, member: updated.rows[0] });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const body = await readJsonBody(req);
      const id = Number(body.id);
      if (!Number.isFinite(id)) return sendJson(res, 400, { ok: false, error: 'missing_id' });
      const deleted = await sql`DELETE FROM members WHERE id = ${id} RETURNING id;`;
      if (deleted.rows.length === 0) return sendJson(res, 404, { ok: false, error: 'not_found' });
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_request' });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PUT', 'DELETE']);
}

async function handleRepertoire(req, res) {
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
}

async function handleChangePassword(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  try {
    const body = await readJsonBody(req);
    const currentPassword = String(body.currentPassword || '').trim();
    const newPassword = String(body.newPassword || '').trim();
    if (!currentPassword || !newPassword) return sendJson(res, 400, { ok: false, error: 'missing_fields' });
    if (newPassword.length < 6) return sendJson(res, 400, { ok: false, error: 'weak_password' });

    await ensureSchema();
    const existing = await sql`SELECT id, username, password_salt, password_hash FROM users WHERE username = ${user.username} LIMIT 1;`;
    const row = existing.rows[0];
    if (!row) return sendJson(res, 404, { ok: false, error: 'not_found' });

    const valid = verifyPassword(currentPassword, row.password_salt, row.password_hash);
    if (!valid) return sendJson(res, 401, { ok: false, error: 'invalid_credentials' });

    const { salt, hash } = hashPassword(newPassword);
    await sql`
      UPDATE users
      SET
        password_salt = ${salt},
        password_hash = ${hash},
        must_change_password = FALSE
      WHERE id = ${row.id};
    `;

    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: 'server_error', detail: String(e && e.message ? e.message : e) });
  }
}

async function handleHealth(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    await ensureSchema();
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: 'db_error', detail: String(e && e.message ? e.message : e) });
  }
}

async function handleContacts(req, res) {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  await ensureSchema();

  const result = await sql`
    SELECT username, profile_photo
    FROM users
    WHERE LOWER(username) <> LOWER(${user.username})
    ORDER BY username ASC;
  `;

  return sendJson(res, 200, {
    ok: true,
    contacts: result.rows.map((r) => ({ username: String(r.username), photo: String(r.profile_photo || '') }))
  });
}

async function handleChatThreads(req, res) {
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
    const other = String(body.otherUsername || '').trim();
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
      const ok = await isThreadMember(threadId, me);
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
    const ok = await isThreadMember(Math.trunc(threadId), me);
    if (!ok) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    await sql`
      DELETE FROM chat_thread_members
      WHERE thread_id = ${Math.trunc(threadId)} AND LOWER(username) = LOWER(${me});
    `;

    return sendJson(res, 200, { ok: true });
  }

  return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
}

async function handleChatGroups(req, res) {
  const user = await requireAdmin(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  await ensureSchema();

  function normalizeList(list) {
    const set = new Set();
    (Array.isArray(list) ? list : []).forEach((v) => {
      const u = String(v || '').trim();
      if (u) set.add(u);
    });
    return Array.from(set);
  }

  async function getGroups() {
    const groups = await sql`
      SELECT id, name, created_by, created_at
      FROM chat_threads
      WHERE type = 'group'
      ORDER BY id DESC;
    `;
    const ids = groups.rows.map((g) => Number(g.id)).filter((x) => Number.isFinite(x));
    if (ids.length === 0) return { groups: [] };

    const members = await sql`
      SELECT tm.thread_id, tm.username, COALESCE(u.profile_photo, '') AS photo
      FROM chat_thread_members tm
      LEFT JOIN users u ON LOWER(u.username) = LOWER(tm.username)
      WHERE tm.thread_id = ANY(${ids})
      ORDER BY tm.thread_id DESC, tm.username ASC;
    `;

    const byThread = new Map();
    members.rows.forEach((r) => {
      const tid = Number(r.thread_id);
      if (!byThread.has(tid)) byThread.set(tid, []);
      byThread.get(tid).push({ username: String(r.username), photo: String(r.photo || '') });
    });

    return {
      groups: groups.rows.map((g) => ({
        id: Number(g.id),
        name: String(g.name || ''),
        createdBy: String(g.created_by || ''),
        createdAt: g.created_at,
        members: byThread.get(Number(g.id)) || []
      }))
    };
  }

  if (req.method === 'GET') {
    const data = await getGroups();
    return sendJson(res, 200, { ok: true, ...data });
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing_name' });
      const me = String(user.username);

      const members = normalizeList(body.members).map((u) => u.toLowerCase());
      if (!members.includes(me.toLowerCase())) members.push(me.toLowerCase());

      const usersResult = await sql`SELECT username FROM users WHERE LOWER(username) = ANY(${members});`;
      const existing = new Set(usersResult.rows.map((r) => String(r.username).toLowerCase()));
      const finalMembers = members.filter((u) => existing.has(u));
      if (finalMembers.length < 2) return sendJson(res, 400, { ok: false, error: 'not_enough_members' });

      const created = await sql`
        INSERT INTO chat_threads (type, name, created_by)
        VALUES ('group', ${name}, ${me})
        RETURNING id;
      `;
      const threadId = Number(created.rows[0].id);

      for (const username of finalMembers) {
        await sql`
          INSERT INTO chat_thread_members (thread_id, username)
          VALUES (${threadId}, ${username})
          ON CONFLICT DO NOTHING;
        `;
      }

      return sendJson(res, 200, { ok: true, threadId });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'server_error', detail: String(e && e.message ? e.message : e) });
    }
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const threadId = Number(body.threadId);
      if (!Number.isFinite(threadId) || threadId <= 0) return sendJson(res, 400, { ok: false, error: 'missing_thread_id' });
      const me = String(user.username);

      const existsGroup = await sql`SELECT id FROM chat_threads WHERE id = ${Math.trunc(threadId)} AND type = 'group' LIMIT 1;`;
      if (!existsGroup.rows[0]) return sendJson(res, 404, { ok: false, error: 'group_not_found' });

      const members = normalizeList(body.members).map((u) => u.toLowerCase());
      if (!members.includes(me.toLowerCase())) members.push(me.toLowerCase());

      const usersResult = await sql`SELECT username FROM users WHERE LOWER(username) = ANY(${members});`;
      const existing = new Set(usersResult.rows.map((r) => String(r.username).toLowerCase()));
      const finalMembers = members.filter((u) => existing.has(u));
      if (finalMembers.length < 2) return sendJson(res, 400, { ok: false, error: 'not_enough_members' });

      await sql`DELETE FROM chat_thread_members WHERE thread_id = ${Math.trunc(threadId)};`;
      for (const username of finalMembers) {
        await sql`
          INSERT INTO chat_thread_members (thread_id, username)
          VALUES (${Math.trunc(threadId)}, ${username})
          ON CONFLICT DO NOTHING;
        `;
      }

      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'server_error', detail: String(e && e.message ? e.message : e) });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
}

async function handleChat(req, res) {
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

      const ok = await isThreadMember(threadId, user.username);
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

      const ok = await isThreadMember(threadId, user.username);
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
}

async function handleChatRead(req, res) {
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

    const ok = await isThreadMember(Math.trunc(threadId), user.username);
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
}

async function handleSchedules(req, res) {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  await ensureSchema();
  const u = new URL(req.url, 'http://localhost');
  const days = Math.min(Math.max(Number(u.searchParams.get('days') || 30), 1), 180);
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(from);
  to.setDate(to.getDate() + days);
  const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  const toStr = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`;

  if (req.method === 'GET') {
    const isAdmin = Boolean((await sql`SELECT is_admin FROM users WHERE LOWER(username) = LOWER(${user.username}) LIMIT 1;`).rows[0]?.is_admin);
    let sched = null;
    if (isAdmin) {
      sched = await sql`SELECT id, date, created_by, created_at FROM schedules WHERE date >= ${fromStr} AND date <= ${toStr} ORDER BY date ASC;`;
    } else {
      sched = await sql`
        SELECT s.id, s.date, s.created_by, s.created_at
        FROM schedules s
        JOIN schedule_members sm ON sm.schedule_id = s.id AND LOWER(sm.username) = LOWER(${user.username})
        WHERE s.date >= ${fromStr} AND s.date <= ${toStr}
        ORDER BY s.date ASC;
      `;
    }
    const ids = sched.rows.map((r) => Number(r.id));
    let members = { rows: [] };
    if (ids.length > 0) {
      members = await sql`
        SELECT sm.schedule_id, sm.username, sm.status, sm.responded_at, COALESCE(u.profile_photo, '') AS photo
        FROM schedule_members sm
        LEFT JOIN users u ON LOWER(u.username) = LOWER(sm.username)
        WHERE sm.schedule_id = ANY(${ids})
        ORDER BY sm.schedule_id ASC, sm.username ASC;
      `;
    }
    const byId = new Map();
    members.rows.forEach((m) => {
      const sid = Number(m.schedule_id);
      if (!byId.has(sid)) byId.set(sid, []);
      byId.get(sid).push({ username: String(m.username), status: String(m.status || 'pending'), photo: String(m.photo || ''), respondedAt: m.responded_at || null });
    });
    const items = sched.rows.map((s) => ({
      id: Number(s.id),
      date: s.date,
      createdBy: String(s.created_by || ''),
      members: byId.get(Number(s.id)) || []
    }));
    return sendJson(res, 200, { ok: true, items });
  }

  if (req.method === 'POST') {
    const admin = await requireAdmin(req);
    if (!admin) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readJsonBody(req);
      const dateStr = String(body.date || '').trim();
      const members = Array.isArray(body.members) ? body.members.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
      if (!dateStr) return sendJson(res, 400, { ok: false, error: 'missing_date' });
      if (members.length === 0) return sendJson(res, 400, { ok: false, error: 'missing_members' });
      const created = await sql`INSERT INTO schedules (date, created_by) VALUES (${dateStr}, ${String(admin.username)}) RETURNING id;`;
      const scheduleId = Number(created.rows[0].id);
      for (const uname of members) {
        await sql`INSERT INTO schedule_members (schedule_id, username, status) VALUES (${scheduleId}, ${uname}, 'pending') ON CONFLICT DO NOTHING;`;
      }
      return sendJson(res, 200, { ok: true, scheduleId });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'server_error', detail: String(e && e.message ? e.message : e) });
    }
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}

async function handleScheduleResponse(req, res) {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  await ensureSchema();
  try {
    const body = await readJsonBody(req);
    const scheduleId = Number(body.scheduleId);
    const action = String(body.action || '').trim().toLowerCase();
    if (!Number.isFinite(scheduleId) || scheduleId <= 0) return sendJson(res, 400, { ok: false, error: 'missing_schedule_id' });
    if (action !== 'accept' && action !== 'decline') return sendJson(res, 400, { ok: false, error: 'invalid_action' });
    const s = await sql`SELECT id, date FROM schedules WHERE id = ${scheduleId} LIMIT 1;`;
    if (!s.rows[0]) return sendJson(res, 404, { ok: false, error: 'not_found' });
    const target = await sql`SELECT username FROM schedule_members WHERE schedule_id = ${scheduleId} AND LOWER(username) = LOWER(${user.username}) LIMIT 1;`;
    if (!target.rows[0]) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    await sql`UPDATE schedule_members SET status = ${action === 'accept' ? 'accepted' : 'declined'}, responded_at = NOW() WHERE schedule_id = ${scheduleId} AND LOWER(username) = LOWER(${user.username});`;
    return sendJson(res, 200, { ok: true });
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid_request' });
  }
}

async function handleMyWeek(req, res) {
  const user = await requireAuth(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  await ensureSchema();
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const mStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  const sStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
  const rows = await sql`
    SELECT sm.status
    FROM schedules s
    JOIN schedule_members sm ON sm.schedule_id = s.id AND LOWER(sm.username) = LOWER(${user.username})
    WHERE s.date >= ${mStr} AND s.date <= ${sStr}
  `;
  const has = rows.rows.some((r) => String(r.status || 'pending') !== 'declined');
  return sendJson(res, 200, { ok: true, scheduledThisWeek: has });
}
module.exports = async (req, res) => {
  const route = routeFromReq(req);

  if (route === 'login') return handleLogin(req, res);
  if (route === 'logout') return handleLogout(req, res);
  if (route === 'me') return handleMe(req, res);
  if (route === 'users') return handleUsers(req, res);
  if (route === 'user-photo') return handleUserPhoto(req, res);
  if (route === 'profile') return handleProfile(req, res);
  if (route === 'members') return handleMembers(req, res);
  if (route === 'repertoire') return handleRepertoire(req, res);
  if (route === 'change-password') return handleChangePassword(req, res);
  if (route === 'health') return handleHealth(req, res);
  if (route === 'contacts') return handleContacts(req, res);
  if (route === 'chat-threads') return handleChatThreads(req, res);
  if (route === 'chat-groups') return handleChatGroups(req, res);
  if (route === 'chat') return handleChat(req, res);
  if (route === 'chat-read') return handleChatRead(req, res);
  if (route === 'schedules') return handleSchedules(req, res);
  if (route === 'schedule-response') return handleScheduleResponse(req, res);
  if (route === 'my-week') return handleMyWeek(req, res);

  return sendJson(res, 404, { ok: false, error: 'not_found' });
};

