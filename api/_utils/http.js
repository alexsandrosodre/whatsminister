const { StringDecoder } = require('string_decoder');

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        return;
      }
      buf += decoder.write(chunk);
    });

    req.on('end', () => {
      buf += decoder.end();
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function sendNoContent(res) {
  res.statusCode = 204;
  res.end();
}

function methodNotAllowed(res, allowed) {
  res.statusCode = 405;
  res.setHeader('Allow', allowed.join(', '));
  res.end();
}

module.exports = { readJsonBody, sendJson, sendNoContent, methodNotAllowed };
