const crypto = require('crypto');

function constantTimeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function hashPassword(password, saltBase64) {
  const salt = saltBase64 ? Buffer.from(saltBase64, 'base64') : crypto.randomBytes(16);
  const derivedKey = crypto.pbkdf2Sync(password, salt, 120_000, 32, 'sha256');
  return {
    salt: salt.toString('base64'),
    hash: derivedKey.toString('base64')
  };
}

function verifyPassword(password, saltBase64, hashBase64) {
  const { hash } = hashPassword(password, saltBase64);
  return constantTimeEqual(hash, hashBase64);
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie ? String(req.headers.cookie) : '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) return;
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [];
  parts.push(`${name}=${encodeURIComponent(value)}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.expires instanceof Date) parts.push(`Expires=${opts.expires.toUTCString()}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0, expires: new Date(0), httpOnly: true, sameSite: 'Lax', secure: isSecureEnv() });
}

function isSecureEnv() {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';
}

function signSession(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('Missing SESSION_SECRET');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return sig;
}

function createSessionToken({ username, isAdmin, ttlSeconds = 60 * 60 * 24 * 7 }) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${username}|${isAdmin ? '1' : '0'}|${exp}`;
  const sig = signSession(payload);
  return `${payload}|${sig}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const parts = String(token).split('|');
  if (parts.length !== 4) return null;
  const [username, isAdminFlag, expStr, sig] = parts;
  const payload = `${username}|${isAdminFlag}|${expStr}`;
  const expected = signSession(payload);
  if (!constantTimeEqual(expected, sig)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now > exp) return null;
  return { username, isAdmin: isAdminFlag === '1', exp };
}

module.exports = {
  hashPassword,
  verifyPassword,
  parseCookies,
  setCookie,
  clearCookie,
  isSecureEnv,
  createSessionToken,
  verifySessionToken
};

