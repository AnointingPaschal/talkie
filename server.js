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

const pems = selfsigned.generate([{ name: 'commonName', value: 's-talk' }], {
  days: 365, algorithm: 'sha256', keySize: 2048,
});

const app       = express();
const useHttps  = !process.env.NO_HTTPS;
const server    = useHttps
  ? https.createServer({ key: pems.private, cert: pems.cert }, app)
  : http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000, pingInterval: 25000,
  maxHttpBufferSize: 1e6,
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 3000;

// ── MongoDB ───────────────────────────────────────────────────────
let dbConnected = false;
const MsgSchema = new mongoose.Schema({
  id: String, channelId: { type: String, index: true },
  socketId: String, username: String, text: String,
  timestamp: { type: Date, default: Date.now },
});
const Message = mongoose.model('Message', MsgSchema);

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => { dbConnected = true; console.log('✅ MongoDB connected'); })
    .catch(e => console.warn('⚠️  MongoDB:', e.message));
}

// ── Channel structure ─────────────────────────────────────────────
// channels: Map<channelId, {
//   users: Map<socketId, UserInfo>,
//   password: string|null,
//   host: socketId,
//   cohosts: Set<socketId>,
//   muted: Set<socketId>,
//   messages: [],
//   memberHistory: Map<username, { socketId|null, lastSeen, online }>,
//   hasActivity: bool, lastActivity: number
// }>
const channels = new Map();
const users    = new Map(); // socketId → { username, channelId }

