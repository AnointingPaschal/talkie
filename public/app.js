/* ─────────────────────────────────────────────────────────────────────────────
   S-talk — Frontend  (WebRTC mesh + Socket.io)
   ───────────────────────────────────────────────────────────────────────────── */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  socket:           null,
  localStream:      null,
  audioCtx:         null,
  analyser:         null,
  peers:            new Map(),
  peerAudios:       new Map(),
  peerUsernames:    new Map(),
  channel:          null,
  username:         '',
  mode:             'ptt',
  isTransmitting:   false,
  isSpeaking:       false,
  isOutgoingMuted:  false,
  scanActive:       false,
  channelList:      [],
  vuBars:           [],
  speakTimer:       null,
  toastTimer:       null,
  missedCandidates: new Map(),
};

const ICE_CFG = { iceServers: [] };

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showToast(msg, type = 'info', duration = 3000) {
  clearTimeout(state.toastTimer);
  const el = $('toast');
  el.textContent = msg;
  el.className   = `toast show ${type}`;
  state.toastTimer = setTimeout(() => { el.className = 'toast'; }, duration);
}

// ── Server URL ────────────────────────────────────────────────────────────────
function getServerUrl() {
  // Electron always uses local
  if (window.electronAPI) return 'https://localhost:3000';
  // Custom override saved by user
  const saved = localStorage.getItem('wt_server');
  if (saved) return saved;
  // Use current origin (works both locally and on Railway/Render)
  return window.location.origin;
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildVUMeter();
  wireSetupScreen();
  wirePTT();
  wireModeButtons();
  wireChannelControls();
  wireChat();
  wireServerSwitch();
});

// ── VU Meter ──────────────────────────────────────────────────────────────────
function buildVUMeter() {
  const container = $('vu-bars');
  for (let i = 0; i < 28; i++) {
    const bar = document.createElement('div');
    bar.className = 'vu-bar';
    container.appendChild(bar);
    state.vuBars.push(bar);
  }
}

function animateVU() {
  if (!state.analyser) return;
  const data = new Uint8Array(state.analyser.frequencyBinCount);
  function frame() {
    requestAnimationFrame(frame);
    state.analyser.getByteFrequencyData(data);
    let sum = 0;
    const lo = 2, hi = Math.floor(data.length * 0.75);
    for (let i = lo; i < hi; i++) sum += data[i];
    const level = sum / ((hi - lo) * 255);
    const active = state.isTransmitting;
    const n      = state.vuBars.length;
    for (let i = 0; i < n; i++) {
      const threshold = i / n;
      const lit       = active && level > threshold * 0.55;
      const pct       = lit ? Math.min(100, 12 + (level - threshold * 0.55) * 280) : 6;
      state.vuBars[i].style.height = pct + '%';
      let color;
      if (i < n * 0.6)       color = lit ? '#34d399' : 'rgba(255,255,255,.05)';
      else if (i < n * 0.82) color = lit ? '#fbbf24' : 'rgba(255,255,255,.05)';
      else                   color = lit ? '#fb7185' : 'rgba(255,255,255,.05)';
      state.vuBars[i].style.background = color;
    }
    if (active) {
      const speaking = level > 0.04;
      if (speaking !== state.isSpeaking) {
        clearTimeout(state.speakTimer);
        if (!speaking) {
          state.speakTimer = setTimeout(() => {
            state.isSpeaking = false;
            state.socket?.emit('speaking', { isSpeaking: false });
          }, 400);
        } else {
          clearTimeout(state.speakTimer);
          state.isSpeaking = true;
          state.socket?.emit('speaking', { isSpeaking: true });
        }
      }
    }
  }
  frame();
}

// ── Setup Screen ──────────────────────────────────────────────────────────────
function wireSetupScreen() {
  const startBtn   = $('start-btn');
  const usernameEl = $('username-input');
  startBtn.addEventListener('click', handleStart);
  usernameEl.addEventListener('keydown', e => { if (e.key === 'Enter') handleStart(); });

  async function handleStart() {
    const raw = usernameEl.value.trim();
    state.username = raw || 'Anonymous';
    setSetupStatus('Requesting microphone…', 'info');
    startBtn.disabled = true;
    const ok = await requestMic();
    if (!ok) { startBtn.disabled = false; return; }
    setSetupStatus('Connecting to server…', 'info');
    initSocket();
    $('setup-screen').classList.add('hidden');
    $('main-app').classList.remove('hidden');
    $('username-pill').textContent = state.username;
  }
}

