const { sendJson, methodNotAllowed } = require('./_utils/http');
const { requireAuth } = require('./_utils/auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireAuth(req);
    if (!user) return sendJson(res, 200, { ok: true, user: null });
    return sendJson(res, 200, { ok: true, user });
  } catch {
    return sendJson(res, 200, { ok: true, user: null });
  }
};

