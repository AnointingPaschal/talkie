'use strict';
/**
 * S-talk — Embedded Mobile Server
 * Runs inside the Android/iOS app via capacitor-nodejs
 * Pure HTTP (no HTTPS needed — localhost is always secure)
 * No MongoDB — in-memory only for offline use
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const os      = require('os');

// Bridge to communicate with the Capacitor WebView
let channel;
try {
  channel = require('bridge');
} catch (_) {
  // Running outside of Capacitor (dev/test) — no-op bridge
  channel = { send: () => {}, receive: () => {} };
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

const PORT = 3000;

// Serve the web app static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/health',  (_, res) => res.json({ status: 'ok', mode: 'mobile-offline' }));
app.get('/api/network', (_, res) => {
  const lanIPs = getLanIPs();
  res.json({ urls: lanIPs.map(ip => `http://${ip}:${PORT}`), port: PORT });
});

// ── In-memory state ──────────────────────────────────────────────────────────
const channels = new Map();
const users    = new Map();

function getOrCreate(channelId, password = null) {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      users: new Map(), password,
      messages: [], hasActivity: false, lastActivity: null,
    });
  }
  return channels.get(channelId);
}
function pruneChannel(id) {
  const ch = channels.get(id);
  if (ch && ch.users.size === 0) channels.delete(id);
}
function getUserInfo(sid) {
  return users.get(sid) || { username: 'Anonymous', channelId: null };
}
function publicChannelList() {
  const list = [];
  for (const [id, ch] of channels) {
    if (!ch.password) {
      list.push({
        id, userCount: ch.users.size,
        hasActivity: ch.hasActivity,
        users: Array.from(ch.users.values()).map(u => u.username),
      });
    }
  }
  return list.sort((a, b) => {
    const na = Number(a.id), nb = Number(b.id);
    return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.id < b.id ? -1 : 1;
  });
}
function broadcastChannelList() { io.emit('channel-list', publicChannelList()); }

// ── Socket.io signaling ───────────────────────────────────────────────────────
io.on('connection', socket => {
  users.set(socket.id, { username: 'Anonymous', channelId: null });

  socket.on('set-username', raw => {
    const username = String(raw || 'Anonymous').trim().slice(0, 24) || 'Anonymous';
    users.set(socket.id, { ...getUserInfo(socket.id), username });
  });

  socket.on('join-channel', ({ channelId, password = '', username = 'Anonymous' }) => {
    channelId = String(channelId).trim().slice(0, 32);
    if (!channelId) return;
    doLeave(socket);

    if (channels.has(channelId)) {
      const ch = channels.get(channelId);
      if (ch.password && ch.password !== password) {
        socket.emit('join-error', { message: 'Incorrect password.' });
        return;
      }
    }

    const uname = String(username || 'Anonymous').trim().slice(0, 24) || 'Anonymous';
    const ch    = getOrCreate(channelId, password || null);
    const existingPeers = Array.from(ch.users.entries())
      .map(([sid, info]) => ({ socketId: sid, username: info.username }));

    ch.users.set(socket.id, { username: uname, isSpeaking: false });
    users.set(socket.id, { username: uname, channelId });
    socket.join(channelId);

    socket.emit('joined-channel', {
      channelId, existingPeers,
      isPrivate: !!ch.password,
      messages: ch.messages.slice(-100),
    });
    socket.to(channelId).emit('user-joined', { socketId: socket.id, username: uname });
    broadcastChannelList();
  });

  socket.on('leave-channel', () => doLeave(socket));

  function doLeave(sock) {
    const { channelId } = getUserInfo(sock.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (ch) {
      ch.users.delete(sock.id);
      sock.leave(channelId);
      sock.to(channelId).emit('user-left', { socketId: sock.id });
      pruneChannel(channelId);
    }
    users.set(sock.id, { ...getUserInfo(sock.id), channelId: null });
    broadcastChannelList();
  }

  socket.on('signal', ({ targetId, data }) => {
    if (targetId && data) socket.to(targetId).emit('signal', { fromId: socket.id, data });
  });

  socket.on('speaking', ({ isSpeaking }) => {
    const { channelId } = getUserInfo(socket.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (!ch) return;
    const cu = ch.users.get(socket.id);
    if (cu) cu.isSpeaking = !!isSpeaking;
    if (isSpeaking) { ch.hasActivity = true; ch.lastActivity = Date.now(); }
    socket.to(channelId).emit('user-speaking', { socketId: socket.id, isSpeaking: !!isSpeaking });
  });

  socket.on('chat-message', ({ text }) => {
    const { channelId, username } = getUserInfo(socket.id);
    if (!channelId || !String(text || '').trim()) return;
    const ch = channels.get(channelId);
    if (!ch) return;
    const msg = {
      id: `${socket.id}-${Date.now()}`,
      socketId: socket.id, username,
      text: String(text).trim().slice(0, 500),
      timestamp: new Date().toISOString(),
    };
    ch.messages.push(msg);
    if (ch.messages.length > 200) ch.messages.shift();
    io.to(channelId).emit('chat-message', msg);
  });

  socket.on('get-channels', () => socket.emit('channel-list', publicChannelList()));

  socket.on('disconnect', () => {
    doLeave(socket);
    users.delete(socket.id);
  });

  socket.emit('channel-list', publicChannelList());
});

setInterval(() => {
  const threshold = Date.now() - 4000;
  for (const ch of channels.values())
    if (ch.hasActivity && ch.lastActivity < threshold) ch.hasActivity = false;
}, 5000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function getLanIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const iface of ifaces)
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
  return ips;
}

// ── Start server ──────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const lanIPs = getLanIPs();
  console.log(`[S-talk] Server running on port ${PORT}`);
  console.log(`[S-talk] LAN IPs: ${lanIPs.join(', ')}`);

  // Notify the WebView that the server is ready
  channel.send('message', {
    event:  'server-ready',
    port:   PORT,
    lanIPs: lanIPs,
  });
});