function setSetupStatus(msg, type) {
  const el = $('setup-status');
  el.textContent = msg;
  el.className   = `setup-status ${type}`;
}

// ── Mic ───────────────────────────────────────────────────────────────────────
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
    if (err.name === 'NotAllowedError')  msg = '❌ Microphone access denied. Allow it in your browser and reload.';
    if (err.name === 'NotFoundError')    msg = '❌ No microphone found.';
    if (err.name === 'NotReadableError') msg = '❌ Mic is in use by another app.';
    setSetupStatus(msg, 'error');
    return false;
  }
}

function setupAnalyser() {
  const AudioCtx  = window.AudioContext || window.webkitAudioContext;
  state.audioCtx  = new AudioCtx();
  state.analyser  = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 512;
  state.analyser.smoothingTimeConstant = 0.75;
  const src = state.audioCtx.createMediaStreamSource(state.localStream);
  src.connect(state.analyser);
  animateVU();
}

// ── Socket ────────────────────────────────────────────────────────────────────
function initSocket() {
  const url = getServerUrl();
  state.socket = io(url, { rejectUnauthorized: false, reconnectionDelayMax: 5000 });

  state.socket.on('connect', () => {
    setConnStatus(true);
    state.socket.emit('set-username', state.username);
    state.socket.emit('get-channels');
    updateServerBadge(url);
  });

  state.socket.on('disconnect', () => {
    setConnStatus(false);
    for (const id of [...state.peers.keys()]) removePeer(id);
    state.peerUsernames.clear();
    state.channel = null;
    updateLCD(); setChannelUIState(false);
  });

  state.socket.on('reconnect', () => {
    showToast('📡 Reconnected', 'success');
    if (state.channel) {
      state.socket.emit('join-channel', { channelId: state.channel, username: state.username });
    }
  });

  state.socket.on('signal', ({ fromId, data }) => handleSignal(fromId, data));

  state.socket.on('joined-channel', ({ channelId, existingPeers, isPrivate, messages }) => {
    state.channel = channelId;
    updateLCD(); setChannelUIState(true);
    $('chat-ch-badge').textContent = `CH ${channelId}${isPrivate ? ' 🔒' : ''}`;
    existingPeers.forEach(({ socketId, username }) => {
      state.peerUsernames.set(socketId, username);
      renderUserAdd(socketId, username);
    });
    existingPeers.forEach(({ socketId }) => createPeer(socketId, true));
    clearChatPanel();
    messages.forEach(m => appendChatMsg(m, true));
    scrollChat();
    showToast(`✅ Joined ${isPrivate ? '🔒 ' : ''}channel ${channelId}`, 'success');
    renderChannelList(state.channelList); // refresh to show "IN" state
  });

  state.socket.on('user-joined', ({ socketId, username }) => {
    state.peerUsernames.set(socketId, username);
    renderUserAdd(socketId, username);
    appendSystemMsg(`${escHtml(username)} joined`);
  });

  state.socket.on('user-left', ({ socketId }) => {
    const uname = state.peerUsernames.get(socketId) || 'Someone';
    removePeer(socketId);
    renderUserRemove(socketId);
    state.peerUsernames.delete(socketId);
    state.missedCandidates.delete(socketId);
    appendSystemMsg(`${escHtml(uname)} left`);
  });

  state.socket.on('user-speaking', ({ socketId, isSpeaking }) => renderSpeaking(socketId, isSpeaking));
  state.socket.on('channel-list',  list => { state.channelList = list; renderChannelList(list); });
  state.socket.on('chat-message',  msg  => appendChatMsg(msg));
  state.socket.on('join-error',    ({ message }) => showToast('❌ ' + message, 'error'));
}

