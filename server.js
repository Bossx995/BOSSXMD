const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PAIRING_SECRET = process.env.PAIRING_SECRET || '';
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');

function json(res, status, body) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') return json(res, 200, {ok:true, service:'BOSS-X'});
  if (req.url === '/api/config' && req.method === 'GET') {
    return json(res, 200, {pairingEnabled: Boolean(PAIRING_SECRET && OWNER_NUMBER)});
  }
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'public','index.html')));
  }
  json(res, 404, {error:'Not found'});
});

server.listen(PORT, HOST, () => console.log(`🌐 BOSS-X web server listening on ${HOST}:${PORT}`));
