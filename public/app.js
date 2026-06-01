/* S-talk — Frontend v4 */
'use strict';

const state = {
  socket: null, localStream: null, audioCtx: null, analyser: null,
  peers: new Map(), peerAudios: new Map(), peerUsernames: new Map(),
  privatePeers: new Map(), privatePeerAudios: new Map(),
  channel: null, username: '', pendingChannel: null,
  isHost: false, isCohost: false, isMuted: false,
  roster: [],  // full member list including offline
  mode: 'ptt', isTransmitting: false, isSpeaking: false,
  isOutgoingMuted: false,
  autoRescan: false, rescanTimer: null,
  channelList: [], vuBars: [],
  speakTimer: null, toastTimer: null, missedCandidates: new Map(),
  activeDM: null, // { socketId, username }
  dmMessages: new Map(), // socketId → [{fromName, text, ts, outgoing}]
  networkInfo: { type: 'unknown', strength: 0, rtt: 0 },
};

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'stun:stun.stunprotocol.org:3478' },
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

function $(id) { return document.getElementById(id); }
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomChannel() { return String(Math.floor(Math.random() * 9000) + 1000); }

function showToast(msg, type = 'info', ms = 3500) {
  clearTimeout(state.toastTimer);
  const el = $('toast');
  el.textContent = msg;
  el.className = `fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] px-5 py-2.5 rounded-full text-sm font-medium shadow-xl whitespace-nowrap pointer-events-none transition-all duration-300 toast-show toast-${type}`;
  state.toastTimer = setTimeout(() => {
    el.className = 'fixed bottom-24 left-1/2 -translate-x-1/2 translate-y-20 opacity-0 pointer-events-none z-[9999] px-5 py-2.5 rounded-full text-sm font-medium shadow-xl whitespace-nowrap transition-all duration-300';
  }, ms);
}

// ── Server detection ──────────────────────────────────────────────
async function detectServer() {
  const saved = localStorage.getItem('wt_server');
  if (saved) return saved;
  if (window.Capacitor?.isNativePlatform()) return 'http://localhost:3000';
  if (window.electronAPI) return 'https://localhost:3000';
  try {
    const res  = await fetch('/api/network', { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    for (const url of (data.urls || [])) {
      try {
        const p = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1500) });
        if (p.ok) return url;
      } catch (_) {}
    }
  } catch (_) {}
  return window.location.origin;
}
function getServerUrl() {
  if (window.Capacitor?.isNativePlatform()) return 'http://localhost:3000';
  if (window.electronAPI) return 'https://localhost:3000';
  return localStorage.getItem('wt_server') || window.location.origin;
}

// ── DOMContentLoaded ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildVUMeter();
  wireSetupScreen();
  wirePTT();
  wireModeButtons();
  wireChannelControls();
  wireChat();
  wireServerSwitch();
  wireNetworkInfo();
  wireDM();
  wireRescanToggle();
});

// ── VU Meter ──────────────────────────────────────────────────────
function buildVUMeter() {
  const c = $('vu-bars');
  for (let i = 0; i < 30; i++) {
    const b = document.createElement('div'); b.className = 'vu-bar'; c.appendChild(b); state.vuBars.push(b);
  }
}
function animateVU() {
  if (!state.analyser) return;
  const data = new Uint8Array(state.analyser.frequencyBinCount);
  const dark  = () => document.documentElement.classList.contains('dark');
  function frame() {
    requestAnimationFrame(frame);
    state.analyser.getByteFrequencyData(data);
    let sum = 0; const lo = 2, hi = Math.floor(data.length * .75);
    for (let i = lo; i < hi; i++) sum += data[i];
    const level = sum / ((hi - lo) * 255);
    const active = state.isTransmitting;
    const n = state.vuBars.length;
    for (let i = 0; i < n; i++) {
      const t = i / n, lit = active && level > t * .55;
      const pct = lit ? Math.min(100, 10 + (level - t * .55) * 260) : 6;
      state.vuBars[i].style.height = pct + '%';
      let c;
      if (i < n * .6)       c = lit ? '#34d399' : (dark() ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)');
      else if (i < n * .82) c = lit ? '#fbbf24' : (dark() ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)');
      else                  c = lit ? '#fb7185' : (dark() ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)');
      state.vuBars[i].style.background = c;
    }
    if (active) {
      const speaking = level > .04;
      if (speaking !== state.isSpeaking) {
        clearTimeout(state.speakTimer);
        if (!speaking) state.speakTimer = setTimeout(() => { state.isSpeaking = false; state.socket?.emit('speaking', { isSpeaking: false }); }, 400);
        else { state.isSpeaking = true; state.socket?.emit('speaking', { isSpeaking: true }); }
      }
    }
  }
  frame();
}

// ── Setup ─────────────────────────────────────────────────────────
function wireSetupScreen() {
  $('start-btn').addEventListener('click', handleStart);
  $('username-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleStart(); });
  $('custom-ch-chk').addEventListener('change', function() {
    $('custom-ch-wrap').classList.toggle('hidden', !this.checked);
    if (this.checked) $('custom-ch-input').focus();
  });
}

async function handleStart() {
  const raw = $('username-input').value.trim();
  state.username = raw || 'Anonymous';
  const useCustom = $('custom-ch-chk')?.checked;
  const customVal = useCustom ? ($('custom-ch-input')?.value.trim() || '') : '';
  state.pendingChannel = useCustom ? (customVal || randomChannel()) : randomChannel();

  setSetupStatus('Requesting microphone…', 'text-indigo-500');
  $('start-btn').disabled = true;
  const ok = await requestMic();
  if (!ok) { $('start-btn').disabled = false; return; }
  setSetupStatus('Connecting…', 'text-indigo-500');
  await initSocket();
  $('setup-screen').classList.add('hidden');
  $('main-app').classList.remove('hidden');
  $('username-pill').textContent = state.username;
}

function setSetupStatus(msg, cls = 'text-gray-400') {
  const el = $('setup-status'); el.textContent = msg; el.className = `text-xs text-center min-h-4 ${cls}`;
}

// ── Mic ───────────────────────────────────────────────────────────
async function requestMic() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        channelCount: 1, sampleRate: { ideal: 22050 },
      }, video: false,
    });
    state.localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    setupAnalyser();
    return true;
  } catch (err) {
    let msg = '❌ ' + err.message;
    if (err.name === 'NotAllowedError')  msg = '❌ Microphone access denied.';
    if (err.name === 'NotFoundError')    msg = '❌ No microphone found.';
    if (err.name === 'NotReadableError') msg = '❌ Mic in use by another app.';
    setSetupStatus(msg, 'text-rose-500');
    return false;
  }
}