// ── WebRTC ────────────────────────────────────────────────────────────────────
function createPeer(peerId, isInitiator) {
  if (state.peers.has(peerId)) return state.peers.get(peerId);
  const pc = new RTCPeerConnection(ICE_CFG);
  state.peers.set(peerId, pc);
  state.missedCandidates.set(peerId, []);

  if (state.localStream)
    state.localStream.getAudioTracks().forEach(t => pc.addTrack(t, state.localStream));

  pc.ontrack = ({ streams }) => {
    if (!streams[0]) return;
    let audio = state.peerAudios.get(peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true; audio.style.display = 'none';
      document.body.appendChild(audio);
      state.peerAudios.set(peerId, audio);
    }
    audio.srcObject = streams[0];
    audio.muted = state.isOutgoingMuted;
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate)
      state.socket.emit('signal', { targetId: peerId, data: { type: 'ice-candidate', payload: candidate } });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') removePeer(peerId);
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        state.socket.emit('signal', { targetId: peerId, data: { type: 'offer', payload: pc.localDescription } });
      } catch (e) { console.error('createOffer', e); }
    };
  }
  return pc;
}

async function handleSignal(fromId, { type, payload }) {
  try {
    if (type === 'offer') {
      const pc = createPeer(fromId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      for (const c of (state.missedCandidates.get(fromId) || []))
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      state.missedCandidates.set(fromId, []);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      state.socket.emit('signal', { targetId: fromId, data: { type: 'answer', payload: pc.localDescription } });
    } else if (type === 'answer') {
      const pc = state.peers.get(fromId);
      if (pc && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        for (const c of (state.missedCandidates.get(fromId) || []))
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        state.missedCandidates.set(fromId, []);
      }
    } else if (type === 'ice-candidate') {
      const pc = state.peers.get(fromId);
      if (!pc || !payload) return;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => {});
      } else {
        const buf = state.missedCandidates.get(fromId) || [];
        buf.push(payload); state.missedCandidates.set(fromId, buf);
      }
    }
  } catch (err) { console.warn('Signal error:', err); }
}

function removePeer(peerId) {
  const pc = state.peers.get(peerId); if (pc) { pc.close(); state.peers.delete(peerId); }
  const audio = state.peerAudios.get(peerId);
  if (audio) { audio.srcObject = null; audio.remove(); state.peerAudios.delete(peerId); }
}

// ── PTT / Toggle ──────────────────────────────────────────────────────────────
function wirePTT() {
  const btn = $('ptt-btn');
  btn.addEventListener('mousedown',  e => { e.preventDefault(); onPress(); });
  btn.addEventListener('mouseup',    () => onRelease());
  btn.addEventListener('mouseleave', () => { if (state.isTransmitting && state.mode === 'ptt') onRelease(); });
  btn.addEventListener('touchstart', e => { e.preventDefault(); onPress(); },   { passive: false });
  btn.addEventListener('touchend',   e => { e.preventDefault(); onRelease(); }, { passive: false });
  btn.addEventListener('touchcancel',() => { if (state.mode === 'ptt') onRelease(); });
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.repeat && !isTypingTarget(e.target)) { e.preventDefault(); onPress(); }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space' && !isTypingTarget(e.target)) { e.preventDefault(); onRelease(); }
  });
}

