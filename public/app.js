/* ─────────────────────────────────────────────────────────────────
   S-talk — Frontend  (WebRTC mesh + Socket.io)
   ───────────────────────────────────────────────────────────────── */
'use strict';

const state = {
  socket: null, localStream: null,
  audioCtx: null, analyser: null,
  peers: new Map(), peerAudios: new Map(), peerUsernames: new Map(),
  channel: null, username: '', pendingChannel: null,
  mode: 'ptt', isTransmitting: false, isSpeaking: false,
  isOutgoingMuted: false, scanActive: false,
  channelList: [], vuBars: [],
  speakTimer: null, toastTimer: null, missedCandidates: new Map(),
};

const ICE_CFG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
  ],
  iceCandidatePoolSize: 10,
};

function $(id) { return document.getElementById(id); }
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomChannel() {
  return String(Math.floor(Math.random() * 9000) + 1000);
}

function showToast(msg, type = 'info', ms = 3000) {
  clearTimeout(state.toastTimer);
  const el = $('toast');
  el.textContent = msg;
  el.className = 'fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] px-5 py-2.5 rounded-full text-sm font-medium shadow-xl whitespace-nowrap pointer-events-none toast-show toast-' + type;
  state.toastTimer = setTimeout(() => { el.className = 'fixed bottom-24 left-1/2 -translate-x-1/2 translate-y-20 opacity-0 pointer-events-none z-[9999] px-5 py-2.5 rounded-full text-sm font-medium shadow-xl whitespace-nowrap transition-all duration-300'; }, ms);
}

function getServerUrl() {
  if (window.Capacitor?.isNativePlatform()) return 'http://localhost:3000';
  if (window.electronAPI) return 'https://localhost:3000';
  return localStorage.getItem('wt_server') || window.location.origin;
}

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildVUMeter();
  wireSetupScreen();
  wirePTT();
  wireModeButtons();
  wireChannelControls();
  wireChat();
  wireServerSwitch();
});

// ── VU Meter ──────────────────────────────────────────────────────
function buildVUMeter() {
  const c = $('vu-bars');
  for (let i = 0; i < 30; i++) {
    const b = document.createElement('div');
    b.className = 'vu-bar';
    c.appendChild(b);
    state.vuBars.push(b);
  }
}

function animateVU() {
  if (!state.analyser) return;
  const data = new Uint8Array(state.analyser.frequencyBinCount);
  const isDark = () => document.documentElement.classList.contains('dark');
  function frame() {
    requestAnimationFrame(frame);
    state.analyser.getByteFrequencyData(data);
    let sum = 0; const lo = 2, hi = Math.floor(data.length * .75);
    for (let i = lo; i < hi; i++) sum += data[i];
    const level = sum / ((hi - lo) * 255);
    const active = state.isTransmitting;
    const n = state.vuBars.length;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const lit = active && level > t * .55;
      const pct = lit ? Math.min(100, 10 + (level - t * .55) * 260) : 6;
      state.vuBars[i].style.height = pct + '%';
      let c;
      if (i < n * .6)       c = lit ? '#34d399' : (isDark() ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)');
      else if (i < n * .82) c = lit ? '#fbbf24' : (isDark() ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)');
      else                  c = lit ? '#fb7185' : (isDark() ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)');
      state.vuBars[i].style.background = c;
    }
    if (active) {
      const speaking = level > .04;
      if (speaking !== state.isSpeaking) {
        clearTimeout(state.speakTimer);
        if (!speaking) {
          state.speakTimer = setTimeout(() => { state.isSpeaking = false; state.socket?.emit('speaking', { isSpeaking: false }); }, 400);
        } else {
          state.isSpeaking = true;
          state.socket?.emit('speaking', { isSpeaking: true });
        }
      }
    }
  }
  frame();
}

