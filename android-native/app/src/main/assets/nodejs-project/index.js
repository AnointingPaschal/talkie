'use strict';
/**
 * S-talk — Embedded Mobile Server
 * Runs inside Android/iOS app via capacitor-nodejs
 * Pure HTTP on port 3000 — no HTTPS needed (localhost is always secure)
 */
const http    = require('http');
const express = require('express');
const { Server } = require('socket.io');
const path    = require('path');
const os      = require('os');

// Bridge to Capacitor WebView
let bridge;
try {
  bridge = require('bridge');
} catch (_) {
  bridge = {
    send:    () => {},
    receive: () => {},
  };
}

const PORT = 3000;
const app   = express();
const srv   = http.createServer(app);
const io    = new Server(srv, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout:  30000,
  pingInterval: 10000,
});

// Serve the bundled web app
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/health', (_, res) =>
  res.json({ status: 'ok', mode: 'android-offline' }));
app.get('/api/network', (_, res) => {
  const ips = getLanIPs();
  res.json({ urls: ips.map(ip => `http://${ip}:${PORT}`), port: PORT });
});

// ── In-memory state ──────────────────────────────────────────────
const channels = new Map();
const users    = new Map();

function getOrCreate(id, pw, hostSid) {
  if (!channels.has(id)) {
    channels.set(id, {
      users: new Map(), password: pw || null,
      host: hostSid, cohosts: new Set(), muted: new Set(),
      messages: [], memberHistory: new Map(),
      hasActivity: false, lastActivity: null,
    });
  }
  return channels.get(id);
}
function pruneChannel(id) { const ch = channels.get(id); if (ch && ch.users.size === 0) channels.delete(id); }
function getUserInfo(sid) { return users.get(sid) || { username: 'Anonymous', channelId: null }; }
function isPrivileged(ch, sid) { return ch.host === sid || ch.cohosts.has(sid); }

function publicChannelList() {
  const list = [];
  for (const [id, ch] of channels) {
    if (!ch.password) {
      list.push({ id, userCount: ch.users.size, hasActivity: ch.hasActivity, users: [...ch.users.values()].map(u => u.username), host: users.get(ch.host)?.username || '' });
    }
  }
  return list.sort((a, b) => { const na = Number(a.id), nb = Number(b.id); return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.id < b.id ? -1 : 1; });
}
function broadcastChannelList() { io.emit('channel-list', publicChannelList()); }

function channelRoster(ch) {
  const online  = [...ch.users.entries()].map(([sid, u]) => ({ socketId: sid, username: u.username, isSpeaking: u.isSpeaking, isMuted: ch.muted.has(sid), isHost: ch.host === sid, isCohost: ch.cohosts.has(sid), online: true }));
  const offline = [];
  for (const [uname, m] of ch.memberHistory) if (!m.online) offline.push({ socketId: null, username: uname, online: false, lastSeen: m.lastSeen });
  return [...online, ...offline];
}