function isTypingTarget(el) {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function onPress() {
  if (!state.channel) { showToast('⚠️ Join a channel first', 'warning'); return; }
  state.mode === 'ptt' ? startTX() : (state.isTransmitting ? stopTX() : startTX());
}
function onRelease() {
  if (state.mode === 'ptt' && state.isTransmitting) stopTX();
}

function startTX() {
  if (state.isTransmitting) return;
  if (state.audioCtx?.state === 'suspended') state.audioCtx.resume();
  state.isTransmitting = true;
  state.localStream?.getAudioTracks().forEach(t => { t.enabled = true; });
  $('ptt-btn').classList.add('transmitting');
  $('ptt-label').textContent = state.mode === 'ptt' ? 'TRANSMITTING…' : 'ON AIR — CLICK TO STOP';
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

// ── Mode Buttons ──────────────────────────────────────────────────────────────
function wireModeButtons() {
  $('ptt-mode-btn').addEventListener('click', () => setMode('ptt'));
  $('tog-mode-btn').addEventListener('click', () => setMode('toggle'));
  $('mute-mic-btn').addEventListener('click', toggleOutputMute);
}

function setMode(mode) {
  if (state.isTransmitting) stopTX();
  state.mode = mode;
  $('ptt-mode-btn').classList.toggle('active', mode === 'ptt');
  $('tog-mode-btn').classList.toggle('active', mode === 'toggle');
  $('lcd-mode').textContent  = mode === 'ptt' ? 'PTT' : 'TOG';
  $('ptt-label').textContent = mode === 'ptt' ? 'PUSH TO TALK' : 'CLICK TO TALK';
  $('ptt-hint').innerHTML    = mode === 'ptt'
    ? 'Hold <kbd>Space</kbd> or press &amp; hold the button'
    : 'Click once to open mic — click again to close';
}

function toggleOutputMute() {
  state.isOutgoingMuted = !state.isOutgoingMuted;
  state.peerAudios.forEach(a => { a.muted = state.isOutgoingMuted; });
  $('mute-mic-btn').querySelector('#mute-icon')?.setAttribute('class', '');
  $('mute-mic-btn').classList.toggle('active', state.isOutgoingMuted);
  // Swap icon
  const btn = $('mute-mic-btn');
  btn.innerHTML = state.isOutgoingMuted
    ? `<svg viewBox="0 0 20 20" fill="currentColor" width="16" id="mute-icon"><path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0 9.972 9.972 0 010 14.142 1 1 0 01-1.414-1.414 7.971 7.971 0 000-11.314 1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clip-rule="evenodd"/><line x1="3" y1="3" x2="17" y2="17" stroke="currentColor" stroke-width="2"/></svg>`
    : `<svg viewBox="0 0 20 20" fill="currentColor" width="16" id="mute-icon"><path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clip-rule="evenodd"/></svg>`;
  showToast(state.isOutgoingMuted ? '🔇 Audio muted' : '🔊 Audio on', 'info', 2000);
}

// ── Channel Controls ──────────────────────────────────────────────────────────
function wireChannelControls() {
  $('join-btn').addEventListener('click',  doHost);
  $('leave-btn').addEventListener('click', doLeave);
  $('scan-btn').addEventListener('click',  toggleScan);
  $('refresh-btn').addEventListener('click', () => state.socket?.emit('get-channels'));
  $('ch-input').addEventListener('keydown', e => { if (e.key === 'Enter') doHost(); });
  $('private-chk').addEventListener('change', () => {
    $('pw-row').classList.toggle('hidden', !$('private-chk').checked);
  });
}

// HOST = create/open a channel and be the first user
function doHost() {
  const chId = $('ch-input').value.trim();
  if (!chId) { showToast('⚠️ Enter a channel name or number', 'warning'); return; }
  if (!state.socket?.connected) { showToast('⚠️ Not connected', 'warning'); return; }
  const isPrivate = $('private-chk').checked;
  const pw        = isPrivate ? $('pw-input').value : '';
  _joinChannel(chId, pw);
}

// Internal join used by both HOST and list JOIN buttons
function _joinChannel(chId, pw = '') {
  if (state.isTransmitting) stopTX();
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.peerUsernames.clear();
  state.missedCandidates.clear();
  renderUsersListEmpty();
  state.socket.emit('join-channel', { channelId: chId, password: pw, username: state.username });
}

function doLeave() {
  if (state.isTransmitting) stopTX();
  state.socket?.emit('leave-channel');
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.peerUsernames.clear();
  state.missedCandidates.clear();
  state.channel = null;
  renderUsersListEmpty();
  updateLCD(); setChannelUIState(false);
  clearChatPanel();
  renderChannelList(state.channelList);
  showToast('👋 Left the channel', 'info', 2000);
}

// ── Scanner ───────────────────────────────────────────────────────────────────
function toggleScan() {
  state.scanActive ? stopScan() : startScan();
}

async function startScan() {
  const active = state.channelList.filter(ch => ch.userCount > 0);
  if (active.length === 0) { showToast('📻 No active channels to scan', 'info'); return; }
  state.scanActive = true;
  $('scan-btn').textContent = '⏹ STOP';
  $('scan-btn').classList.add('scanning');
  for (const ch of active) {
    if (!state.scanActive) break;
    $('lcd-status').textContent  = 'SCANNING…';
    $('lcd-channel').textContent = String(ch.id).padStart(2, '0');
    await sleep(350);
    if (!state.scanActive) break;
    $('ch-input').value = ch.id;
    _joinChannel(ch.id);
    showToast(`📡 Scan → Channel ${ch.id}`, 'success');
    break;
  }
  stopScan();
}

function stopScan() {
  state.scanActive = false;
  $('scan-btn').textContent = '⟳ SCAN';
  $('scan-btn').classList.remove('scanning');
  if (!state.channel) updateLCD();
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function wireChat() {
  $('chat-send-btn').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}
function sendChat() {
  const inp = $('chat-input');
  const text = inp.value.trim();
  if (!text || !state.channel) return;
  state.socket?.emit('chat-message', { text });
  inp.value = '';
}
function appendChatMsg(msg, isHistory = false) {
  const box = $('chat-messages');
  const wc  = box.querySelector('.chat-welcome');
  if (wc) wc.remove();
  const isOwn = msg.socketId === state.socket?.id;
  const time  = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const div   = document.createElement('div');
  div.className = `chat-msg ${isOwn ? 'own' : 'other'}`;
  div.innerHTML = `
    <span class="msg-username">${escHtml(msg.username)}</span>
    <span class="msg-text">${escHtml(msg.text)}</span>
    <span class="msg-time">${time}</span>
  `;
  box.appendChild(div);
  if (!isHistory) scrollChat();
  // Badge on mobile if chat tab isn't active
  if (!isHistory) {
    const chatPanel = $('panel-chat');
    if (chatPanel && chatPanel.classList.contains('mobile-hidden') && !isOwn) {
      const badge = $('chat-badge');
      if (badge) {
        const current = parseInt(badge.textContent) || 0;
        badge.textContent = current + 1;
        badge.classList.remove('hidden');
      }
    }
  }
}
function appendSystemMsg(html) {
  const box = $('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.innerHTML = html;
  box.appendChild(div);
  scrollChat();
}
function clearChatPanel() {
  $('chat-messages').innerHTML = `
    <div class="chat-welcome">
      <div class="cw-icon"><svg viewBox="0 0 48 48" fill="none" width="52"><circle cx="24" cy="24" r="22" stroke="rgba(129,140,248,.3)" stroke-width="1.5"/><path d="M12 24c0-6.627 5.373-12 12-12s12 5.373 12 12-5.373 12-12 12H12l2-4c-1.245-2.18-2-4.73-2-8z" fill="rgba(129,140,248,.12)" stroke="rgba(129,140,248,.4)" stroke-width="1.5"/><circle cx="18" cy="24" r="1.5" fill="rgba(129,140,248,.7)"/><circle cx="24" cy="24" r="1.5" fill="rgba(129,140,248,.7)"/><circle cx="30" cy="24" r="1.5" fill="rgba(129,140,248,.7)"/></svg></div>
      <p class="cw-title">No messages yet</p>
      <p class="cw-sub">Join a channel to chat</p>
    </div>`;
  $('chat-ch-badge').textContent = 'No channel';
}
function scrollChat() {
  const box = $('chat-messages');
  box.scrollTop = box.scrollHeight;
}

// ── Server Switch ─────────────────────────────────────────────────────────────
function wireServerSwitch() {
  const btn = $('server-switch-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const input = $('server-url-input');
    const panel = $('server-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      input.value = localStorage.getItem('wt_server') || window.location.origin;
    }
  });
  $('server-save-btn')?.addEventListener('click', () => {
    const val = $('server-url-input').value.trim();
    if (val) {
      localStorage.setItem('wt_server', val);
      showToast('Server URL saved — reload to connect', 'info', 4000);
      $('server-panel').classList.add('hidden');
    }
  });
  $('server-reset-btn')?.addEventListener('click', () => {
    localStorage.removeItem('wt_server');
    showToast('Reset — reload to reconnect', 'info');
    $('server-panel').classList.add('hidden');
  });
}

function updateServerBadge(url) {
  const badge = $('server-badge');
  if (!badge) return;
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1') || url.match(/192\.168\.|10\.\d+\.\d+\.|172\./);
  badge.textContent = isLocal ? 'LAN' : 'ONLINE';
  badge.className   = `server-mode-badge ${isLocal ? 'badge-lan' : 'badge-online'}`;
}

// ── UI Renderers ──────────────────────────────────────────────────────────────
function setConnStatus(connected) {
  $('conn-dot').className     = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  $('conn-label').textContent = connected ? 'ONLINE' : 'OFFLINE';
}
function updateLCD() {
  const ch = state.channel;
  $('lcd-channel').textContent   = ch ? String(ch).padStart(2, '0') : '--';
  $('lcd-status').textContent    = ch ? `ON CH ${ch}` : 'STANDBY';
  $('lcd-usercount').textContent = ch ? state.peers.size + 1 : 0;
}
function setChannelUIState(inChannel) {
  $('ptt-btn').disabled       = !inChannel;
  $('leave-btn').disabled     = !inChannel;
  $('chat-input').disabled    = !inChannel;
  $('chat-send-btn').disabled = !inChannel;
}
function renderUserAdd(socketId, username) {
  const list  = $('users-list');
  const empty = list.querySelector('.list-empty');
  if (empty) empty.remove();
  if ($(`user-${socketId}`)) return;
  const initial = (username[0] || '?').toUpperCase();
  const div     = document.createElement('div');
  div.id        = `user-${socketId}`;
  div.className = 'user-item';
  div.innerHTML = `
    <div class="user-avatar">${escHtml(initial)}</div>
    <span class="user-name">${escHtml(username)}</span>
    <span class="user-mic" aria-label="speaking">🎙️</span>
  `;
  list.appendChild(div);
  updateLCD();
}
function renderUserRemove(socketId) {
  const el = $(`user-${socketId}`);
  if (el) el.remove();
  if (!$('users-list').querySelector('.user-item')) renderUsersListEmpty();
  updateLCD();
}
function renderUsersListEmpty() {
  $('users-list').innerHTML = '<div class="list-empty">Join a channel to see users</div>';
}
function renderSpeaking(socketId, isSpeaking) {
  const el = $(`user-${socketId}`);
  if (el) el.classList.toggle('speaking', isSpeaking);
}

function renderChannelList(channels) {
  const list = $('ch-list');
  if (channels.length === 0) {
    list.innerHTML = '<div class="list-empty">No active channels yet</div>';
    return;
  }
  list.innerHTML = channels.map(ch => {
    const isCurrent = state.channel === ch.id;
    return `
    <div class="ch-item ${isCurrent ? 'current' : ''} ${ch.hasActivity ? 'has-activity' : ''}">
      <div class="ch-item-info">
        <div class="ch-item-top">
          <span class="ch-number">CH ${escHtml(String(ch.id))}</span>
          ${ch.hasActivity ? '<span class="ch-dot" title="Active"></span>' : ''}
        </div>
        <span class="ch-usernames">${ch.users.slice(0, 3).map(escHtml).join(', ') || 'Empty'}</span>
      </div>
      <div class="ch-item-right">
        <span class="ch-usercount">${ch.userCount} <svg viewBox="0 0 12 12" fill="currentColor" width="10"><path d="M4 5a2 2 0 100-4 2 2 0 000 4zm-4 6a6 6 0 018 0H0zm10-4a2 2 0 100-4 2 2 0 000 4zm0 4a4 4 0 00-3.5 2H14a4 4 0 00-3.5-2H10z"/></svg></span>
        <button class="ch-join-btn ${isCurrent ? 'ch-join-current' : ''}"
                onclick="quickJoin(${JSON.stringify(ch.id)})"
                ${isCurrent ? 'disabled' : ''}>
          ${isCurrent ? '✓ IN' : 'JOIN'}
        </button>
      </div>
    </div>`;
  }).join('');
}

window.quickJoin = function(channelId) {
  const privateChk = $('private-chk');
  const isPrivate  = channels?.get?.(channelId)?.password;
  if (isPrivate) {
    const pw = prompt(`Channel ${channelId} is private. Enter password:`);
    if (pw === null) return;
    _joinChannel(channelId, pw);
  } else {
    _joinChannel(channelId, '');
  }
};

window.setMode = setMode;
