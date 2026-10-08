const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/signal', maxPayload: 65536 });
app.get(['/host', '/listen', '/host.html', '/listen.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls: process.env.TURN_URL.split(',').map(s => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.json({ iceServers });
});
// Each room contains multiple hosts and listeners.
const rooms = new Map();
let nextId = 1;
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { hosts: new Map(), listeners: new Map() });
  return rooms.get(code);
}
function counts(room) { return { hostCount: room.hosts.size, listenerCount: room.listeners.size }; }
function broadcastCounts(room) {
  for (const ws of [...room.hosts.values(), ...room.listeners.values()]) safeSend(ws, { type: 'room-counts', ...counts(room) });
}
function cleanup(ws) {
  const { roomCode, role, clientId } = ws.meta || {};
  ws.meta = {};
  const room = rooms.get(roomCode);
  if (!room) return;
  if (role === 'host' && room.hosts.delete(clientId)) {
    for (const listener of room.listeners.values()) safeSend(listener, { type: 'host-left', hostId: clientId });
  } else if (role === 'listener' && room.listeners.delete(clientId)) {
    for (const host of room.hosts.values()) safeSend(host, { type: 'listener-left', listenerId: clientId });
  }
  broadcastCounts(room);
  if (!room.hosts.size && !room.listeners.size) rooms.delete(roomCode);
}
wss.on('connection', ws => {
  ws.meta = {};
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.type === 'join') {
      const roomCode = String(msg.roomCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const role = msg.role === 'host' ? 'host' : 'listener';
      if (!roomCode) return safeSend(ws, { type: 'error', message: '방 코드가 필요합니다.' });
      cleanup(ws);
      const room = getRoom(roomCode);
      const clientId = `c${nextId++}`;
      ws.meta = { roomCode, role, clientId };
      (role === 'host' ? room.hosts : room.listeners).set(clientId, ws);
      safeSend(ws, { type: 'joined', role, roomCode, clientId, ...counts(room) });
      if (role === 'host') {
        for (const listener of room.listeners.values()) safeSend(listener, { type: 'host-ready', hostId: clientId });
      } else {
        for (const host of room.hosts.values()) safeSend(host, { type: 'listener-joined', listenerId: clientId });
      }
      broadcastCounts(room);
      return;
    }
    const { roomCode, role, clientId } = ws.meta;
    const room = rooms.get(roomCode);
    if (!room) return;
    if (role === 'host' && msg.type === 'host-started') {
      ws.meta.broadcasting = true;
      for (const [id] of room.listeners) safeSend(ws, { type: 'listener-joined', listenerId: id });
      return;
    }
    if (role === 'host' && msg.type === 'host-stopped') {
      ws.meta.broadcasting = false;
      for (const listener of room.listeners.values()) safeSend(listener, { type: 'host-left', hostId: clientId });
      return;
    }
    if (role === 'listener' && msg.type === 'question') {
      const text = String(msg.text || '').trim().slice(0, 300);
      if (!text) return;
      const question = { type: 'question', questionId: `${clientId}-${Date.now()}-${++nextId}`,
        name: String(msg.name || '익명').slice(0, 20), text, at: Date.now(), fromId: clientId };
      for (const host of room.hosts.values()) safeSend(host, question);
      return;
    }
    if (role === 'listener' && msg.type === 'retry') {
      const host = room.hosts.get(msg.targetId);
      if (host?.meta.broadcasting) safeSend(host, { type: 'listener-joined', listenerId: clientId });
      return;
    }
    // WebRTC messages can only reach the opposite role in the same room.
    if (!['offer', 'answer', 'ice'].includes(msg.type)) return;
    if ((msg.type === 'offer' && role !== 'host') || (msg.type === 'answer' && role !== 'listener')) return;
    const target = (role === 'host' ? room.listeners : room.hosts).get(msg.targetId);
    if (target) safeSend(target, { type: msg.type, sdp: msg.sdp, candidate: msg.candidate, fromId: clientId });
  });
  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { cleanup(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Mobile Guide running on port ${port}`));