function setupAnalyser() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  state.audioCtx = new Ctx();
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 512; state.analyser.smoothingTimeConstant = .75;
  state.audioCtx.createMediaStreamSource(state.localStream).connect(state.analyser);
  animateVU();
}

// ── Socket ────────────────────────────────────────────────────────
async function initSocket() {
  const url = await detectServer();
  // Show connecting state immediately
  setConnStatus('connecting');

  state.socket = io(url, {
    rejectUnauthorized:    false,
    transports:            ['websocket', 'polling'], // polling fallback for restrictive networks
    upgrade:               true,
    reconnectionDelay:     1000,
    reconnectionDelayMax:  5000,
    reconnectionAttempts:  Infinity,
    timeout:               20000,
  });

  state.socket.on('connect', () => {
    setConnStatus('online');
    state.socket.emit('set-username', state.username);
    state.socket.emit('get-channels');
    updateServerBadge(url);
    if (state.pendingChannel) {
      _joinChannel(state.pendingChannel, ''); state.pendingChannel = null;
    }
  });

  state.socket.on('disconnect', () => {
    setConnStatus('offline');
    for (const id of [...state.peers.keys()]) removePeer(id);
    state.peerUsernames.clear();
    const prevCh = state.channel;
    state.channel = null;
    updateStatus(); setChannelUIState(false);
    if (state.autoRescan && prevCh) scheduleRescan(prevCh);
  });

  state.socket.on('reconnecting', attempt => {
    setConnStatus('connecting');
    if (attempt > 1) showToast(`🔄 Reconnecting… (${attempt})`, 'warning', 2000);
  });

  state.socket.on('connect_error', err => {
    setConnStatus('offline');
    console.warn('connect_error:', err.message);
  });

  state.socket.io.on('reconnect', () => {
    showToast('📡 Reconnected', 'success');
    if (state.channel) state.socket.emit('join-channel', { channelId: state.channel, username: state.username });
  });

  state.socket.io.on('reconnect_attempt', attempt => {
    setConnStatus('connecting');
  });

  state.socket.on('signal',         ({ fromId, data }) => handleSignal(fromId, data));
  state.socket.on('private-signal', ({ fromId, data }) => handlePrivateSignal(fromId, data));

  state.socket.on('joined-channel', ({ channelId, existingPeers, isPrivate, messages, isHost, isCohost, isMuted, roster }) => {
    clearRescan();
    state.channel   = channelId;
    state.isHost    = isHost;
    state.isCohost  = isCohost;
    state.isMuted   = isMuted;
    state.roster    = roster || [];
    updateStatus(); setChannelUIState(true);
    $('chat-ch-badge').textContent = 'CH ' + channelId + (isPrivate ? ' 🔒' : '');
    existingPeers.forEach(({ socketId, username }) => { state.peerUsernames.set(socketId, username); });
    existingPeers.forEach(({ socketId }) => createPeer(socketId, true));
    renderRoster(state.roster);
    clearChatPanel();
    messages.forEach(m => appendChatMsg(m, true));
    scrollChat();
    showToast(`✅ CH ${channelId}${isHost ? ' — You are host 👑' : ''}`, 'success');
    renderChannelList(state.channelList);
    updateHostUI();
    if (isMuted) showToast('🔇 You have been muted by the host', 'warning', 5000);
  });

  state.socket.on('user-joined', ({ socketId, username }) => {
    state.peerUsernames.set(socketId, username);
    appendSystemMsg(escHtml(username) + ' joined');
  });

  state.socket.on('user-left', ({ socketId }) => {
    const u = state.peerUsernames.get(socketId) || 'Someone';
    removePeer(socketId);
    state.peerUsernames.delete(socketId);
    state.missedCandidates.delete(socketId);
    appendSystemMsg(escHtml(u) + ' left');
  });

  state.socket.on('roster-update', roster => {
    state.roster = roster;
    renderRoster(roster);
  });

  state.socket.on('host-changed', ({ newHostId, newHostName }) => {
    if (newHostId === state.socket.id) {
      state.isHost = true;
      updateHostUI();
      showToast('👑 You are now the host', 'success');
    } else {
      showToast('👑 ' + newHostName + ' is now the host', 'info');
    }
  });

  state.socket.on('you-were-muted', ({ muted }) => {
    state.isMuted = muted;
    if (muted && state.isTransmitting) stopTX();
    showToast(muted ? '🔇 Host muted you' : '🔊 Host unmuted you', 'warning', 4000);
    updateHostUI();
  });

  state.socket.on('you-were-kicked', ({ channelId }) => {
    showToast('🚫 You were removed from CH ' + channelId, 'error', 6000);
    doLeave();
  });

  state.socket.on('your-role-changed', ({ isCohost }) => {
    state.isCohost = isCohost;
    updateHostUI();
    showToast(isCohost ? '⭐ You are now co-host' : 'Co-host removed', 'info', 4000);
  });

  state.socket.on('reinvite', ({ channelId, fromName }) => {
    const accept = confirm(`${fromName} is inviting you back to CH ${channelId}. Rejoin?`);
    if (accept) _joinChannel(channelId, '');
  });

  state.socket.on('user-speaking', ({ socketId, isSpeaking }) => {
    const el = $('ru-' + socketId);
    if (el) el.classList.toggle('roster-speaking', isSpeaking);
  });

  state.socket.on('user-muted', ({ socketId, muted }) => {
    const el = $('ru-' + socketId);
    if (el) el.querySelector('.muted-icon')?.classList.toggle('hidden', !muted);
  });

  state.socket.on('channel-list',  list => { state.channelList = list; renderChannelList(list); });
  state.socket.on('chat-message',  msg  => appendChatMsg(msg));

  state.socket.on('private-message', msg => {
    receiveDM(msg.fromId, msg.fromName, msg.text, msg.timestamp, false);
  });
  state.socket.on('private-message-sent', msg => {
    receiveDM(msg.toId, null, msg.text, msg.timestamp, true);
  });

  state.socket.on('join-error', ({ message }) => showToast('❌ ' + message, 'error'));
}

