/**
 * 极简静态服务器 —— 把 live-dist 目录在浏览器里跑起来。
 * 自带 CORS 头 + WebSocket 代理不拦截。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3300;
const ROOT = path.resolve(__dirname, 'live-dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(ROOT, url.split('?')[0]);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ Otto Live 已就绪: http://127.0.0.1:${PORT}\n`);
  console.log('   后端 otto-server: http://127.0.0.1:7637');
  console.log('   按 Ctrl+C 停止\n');
});