// ── Setup Screen ──────────────────────────────────────────────────
function wireSetupScreen() {
  $('start-btn').addEventListener('click', handleStart);
  $('username-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleStart(); });
  // custom-ch-input Enter
  const ci = $('custom-ch-input');
  if (ci) ci.addEventListener('keydown', e => { if (e.key === 'Enter') handleStart(); });
}

async function handleStart() {
  const raw      = $('username-input').value.trim();
  state.username = raw || 'Anonymous';

  const useCustom  = $('custom-ch-chk')?.checked;
  const customVal  = useCustom ? ($('custom-ch-input')?.value.trim() || '') : '';
  const channelId  = useCustom ? (customVal || randomChannel()) : randomChannel();

  state.pendingChannel = channelId;

  setSetupStatus('Requesting microphone…', 'text-indigo-500');
  $('start-btn').disabled = true;

  const ok = await requestMic();
  if (!ok) { $('start-btn').disabled = false; return; }

  setSetupStatus('Connecting…', 'text-indigo-500');
  initSocket();
  $('setup-screen').classList.add('hidden');
  $('main-app').classList.remove('hidden');
  $('username-pill').textContent = state.username;
}

function setSetupStatus(msg, cls = 'text-gray-400') {
  const el = $('setup-status');
  el.textContent = msg;
  el.className   = 'text-xs text-center min-h-4 ' + cls;
}

// ── Microphone ────────────────────────────────────────────────────
async function requestMic() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    state.localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    setupAnalyser();
    return true;
  } catch (err) {
    let msg = '❌ ' + err.message;
    if (err.name === 'NotAllowedError')  msg = '❌ Microphone access denied.';
    if (err.name === 'NotFoundError')    msg = '❌ No microphone found.';
    if (err.name === 'NotReadableError') msg = '❌ Mic is in use by another app.';
    setSetupStatus(msg, 'text-rose-500');
    return false;
  }
}

function setupAnalyser() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  state.audioCtx = new Ctx();
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 512;
  state.analyser.smoothingTimeConstant = .75;
  state.audioCtx.createMediaStreamSource(state.localStream).connect(state.analyser);
  animateVU();
}

// ── Socket ────────────────────────────────────────────────────────
function initSocket() {
  const url = getServerUrl();
  state.socket = io(url, {
    rejectUnauthorized: false,
    timeout: 8000,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
  });

  let connectAttempts = 0;

  state.socket.on('connect', () => {
    connectAttempts = 0;
    setConnStatus(true);
    hideOfflineBanner();
    state.socket.emit('set-username', state.username);
    state.socket.emit('get-channels');
    updateServerBadge(url);
    if (state.pendingChannel) {
      _joinChannel(state.pendingChannel, '');
      state.pendingChannel = null;
    }
  });

  state.socket.on('connect_error', () => {
    connectAttempts++;
    setConnStatus(false);
    if (connectAttempts >= 2) showOfflineBanner(url);
  });

  state.socket.on('disconnect', () => {
    setConnStatus(false);
    for (const id of [...state.peers.keys()]) removePeer(id);
    state.peerUsernames.clear();
    state.channel = null;
    updateStatus(); setChannelUIState(false);
    showOfflineBanner(url);
  });

  state.socket.on('reconnect', () => {
    showToast('📡 Reconnected', 'success');
    hideOfflineBanner();
    if (state.channel) state.socket.emit('join-channel', { channelId: state.channel, username: state.username });
  });

  state.socket.on('signal', ({ fromId, data }) => handleSignal(fromId, data));

  state.socket.on('joined-channel', ({ channelId, existingPeers, isPrivate, messages }) => {
    state.channel = channelId;
    updateStatus(); setChannelUIState(true);
    $('chat-ch-badge').textContent = 'CH ' + channelId + (isPrivate ? ' 🔒' : '');
    existingPeers.forEach(({ socketId, username }) => {
      state.peerUsernames.set(socketId, username);
      renderUserAdd(socketId, username);
    });
    existingPeers.forEach(({ socketId }) => createPeer(socketId, true));
    clearChatPanel();
    messages.forEach(m => appendChatMsg(m, true));
    scrollChat();
    showToast('✅ On ' + (isPrivate ? '🔒 ' : '') + 'CH ' + channelId, 'success');
    renderChannelList(state.channelList);
  });

  state.socket.on('user-joined', ({ socketId, username }) => {
    state.peerUsernames.set(socketId, username);
    renderUserAdd(socketId, username);
    appendSystemMsg(escHtml(username) + ' joined');
  });

  state.socket.on('user-left', ({ socketId }) => {
    const u = state.peerUsernames.get(socketId) || 'Someone';
    removePeer(socketId);
    renderUserRemove(socketId);
    state.peerUsernames.delete(socketId);
    state.missedCandidates.delete(socketId);
    appendSystemMsg(escHtml(u) + ' left');
  });

  state.socket.on('user-speaking', ({ socketId, isSpeaking }) => renderSpeaking(socketId, isSpeaking));
  state.socket.on('channel-list',  list => { state.channelList = list; renderChannelList(list); });
  state.socket.on('chat-message',  msg  => appendChatMsg(msg));
  state.socket.on('join-error',    ({ message }) => showToast('❌ ' + message, 'error'));
}