// ── WebRTC ────────────────────────────────────────────────────────
function createPeer(peerId, isInitiator) {
  if (state.peers.has(peerId)) return state.peers.get(peerId);
  const pc = new RTCPeerConnection(ICE);
  state.peers.set(peerId, pc); state.missedCandidates.set(peerId, []);
  if (state.localStream) state.localStream.getAudioTracks().forEach(t => pc.addTrack(t, state.localStream));
  pc.ontrack = ({ streams }) => {
    if (!streams[0]) return;
    let a = state.peerAudios.get(peerId);
    if (!a) { a = document.createElement('audio'); a.autoplay = true; a.style.display = 'none'; document.body.appendChild(a); state.peerAudios.set(peerId, a); }
    a.srcObject = streams[0]; a.muted = state.isOutgoingMuted;
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket.emit('signal', { targetId: peerId, data: { type: 'ice-candidate', payload: candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') { pc.restartIce(); setTimeout(() => { if (pc.connectionState === 'failed') removePeer(peerId); }, 8000); }
  };
  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        state.socket.emit('signal', { targetId: peerId, data: { type: 'offer', payload: pc.localDescription } });
      } catch (e) { console.error('offer', e); }
    };
  }
  return pc;
}

async function handleSignal(fromId, { type, payload }) {
  try {
    if (type === 'offer') {
      const pc = createPeer(fromId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      for (const c of (state.missedCandidates.get(fromId) || [])) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      state.missedCandidates.set(fromId, []);
      const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
      state.socket.emit('signal', { targetId: fromId, data: { type: 'answer', payload: pc.localDescription } });
    } else if (type === 'answer') {
      const pc = state.peers.get(fromId);
      if (pc && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        for (const c of (state.missedCandidates.get(fromId) || [])) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        state.missedCandidates.set(fromId, []);
      }
    } else if (type === 'ice-candidate') {
      const pc = state.peers.get(fromId); if (!pc || !payload) return;
      if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => {});
      else { const buf = state.missedCandidates.get(fromId) || []; buf.push(payload); state.missedCandidates.set(fromId, buf); }
    }
  } catch (e) { console.warn('signal', e); }
}

function removePeer(id) {
  const pc = state.peers.get(id); if (pc) { pc.close(); state.peers.delete(id); }
  const a = state.peerAudios.get(id); if (a) { a.srcObject = null; a.remove(); state.peerAudios.delete(id); }
}

// ── Private calls (WebRTC direct) ────────────────────────────────
async function startPrivateCall(targetId) {
  if (state.privatePeers.has(targetId)) return;
  const pc = new RTCPeerConnection(ICE);
  state.privatePeers.set(targetId, pc);
  if (state.localStream) state.localStream.getAudioTracks().forEach(t => pc.addTrack(t, state.localStream));
  pc.ontrack = ({ streams }) => {
    let a = state.privatePeerAudios.get(targetId);
    if (!a) { a = document.createElement('audio'); a.autoplay = true; a.style.display = 'none'; document.body.appendChild(a); state.privatePeerAudios.set(targetId, a); }
    a.srcObject = streams[0];
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket.emit('private-signal', { targetId, data: { type: 'ice-candidate', payload: candidate } });
  };
  pc.onnegotiationneeded = async () => {
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    state.socket.emit('private-signal', { targetId, data: { type: 'offer', payload: pc.localDescription } });
  };
}

async function handlePrivateSignal(fromId, { type, payload }) {
  try {
    if (type === 'offer') {
      const pc = new RTCPeerConnection(ICE);
      state.privatePeers.set(fromId, pc);
      if (state.localStream) state.localStream.getAudioTracks().forEach(t => pc.addTrack(t, state.localStream));
      pc.ontrack = ({ streams }) => {
        let a = state.privatePeerAudios.get(fromId);
        if (!a) { a = document.createElement('audio'); a.autoplay = true; a.style.display = 'none'; document.body.appendChild(a); state.privatePeerAudios.set(fromId, a); }
        a.srcObject = streams[0];
      };
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) state.socket.emit('private-signal', { targetId: fromId, data: { type: 'ice-candidate', payload: candidate } });
      };
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
      state.socket.emit('private-signal', { targetId: fromId, data: { type: 'answer', payload: pc.localDescription } });
    } else if (type === 'answer') {
      const pc = state.privatePeers.get(fromId);
      if (pc) { await pc.setRemoteDescription(new RTCSessionDescription(payload)); }
    } else if (type === 'ice-candidate') {
      const pc = state.privatePeers.get(fromId);
      if (pc && pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => {});
    }
  } catch (e) { console.warn('private signal', e); }
}

// ── PTT ───────────────────────────────────────────────────────────
function wirePTT() {
  const btn = $('ptt-btn');
  btn.addEventListener('mousedown',  e => { e.preventDefault(); onPress(); });
  btn.addEventListener('mouseup',    () => onRelease());
  btn.addEventListener('mouseleave', () => { if (state.isTransmitting && state.mode === 'ptt') onRelease(); });
  btn.addEventListener('touchstart', e => { e.preventDefault(); onPress(); },   { passive: false });
  btn.addEventListener('touchend',   e => { e.preventDefault(); onRelease(); }, { passive: false });
  btn.addEventListener('touchcancel',() => { if (state.mode === 'ptt') onRelease(); });
  document.addEventListener('keydown', e => { if (e.code === 'Space' && !e.repeat && !isTyping(e.target)) { e.preventDefault(); onPress(); } });
  document.addEventListener('keyup',   e => { if (e.code === 'Space' && !isTyping(e.target)) { e.preventDefault(); onRelease(); } });
}

