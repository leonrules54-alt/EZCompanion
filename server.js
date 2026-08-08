const http = require('http');
const fs = require('fs');
const path = require('path');

// Optional static preview server for plain browsers.
// The Electron app does NOT need this server: main.js loads its windows over
// the file:// protocol via loadAppFile(). This server is only useful for
// `npm start` browser previews, or as a dev server for the renderer by
// running Electron with WOLF_DEV_URL=http://localhost:3737.
//
// The root URL serves the landing page (landing.html) so the browser preview
// matches the Vercel deployment (see vercel.json); the app dashboard stays
// available at /index.html.
const PORT = 3737;

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  // Root (with or without a query string, e.g. /?utm_source=x) serves the
  // landing page — matching the Vercel rewrite in vercel.json.
  const pathname = req.url.split('?')[0];
  const rel = pathname === '/' || pathname === '' ? '/landing.html' : pathname;
  const filePath = path.join(__dirname, rel);

  // Path-traversal guard: never serve files outside the project folder
  // (a URL like /../package.json would otherwise read arbitrary files).
  if (!filePath.startsWith(path.resolve(__dirname) + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  🐺 Wolf Pet preview: http://localhost:${PORT} (browser preview only — Electron loads local files)\n`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  [server] Port ${PORT} is already in use — is another preview already running?\n`);
  } else {
    console.error('[server] Failed to start:', err.message);
  }
  process.exit(1);
});
