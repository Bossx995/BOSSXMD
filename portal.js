const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const ROOT = path.resolve(process.env.SESSIONS_DIR || './sessions');
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS || 20));
const RATE_WINDOW = 10 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 8;
const sessions = new Map();
const ipHits = new Map();

fs.mkdirSync(ROOT, { recursive: true });

function cleanNumber(v) {
  return String(v || '').replace(/\D/g, '');
}
function validNumber(n) { return /^\d{8,15}$/.test(n); }
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}
function html(res, body, status=200) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}
function allowed(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (arr.length >= MAX_REQUESTS_PER_IP) { ipHits.set(ip, arr); return false; }
  arr.push(now); ipHits.set(ip, arr); return true;
}
function makeId() { return crypto.randomBytes(10).toString('hex'); }
function killSession(s) {
  if (!s || !s.child || s.child.killed) return;
  try { s.child.kill('SIGTERM'); } catch {}
}
function createSession(number) {
  if (sessions.size >= MAX_SESSIONS) throw new Error('Server is busy. Try again later.');
  const id = makeId();
  const dir = path.join(ROOT, id);
  const auth = path.join(dir, 'auth_info');
  const data = path.join(dir, 'bot_data');
  fs.mkdirSync(auth, { recursive: true });
  fs.mkdirSync(data, { recursive: true });

  const env = {
    ...process.env,
    OWNER_NUMBER: number,
    AUTH_DIR: auth,
    DATA_DIR: data,
    OWNER_PHOTO: path.join(__dirname, 'owner.jpg'),
    SESSION_ID: id,
    PAIRING_NUMBER: number,
    BOT_MODE: process.env.BOT_MODE || 'public'
  };
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const session = { id, number, child, code: null, status: 'starting', createdAt: Date.now(), output: '' };
  sessions.set(id, session);

  const onData = chunk => {
    const text = String(chunk);
    session.output = (session.output + text).slice(-6000);
    const m = text.match(/PAIRING CODE:\s*([A-Z0-9-]+)/i);
    if (m) { session.code = m[1].trim(); session.status = 'pairing'; }
    if (/CONNECTED SUCCESSFULLY/i.test(text)) session.status = 'connected';
    if (/logged out/i.test(text)) session.status = 'logged_out';
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, signal) => {
    session.exit = { code, signal };
    if (session.status !== 'connected') session.status = 'stopped';
    setTimeout(() => sessions.delete(id), 60 * 60 * 1000);
  });
  return session;
}

const PAGE = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>BOSS X Pairing</title>
<style>
body{margin:0;background:#0f1117;color:#fff;font-family:Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box}
.card{width:min(460px,100%);background:#191d27;border:1px solid #2d3444;border-radius:18px;padding:24px;box-sizing:border-box;box-shadow:0 15px 50px #0008}
h1{margin:0 0 8px;font-size:28px}.muted{color:#aeb6c5;line-height:1.5}input{width:100%;box-sizing:border-box;padding:14px;border-radius:10px;border:1px solid #3b4354;background:#0d1016;color:#fff;font-size:16px;margin:14px 0}button{width:100%;padding:14px;border:0;border-radius:10px;background:#fff;color:#111;font-weight:700;font-size:16px}button:disabled{opacity:.5}.code{font-size:30px;letter-spacing:4px;text-align:center;background:#0b0e13;padding:18px;border-radius:12px;margin-top:18px;font-weight:800}.ok{color:#7ee787}.err{color:#ff7b72}.small{font-size:13px;color:#8992a3;margin-top:14px}
</style></head><body><div class="card"><h1>🔐 BOSS X Pairing</h1><p class="muted">Enter your WhatsApp number with country code. You must approve the pairing request in WhatsApp.</p><input id="num" inputmode="numeric" placeholder="919XXXXXXXXX"><button id="btn" onclick="pair()">GET PAIRING CODE</button><div id="out"></div><p class="small">Your number is used only to request the WhatsApp pairing code for this session.</p></div>
<script>
async function pair(){const n=document.getElementById('num').value.replace(/\D/g,'');const b=document.getElementById('btn'),o=document.getElementById('out');if(n.length<8||n.length>15){o.innerHTML='<p class="err">Enter a valid number with country code.</p>';return}b.disabled=true;o.innerHTML='<p class="muted">Generating code…</p>';try{const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:n})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Failed');o.innerHTML='<p class="muted">Open WhatsApp → Linked devices → Link a device → Link with phone number instead.</p><div class="code">'+d.code+'</div><p class="ok">Session: '+d.id+'</p><p class="muted">Keep this page open until WhatsApp shows that the device is linked.</p>';poll(d.id)}catch(e){o.innerHTML='<p class="err">'+e.message+'</p>';b.disabled=false}}
async function poll(id){for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,2000));try{const r=await fetch('/api/status/'+id);const d=await r.json();if(d.status==='connected'){document.getElementById('out').innerHTML='<p class="ok">✅ WhatsApp connected successfully.</p><p class="muted">Your BOSS X session is running.</p>';return}if(d.status==='stopped'||d.status==='logged_out'){document.getElementById('out').innerHTML='<p class="err">Session stopped. Generate a new code.</p>';document.getElementById('btn').disabled=false;return}}catch{}}}
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'BOSS X Pairing', sessions: sessions.size, maxSessions: MAX_SESSIONS });
  }
  if (req.method === 'GET' && url.pathname === '/') return html(res, PAGE);
  if (req.method === 'GET' && url.pathname.startsWith('/api/status/')) {
    const id = url.pathname.split('/').pop();
    const s = sessions.get(id);
    if (!s) return json(res, 404, { error: 'Session not found' });
    return json(res, 200, { id: s.id, status: s.status });
  }
  if (req.method === 'POST' && url.pathname === '/api/pair') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!allowed(ip)) return json(res, 429, { error: 'Too many requests. Try again later.' });
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}');
        const number = cleanNumber(body.number);
        if (!validNumber(number)) return json(res, 400, { error: 'Invalid WhatsApp number.' });
        const s = createSession(number);
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          if (s.code) { clearInterval(timer); return json(res, 200, { id: s.id, code: s.code }); }
          if (s.status === 'stopped' || tries > 30) { clearInterval(timer); killSession(s); return json(res, 500, { error: 'Could not generate pairing code. Try again.' }); }
        }, 500);
      } catch (e) { return json(res, 500, { error: e.message || 'Server error' }); }
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => console.log(`🌐 BOSS X Pairing Website running on http://${HOST}:${PORT}`));
