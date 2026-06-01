'use strict';
require('dotenv').config();

const express    = require('express');
const https      = require('https');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const os         = require('os');
const selfsigned = require('selfsigned');
const mongoose   = require('mongoose');

// ── TLS ───────────────────────────────────────────────────────────
const pems = selfsigned.generate([{ name: 'commonName', value: 's-talk' }], {
  days: 365, algorithm: 'sha256', keySize: 2048,
});

const app      = express();
const useHttps = !process.env.NO_HTTPS;
const server   = useHttps
  ? https.createServer({ key: pems.private, cert: pems.cert }, app)
  : http.createServer(app);

const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:        30000,
  pingInterval:       10000,
  maxHttpBufferSize:  1e6,
  // Force WebSocket only — avoids sticky-session issues on Render free tier
  transports:         ['websocket'],
  allowUpgrades:      false,
});

// ── MongoDB ───────────────────────────────────────────────────────
let dbConnected = false;

// Define models ONCE at top level — never inside handlers
const MessageSchema = new mongoose.Schema({
  id:        String,
  channelId: { type: String, index: true },
  socketId:  String,
  username:  String,
  text:      String,
  timestamp: { type: Date, default: Date.now },
});
const ChannelMetaSchema = new mongoose.Schema({
  channelId:  { type: String, unique: true },
  isPrivate:  Boolean,
  lastActive: Date,
  createdBy:  String,
});

const Message     = mongoose.model('Message',     MessageSchema);
const ChannelMeta = mongoose.model('ChannelMeta', ChannelMetaSchema);

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => { dbConnected = true; console.log('✅ MongoDB connected'); })
    .catch(e => console.warn('⚠️  MongoDB:', e.message));
}

// ── In-memory state ───────────────────────────────────────────────
const channels = new Map();
const users    = new Map();

