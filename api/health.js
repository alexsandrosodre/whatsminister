const { ensureSchema } = require('./_utils/db');
const { sendJson, methodNotAllowed } = require('./_utils/http');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    await ensureSchema();
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: 'db_error', detail: String(e && e.message ? e.message : e) });
  }
};

