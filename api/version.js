const { sendJson, methodNotAllowed } = require('./_utils/http');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const build =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    process.env.GIT_COMMIT_SHA ||
    '';

  const now = new Date().toISOString();

  return sendJson(res, 200, { ok: true, build, now });
};