function isTyping(el) { return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable; }

function onPress() {
  if (!state.channel) { showToast('⚠️ Join a channel first', 'warning'); return; }
  if (state.isMuted)  { showToast('🔇 You are muted by the host', 'warning'); return; }
  state.mode === 'ptt' ? startTX() : (state.isTransmitting ? stopTX() : startTX());
}
function onRelease() { if (state.mode === 'ptt' && state.isTransmitting) stopTX(); }

function startTX() {
  if (state.isTransmitting) return;
  if (state.audioCtx?.state === 'suspended') state.audioCtx.resume();
  state.isTransmitting = true;
  state.localStream?.getAudioTracks().forEach(t => { t.enabled = true; });
  $('ptt-btn').classList.add('transmitting');
  $('ptt-label').textContent = state.mode === 'ptt' ? 'TRANSMITTING…' : 'ON AIR';
  $('lcd-tx').textContent    = '● TX';
  $('lcd-signal').classList.add('active');
}

function stopTX() {
  if (!state.isTransmitting) return;
  state.isTransmitting = false;
  state.localStream?.getAudioTracks().forEach(t => { t.enabled = false; });
  clearTimeout(state.speakTimer);
  state.isSpeaking = false;
  state.socket?.emit('speaking', { isSpeaking: false });
  $('ptt-btn').classList.remove('transmitting');
  $('ptt-label').textContent = state.mode === 'ptt' ? 'PUSH TO TALK' : 'CLICK TO TALK';
  $('lcd-tx').textContent    = '';
  $('lcd-signal').classList.remove('active');
}

// ── Mode buttons ──────────────────────────────────────────────────
function wireModeButtons() {
  $('ptt-mode-btn').addEventListener('click', () => setMode('ptt'));
  $('tog-mode-btn').addEventListener('click', () => setMode('toggle'));
  $('mute-mic-btn').addEventListener('click', toggleMute);
}

function setMode(m) {
  if (state.isTransmitting) stopTX();
  state.mode = m;
  $('ptt-mode-btn').classList.toggle('active', m === 'ptt');
  $('tog-mode-btn').classList.toggle('active', m !== 'ptt');
  $('lcd-mode').textContent  = m === 'ptt' ? 'PTT' : 'TOG';
  $('ptt-label').textContent = m === 'ptt' ? 'PUSH TO TALK' : 'CLICK TO TALK';
  $('ptt-hint').innerHTML    = m === 'ptt'
    ? 'Hold <kbd class="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 font-mono text-gray-500">Space</kbd> or hold the button'
    : 'Tap once to open mic — tap again to close';
}

function toggleMute() {
  state.isOutgoingMuted = !state.isOutgoingMuted;
  state.peerAudios.forEach(a => { a.muted = state.isOutgoingMuted; });
  const btn = $('mute-mic-btn');
  btn.classList.toggle('text-amber-500', state.isOutgoingMuted);
  btn.classList.toggle('bg-amber-50', state.isOutgoingMuted);
  btn.classList.toggle('dark:bg-amber-900/20', state.isOutgoingMuted);
  showToast(state.isOutgoingMuted ? '🔇 Incoming muted' : '🔊 Incoming on', 'info', 2000);
}

// ── Channel controls ──────────────────────────────────────────────
function wireChannelControls() {
  $('join-btn').addEventListener('click', doHost);
  $('freq-join-btn').addEventListener('click', doJoin);
  $('leave-btn').addEventListener('click', doLeave);
  $('scan-btn').addEventListener('click', toggleScan);
  $('refresh-btn').addEventListener('click', () => state.socket?.emit('get-channels'));
  $('ch-input').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
  $('private-chk').addEventListener('change', () => {
    $('pw-row').classList.toggle('hidden', !$('private-chk').checked);
  });
}

function doHost() {
  const ch = $('ch-input').value.trim() || randomChannel();
  $('ch-input').value = ch;
  if (!state.socket?.connected) { showToast('⚠️ Not connected', 'warning'); return; }
  _joinChannel(ch, $('private-chk').checked ? $('pw-input').value : '');
}

function doJoin() {
  const ch = $('ch-input').value.trim();
  if (!ch) { showToast('⚠️ Enter a channel', 'warning'); return; }
  if (!state.socket?.connected) { showToast('⚠️ Not connected', 'warning'); return; }
  _joinChannel(ch, $('private-chk').checked ? $('pw-input').value : '');
}

function _joinChannel(chId, pw = '') {
  if (!state.socket?.connected) { showToast('⚠️ Not connected', 'warning'); return; }
  if (state.isTransmitting) stopTX();
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.peerUsernames.clear(); state.missedCandidates.clear();
  state.socket.emit('join-channel', { channelId: chId, password: pw, username: state.username });
}

function doLeave() {
  clearRescan();
  if (state.isTransmitting) stopTX();
  state.socket?.emit('leave-channel');
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.peerUsernames.clear(); state.missedCandidates.clear();
  state.channel = null; state.isHost = false; state.isCohost = false; state.isMuted = false;
  state.roster  = [];
  updateStatus(); setChannelUIState(false); clearChatPanel();
  renderChannelList(state.channelList);
  renderRoster([]);
  updateHostUI();
  showToast('👋 Left channel', 'info', 2000);
}

// ── Auto-rescan ───────────────────────────────────────────────────
function wireRescanToggle() {
  const toggle = $('rescan-toggle');
  if (!toggle) return;
  // Load saved preference
  const saved = localStorage.getItem('stalk-autorescan') === 'true';
  state.autoRescan = saved;
  toggle.checked = saved;
  updateRescanBadge();
  toggle.addEventListener('change', function() {
    state.autoRescan = this.checked;
    localStorage.setItem('stalk-autorescan', this.checked);
    updateRescanBadge();
    showToast(this.checked ? '🔄 Auto-rescan ON' : '🔄 Auto-rescan OFF', 'info', 2000);
  });
}