function getOrCreate(channelId, password, hostSocketId) {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      users:         new Map(),
      password:      password || null,
      host:          hostSocketId,
      cohosts:       new Set(),
      muted:         new Set(),
      messages:      [],
      memberHistory: new Map(),
      hasActivity:   false,
      lastActivity:  null,
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

function isPrivileged(ch, sid) {
  return ch.host === sid || ch.cohosts.has(sid);
}

function publicChannelList() {
  const list = [];
  for (const [id, ch] of channels) {
    if (!ch.password) {
      list.push({
        id,
        userCount:   ch.users.size,
        hasActivity: ch.hasActivity,
        users:       Array.from(ch.users.values()).map(u => u.username),
        host:        users.get(ch.host)?.username || '',
      });
    }
  }
  return list.sort((a, b) => {
    const na = Number(a.id), nb = Number(b.id);
    return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.id < b.id ? -1 : 1;
  });
}

function broadcastChannelList() { io.emit('channel-list', publicChannelList()); }

function channelRoster(ch) {
  const online = Array.from(ch.users.entries()).map(([sid, u]) => ({
    socketId:   sid,
    username:   u.username,
    isSpeaking: u.isSpeaking,
    isMuted:    ch.muted.has(sid),
    isHost:     ch.host === sid,
    isCohost:   ch.cohosts.has(sid),
    online:     true,
  }));
  const offline = [];
  for (const [uname, meta] of ch.memberHistory) {
    if (!meta.online) {
      offline.push({ socketId: null, username: uname, online: false, lastSeen: meta.lastSeen });
    }
  }
  return [...online, ...offline];
}

// ── REST ──────────────────────────────────────────────────────────
app.use(express.json());

// No-cache for HTML
app.get('/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_, res) =>
  res.json({ status: 'ok', db: dbConnected, channels: channels.size, users: users.size }));

app.get('/api/channels', (_, res) => res.json(publicChannelList()));

app.get('/api/network', (_, res) => {
  const nets = os.networkInterfaces();
  const lanIPs = [];
  for (const ifaces of Object.values(nets))
    for (const iface of ifaces)
      if (iface.family === 'IPv4' && !iface.internal) lanIPs.push(iface.address);
  const proto = useHttps ? 'https' : 'http';
  res.json({ urls: lanIPs.map(ip => `${proto}://${ip}:${PORT}`), port: PORT });
});

app.get('/api/channels/:id/messages', async (req, res) => {
  if (!dbConnected) return res.json([]);
  try {
    const msgs = await Message.find({ channelId: req.params.id })
      .sort({ timestamp: -1 }).limit(100).lean();
    res.json(msgs.reverse());
  } catch (e) { res.json([]); }
});

// ── Socket.io ─────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);
  users.set(socket.id, { username: 'Anonymous', channelId: null });

  socket.on('set-username', raw => {
    try {
      const username = String(raw || 'Anonymous').trim().slice(0, 24) || 'Anonymous';
      users.set(socket.id, { ...getUserInfo(socket.id), username });
    } catch (e) { console.error('set-username', e.message); }
  });

  socket.on('join-channel', async ({ channelId, password = '', username = 'Anonymous' } = {}) => {
    try {
      channelId = String(channelId || '').trim().slice(0, 32);
      if (!channelId) return;
      doLeave(socket);

      if (channels.has(channelId)) {
        const ch = channels.get(channelId);
        if (ch.password && ch.password !== password) {
          socket.emit('join-error', { message: 'Incorrect password.' }); return;
        }
      }

      const uname = String(username || 'Anonymous').trim().slice(0, 24) || 'Anonymous';
      const ch    = getOrCreate(channelId, password || null, socket.id);
      if (ch.users.size === 0) ch.host = socket.id;

      const existingPeers = Array.from(ch.users.entries())
        .map(([sid, info]) => ({ socketId: sid, username: info.username }));

      ch.users.set(socket.id, { username: uname, isSpeaking: false });
      ch.memberHistory.set(uname, { socketId: socket.id, lastSeen: Date.now(), online: true });
      users.set(socket.id, { username: uname, channelId });
      socket.join(channelId);

      let history = ch.messages.slice(-100);
      if (dbConnected) {
        try {
          const dbMsgs = await Message.find({ channelId }).sort({ timestamp: -1 }).limit(100).lean();
          history = dbMsgs.reverse();
        } catch (_) {}
      }

      socket.emit('joined-channel', {
        channelId, existingPeers,
        isPrivate: !!ch.password,
        messages:  history,
        isHost:    ch.host === socket.id,
        isCohost:  ch.cohosts.has(socket.id),
        isMuted:   ch.muted.has(socket.id),
        roster:    channelRoster(ch),
      });

      socket.to(channelId).emit('user-joined', { socketId: socket.id, username: uname });
      io.to(channelId).emit('roster-update', channelRoster(ch));
      broadcastChannelList();

      // Persist channel meta — use ChannelMeta model defined at top level
      if (dbConnected) {
        ChannelMeta.findOneAndUpdate(
          { channelId },
          { isPrivate: !!ch.password, lastActive: new Date(), $setOnInsert: { channelId, createdBy: uname } },
          { upsert: true, new: true }
        ).catch(() => {});
      }
    } catch (e) { console.error('join-channel', e.message); }
  });

  socket.on('leave-channel', () => { try { doLeave(socket); } catch (e) { console.error('leave', e.message); } });

  function doLeave(sock) {
    const { channelId } = getUserInfo(sock.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (ch) {
      const uname = ch.users.get(sock.id)?.username;
      ch.users.delete(sock.id);
      ch.muted.delete(sock.id);
      if (uname) ch.memberHistory.set(uname, { socketId: null, lastSeen: Date.now(), online: false });

      if (ch.host === sock.id && ch.users.size > 0) {
        const newHost = ch.cohosts.size > 0 ? [...ch.cohosts][0] : [...ch.users.keys()][0];
        ch.host = newHost;
        ch.cohosts.delete(newHost);
        io.to(channelId).emit('host-changed', {
          newHostId:   newHost,
          newHostName: ch.users.get(newHost)?.username,
        });
      }

      sock.leave(channelId);
      sock.to(channelId).emit('user-left', { socketId: sock.id });
      io.to(channelId).emit('roster-update', channelRoster(ch));
      pruneChannel(channelId);
    }
    users.set(sock.id, { ...getUserInfo(sock.id), channelId: null });
    broadcastChannelList();
  }

  socket.on('signal', ({ targetId, data } = {}) => {
    try { if (targetId && data) socket.to(targetId).emit('signal', { fromId: socket.id, data }); }
    catch (e) { console.error('signal', e.message); }
  });

  socket.on('private-signal', ({ targetId, data } = {}) => {
    try { if (targetId && data) socket.to(targetId).emit('private-signal', { fromId: socket.id, data }); }
    catch (e) {}
  });

  socket.on('speaking', ({ isSpeaking } = {}) => {
    try {
      const { channelId } = getUserInfo(socket.id);
      if (!channelId) return;
      const ch = channels.get(channelId);
      if (!ch || ch.muted.has(socket.id)) return;
      const cu = ch.users.get(socket.id);
      if (cu) cu.isSpeaking = !!isSpeaking;
      if (isSpeaking) { ch.hasActivity = true; ch.lastActivity = Date.now(); }
      socket.to(channelId).emit('user-speaking', { socketId: socket.id, isSpeaking: !!isSpeaking });
    } catch (e) {}
  });

  socket.on('chat-message', async ({ text } = {}) => {
    try {
      const { channelId, username } = getUserInfo(socket.id);
      if (!channelId || !String(text || '').trim()) return;
      const ch = channels.get(channelId);
      if (!ch) return;
      const msg = {
        id: `${socket.id}-${Date.now()}`, socketId: socket.id, username,
        text: String(text).trim().slice(0, 500), timestamp: new Date().toISOString(),
      };
      ch.messages.push(msg);
      if (ch.messages.length > 200) ch.messages.shift();
      io.to(channelId).emit('chat-message', msg);
      if (dbConnected) Message.create({ ...msg, channelId }).catch(() => {});
    } catch (e) { console.error('chat-message', e.message); }
  });

  socket.on('private-message', ({ targetId, text } = {}) => {
    try {
      if (!targetId || !text) return;
      const { username } = getUserInfo(socket.id);
      const msg = { fromId: socket.id, fromName: username, text: String(text).trim().slice(0, 500), timestamp: new Date().toISOString() };
      socket.to(targetId).emit('private-message', msg);
      socket.emit('private-message-sent', { ...msg, toId: targetId });
    } catch (e) {}
  });

  socket.on('mute-user', ({ targetId, muted } = {}) => {
    try {
      const { channelId } = getUserInfo(socket.id);
      if (!channelId) return;
      const ch = channels.get(channelId);
      if (!ch || !isPrivileged(ch, socket.id)) return;
      muted ? ch.muted.add(targetId) : ch.muted.delete(targetId);
      io.to(targetId).emit('you-were-muted', { muted });
      io.to(channelId).emit('user-muted', { socketId: targetId, muted });
      io.to(channelId).emit('roster-update', channelRoster(ch));
    } catch (e) {}
  });

  socket.on('kick-user', ({ targetId } = {}) => {
    try {
      const { channelId } = getUserInfo(socket.id);
      if (!channelId) return;
      const ch = channels.get(channelId);
      if (!ch || !isPrivileged(ch, socket.id) || targetId === ch.host) return;
      io.to(targetId).emit('you-were-kicked', { channelId });
      const targetSock = io.sockets.sockets.get(targetId);
      if (targetSock) doLeave(targetSock);
    } catch (e) {}
  });

  socket.on('assign-cohost', ({ targetId, isCohost } = {}) => {
    try {
      const { channelId } = getUserInfo(socket.id);
      if (!channelId) return;
      const ch = channels.get(channelId);
      if (!ch || ch.host !== socket.id) return;
      isCohost ? ch.cohosts.add(targetId) : ch.cohosts.delete(targetId);
      io.to(targetId).emit('your-role-changed', { isCohost, channelId });
      io.to(channelId).emit('roster-update', channelRoster(ch));
    } catch (e) {}
  });

  socket.on('reinvite-member', ({ username } = {}) => {
    try {
      const { channelId } = getUserInfo(socket.id);
      if (!channelId) return;
      const ch = channels.get(channelId);
      if (!ch || !isPrivileged(ch, socket.id)) return;
      for (const [sid, u] of users) {
        if (u.username === username && !u.channelId) {
          io.to(sid).emit('reinvite', { channelId, fromName: getUserInfo(socket.id).username });
          break;
        }
      }
    } catch (e) {}
  });

  socket.on('get-channels', () => {
    try { socket.emit('channel-list', publicChannelList()); } catch (e) {}
  });

  socket.on('disconnect', reason => {
    console.log(`[-] ${socket.id} (${reason})`);
    try { doLeave(socket); } catch (e) {}
    users.delete(socket.id);
  });

  socket.on('error', err => { console.error('socket error', err.message); });

  socket.emit('channel-list', publicChannelList());
});

