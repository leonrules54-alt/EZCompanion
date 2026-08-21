const http = require('http');
const fs = require('fs');
const path = require('path');

// Optional static preview server for plain browsers.
// The Electron app does NOT need this server: main.js loads its windows over
// the file:// protocol via loadAppFile(). This server is only useful for
// `npm start` browser previews, or as a dev server for the renderer by
// running Electron with HALO_DEV_URL=http://localhost:3737.
//
// The root URL serves index.html, which IS the landing page (landing was
// renamed to index.html so the Vercel deployment serves it natively). The
// app dashboard (app.html) is desktop-only and stays available locally at
// /app.html for browser previews.
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
  // Root (with or without a query string, e.g. /?utm_source=x) serves
  // index.html, which is the landing page.
  const pathname = req.url.split('?')[0];
  const rel = pathname === '/' || pathname === '' ? '/index.html' : pathname;
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
  console.log(`\n  🐺 Halo preview: http://localhost:${PORT} (browser preview only — Electron loads local files)\n`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  [server] Port ${PORT} is already in use — is another preview already running?\n`);
  } else {
    console.error('[server] Failed to start:', err.message);
  }
  process.exit(1);
});
