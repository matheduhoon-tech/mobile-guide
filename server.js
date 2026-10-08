const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/signal' });

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/host', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/listen', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
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

// roomCode -> { hosts: Map(id, ws), listeners: Map(id, ws) }
const rooms = new Map();
let nextId = 1;

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { hosts: new Map(), listeners: new Map() });
  return rooms.get(code);
}
function activeHostIds(room) {
  return [...room.hosts.entries()].filter(([, ws]) => ws.meta?.active).map(([id]) => id);
}
function broadcastCounts(room) {
  const payload = {
    type: 'room-counts',
    hostCount: room.hosts.size,
    activeHostCount: activeHostIds(room).length,
    listenerCount: room.listeners.size
  };
  for (const ws of room.hosts.values()) safeSend(ws, payload);
  for (const ws of room.listeners.values()) safeSend(ws, payload);
}
function cleanup(ws) {
  const { roomCode, role, clientId } = ws.meta || {};
  if (!roomCode || !clientId) return;
  const room = rooms.get(roomCode);
  if (!room) return;

  if (role === 'host') {
    room.hosts.delete(clientId);
    for (const listener of room.listeners.values()) {
      safeSend(listener, { type: 'host-left', hostId: clientId });
    }
  } else {
    room.listeners.delete(clientId);
    for (const host of room.hosts.values()) {
      safeSend(host, { type: 'listener-left', listenerId: clientId });
    }
  }
  broadcastCounts(room);
  if (room.hosts.size === 0 && room.listeners.size === 0) rooms.delete(roomCode);
  ws.meta = {};
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
      ws.meta = { roomCode, role, clientId, active: false };

      if (role === 'host') {
        room.hosts.set(clientId, ws);
        safeSend(ws, {
          type: 'joined', role, roomCode, clientId,
          hostCount: room.hosts.size,
          activeHostCount: activeHostIds(room).length,
          listenerCount: room.listeners.size
        });
      } else {
        room.listeners.set(clientId, ws);
        const hostIds = activeHostIds(room);
        safeSend(ws, {
          type: 'joined', role, roomCode, clientId,
          hostCount: room.hosts.size,
          activeHostCount: hostIds.length,
          listenerCount: room.listeners.size,
          hostIds
        });
        // Tell every already-broadcasting host to create an independent peer for this listener.
        for (const hostId of hostIds) {
          const host = room.hosts.get(hostId);
          safeSend(host, { type: 'listener-joined', listenerId: clientId });
        }
      }
      broadcastCounts(room);
      return;
    }

    const { roomCode, role, clientId } = ws.meta || {};
    const room = rooms.get(roomCode);
    if (!room || !clientId) return;

    if (role === 'host' && msg.type === 'host-started') {
      ws.meta.active = true;
      // A late host must independently negotiate with every existing listener.
      for (const [listenerId, listener] of room.listeners) {
        safeSend(ws, { type: 'listener-joined', listenerId });
        safeSend(listener, { type: 'host-ready', hostId: clientId });
      }
      broadcastCounts(room);
      return;
    }

    if (role === 'host' && msg.type === 'host-stopped') {
      ws.meta.active = false;
      for (const listener of room.listeners.values()) {
        safeSend(listener, { type: 'host-stopped', hostId: clientId });
      }
      broadcastCounts(room);
      return;
    }

    // Host -> exactly one listener. Each host keeps its own peer connection.
    if (role === 'host' && msg.targetId) {
      const target = room.listeners.get(msg.targetId);
      safeSend(target, { ...msg, fromId: clientId, targetId: undefined });
      return;
    }

    if (role === 'listener') {
      // Listener -> one host for WebRTC signalling.
      if (msg.targetId && room.hosts.has(msg.targetId)) {
        safeSend(room.hosts.get(msg.targetId), { ...msg, fromId: clientId, targetId: undefined });
        return;
      }
      // Listener questions intentionally fan out to every host.
      if (msg.type === 'question') {
        for (const host of room.hosts.values()) {
          safeSend(host, { ...msg, fromId: clientId, targetId: undefined });
        }
      }
    }
  });

  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Mobile Guide v4 running on port ${port}`));