// ── Offline banner ────────────────────────────────────────────────
function showOfflineBanner(currentUrl) {
  let el = $('offline-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'offline-banner';
    el.className = 'fixed top-14 left-0 right-0 z-50 mx-3 mt-2';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="bg-amber-50 dark:bg-amber-900/40 border border-amber-200 dark:border-amber-700 rounded-2xl p-3.5 shadow-lg">
      <p class="text-xs font-bold text-amber-700 dark:text-amber-400 mb-1">📡 Can't reach server</p>
      <p class="text-[11px] text-amber-600 dark:text-amber-500 mb-2.5">You're offline or the server is unreachable. Enter a LAN server URL to connect locally.</p>
      <div class="flex gap-2">
        <input id="lan-url-input" type="url" value="${currentUrl.startsWith('http://localhost') ? '' : currentUrl}"
          placeholder="http://192.168.1.x:3000"
          class="flex-1 text-xs px-3 py-2 rounded-xl bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-400">
        <button onclick="connectToLAN()" class="px-3 py-2 rounded-xl bg-amber-500 text-white text-xs font-bold hover:bg-amber-600 active:scale-95 transition-all whitespace-nowrap">Connect</button>
      </div>
    </div>`;
}

function hideOfflineBanner() {
  const el = $('offline-banner');
  if (el) el.remove();
}

window.connectToLAN = function() {
  const url = $('lan-url-input')?.value.trim();
  if (!url) { showToast('⚠️ Enter a URL', 'warning'); return; }
  localStorage.setItem('wt_server', url);
  state.socket?.disconnect();
  hideOfflineBanner();
  initSocket();
  showToast('🔄 Connecting to ' + url, 'info');
};

// ── WebRTC ────────────────────────────────────────────────────────
function createPeer(peerId, isInitiator) {
  if (state.peers.has(peerId)) return state.peers.get(peerId);
  const pc = new RTCPeerConnection(ICE_CFG);
  state.peers.set(peerId, pc);
  state.missedCandidates.set(peerId, []);

  if (state.localStream)
    state.localStream.getAudioTracks().forEach(t => pc.addTrack(t, state.localStream));

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
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      state.socket.emit('signal', { targetId: fromId, data: { type: 'answer', payload: pc.localDescription } });
    } else if (type === 'answer') {
      const pc = state.peers.get(fromId);
      if (pc && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        for (const c of (state.missedCandidates.get(fromId) || [])) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        state.missedCandidates.set(fromId, []);
      }
    } else if (type === 'ice-candidate') {
      const pc = state.peers.get(fromId);
      if (!pc || !payload) return;
      if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => {});
      else { const buf = state.missedCandidates.get(fromId) || []; buf.push(payload); state.missedCandidates.set(fromId, buf); }
    }
  } catch (e) { console.warn('signal', e); }
}

function removePeer(id) {
  const pc = state.peers.get(id); if (pc) { pc.close(); state.peers.delete(id); }
  const a  = state.peerAudios.get(id); if (a) { a.srcObject = null; a.remove(); state.peerAudios.delete(id); }
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

// ── Modes ─────────────────────────────────────────────────────────
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
  btn.classList.toggle('bg-amber-50',    state.isOutgoingMuted);
  btn.classList.toggle('dark:bg-amber-900/20', state.isOutgoingMuted);
  showToast(state.isOutgoingMuted ? '🔇 Audio muted' : '🔊 Audio on', 'info', 2000);
}

// ── Channel Controls ──────────────────────────────────────────────
function wireChannelControls() {
  $('join-btn').addEventListener('click', doHost);
  $('freq-join-btn').addEventListener('click', doJoin);
  $('leave-btn').addEventListener('click', doLeave);
  $('scan-btn').addEventListener('click',  toggleScan);
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
  if (!ch) { showToast('⚠️ Enter a channel or frequency', 'warning'); return; }
  if (!state.socket?.connected) { showToast('⚠️ Not connected', 'warning'); return; }
  _joinChannel(ch, $('private-chk').checked ? $('pw-input').value : '');
}

function _joinChannel(chId, pw = '') {
  if (!state.socket?.connected) { showToast('⚠️ Not connected', 'warning'); return; }
  if (state.isTransmitting) stopTX();
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.peerUsernames.clear(); state.missedCandidates.clear();
  renderUsersEmpty();
  state.socket.emit('join-channel', { channelId: chId, password: pw, username: state.username });
}

function doLeave() {
  if (state.isTransmitting) stopTX();
  state.socket?.emit('leave-channel');
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.peerUsernames.clear(); state.missedCandidates.clear();
  state.channel = null;
  renderUsersEmpty(); updateStatus(); setChannelUIState(false); clearChatPanel();
  renderChannelList(state.channelList);
  showToast('👋 Left the channel', 'info', 2000);
}

// ── Scanner ───────────────────────────────────────────────────────
function toggleScan() { state.scanActive ? stopScan() : startScan(); }

async function startScan() {
  const active = state.channelList.filter(c => c.userCount > 0);
  if (!active.length) { showToast('📻 No active channels', 'info'); return; }
  state.scanActive = true;
  $('scan-btn').textContent = '⏹ Stop';
  $('scan-btn').classList.add('border-amber-500');
  for (const ch of active) {
    if (!state.scanActive) break;
    $('lcd-status').textContent = 'SCAN…';
    $('lcd-channel').textContent = ch.id;
    await sleep(350);
    if (!state.scanActive) break;
    $('ch-input').value = ch.id;
    _joinChannel(ch.id, '');
    showToast('📡 Tuned → CH ' + ch.id, 'success');
    break;
  }
  stopScan();
}

function stopScan() {
  state.scanActive = false;
  $('scan-btn').textContent = '⟳ Scan';
  $('scan-btn').classList.remove('border-amber-500');
  if (!state.channel) updateStatus();
}

// ── Chat ──────────────────────────────────────────────────────────
function wireChat() {
  $('chat-send-btn').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
}
function sendChat() {
  const inp = $('chat-input');
  const txt = inp.value.trim();
  if (!txt || !state.channel) return;
  state.socket?.emit('chat-message', { text: txt });
  inp.value = '';
}
function appendChatMsg(msg, isHistory = false) {
  const box = $('chat-messages');
  const wc  = box.querySelector('.chat-welcome');
  if (wc) wc.remove();
  const isOwn = msg.socketId === state.socket?.id;
  const time  = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const div   = document.createElement('div');
  div.className = 'flex ' + (isOwn ? 'justify-end' : 'justify-start') + ' msg-in';
  div.innerHTML = `
    <div class="max-w-[78%] flex flex-col gap-1 ${isOwn ? 'items-end' : 'items-start'}">
      <span class="text-[10px] text-gray-400 px-1">${escHtml(msg.username)}</span>
      <div class="${isOwn
        ? 'bg-indigo-500 text-white rounded-2xl rounded-br-sm shadow-md shadow-indigo-500/20'
        : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-2xl rounded-bl-sm border border-gray-200 dark:border-gray-700'} px-4 py-2.5 text-sm leading-relaxed">
        ${escHtml(msg.text)}
      </div>
      <span class="text-[10px] text-gray-300 dark:text-gray-600 px-1">${time}</span>
    </div>`;
  box.appendChild(div);
  if (!isHistory) scrollChat();
  // Badge
  if (!isHistory && !isOwn) {
    const chatPanel = $('panel-chat');
    if (chatPanel?.classList.contains('mobile-hidden')) {
      const b = $('chat-badge');
      if (b) { b.textContent = (parseInt(b.textContent) || 0) + 1; b.classList.remove('hidden'); }
    }
  }
}
function appendSystemMsg(html) {
  const box = $('chat-messages');
  const div = document.createElement('div');
  div.className = 'flex items-center gap-3 text-[11px] text-gray-400 my-1 msg-in';
  div.innerHTML = `<div class="flex-1 h-px bg-gray-100 dark:bg-gray-800"></div><span>${html}</span><div class="flex-1 h-px bg-gray-100 dark:bg-gray-800"></div>`;
  box.appendChild(div);
  scrollChat();
}
function clearChatPanel() {
  $('chat-messages').innerHTML = `
    <div class="chat-welcome flex flex-col items-center justify-center h-full gap-3 text-center py-12">
      <div class="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center">
        <svg viewBox="0 0 20 20" fill="currentColor" class="w-7 h-7 text-indigo-300 dark:text-indigo-600"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z" clip-rule="evenodd"/></svg>
      </div>
      <p class="text-sm font-semibold text-gray-400">No messages yet</p>
      <p class="text-xs text-gray-300 dark:text-gray-600">Join a channel to start chatting</p>
    </div>`;
  $('chat-ch-badge').textContent = 'No channel';
}
function scrollChat() { const b = $('chat-messages'); b.scrollTop = b.scrollHeight; }

// ── Server switch ─────────────────────────────────────────────────
function wireServerSwitch() {
  $('server-switch-btn')?.addEventListener('click', () => {
    const p = $('server-panel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden'))
      $('server-url-input').value = localStorage.getItem('wt_server') || '';
  });
  $('server-save-btn')?.addEventListener('click', () => {
    const v = $('server-url-input').value.trim();
    if (v) { localStorage.setItem('wt_server', v); showToast('Saved — reload to connect', 'info', 4000); }
    $('server-panel').classList.add('hidden');
  });
  $('server-reset-btn')?.addEventListener('click', () => {
    localStorage.removeItem('wt_server');
    showToast('Reset', 'info');
    $('server-panel').classList.add('hidden');
  });
}

function updateServerBadge(url) {
  const b = $('server-badge'); if (!b) return;
  const isLocal = /localhost|127\.0\.0\.1|192\.168\.|10\.\d+\.\d+|172\./.test(url);
  b.textContent = isLocal ? 'LAN' : 'ONLINE';
  b.className = isLocal
    ? 'text-[9px] font-bold tracking-widest px-2 py-0.5 rounded-full bg-cyan-100 dark:bg-cyan-900/40 text-cyan-600 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-800'
    : 'text-[9px] font-bold tracking-widest px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800';
}

// ── UI Renderers ──────────────────────────────────────────────────
function setConnStatus(on) {
  const dot = $('conn-dot'); const lbl = $('conn-label');
  dot.className = 'w-2 h-2 rounded-full ' + (on ? 'status-dot-connected' : 'status-dot-disconnected');
  lbl.textContent = on ? 'ONLINE' : 'OFFLINE';
}

function updateStatus() {
  const ch = state.channel;
  $('lcd-channel').textContent   = ch ? String(ch) : '--';
  $('lcd-status').textContent    = ch ? 'ON CH ' + ch : 'STANDBY';
  $('lcd-usercount').textContent = ch ? state.peers.size + 1 : 0;
}

function setChannelUIState(inCh) {
  $('ptt-btn').disabled       = !inCh;
  $('leave-btn').disabled     = !inCh;
  $('chat-input').disabled    = !inCh;
  $('chat-send-btn').disabled = !inCh;
}

function renderUserAdd(sid, username) {
  const list = $('users-list');
  const empty = list.querySelector('.users-empty');
  if (empty) empty.remove();
  if ($('u-' + sid)) return;
  const init = (username[0] || '?').toUpperCase();
  const div  = document.createElement('div');
  div.id        = 'u-' + sid;
  div.className = 'flex items-center gap-3 p-2.5 rounded-2xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/60 transition-all';
  div.innerHTML = `
    <div class="user-avatar-el w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 border-2 border-transparent flex items-center justify-center text-sm font-bold text-white flex-shrink-0 transition-all">
      ${escHtml(init)}
    </div>
    <span class="flex-1 text-sm font-medium text-gray-800 dark:text-gray-200 truncate">${escHtml(username)}</span>
    <span class="user-mic-icon text-sm opacity-0 transition-opacity">🎙️</span>`;
  list.appendChild(div);
  updateStatus();
}

function renderUserRemove(sid) {
  $('u-' + sid)?.remove();
  if (!$('users-list').querySelector('[id^="u-"]'))
    renderUsersEmpty();
  updateStatus();
}

function renderUsersEmpty() {
  $('users-list').innerHTML = '<p class="users-empty text-xs text-gray-400 italic">Join a channel to see users</p>';
}

function renderSpeaking(sid, isSpeaking) {
  const el = $('u-' + sid); if (!el) return;
  el.classList.toggle('user-item-speaking', isSpeaking);
  const mic = el.querySelector('.user-mic-icon');
  if (mic) mic.style.opacity = isSpeaking ? '1' : '0';
}

function renderChannelList(channels) {
  const list = $('ch-list'); list.innerHTML = '';
  if (!channels || !channels.length) {
    list.innerHTML = '<p class="text-xs text-gray-400 italic text-center py-8">No active frequencies yet</p>';
    return;
  }
  channels.forEach(ch => {
    const isCurrent = state.channel === ch.id;
    const names = (ch.users || []).slice(0, 3).map(escHtml).join(', ') || 'empty';
    const card = document.createElement('div');
    card.className = 'ch-card flex items-center gap-3 p-3.5 rounded-2xl ' +
      (isCurrent
        ? 'bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700'
        : 'bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/60 hover:border-indigo-200 dark:hover:border-indigo-700');
    card.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-bold text-sm font-mono ${isCurrent ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-800 dark:text-gray-200'}">${escHtml(String(ch.id))}</span>
          ${ch.hasActivity ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-slow"></span>' : ''}
          ${isCurrent ? '<span class="text-[9px] font-bold tracking-widest px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-700">ON AIR</span>' : ''}
        </div>
        <p class="text-xs text-gray-400 truncate mt-0.5">${ch.userCount} user${ch.userCount !== 1 ? 's' : ''} · ${names}</p>
      </div>
      ${!isCurrent ? '<svg viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 text-gray-300 dark:text-gray-600 flex-shrink-0"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>' : ''}`;

    if (!isCurrent) {
      card.addEventListener('click', () => {
        $('ch-input').value = ch.id;
        _joinChannel(ch.id, '');
      });
    }
    list.appendChild(card);
  });
}

window.setMode = setMode;
