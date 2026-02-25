/**
 * Signaling server - Node.js built-in http only. No packages.
 * Uses SSE for server→client and POST for client→server.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const PUBLIC = path.join(__dirname, 'public');

// meetingId -> Map of userId -> { name, queue: [] }
const meetings = new Map();

// Parse JSON body from request
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
  });
}

// Get query param
function getQuery(req, key) {
  const u = url.parse(req.url, true);
  return u.query[key] || '';
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, filePath) {
  const full = path.join(PUBLIC, filePath);
  const stream = fs.createReadStream(full);
  stream.on('error', () => { res.writeHead(404); res.end('Not found'); });
  stream.pipe(res);
}

function getMeeting(meetingId) {
  if (!meetings.has(meetingId)) meetings.set(meetingId, new Map());
  return meetings.get(meetingId);
}

// POST /api/join  body: { meetingId, userId, userName }
async function apiJoin(req, res) {
  const body = await parseBody(req);
  const { meetingId, userId, userName } = body;
  if (!meetingId || !userId || !userName) {
    return sendJson(res, 400, { error: 'missing meetingId, userId or userName' });
  }
  const meeting = getMeeting(meetingId);
  const peers = [];
  meeting.forEach((data, id) => { peers.push({ userId: id, userName: data.name }); });
  meeting.set(userId, { name: userName, queue: [] });
  sendJson(res, 200, { peers });
}

// POST /api/signal  body: { meetingId, from, to, type, payload }
async function apiSignal(req, res) {
  const body = await parseBody(req);
  const { meetingId, from, to, type, payload } = body;
  if (!meetingId || !from || !to) return sendJson(res, 400, { error: 'missing fields' });
  const meeting = getMeeting(meetingId);
  const peer = meeting.get(to);
  if (!peer) return sendJson(res, 404, { error: 'peer not found' });
  peer.queue.push({ from, type, payload });
  sendJson(res, 200, { ok: true });
}

// GET /api/events?meetingId=...&userId=...  -> SSE stream
function apiEvents(req, res, meetingId, userId) {
  const meeting = getMeeting(meetingId);
  const peer = meeting.get(userId);
  if (!peer) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  const sendEvent = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');
  const interval = setInterval(() => {
    while (peer.queue.length) sendEvent(peer.queue.shift());
  }, 200);
  req.on('close', () => {
    clearInterval(interval);
    meeting.delete(userId);
  });
}

// GET /api/peers?meetingId=...
function apiPeers(req, res, meetingId) {
  const meeting = getMeeting(meetingId);
  const peers = [];
  meeting.forEach((data, id) => peers.push({ userId: id, userName: data.name }));
  sendJson(res, 200, { peers });
}

const mime = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const pathname = u.pathname;

  if (req.method === 'POST' && pathname === '/api/join') return apiJoin(req, res);
  if (req.method === 'POST' && pathname === '/api/signal') return apiSignal(req, res);
  if (req.method === 'GET' && pathname === '/api/events') {
    return apiEvents(req, res, getQuery(req, 'meetingId'), getQuery(req, 'userId'));
  }
  if (req.method === 'GET' && pathname === '/api/peers') {
    return apiPeers(req, res, getQuery(req, 'meetingId'));
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC, filePath);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  const ext = path.extname(full);
  const contentType = mime[ext] || 'application/octet-stream';
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('Server at http://localhost:' + PORT));