function updateRescanBadge() {
  const badge = $('rescan-badge');
  if (!badge) return;
  badge.classList.toggle('hidden', !state.autoRescan);
}

function scheduleRescan(channelId) {
  clearRescan();
  let attempts = 0;
  const maxAttempts = 20;
  function tryRescan() {
    if (!state.autoRescan || state.channel) return;
    attempts++;
    if (attempts > maxAttempts) { showToast('⚠️ Could not reconnect after 20 tries', 'warning'); return; }
    if (state.socket?.connected) {
      showToast(`🔄 Reconnecting to CH ${channelId}… (${attempts})`, 'info', 2000);
      _joinChannel(channelId, '');
    } else {
      state.rescanTimer = setTimeout(tryRescan, 3000);
    }
  }
  state.rescanTimer = setTimeout(tryRescan, 2000);
}

function clearRescan() {
  clearTimeout(state.rescanTimer);
  state.rescanTimer = null;
}

// ── Host: Roster scan & reinvite ──────────────────────────────────
function hostRescanRoster() {
  if (!state.isHost && !state.isCohost) return;
  // Reinvite all offline members
  const offline = state.roster.filter(m => !m.online);
  if (!offline.length) { showToast('Everyone is online', 'success', 2000); return; }
  offline.forEach(m => {
    state.socket.emit('reinvite-member', { username: m.username });
  });
  showToast(`📡 Sent rejoins to ${offline.length} offline member${offline.length > 1 ? 's' : ''}`, 'info');
}

// ── Scan ──────────────────────────────────────────────────────────
let _scanActive = false;
function toggleScan() { _scanActive ? stopListScan() : startListScan(); }
async function startListScan() {
  const active = state.channelList.filter(c => c.userCount > 0);
  if (!active.length) { showToast('📻 No active channels', 'info'); return; }
  _scanActive = true;
  $('scan-btn').textContent = '⏹ Stop';
  for (const ch of active) {
    if (!_scanActive) break;
    $('lcd-status').textContent  = 'SCAN…';
    $('lcd-channel').textContent = ch.id;
    await sleep(350);
    if (!_scanActive) break;
    $('ch-input').value = ch.id;
    _joinChannel(ch.id, '');
    showToast('📡 CH ' + ch.id, 'success');
    break;
  }
  stopListScan();
}
function stopListScan() { _scanActive = false; $('scan-btn').textContent = '⟳ Scan'; if (!state.channel) updateStatus(); }

// ── DM ────────────────────────────────────────────────────────────
function wireDM() {
  $('dm-send-btn')?.addEventListener('click', sendDM);
  $('dm-input')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDM(); } });
  $('dm-close-btn')?.addEventListener('click', closeDMPanel);
}

function openDM(socketId, username) {
  state.activeDM = { socketId, username };
  const panel = $('dm-panel');
  const title = $('dm-title');
  if (panel) { panel.classList.remove('hidden'); title.textContent = '💬 ' + username; }
  renderDMMessages(socketId);
  $('dm-input')?.focus();
  startPrivateCall(socketId);
}

function closeDMPanel() {
  state.activeDM = null;
  $('dm-panel')?.classList.add('hidden');
  // Close private call
  state.privatePeers.forEach(pc => pc.close());
  state.privatePeers.clear();
  state.privatePeerAudios.forEach(a => { a.srcObject = null; a.remove(); });
  state.privatePeerAudios.clear();
}

function sendDM() {
  const inp = $('dm-input'); if (!inp || !state.activeDM) return;
  const text = inp.value.trim(); if (!text) return;
  state.socket.emit('private-message', { targetId: state.activeDM.socketId, text });
  inp.value = '';
}

function receiveDM(socketId, fromName, text, timestamp, outgoing) {
  if (!state.dmMessages.has(socketId)) state.dmMessages.set(socketId, []);
  state.dmMessages.get(socketId).push({ fromName, text, timestamp, outgoing });
  if (state.activeDM?.socketId === socketId) renderDMMessages(socketId);
  else if (!outgoing) {
    const name = fromName || state.peerUsernames.get(socketId) || 'Unknown';
    showToast('💬 ' + name + ': ' + text.slice(0, 30), 'info', 5000);
  }
}