function getOrCreate(channelId, password = null, hostSocketId) {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      users:         new Map(),
      password,
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
  // Send full roster including offline members
  const online = Array.from(ch.users.entries()).map(([sid, u]) => ({
    socketId: sid,
    username: u.username,
    isSpeaking: u.isSpeaking,
    isMuted:   ch.muted.has(sid),
    isHost:    ch.host === sid,
    isCohost:  ch.cohosts.has(sid),
    online:    true,
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

// Never cache HTML — always serve fresh
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
  const msgs = await Message.find({ channelId: req.params.id })
    .sort({ timestamp: -1 }).limit(100).lean();
  res.json(msgs.reverse());
});

// ── Socket.io ─────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);
  users.set(socket.id, { username: 'Anonymous', channelId: null });

  socket.on('set-username', raw => {
    const username = String(raw || 'Anonymous').trim().slice(0, 24) || 'Anonymous';
    users.set(socket.id, { ...getUserInfo(socket.id), username });
  });

  // ── Join ──────────────────────────────────────────────────────
  socket.on('join-channel', async ({ channelId, password = '', username = 'Anonymous' }) => {
    channelId = String(channelId).trim().slice(0, 32);
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

    // If first user, they become host
    if (ch.users.size === 0) ch.host = socket.id;

    const existingPeers = Array.from(ch.users.entries())
      .map(([sid, info]) => ({ socketId: sid, username: info.username }));

    ch.users.set(socket.id, { username: uname, isSpeaking: false });
    ch.memberHistory.set(uname, { socketId: socket.id, lastSeen: Date.now(), online: true });
    users.set(socket.id, { username: uname, channelId });
    socket.join(channelId);

    // Load history
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

    // Broadcast updated roster to all
    io.to(channelId).emit('roster-update', channelRoster(ch));

    if (dbConnected) {
      mongoose.model('ChannelMeta', new mongoose.Schema({ channelId: { type: String, unique: true }, isPrivate: Boolean, lastActive: Date, createdBy: String }))
        .findOneAndUpdate({ channelId }, { isPrivate: !!ch.password, lastActive: new Date(), $setOnInsert: { channelId, createdBy: uname } }, { upsert: true, new: true })
        .catch(() => {});
    }

    broadcastChannelList();
  });

  socket.on('leave-channel', () => doLeave(socket));

  function doLeave(sock) {
    const { channelId } = getUserInfo(sock.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (ch) {
      const uname = ch.users.get(sock.id)?.username;
      ch.users.delete(sock.id);
      ch.muted.delete(sock.id);

      // Mark offline in history
      if (uname) {
        ch.memberHistory.set(uname, { socketId: null, lastSeen: Date.now(), online: false });
      }

      // Transfer host if host left
      if (ch.host === sock.id && ch.users.size > 0) {
        // Promote oldest cohost, or first user
        const newHost = ch.cohosts.size > 0
          ? [...ch.cohosts][0]
          : [...ch.users.keys()][0];
        ch.host = newHost;
        ch.cohosts.delete(newHost);
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

  // ── WebRTC signaling ──────────────────────────────────────────
  socket.on('signal', ({ targetId, data }) => {
    if (targetId && data) socket.to(targetId).emit('signal', { fromId: socket.id, data });
  });

  // ── Speaking ──────────────────────────────────────────────────
  socket.on('speaking', ({ isSpeaking }) => {
    const { channelId } = getUserInfo(socket.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (!ch) return;
    if (ch.muted.has(socket.id)) return; // server-enforced mute
    const cu = ch.users.get(socket.id);
    if (cu) cu.isSpeaking = !!isSpeaking;
    if (isSpeaking) { ch.hasActivity = true; ch.lastActivity = Date.now(); }
    socket.to(channelId).emit('user-speaking', { socketId: socket.id, isSpeaking: !!isSpeaking });
  });

  // ── Chat ──────────────────────────────────────────────────────
  socket.on('chat-message', async ({ text }) => {
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
  });

  // ── Private message ───────────────────────────────────────────
  socket.on('private-message', ({ targetId, text }) => {
    if (!targetId || !text) return;
    const { username } = getUserInfo(socket.id);
    const msg = {
      fromId: socket.id, fromName: username,
      text: String(text).trim().slice(0, 500),
      timestamp: new Date().toISOString(),
    };
    socket.to(targetId).emit('private-message', msg);
    socket.emit('private-message-sent', { ...msg, toId: targetId });
  });

  // ── Private call (WebRTC direct) ──────────────────────────────
  socket.on('private-signal', ({ targetId, data }) => {
    if (targetId && data) socket.to(targetId).emit('private-signal', { fromId: socket.id, data });
  });

  // ── Host: mute user ───────────────────────────────────────────
  socket.on('mute-user', ({ targetId, muted }) => {
    const { channelId } = getUserInfo(socket.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (!ch || !isPrivileged(ch, socket.id)) return;
    if (muted) ch.muted.add(targetId);
    else       ch.muted.delete(targetId);
    io.to(targetId).emit('you-were-muted', { muted });
    io.to(channelId).emit('user-muted', { socketId: targetId, muted });
    io.to(channelId).emit('roster-update', channelRoster(ch));
  });

  // ── Host: kick user ───────────────────────────────────────────
  socket.on('kick-user', ({ targetId }) => {
    const { channelId } = getUserInfo(socket.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (!ch || !isPrivileged(ch, socket.id)) return;
    if (targetId === ch.host) return; // can't kick host
    io.to(targetId).emit('you-were-kicked', { channelId });
    const targetSock = io.sockets.sockets.get(targetId);
    if (targetSock) doLeave(targetSock);
  });

  // ── Host: assign cohost ───────────────────────────────────────
  socket.on('assign-cohost', ({ targetId, isCohost }) => {
    const { channelId } = getUserInfo(socket.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (!ch || ch.host !== socket.id) return; // only host can assign
    if (isCohost) ch.cohosts.add(targetId);
    else          ch.cohosts.delete(targetId);
    io.to(targetId).emit('your-role-changed', { isCohost, channelId });
    io.to(channelId).emit('roster-update', channelRoster(ch));
  });

  // ── Host: rescan & reinvite offline member ────────────────────
  socket.on('reinvite-member', ({ username }) => {
    const { channelId } = getUserInfo(socket.id);
    if (!channelId) return;
    const ch = channels.get(channelId);
    if (!ch || !isPrivileged(ch, socket.id)) return;
    // Find their socket if reconnected elsewhere
    for (const [sid, u] of users) {
      if (u.username === username && !u.channelId) {
        io.to(sid).emit('reinvite', { channelId, fromName: getUserInfo(socket.id).username });
        break;
      }
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

// ── Decay activity ────────────────────────────────────────────────
setInterval(() => {
  const t = Date.now() - 4000;
  for (const ch of channels.values())
    if (ch.hasActivity && ch.lastActivity < t) ch.hasActivity = false;
}, 5000);

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
  console.log(`   DB     : ${dbConnected ? 'MongoDB ✅' : 'In-memory'}\n`);
});

module.exports = { app, server };