// ── Decay activity ────────────────────────────────────────────────
setInterval(() => {
  const t = Date.now() - 4000;
  for (const ch of channels.values())
    if (ch.hasActivity && ch.lastActivity < t) ch.hasActivity = false;
}, 5000);

// ── Keep-alive self-ping ──────────────────────────────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    https.get(`https://${RENDER_URL}/api/health`, res => res.resume())
      .on('error', () => {});
  }, 10 * 60 * 1000);
  console.log(`🏓 Self-ping active → https://${RENDER_URL}/api/health`);
}

// ── Global error guards — prevent crash on unhandled errors ───────
process.on('uncaughtException',  err => console.error('Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('Rejection:', err?.message || err));

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lanIPs = [];
  for (const ifaces of Object.values(nets))
    for (const iface of ifaces)
      if (iface.family === 'IPv4' && !iface.internal) lanIPs.push(iface.address);
  const proto = useHttps ? 'https' : 'http';
  console.log(`\n🎙️  S-talk Server Ready`);
  console.log(`   Local  : ${proto}://localhost:${PORT}`);
  lanIPs.forEach(ip => console.log(`   Network: ${proto}://${ip}:${PORT}`));
  console.log(`   DB: ${dbConnected ? 'MongoDB ✅' : 'In-memory'}\n`);
});

module.exports = { app, server };
