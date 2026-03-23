const { sendNoContent, methodNotAllowed } = require('./_utils/http');
const { clearCookie } = require('./_utils/security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  clearCookie(res, 'wm_session');
  return sendNoContent(res);
};