// ── Socket.io ────────────────────────────────────────────────────
io.on('connection', socket => {
  users.set(socket.id, { username: 'Anonymous', channelId: null });

  socket.on('set-username', raw => {
    const u = String(raw || 'Anonymous').trim().slice(0, 24) || 'Anonymous';
    users.set(socket.id, { ...getUserInfo(socket.id), username: u });
  });

  socket.on('join-channel', ({ channelId, password = '', username = 'Anonymous' } = {}) => {
    channelId = String(channelId || '').trim().slice(0, 32);
    if (!channelId) return;
    doLeave(socket);
    if (channels.has(channelId)) {
      const ch = channels.get(channelId);
      if (ch.password && ch.password !== password) { socket.emit('join-error', { message: 'Incorrect password.' }); return; }
    }
    const uname = String(username || 'Anonymous').trim().slice(0, 24) || 'Anonymous';
    const ch    = getOrCreate(channelId, password || null, socket.id);
    if (ch.users.size === 0) ch.host = socket.id;
    const existingPeers = [...ch.users.entries()].map(([sid, info]) => ({ socketId: sid, username: info.username }));
    ch.users.set(socket.id, { username: uname, isSpeaking: false });
    ch.memberHistory.set(uname, { socketId: socket.id, lastSeen: Date.now(), online: true });
    users.set(socket.id, { username: uname, channelId });
    socket.join(channelId);
    socket.emit('joined-channel', { channelId, existingPeers, isPrivate: !!ch.password, messages: ch.messages.slice(-100), isHost: ch.host === socket.id, isCohost: ch.cohosts.has(socket.id), isMuted: ch.muted.has(socket.id), roster: channelRoster(ch) });
    socket.to(channelId).emit('user-joined', { socketId: socket.id, username: uname });
    io.to(channelId).emit('roster-update', channelRoster(ch));
    broadcastChannelList();
  });

  socket.on('leave-channel', () => doLeave(socket));

  function doLeave(sock) {
    const { channelId } = getUserInfo(sock.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (ch) {
      const uname = ch.users.get(sock.id)?.username;
      ch.users.delete(sock.id); ch.muted.delete(sock.id);
      if (uname) ch.memberHistory.set(uname, { socketId: null, lastSeen: Date.now(), online: false });
      if (ch.host === sock.id && ch.users.size > 0) {
        const newHost = ch.cohosts.size > 0 ? [...ch.cohosts][0] : [...ch.users.keys()][0];
        ch.host = newHost; ch.cohosts.delete(newHost);
        io.to(channelId).emit('host-changed', { newHostId: newHost, newHostName: ch.users.get(newHost)?.username });
      }
      sock.leave(channelId);
      sock.to(channelId).emit('user-left', { socketId: sock.id });
      io.to(channelId).emit('roster-update', channelRoster(ch));
      pruneChannel(channelId);
    }
    users.set(sock.id, { ...getUserInfo(sock.id), channelId: null });
    broadcastChannelList();
  }

  socket.on('signal',         ({ targetId, data } = {}) => { if (targetId && data) socket.to(targetId).emit('signal',         { fromId: socket.id, data }); });
  socket.on('private-signal', ({ targetId, data } = {}) => { if (targetId && data) socket.to(targetId).emit('private-signal', { fromId: socket.id, data }); });

  socket.on('speaking', ({ isSpeaking } = {}) => {
    const { channelId } = getUserInfo(socket.id); if (!channelId) return;
    const ch = channels.get(channelId); if (!ch || ch.muted.has(socket.id)) return;
    const cu = ch.users.get(socket.id); if (cu) cu.isSpeaking = !!isSpeaking;
    if (isSpeaking) { ch.hasActivity = true; ch.lastActivity = Date.now(); }
    socket.to(channelId).emit('user-speaking', { socketId: socket.id, isSpeaking: !!isSpeaking });
  });

  socket.on('chat-message', ({ text } = {}) => {
    const { channelId, username } = getUserInfo(socket.id); if (!channelId || !String(text||'').trim()) return;
    const ch = channels.get(channelId); if (!ch) return;
    const msg = { id: `${socket.id}-${Date.now()}`, socketId: socket.id, username, text: String(text).trim().slice(0,500), timestamp: new Date().toISOString() };
    ch.messages.push(msg); if (ch.messages.length > 200) ch.messages.shift();
    io.to(channelId).emit('chat-message', msg);
  });

  socket.on('private-message', ({ targetId, text } = {}) => {
    if (!targetId || !text) return;
    const { username } = getUserInfo(socket.id);
    const msg = { fromId: socket.id, fromName: username, text: String(text).trim().slice(0,500), timestamp: new Date().toISOString() };
    socket.to(targetId).emit('private-message', msg);
    socket.emit('private-message-sent', { ...msg, toId: targetId });
  });

  socket.on('mute-user',     ({ targetId, muted } = {}) => { const { channelId } = getUserInfo(socket.id); if (!channelId) return; const ch = channels.get(channelId); if (!ch || !isPrivileged(ch, socket.id)) return; muted ? ch.muted.add(targetId) : ch.muted.delete(targetId); io.to(targetId).emit('you-were-muted', { muted }); io.to(channelId).emit('user-muted', { socketId: targetId, muted }); io.to(channelId).emit('roster-update', channelRoster(ch)); });
  socket.on('kick-user',     ({ targetId } = {}) => { const { channelId } = getUserInfo(socket.id); if (!channelId) return; const ch = channels.get(channelId); if (!ch || !isPrivileged(ch, socket.id) || targetId === ch.host) return; io.to(targetId).emit('you-were-kicked', { channelId }); const s = io.sockets.sockets.get(targetId); if (s) doLeave(s); });
  socket.on('assign-cohost', ({ targetId, isCohost } = {}) => { const { channelId } = getUserInfo(socket.id); if (!channelId) return; const ch = channels.get(channelId); if (!ch || ch.host !== socket.id) return; isCohost ? ch.cohosts.add(targetId) : ch.cohosts.delete(targetId); io.to(targetId).emit('your-role-changed', { isCohost, channelId }); io.to(channelId).emit('roster-update', channelRoster(ch)); });

  socket.on('get-channels', () => socket.emit('channel-list', publicChannelList()));
  socket.on('disconnect',   () => { doLeave(socket); users.delete(socket.id); });
  socket.emit('channel-list', publicChannelList());
});

setInterval(() => { const t = Date.now()-4000; for (const ch of channels.values()) if (ch.hasActivity && ch.lastActivity < t) ch.hasActivity = false; }, 5000);

function getLanIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const iface of ifaces)
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
  return ips;
}

srv.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIPs();
  console.log(`[S-talk] Server on port ${PORT}`);
  console.log(`[S-talk] LAN: ${ips.join(', ')}`);
  bridge.send('message', { event: 'server-ready', port: PORT, lanIPs: ips });
});
