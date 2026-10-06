const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/signal' });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map(s => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.json({ iceServers });
});

// roomCode -> { host: ws|null, listeners: Map(id, ws) }
const rooms = new Map();
let nextId = 1;

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, listeners: new Map() });
  return rooms.get(code);
}

function cleanup(ws) {
  const { roomCode, role, clientId } = ws.meta || {};
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;

  if (role === 'host' && room.host === ws) {
    room.host = null;
    for (const [id, listener] of room.listeners) {
      safeSend(listener, { type: 'host-left' });
    }
  } else if (role === 'listener' && clientId) {
    room.listeners.delete(clientId);
    safeSend(room.host, { type: 'listener-left', listenerId: clientId, count: room.listeners.size });
  }
  if (!room.host && room.listeners.size === 0) rooms.delete(roomCode);
}

wss.on('connection', (ws) => {
  ws.meta = {};

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      const roomCode = String(msg.roomCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const role = msg.role === 'host' ? 'host' : 'listener';
      if (!roomCode) return safeSend(ws, { type: 'error', message: '방 코드가 필요합니다.' });

      cleanup(ws);
      const room = getRoom(roomCode);
      const clientId = `c${nextId++}`;
      ws.meta = { roomCode, role, clientId };

      if (role === 'host') {
        if (room.host && room.host !== ws) {
          safeSend(room.host, { type: 'replaced' });
          try { room.host.close(); } catch {}
        }
        room.host = ws;
        safeSend(ws, { type: 'joined', role, roomCode, clientId, count: room.listeners.size });
        for (const [id, listener] of room.listeners) {
          safeSend(ws, { type: 'listener-joined', listenerId: id, count: room.listeners.size });
          safeSend(listener, { type: 'host-ready' });
        }
      } else {
        room.listeners.set(clientId, ws);
        safeSend(ws, { type: 'joined', role, roomCode, clientId, hostOnline: !!room.host });
        safeSend(room.host, { type: 'listener-joined', listenerId: clientId, count: room.listeners.size });
      }
      return;
    }

    const { roomCode, role, clientId } = ws.meta || {};
    const room = rooms.get(roomCode);
    if (!room) return;

    // Host starts after listeners are already waiting: ask host to create peers for all of them.
    if (role === 'host' && msg.type === 'host-started') {
      for (const [id] of room.listeners) {
        safeSend(ws, { type: 'listener-joined', listenerId: id, count: room.listeners.size });
      }
      return;
    }

    // Host -> one listener
    if (role === 'host' && msg.targetId) {
      const target = room.listeners.get(msg.targetId);
      safeSend(target, { ...msg, fromId: clientId, targetId: undefined });
      return;
    }

    // Listener -> host
    if (role === 'listener') {
      safeSend(room.host, { ...msg, fromId: clientId, targetId: undefined });
    }
  });

  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Mobile Guide running on port ${port}`));
