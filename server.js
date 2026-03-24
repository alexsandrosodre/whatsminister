const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Simple .env loader for local runs
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    text.split(/\r?\n/).forEach((line) => {
      const m = /^([^#=\s]+)\s*=\s*(.+)$/.exec(line);
      if (m) {
        const key = m[1].trim();
        const val = m[2].trim();
        if (key && !(key in process.env)) process.env[key] = val;
      }
    });
  }
} catch {}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = __dirname;

function contentType(p) {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function serveFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType(filePath));
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not Found');
  }
}

function notFound(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
}

const apiHandler = require('./api/index.js');

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url);
    const pathname = parsed.pathname || '/';

    if (pathname.startsWith('/api/')) {
      return apiHandler(req, res);
    }

    // Static
    let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!fs.existsSync(filePath)) filePath = path.join(ROOT, 'index.html');
    return serveFile(res, filePath);
  } catch {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'server_error' }));
  }
});

server.listen(PORT, () => {
  console.log(`Local server running at http://localhost:${PORT}/`);
});
