const { ensureSchema, sql } = require('./_utils/db');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAdmin } = require('./_utils/auth');
const { hashPassword } = require('./_utils/security');

module.exports = async (req, res) => {
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
};
