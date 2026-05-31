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

// ── TLS (self-signed for LAN / HTTPS) ────────────────────────────────────────
const pems = selfsigned.generate([{ name: 'commonName', value: 's-talk' }], {
  days: 365, algorithm: 'sha256', keySize: 2048,
});

const app        = express();
const isElectron = !!process.env.ELECTRON;
const useHttps   = !process.env.NO_HTTPS;

// Railway / Render set PORT env. For LAN use https (mic requires it on mobile).
const server = useHttps
  ? https.createServer({ key: pems.private, cert: pems.cert }, app)
  : http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
  // Polling fallback for environments that don't support websockets (Vercel edge)
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 3000;

// ── MongoDB ───────────────────────────────────────────────────────────────────
let dbConnected = false;

const MessageSchema = new mongoose.Schema({
  id:        { type: String, required: true },
  channelId: { type: String, required: true, index: true },
  socketId:  String,
  username:  String,
  text:      String,
  timestamp: { type: Date, default: Date.now },
});
const ChannelMeta = mongoose.model('ChannelMeta', new mongoose.Schema({
  channelId:   { type: String, unique: true },
  isPrivate:   Boolean,
  createdAt:   { type: Date, default: Date.now },
  lastActive:  Date,
  createdBy:   String,
}));
const Message = mongoose.model('Message', MessageSchema);

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => { dbConnected = true; console.log('✅ MongoDB connected'); })
    .catch(err => console.warn('⚠️  MongoDB error — running in-memory only:', err.message));
}

// ── In-memory state ───────────────────────────────────────────────────────────
const channels = new Map();   // channelId → { users, password, messages, hasActivity, lastActivity }
const users    = new Map();   // socketId  → { username, channelId }

// ── Helpers ───────────────────────────────────────────────────────────────────
function getOrCreate(channelId, password = null) {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      users: new Map(), password, messages: [],
      hasActivity: false, lastActivity: null,
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

// ── REST ──────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', db: dbConnected, channels: channels.size, users: users.size }));

app.get('/api/channels', (_req, res) => res.json(publicChannelList()));

// Fetch persistent message history for a channel
app.get('/api/channels/:id/messages', async (req, res) => {
  if (!dbConnected) return res.json([]);
  const msgs = await Message.find({ channelId: req.params.id })
    .sort({ timestamp: -1 }).limit(100).lean();
  res.json(msgs.reverse());
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);
  users.set(socket.id, { username: 'Anonymous', channelId: null });

  socket.on('set-username', raw => {
    const username = String(raw || 'Anonymous').trim().slice(0, 24) || 'Anonymous';
    users.set(socket.id, { ...getUserInfo(socket.id), username });
  });

  socket.on('join-channel', async ({ channelId, password = '', username = 'Anonymous' }) => {
    channelId = String(channelId).trim().slice(0, 32);
    if (!channelId) return;
    doLeave(socket);

    // Auth
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

    // Load message history (DB preferred, else in-memory)
    let history = ch.messages.slice(-100);
    if (dbConnected) {
      try {
        const dbMsgs = await Message.find({ channelId }).sort({ timestamp: -1 }).limit(100).lean();
        history = dbMsgs.reverse().map(m => ({
          id: m.id, socketId: m.socketId, username: m.username,
          text: m.text, timestamp: m.timestamp,
        }));
      } catch (_) {}
    }

    socket.emit('joined-channel', {
      channelId, existingPeers,
      isPrivate: !!ch.password,
      messages: history,
    });

    socket.to(channelId).emit('user-joined', { socketId: socket.id, username: uname });

    // Persist channel meta to DB
    if (dbConnected) {
      ChannelMeta.findOneAndUpdate(
        { channelId },
        { isPrivate: !!ch.password, lastActive: new Date(), $setOnInsert: { channelId, createdBy: uname } },
        { upsert: true, new: true }
      ).catch(() => {});
    }

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

  // WebRTC signaling
  socket.on('signal', ({ targetId, data }) => {
    if (targetId && data) socket.to(targetId).emit('signal', { fromId: socket.id, data });
  });

  // Speaking indicator
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

  // Chat message
  socket.on('chat-message', async ({ text }) => {
    const { channelId, username } = getUserInfo(socket.id);
    if (!channelId || !String(text || '').trim()) return;
    const ch = channels.get(channelId);
    if (!ch) return;

    const msg = {
      id:        `${socket.id}-${Date.now()}`,
      socketId:  socket.id,
      username,
      text:      String(text).trim().slice(0, 500),
      timestamp: new Date().toISOString(),
    };

    ch.messages.push(msg);
    if (ch.messages.length > 200) ch.messages.shift();
    io.to(channelId).emit('chat-message', msg);

    // Persist to DB
    if (dbConnected) {
      Message.create({ ...msg, channelId }).catch(() => {});
    }
  });

  socket.on('get-channels', () => socket.emit('channel-list', publicChannelList()));

  socket.on('disconnect', () => {
    doLeave(socket);
    users.delete(socket.id);
    console.log(`[-] ${socket.id}`);
  });

  socket.emit('channel-list', publicChannelList());
});

// ── Decay activity ────────────────────────────────────────────────────────────
setInterval(() => {
  const threshold = Date.now() - 4000;
  for (const ch of channels.values()) {
    if (ch.hasActivity && ch.lastActivity < threshold) ch.hasActivity = false;
  }
}, 5000);

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const nets   = os.networkInterfaces();
  const lanIPs = [];
  for (const ifaces of Object.values(nets))
    for (const iface of ifaces)
      if (iface.family === 'IPv4' && !iface.internal) lanIPs.push(iface.address);

  const proto = useHttps ? 'https' : 'http';
  const bar = '─'.repeat(52);
  console.log(`\n┌${bar}┐`);
  console.log(`│   🎙️  S-talk  —  Server Ready                │`);
  console.log(`├${bar}┤`);
  console.log(`│  ► Local  :  ${proto}://localhost:${PORT}                    │`);
  lanIPs.forEach(ip => console.log(`│  ► LAN    :  ${proto}://${ip}:${PORT}                    │`));
  if (dbConnected) console.log(`│  ► DB     :  MongoDB connected ✅                  │`);
  else             console.log(`│  ► DB     :  In-memory (set MONGODB_URI for DB)    │`);
  console.log(`└${bar}┘\n`);
});

module.exports = { app, server };