function renderDMMessages(socketId) {
  const box = $('dm-messages'); if (!box) return;
  const msgs = state.dmMessages.get(socketId) || [];
  box.innerHTML = '';
  msgs.forEach(m => {
    const div = document.createElement('div');
    div.className = 'flex ' + (m.outgoing ? 'justify-end' : 'justify-start');
    div.innerHTML = `<div class="${m.outgoing
      ? 'bg-indigo-500 text-white rounded-2xl rounded-br-sm'
      : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-2xl rounded-bl-sm border border-gray-200 dark:border-gray-700'} px-3 py-2 text-sm max-w-[80%] msg-in">${escHtml(m.text)}</div>`;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

// ── Network info ──────────────────────────────────────────────────
function wireNetworkInfo() {
  updateNetworkInfo();
  if (navigator.connection) {
    navigator.connection.addEventListener('change', updateNetworkInfo);
  }
  setInterval(updateNetworkInfo, 10000);
}

function updateNetworkInfo() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const el   = $('network-info'); if (!el) return;

  if (!conn) { el.innerHTML = '<span class="text-gray-400 text-xs">Network info unavailable</span>'; return; }

  const type       = conn.type || 'unknown';
  const effectType = conn.effectiveType || '?';
  const rtt        = conn.rtt || 0;
  const downlink   = conn.downlink || 0;

  // Signal strength from downlink (Mbps)
  let bars = 0;
  if (downlink >= 10) bars = 5;
  else if (downlink >= 5)  bars = 4;
  else if (downlink >= 2)  bars = 3;
  else if (downlink >= 1)  bars = 2;
  else if (downlink > 0)   bars = 1;

  const barColors = ['bg-gray-300 dark:bg-gray-600','bg-gray-300 dark:bg-gray-600','bg-gray-300 dark:bg-gray-600','bg-gray-300 dark:bg-gray-600','bg-gray-300 dark:bg-gray-600'];
  for (let i = 0; i < bars; i++) barColors[i] = 'bg-emerald-500';

  const typeIcon = type === 'wifi' ? '📶' : type === 'cellular' ? '📡' : type === 'ethernet' ? '🔌' : '🌐';
  const typeLabel = type !== 'unknown' ? type : effectType;

  el.innerHTML = `
    <div class="flex items-center gap-2 flex-wrap">
      <span class="text-sm">${typeIcon}</span>
      <span class="text-xs font-medium text-gray-600 dark:text-gray-400 capitalize">${typeLabel}</span>
      <div class="flex items-end gap-px h-3.5">
        ${[1,2,3,4,5].map((h,i) => `<div class="w-1 rounded-sm ${barColors[i]}" style="height:${20+i*20}%"></div>`).join('')}
      </div>
      ${rtt ? `<span class="text-xs text-gray-400">${rtt}ms</span>` : ''}
      ${downlink ? `<span class="text-xs text-gray-400">${downlink}Mbps</span>` : ''}
    </div>`;
}

// ── Host UI update ────────────────────────────────────────────────
function updateHostUI() {
  const canControl = state.isHost || state.isCohost;
  const badge = $('host-badge');
  const rescanBtn = $('host-rescan-btn');
  if (badge) {
    badge.classList.toggle('hidden', !state.isHost && !state.isCohost);
    badge.textContent = state.isHost ? '👑 Host' : '⭐ Co-host';
    badge.className = state.isHost
      ? 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-700'
      : 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-700';
  }
  if (rescanBtn) rescanBtn.classList.toggle('hidden', !canControl);
  // Re-render roster to show/hide host controls
  renderRoster(state.roster);
}

// ── Roster rendering ──────────────────────────────────────────────
function renderRoster(roster) {
  const list  = $('users-list'); if (!list) return;
  const canControl = state.isHost || state.isCohost;
  list.innerHTML = '';

  if (!roster || !roster.length) {
    list.innerHTML = '<p class="text-xs text-gray-400 italic">Join a channel to see users</p>';
    return;
  }

  roster.forEach(m => {
    const isSelf    = m.socketId === state.socket?.id;
    const isOffline = !m.online;
    const isHost    = m.isHost;
    const isCohost  = m.isCohost;
    const isMuted   = m.isMuted;

    const div = document.createElement('div');
    div.id        = 'ru-' + (m.socketId || 'off-' + m.username);
    div.className = `flex flex-col gap-2 p-3 rounded-2xl border transition-all ${
      isOffline
        ? 'bg-gray-50/50 dark:bg-gray-900/30 border-gray-100 dark:border-gray-800 opacity-50'
        : 'bg-gray-50 dark:bg-gray-800/60 border-gray-100 dark:border-gray-700/60'}`;

    const init = (m.username[0] || '?').toUpperCase();
    const gradients = ['from-indigo-400 to-violet-500','from-emerald-400 to-teal-500','from-rose-400 to-pink-500','from-amber-400 to-orange-500'];
    const grad = gradients[m.username.charCodeAt(0) % gradients.length];

    div.innerHTML = `
      <div class="flex items-center gap-2.5">
        <div class="user-avatar-el w-9 h-9 shrink-0 rounded-full bg-gradient-to-br ${grad} flex items-center justify-center text-xs font-bold text-white border-2 border-transparent transition-all">
          ${escHtml(init)}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-sm font-medium truncate ${isOffline ? 'line-through text-gray-400' : ''}">${escHtml(m.username)}</span>
            ${isSelf   ? '<span class="text-[9px] px-1.5 py-px rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-500 dark:text-indigo-400 font-bold">YOU</span>' : ''}
            ${isHost   ? '<span class="text-[9px] px-1.5 py-px rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-bold border border-amber-200 dark:border-amber-700">👑 Host</span>' : ''}
            ${isCohost ? '<span class="text-[9px] px-1.5 py-px rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 font-bold border border-violet-200 dark:border-violet-700">⭐ Co-host</span>' : ''}
            ${isOffline ? '<span class="text-[9px] text-gray-400 font-medium">offline</span>' : ''}
          </div>
          ${isOffline ? `<span class="text-[10px] text-gray-400">Last seen ${timeAgo(m.lastSeen)}</span>` : ''}
        </div>
        <!-- Speaking / muted indicators -->
        <span class="muted-icon ${isMuted ? '' : 'hidden'} flex items-center justify-center w-7 h-7 rounded-full bg-rose-100 dark:bg-rose-900/30">
          <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 text-rose-500"><path fill-rule="evenodd" d="M13.477 14.89A6 6 0 015.11 6.524l8.367 8.368zm1.414-1.414L6.524 5.11a6 6 0 018.367 8.367zM18 10a8 8 0 11-16 0 8 8 0 0116 0z" clip-rule="evenodd"/></svg>
        </span>
        <span class="user-mic-icon opacity-0 transition-opacity flex items-center justify-center w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
          <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 text-emerald-500"><path fill-rule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clip-rule="evenodd"/></svg>
        </span>
      </div>

      <!-- Action buttons row -->
      <div class="flex flex-wrap items-center gap-1.5 pl-11">

        <!-- Speaking indicator -->
        <span class="muted-icon ${isMuted ? '' : 'hidden'} flex items-center justify-center w-7 h-7 rounded-full bg-rose-100 dark:bg-rose-900/30">
          <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 text-rose-500"><path fill-rule="evenodd" d="M13.477 14.89A6 6 0 015.11 6.524l8.367 8.368zm1.414-1.414L6.524 5.11a6 6 0 018.367 8.367zM18 10a8 8 0 11-16 0 8 8 0 0116 0z" clip-rule="evenodd"/></svg>
        </span>
        <span class="user-mic-icon opacity-0 transition-opacity flex items-center justify-center w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
          <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 text-emerald-500"><path fill-rule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clip-rule="evenodd"/></svg>
        </span>

        ${!isSelf && !isOffline && m.socketId ? `
          <!-- Private call button -->
          <button class="dm-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 active:scale-95 transition-all" title="Private call">
            <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 shrink-0">
              <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/>
            </svg>
            <span class="text-[10px] font-bold">Talk</span>
          </button>` : ''}

        ${canControl && !isSelf && m.socketId ? `
          <!-- Mute button -->
          <button class="mute-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl border active:scale-95 transition-all ${isMuted
            ? 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-700 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100'
            : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}" title="${isMuted ? 'Unmute' : 'Mute'}">
            ${isMuted
              ? `<svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 shrink-0"><path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z" clip-rule="evenodd"/></svg><span class="text-[10px] font-bold">Unmute</span>`
              : `<svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 shrink-0"><path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clip-rule="evenodd"/></svg><span class="text-[10px] font-bold">Mute</span>`}
          </button>

          ${state.isHost ? `
          <!-- Co-host button -->
          <button class="cohost-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl border active:scale-95 transition-all ${isCohost
            ? 'bg-violet-50 dark:bg-violet-900/30 border-violet-200 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-100'
            : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}" title="${isCohost ? 'Remove co-host' : 'Make co-host'}">
            <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 shrink-0 ${isCohost ? 'text-violet-500' : 'text-amber-400'}">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
            </svg>
            <span class="text-[10px] font-bold">${isCohost ? 'Unhost' : 'Co-host'}</span>
          </button>

          <!-- Kick button -->
          <button class="kick-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-rose-500 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/40 active:scale-95 transition-all" title="Kick from channel">
            <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 shrink-0">
              <path d="M11 6a3 3 0 11-6 0 3 3 0 016 0zM14 14a6 6 0 00-12 0v1h12v-1zm2.707-5.707a1 1 0 00-1.414 0L14 9.586l-1.293-1.293a1 1 0 00-1.414 1.414L12.586 11l-1.293 1.293a1 1 0 101.414 1.414L14 12.414l1.293 1.293a1 1 0 001.414-1.414L15.414 11l1.293-1.293a1 1 0 000-1.414z"/>
            </svg>
            <span class="text-[10px] font-bold">Kick</span>
          </button>` : ''}` : ''}

        ${canControl && isOffline ? `
          <!-- Reinvite button -->
          <button class="reinvite-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 active:scale-95 transition-all" title="Reinvite to channel">
            <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5 shrink-0">
              <path d="M8 9a3 3 0 100-6 3 3 0 000 6zM8 11a6 6 0 016 6H2a6 6 0 016-6zM16 7a1 1 0 10-2 0v1h-1a1 1 0 100 2h1v1a1 1 0 102 0v-1h1a1 1 0 100-2h-1V7z"/>
            </svg>
            <span class="text-[10px] font-bold">Reinvite</span>
          </button>` : ''}
      </div>`;

    // Wire up buttons
    const sid = m.socketId;
    div.querySelector('.dm-btn')?.addEventListener('click', () => openDM(sid, m.username));
    div.querySelector('.mute-btn')?.addEventListener('click', () => {
      state.socket.emit('mute-user', { targetId: sid, muted: !isMuted });
    });
    div.querySelector('.cohost-btn')?.addEventListener('click', () => {
      state.socket.emit('assign-cohost', { targetId: sid, isCohost: !isCohost });
    });
    div.querySelector('.kick-btn')?.addEventListener('click', () => {
      if (confirm('Kick ' + m.username + ' from the channel?')) {
        state.socket.emit('kick-user', { targetId: sid });
      }
    });
    div.querySelector('.reinvite-btn')?.addEventListener('click', () => {
      state.socket.emit('reinvite-member', { username: m.username });
      showToast('📡 Invite sent to ' + m.username, 'info', 2000);
    });

    list.appendChild(div);
  });

  updateStatus();
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ago';
}

// ── Channel list ──────────────────────────────────────────────────
function renderChannelList(channels) {
  const list = $('ch-list'); list.innerHTML = '';
  if (!channels || !channels.length) {
    list.innerHTML = '<p class="text-xs text-gray-400 italic text-center py-8">No active frequencies yet</p>';
    return;
  }
  channels.forEach(ch => {
    const isCurrent = state.channel === ch.id;
    const names     = (ch.users || []).slice(0, 3).map(escHtml).join(', ') || 'empty';
    const card = document.createElement('div');
    card.className = `ch-card flex items-center gap-3 p-3.5 rounded-2xl border ${isCurrent
      ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-700'
      : 'bg-gray-50 dark:bg-gray-800/60 border-gray-100 dark:border-gray-700/60 hover:border-indigo-200 dark:hover:border-indigo-700'}`;
    card.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-bold text-sm font-mono ${isCurrent ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-800 dark:text-gray-200'}">${escHtml(String(ch.id))}</span>
          ${ch.hasActivity ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-slow"></span>' : ''}
          ${isCurrent ? '<span class="text-[9px] font-bold px-1.5 py-px rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-700">ON AIR</span>' : ''}
        </div>
        <p class="text-xs text-gray-400 truncate mt-0.5">${ch.userCount} user${ch.userCount!==1?'s':''} · ${names}</p>
        ${ch.host ? `<p class="text-[10px] text-gray-300 dark:text-gray-600">👑 ${escHtml(ch.host)}</p>` : ''}
      </div>
      ${!isCurrent ? '<svg viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 text-gray-300 dark:text-gray-600 flex-shrink-0"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>' : ''}`;
    if (!isCurrent) card.addEventListener('click', () => { $('ch-input').value = ch.id; _joinChannel(ch.id, ''); });
    list.appendChild(card);
  });
}

// ── Chat ──────────────────────────────────────────────────────────
function wireChat() {
  $('chat-send-btn').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
}
function sendChat() {
  const inp = $('chat-input'), txt = inp.value.trim();
  if (!txt || !state.channel) return;
  state.socket?.emit('chat-message', { text: txt }); inp.value = '';
}
function appendChatMsg(msg, isHistory = false) {
  const box = $('chat-messages');
  box.querySelector('.chat-welcome')?.remove();
  const isOwn = msg.socketId === state.socket?.id;
  const time  = new Date(msg.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const div   = document.createElement('div');
  div.className = 'flex ' + (isOwn ? 'justify-end' : 'justify-start') + ' msg-in';
  div.innerHTML = `<div class="max-w-[78%] flex flex-col gap-1 ${isOwn?'items-end':'items-start'}">
    <span class="text-[10px] text-gray-400 px-1">${escHtml(msg.username)}</span>
    <div class="${isOwn?'bg-indigo-500 text-white rounded-2xl rounded-br-sm shadow-md shadow-indigo-500/20':'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-2xl rounded-bl-sm border border-gray-200 dark:border-gray-700'} px-4 py-2.5 text-sm leading-relaxed">${escHtml(msg.text)}</div>
    <span class="text-[10px] text-gray-300 dark:text-gray-600 px-1">${time}</span>
  </div>`;
  box.appendChild(div);
  if (!isHistory) scrollChat();
  if (!isHistory && !isOwn) {
    if ($('panel-chat')?.classList.contains('mobile-hidden')) {
      const b = $('chat-badge');
      if (b) { b.textContent = (parseInt(b.textContent)||0)+1; b.classList.remove('hidden'); }
    }
  }
}
function appendSystemMsg(html) {
  const box = $('chat-messages'), div = document.createElement('div');
  div.className = 'flex items-center gap-3 text-[11px] text-gray-400 my-1 msg-in';
  div.innerHTML = `<div class="flex-1 h-px bg-gray-100 dark:bg-gray-800"></div><span>${html}</span><div class="flex-1 h-px bg-gray-100 dark:bg-gray-800"></div>`;
  box.appendChild(div); scrollChat();
}
function clearChatPanel() {
  $('chat-messages').innerHTML = `<div class="chat-welcome flex flex-col items-center justify-center h-full gap-3 text-center py-12"><div class="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center"><svg viewBox="0 0 20 20" fill="currentColor" class="w-7 h-7 text-indigo-300 dark:text-indigo-600"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z" clip-rule="evenodd"/></svg></div><p class="text-sm font-semibold text-gray-400">No messages yet</p><p class="text-xs text-gray-300 dark:text-gray-600">Join a channel to start chatting</p></div>`;
  $('chat-ch-badge').textContent = 'No channel';
}
function scrollChat() { const b = $('chat-messages'); b.scrollTop = b.scrollHeight; }

// ── Server switch ─────────────────────────────────────────────────
function wireServerSwitch() {
  $('server-switch-btn')?.addEventListener('click', () => {
    const p = $('server-panel'); p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) $('server-url-input').value = localStorage.getItem('wt_server') || '';
  });
  $('server-save-btn')?.addEventListener('click', () => {
    const v = $('server-url-input').value.trim();
    if (v) { localStorage.setItem('wt_server', v); showToast('Saved — reload to connect', 'info', 4000); }
    $('server-panel').classList.add('hidden');
  });
  $('server-reset-btn')?.addEventListener('click', () => { localStorage.removeItem('wt_server'); showToast('Reset', 'info'); $('server-panel').classList.add('hidden'); });
}
function updateServerBadge(url) {
  const b = $('server-badge'); if (!b) return;
  const isLocal = /localhost|127\.0\.0\.1|192\.168\.|10\.\d+\.\d+|172\./.test(url);
  b.textContent = isLocal ? 'LAN' : 'ONLINE';
  b.className = isLocal
    ? 'text-[9px] font-bold tracking-widest px-2 py-0.5 rounded-full bg-cyan-100 dark:bg-cyan-900/40 text-cyan-600 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-800'
    : 'text-[9px] font-bold tracking-widest px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800';
}

// ── UI helpers ────────────────────────────────────────────────────
function setConnStatus(state) {
  const dot = $('conn-dot');
  const lbl = $('conn-label');
  if (state === 'online') {
    dot.className     = 'w-2 h-2 rounded-full status-dot-connected';
    lbl.textContent   = 'ONLINE';
    lbl.className     = 'text-[10px] font-bold tracking-widest text-emerald-500';
  } else if (state === 'offline') {
    dot.className     = 'w-2 h-2 rounded-full status-dot-disconnected';
    lbl.textContent   = 'OFFLINE';
    lbl.className     = 'text-[10px] font-bold tracking-widest text-rose-400';
  } else {
    // connecting
    dot.className     = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
    lbl.textContent   = 'CONNECTING';
    lbl.className     = 'text-[10px] font-bold tracking-widest text-amber-400';
  }
}
function updateStatus() {
  const ch = state.channel;
  $('lcd-channel').textContent   = ch ? String(ch) : '--';
  $('lcd-status').textContent    = ch ? 'ON CH ' + ch : 'STANDBY';
  $('lcd-usercount').textContent = state.roster.filter(m => m.online).length || 0;
}
function setChannelUIState(inCh) {
  $('ptt-btn').disabled       = !inCh;
  $('leave-btn').disabled     = !inCh;
  $('chat-input').disabled    = !inCh;
  $('chat-send-btn').disabled = !inCh;
}
window.setMode     = setMode;
window.hostRescan  = hostRescanRoster;


// ── Keep-alive ping (prevents Render free tier spin-down) ─────────
(function keepAlive() {
  // Only ping when running on a remote server (not LAN/localhost)
  const url = window.location.origin;
  const isRemote = !url.includes('localhost') && !url.match(/192\.168\.|10\.\d+|172\./);
  if (!isRemote) return;

  function ping() {
    fetch('/api/health', { method: 'GET', cache: 'no-store' }).catch(() => {});
  }

  // Ping every 10 minutes
  setInterval(ping, 10 * 60 * 1000);

  // Also ping when tab becomes visible again after being hidden
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ping();
  });
})();
