(() => {
'use strict';

/* =====================================================================
   Helpers
   ===================================================================== */
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const mem = {};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
};
const session = {
  get(k) { try { return sessionStorage.getItem(k) || mem[k]; } catch { return mem[k]; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } mem[k] = v; }
};
// Per-tab id so you can test with two tabs on one computer. Survives refresh.
const clientId = (() => {
  let id = session.get('oc.cid');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    session.set('oc.cid', id);
  }
  return id;
})();

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function parseStart(v) {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return +v;
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

/** Returns { id, start } for any YouTube URL (or bare 11-char id), else null. */
function parseYT(input) {
  input = String(input || '').trim();
  if (/^[\w-]{11}$/.test(input)) return { id: input, start: 0 };
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/); if (m) id = m[1]; }
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  return { id, start: parseStart(u.searchParams.get('t') || u.searchParams.get('start')) };
}

const titleCache = new Map();
async function getTitle(id) {
  if (titleCache.has(id)) return titleCache.get(id);
  try {
    const r = await fetch('/api/title?id=' + encodeURIComponent(id));
    const j = await r.json();
    titleCache.set(id, j.title || 'YouTube video');
  } catch { return 'YouTube video'; }
  return titleCache.get(id);
}

function toast(text, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
let stageToastTimer;
function stageToast(text) {
  const el = $('stageToast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(stageToastTimer);
  stageToastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function banner(text, isErr) {
  const b = $('banner');
  if (!text) return b.classList.add('hidden');
  b.textContent = text;
  b.classList.toggle('err', !!isErr);
  b.classList.remove('hidden');
}

let _ac;
function getAC() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!_ac) _ac = new AC();
  if (_ac.state === 'suspended') _ac.resume().catch(() => {});
  return _ac;
}
document.addEventListener('pointerdown', () => { if (_ac) getAC(); }, { passive: true });
function blip() {
  try {
    const c = getAC(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.07, c.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.25);
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + 0.26);
  } catch { /* ignore */ }
}

function watchSpeaking(stream, tile) {
  try {
    const c = getAC(); if (!c || !stream.getAudioTracks().length) return () => {};
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const iv = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let s = 0;
      for (const v of buf) { const d = (v - 128) / 128; s += d * d; }
      tile.classList.toggle('speaking', Math.sqrt(s / buf.length) > 0.04);
    }, 150);
    return () => { clearInterval(iv); tile.classList.remove('speaking'); try { src.disconnect(); } catch { /* */ } };
  } catch { return () => {}; }
}

/* =====================================================================
   State
   ===================================================================== */
let socket = null;
let myName = 'Me', roomCode = '', myId = null;
let peer = null;                 // { id, name, media }
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

/* =====================================================================
   Lobby
   ===================================================================== */
const ADJ = ['cozy', 'sunny', 'velvet', 'golden', 'quiet', 'lazy', 'cosmic', 'gentle', 'wild', 'sweet'];
const NOUN = ['panda', 'otter', 'comet', 'maple', 'lantern', 'cinema', 'sofa', 'blanket', 'sparrow', 'moon'];
function randomRoom() {
  const r = (a) => a[Math.floor(Math.random() * a.length)];
  const n = crypto.getRandomValues(new Uint16Array(1))[0] % 9000 + 1000;
  return `${r(ADJ)}-${r(NOUN)}-${n}`;
}
function lobbyMsg(text, info) {
  const el = $('lobbyMsg');
  el.textContent = text || '';
  el.classList.toggle('info', !!info);
}

(async function initLobby() {
  $('name').value = store.get('oc.name', '');
  const q = new URLSearchParams(location.search);
  $('room').value = (q.get('room') || store.get('oc.room', '')).toLowerCase();
  if (!$('name').value) $('name').focus(); else if (!$('room').value) $('room').focus();
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (cfg.passwordRequired) {
      $('passWrap').classList.remove('hidden');
      $('pass').value = store.get('oc.pass', '');
      $('pass').required = true;
    }
  } catch { /* ignore */ }
})();

$('randomBtn').onclick = () => { $('room').value = randomRoom(); $('room').focus(); };
$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('name').value.trim();
  const room = $('room').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const pass = $('pass').value;
  if (!name) return lobbyMsg('Please enter your name.');
  if (room.length < 4) return lobbyMsg('Room code needs at least 4 letters or numbers.');
  $('room').value = room;
  store.set('oc.name', name); store.set('oc.room', room);
  if (pass) store.set('oc.pass', pass);
  $('joinBtn').disabled = true;
  try {
    await startSession(name, room, pass);
  } catch (err) {
    lobbyMsg(err.message || 'Could not join.');
    $('joinBtn').disabled = false;
  }
});

async function startSession(name, room, pass) {
  myName = name; roomCode = room;
  lobbyMsg('Getting your camera and mic ready…', true);
  try { iceServers = await (await fetch('/api/ice')).json(); } catch { /* use default */ }
  await Media.init();
  lobbyMsg('Joining room…', true);
  await connect(pass);
  $('lobby').classList.add('hidden');
  $('app').classList.remove('hidden');
  history.replaceState(null, '', '/?room=' + encodeURIComponent(room));
  $('roomLabel').textContent = room;
  $('meAvatar').textContent = name.charAt(0) || 'Y';
  Media.render();
  Chat.focus();
}

/* =====================================================================
   Local media (camera + mic)
   ===================================================================== */
const Media = (() => {
  let stream = new MediaStream();
  let micOn = true, camOn = true;
  let facing = 'user';
  let canFlip = false;
  let stopSpeak = () => {};

  const VIDEO = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };
  const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

  const audioTrack = () => stream.getAudioTracks()[0] || null;
  const videoTrack = () => stream.getVideoTracks()[0] || null;
  const state = () => ({ mic: !!audioTrack() && micOn, cam: !!videoTrack() && camOn });

  async function init() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      lobbyMsg('Camera/mic need HTTPS. You can still watch and chat.', true);
      await wait(900);
      return;
    }
    const tries = [
      { audio: AUDIO, video: { ...VIDEO, facingMode: 'user' } },
      { audio: AUDIO, video: false },
      { audio: false, video: { ...VIDEO, facingMode: 'user' } }
    ];
    for (const c of tries) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch { /* try next */ }
    }
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      canFlip = devs.filter((d) => d.kind === 'videoinput').length > 1;
    } catch { /* ignore */ }
    if (!audioTrack() && !videoTrack()) {
      lobbyMsg('No camera/mic access. Joining as watch-and-chat only.', true);
      await wait(900);
    }
  }

  function render() {
    const s = state();
    const lv = $('localVideo');
    if (lv.srcObject !== stream) lv.srcObject = stream;
    lv.classList.toggle('mirror', facing === 'user');
    $('meOff').classList.toggle('hidden', s.cam);
    $('meOffText').textContent = videoTrack() ? 'Camera off' : 'No camera';
    $('meMicOff').classList.toggle('hidden', s.mic);
    const mic = $('micBtn'), cam = $('camBtn');
    mic.classList.toggle('off', !s.mic);
    cam.classList.toggle('off', !s.cam);
    mic.querySelector('use').setAttribute('href', s.mic ? '#i-mic' : '#i-mic-off');
    cam.querySelector('use').setAttribute('href', s.cam ? '#i-video' : '#i-video-off');
    $('flipBtn').classList.toggle('hidden', !(canFlip && videoTrack()));
    stopSpeak();
    stopSpeak = watchSpeaking(new MediaStream(stream.getAudioTracks()), $('meTile'));
  }

  function broadcast() { if (socket && socket.connected) socket.emit('media:state', state()); }

  async function acquire(kind) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: AUDIO } : { video: { ...VIDEO, facingMode: facing } });
      const t = kind === 'audio' ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
      stream.addTrack(t);
      if (kind === 'audio') micOn = true; else camOn = true;
      Peer.setLocalTracks();
      return true;
    } catch {
      toast(`Couldn't access the ${kind === 'audio' ? 'microphone' : 'camera'}. Check browser permissions.`, true);
      return false;
    }
  }

  async function toggleMic() {
    if (!audioTrack()) { if (!(await acquire('audio'))) return; }
    else { micOn = !micOn; audioTrack().enabled = micOn; }
    render(); broadcast();
  }
  async function toggleCam() {
    if (!videoTrack()) { if (!(await acquire('video'))) return; }
    else { camOn = !camOn; videoTrack().enabled = camOn; }
    render(); broadcast();
  }
  async function flip() {
    const old = videoTrack(); if (!old) return;
    const next = facing === 'user' ? 'environment' : 'user';
    old.stop(); stream.removeTrack(old);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, facingMode: { ideal: next } } });
      const t = s.getVideoTracks()[0];
      t.enabled = camOn;
      stream.addTrack(t);
      facing = next;
    } catch {
      try { // fall back to the original camera
        const s = await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, facingMode: facing } });
        stream.addTrack(s.getVideoTracks()[0]);
      } catch { /* give up */ }
      toast("Couldn't switch camera.", true);
    }
    Peer.setLocalTracks(); render(); broadcast();
  }
  function stop() { stopSpeak(); stream.getTracks().forEach((t) => t.stop()); }

  $('micBtn').onclick = toggleMic;
  $('camBtn').onclick = toggleCam;
  $('flipBtn').onclick = flip;

  return { init, render, state, audioTrack, videoTrack, stop };
})();

/* =====================================================================
   WebRTC peer (perfect negotiation, one partner)
   ===================================================================== */
const Peer = (() => {
  let pc = null, polite = false, makingOffer = false, ignoreOffer = false;
  let audioTx = null, videoTx = null, remote = null, stopSpeak = () => {};
  let rtc = 'idle';

  const send = (data) => socket && socket.emit('signal', data);

  function create() {
    close();
    polite = String(myId) > String(peer.id);
    makingOffer = false; ignoreOffer = false;
    const conn = (pc = new RTCPeerConnection({ iceServers }));
    remote = new MediaStream();
    $('remoteVideo').srcObject = remote;

    audioTx = conn.addTransceiver(Media.audioTrack() || 'audio', { direction: 'sendrecv' });
    videoTx = conn.addTransceiver(Media.videoTrack() || 'video', { direction: 'sendrecv' });

    conn.ontrack = (e) => {
      remote.addTrack(e.track);
      $('remoteVideo').play().catch(() => {});
      if (e.track.kind === 'audio') {
        stopSpeak();
        stopSpeak = watchSpeaking(new MediaStream([e.track]), $('partnerTile'));
      }
    };
    conn.onicecandidate = ({ candidate }) => { if (candidate) send({ candidate }); };
    conn.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await conn.setLocalDescription();
        send({ description: conn.localDescription });
      } catch (err) { console.warn('negotiation', err); } finally { makingOffer = false; }
    };
    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      rtc = conn.connectionState;
      if (rtc === 'failed') { try { conn.restartIce(); } catch { /* */ } }
      renderPresence();
    };
    renderPresence();
  }

  async function onSignal({ description, candidate }) {
    if (!pc) { if (!peer) return; create(); }
    const conn = pc;
    try {
      if (description) {
        const collision = description.type === 'offer' && (makingOffer || conn.signalingState !== 'stable');
        ignoreOffer = !polite && collision;
        if (ignoreOffer) return;
        await conn.setRemoteDescription(description);
        if (description.type === 'offer') {
          await conn.setLocalDescription();
          send({ description: conn.localDescription });
        }
      } else if (candidate) {
        try { await conn.addIceCandidate(candidate); } catch (err) { if (!ignoreOffer) throw err; }
      }
    } catch (err) { console.warn('signal', err); }
  }

  /** Swap camera/mic tracks into the existing senders without renegotiating. */
  function setLocalTracks() {
    if (!pc) return;
    if (audioTx) audioTx.sender.replaceTrack(Media.audioTrack()).catch(() => {});
    if (videoTx) videoTx.sender.replaceTrack(Media.videoTrack()).catch(() => {});
  }

  function close() {
    stopSpeak(); stopSpeak = () => {};
    if (pc) { pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = null; try { pc.close(); } catch { /* */ } }
    pc = null; audioTx = videoTx = null; rtc = 'idle';
    $('remoteVideo').srcObject = null;
  }

  return { create, close, onSignal, setLocalTracks, state: () => rtc };
})();

/* =====================================================================
   Presence / partner tile
   ===================================================================== */
function renderPresence() {
  const dot = $('presenceDot'), txt = $('presenceText');
  const connected = !!peer;
  const rtc = Peer.state();
  dot.className = 'dot' + (connected ? (rtc === 'connected' ? ' on' : ' warn') : '');
  if (!connected) txt.textContent = 'Waiting for your partner…';
  else if (rtc === 'connected') txt.textContent = `${peer.name} is here`;
  else if (rtc === 'failed') txt.textContent = `${peer.name} is here (video connection failed)`;
  else txt.textContent = `${peer.name} is here · connecting video…`;

  $('syncBadge').textContent = connected ? 'In sync' : 'Solo';
  $('syncBadge').classList.toggle('ok', connected);

  const m = (peer && peer.media) || { mic: true, cam: true };
  $('partnerName').textContent = peer ? peer.name : 'Partner';
  $('partnerAvatar').textContent = peer ? peer.name.charAt(0) : '?';
  $('partnerOff').classList.toggle('hidden', !!(peer && m.cam && rtc === 'connected'));
  $('partnerOffText').textContent = !peer ? 'Waiting…' : (!m.cam ? 'Camera off' : 'Connecting…');
  $('partnerMicOff').classList.toggle('hidden', !(peer && !m.mic));
}

/* =====================================================================
   YouTube synced player
   ===================================================================== */
const Player = (() => {
  let yt = null, ready = false, creating = false, apiPromise = null;
  let current = null;            // videoId currently loaded
  let desired = null;            // last known room state { videoId, playing, time, at }
  let ignoreUntil = 0, lastLocalAt = 0;
  let lastPos = null, lastAt = 0, lastPlaying = false;
  let stuckTimer = null;

  const S = () => window.YT && YT.PlayerState;
  const ignoreFor = (ms) => { ignoreUntil = Date.now() + ms; };

  function loadAPI() {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      if (window.YT && YT.Player) return resolve();
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiPromise = null; reject(new Error('YouTube could not be loaded')); };
      document.head.appendChild(s);
    });
    return apiPromise;
  }

  function showStage(on) { $('stageEmpty').classList.toggle('hidden', on); }

  function create(videoId) {
    if (creating || yt) return;
    creating = true;
    current = videoId;
    showStage(true);
    loadAPI().then(() => {
      yt = new YT.Player('player', {
        videoId,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, enablejsapi: 1, origin: location.origin },
        events: {
          onReady: () => { ready = true; creating = false; if (desired) applyDesired(); },
          onStateChange,
          onError: (e) => toast(e.data === 101 || e.data === 150
            ? "The owner of this video doesn't allow embedding. Try another link."
            : "This video can't be played. Try another link.", true)
        }
      });
    }).catch((err) => { creating = false; toast(err.message, true); });
  }

  function setTitle() {
    if (!current) return;
    const id = current;
    $('nowTitle').textContent = 'Loading title…';
    getTitle(id).then((t) => { if (current === id) $('nowTitle').textContent = t; });
  }

  function applyDesired(action) {
    if (!desired) return;
    const d = desired;
    if (!ready) { if (!yt) create(d.videoId); return; }
    ignoreFor(1600);
    showStage(true);
    if (current !== d.videoId) {
      current = d.videoId;
      const opts = { videoId: d.videoId, startSeconds: Math.max(0, d.time) };
      d.playing ? yt.loadVideoById(opts) : yt.cueVideoById(opts);
      setTitle();
    } else {
      const target = d.playing ? d.time + (Date.now() - d.at) / 1000 : d.time;
      const cur = yt.getCurrentTime();
      const threshold = action === 'seek' ? 0.4 : 1.2;
      if (Math.abs(cur - target) > threshold) yt.seekTo(target, true);
      const st = yt.getPlayerState();
      if (d.playing && st !== S().PLAYING && st !== S().BUFFERING) yt.playVideo();
      if (!d.playing && st === S().PLAYING) yt.pauseVideo();
    }
    watchStuck();
  }

  /** Autoplay can be blocked (esp. iOS). If we should be playing but aren't, offer a tap. */
  function watchStuck() {
    clearTimeout(stuckTimer);
    if (!desired || !desired.playing) return $('tapPlay').classList.add('hidden');
    stuckTimer = setTimeout(() => {
      if (!ready || !desired || !desired.playing) return;
      const st = yt.getPlayerState();
      if (st !== S().PLAYING && st !== S().BUFFERING) $('tapPlay').classList.remove('hidden');
    }, 2800);
  }
  $('tapPlay').onclick = () => {
    $('tapPlay').classList.add('hidden');
    if (!ready || !desired) return;
    ignoreFor(1600);
    const target = desired.playing ? desired.time + (Date.now() - desired.at) / 1000 : desired.time;
    yt.seekTo(target, true);
    yt.playVideo();
  };

  function push(action) {
    if (!socket || !ready || !current) return;
    const st = yt.getPlayerState();
    const playing = action === 'play' ? true : action === 'pause' ? false : (st === S().PLAYING || st === S().BUFFERING);
    const time = yt.getCurrentTime();
    lastLocalAt = Date.now();
    lastPos = time; lastAt = Date.now(); lastPlaying = playing;
    desired = { videoId: current, playing, time, at: Date.now() };
    socket.emit('sync:set', { videoId: current, playing, time, action });
    $('tapPlay').classList.add('hidden');
  }

  function onStateChange(e) {
    const st = e.data;
    if (st === S().ENDED) { socket && socket.emit('sync:ended', { videoId: current, time: yt.getCurrentTime() }); return; }
    if (st === S().PLAYING) $('tapPlay').classList.add('hidden');
    if (Date.now() < ignoreUntil) return;           // caused by us applying remote state
    if (st === S().PLAYING) push('play');
    else if (st === S().PAUSED) push('pause');
  }

  // Detect scrubbing/seeking by watching for jumps in playback position.
  setInterval(() => {
    if (!ready || !yt || !current) return;
    let cur, st;
    try { cur = yt.getCurrentTime(); st = yt.getPlayerState(); } catch { return; }
    const now = Date.now();
    if (now >= ignoreUntil && lastPos !== null && st !== S().UNSTARTED && st !== S().CUED) {
      const rate = yt.getPlaybackRate ? yt.getPlaybackRate() : 1;
      const expected = lastPlaying ? lastPos + ((now - lastAt) / 1000) * rate : lastPos;
      if (Math.abs(cur - expected) > 1.8) push('seek');
    }
    lastPos = cur; lastAt = now; lastPlaying = st === S().PLAYING;
  }, 500);

  /* public actions */
  function playNow(id, start = 0) {
    desired = { videoId: id, playing: true, time: start, at: Date.now() };
    lastLocalAt = Date.now();
    if (!yt) create(id); else applyDesired('load');
    setTitle();
    socket.emit('sync:set', { videoId: id, playing: true, time: start, action: 'load' });
  }
  function hasVideo() { return !!current; }

  function onRemote(st) {
    desired = { videoId: st.videoId, playing: st.playing, time: st.time, at: Date.now() };
    if (!yt) { create(st.videoId); setTitle(); return; }
    applyDesired(st.action);
  }

  function onTick(st) {
    if (!ready || !st || st.videoId !== current) return;
    if (Date.now() - lastLocalAt < 3000 || Date.now() < ignoreUntil) return;
    desired = { ...st, at: Date.now() };
    const ps = yt.getPlayerState();
    if (st.playing && ps === S().PLAYING) {
      if (Math.abs(yt.getCurrentTime() - st.time) > 1.5) { ignoreFor(1600); yt.seekTo(st.time + 0.3, true); }
    }
  }

  function describe(st) {
    const who = st.by || 'Your partner';
    switch (st.action) {
      case 'play': return `${who} pressed play at ${fmtTime(st.time)}`;
      case 'pause': return `${who} paused at ${fmtTime(st.time)}`;
      case 'seek': return `${who} jumped to ${fmtTime(st.time)}`;
      case 'load': return `${who} started a new video`;
      default: return '';
    }
  }

  return { playNow, onRemote, onTick, hasVideo, describe };
})();

/* =====================================================================
   Chat
   ===================================================================== */
const EMOJIS = ['😀', '😂', '🥰', '😍', '😘', '😎', '🥹', '😭', '😮', '🤔', '😴', '🙄', '👍', '👏', '🙏', '💪',
  '❤️', '💕', '💖', '🔥', '✨', '🎉', '🍿', '🌙'];

const Chat = (() => {
  let tab = 'chat', unread = 0, lastFrom = null, lastTs = 0, typingTimer = null, iAmTyping = false;
  const box = () => $('messages');
  const baseTitle = document.title;

  function nearBottom() { const m = box(); return m.scrollHeight - m.scrollTop - m.clientHeight < 140; }
  function toBottom() { const m = box(); m.scrollTop = m.scrollHeight; }

  function linkify(parent, text) {
    const re = /https?:\/\/[^\s<]+/g;
    let last = 0, m, yt = null;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = m[0]; a.textContent = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
      parent.append(a);
      last = m.index + m[0].length;
      yt = yt || parseYT(m[0]);
    }
    if (last < text.length) parent.append(text.slice(last));
    return yt;
  }

  function add(msg, opts = {}) {
    const mine = msg.cid === clientId;
    const el = document.createElement('div');
    const first = lastFrom !== msg.cid || msg.ts - lastTs > 120000;
    el.className = 'msg ' + (mine ? 'mine' : 'them') + (first ? ' first' : '');
    if (first && !mine) {
      const who = document.createElement('span');
      who.className = 'who'; who.textContent = msg.from;
      el.append(who);
    }
    const body = document.createElement('span');
    const yt = linkify(body, msg.text);
    el.append(body);
    if (yt) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'watch';
      b.innerHTML = '<svg class="ic xs"><use href="#i-play"/></svg> Watch this together';
      b.onclick = () => Player.playNow(yt.id, yt.start);
      el.append(document.createElement('br'), b);
    }
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.append(time);

    const stick = mine || nearBottom() || opts.history;
    box().append(el);
    lastFrom = msg.cid; lastTs = msg.ts;
    if (stick) toBottom();

    if (!mine && !opts.history) {
      if (tab !== 'chat' || document.hidden) {
        unread++; renderUnread(); blip();
      }
    }
  }

  function system(text) {
    const el = document.createElement('div');
    el.className = 'sys'; el.textContent = text;
    const stick = nearBottom();
    box().append(el); lastFrom = null;
    if (stick) toBottom();
  }

  function reset(history) {
    box().textContent = ''; lastFrom = null; lastTs = 0;
    (history || []).forEach((m) => add(m, { history: true }));
    toBottom();
  }

  function renderUnread() {
    const b = $('chatBadge');
    b.textContent = unread > 99 ? '99+' : unread;
    b.classList.toggle('hidden', !unread);
    document.title = unread ? `(${unread}) ${baseTitle}` : baseTitle;
  }
  function clearUnread() { if (tab === 'chat' && !document.hidden) { unread = 0; renderUnread(); } }
  document.addEventListener('visibilitychange', clearUnread);
  window.addEventListener('focus', clearUnread);

  function setTab(t) {
    tab = t;
    $('tabChat').classList.toggle('active', t === 'chat');
    $('tabQueue').classList.toggle('active', t === 'queue');
    $('chatPanel').classList.toggle('hidden', t !== 'chat');
    $('queuePanel').classList.toggle('hidden', t !== 'queue');
    if (t === 'chat') { clearUnread(); toBottom(); }
  }
  $('tabChat').onclick = () => setTab('chat');
  $('tabQueue').onclick = () => setTab('queue');

  /* sending */
  function setTyping(v) {
    if (iAmTyping === v) return;
    iAmTyping = v;
    socket && socket.emit('chat:typing', v);
  }
  $('chatInput').addEventListener('input', () => {
    setTyping(true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => setTyping(false), 2000);
  });
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text || !socket) return;
    if (!socket.connected) return toast('Offline. Reconnecting…', true);
    socket.emit('chat:send', { text });
    input.value = '';
    clearTimeout(typingTimer); setTyping(false);
    $('emojiPop').classList.add('hidden');
    input.focus();
  });

  /* emoji picker */
  const pop = $('emojiPop');
  EMOJIS.forEach((em) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = em;
    b.onclick = () => { const i = $('chatInput'); i.value += em; i.focus(); };
    pop.append(b);
  });
  $('emojiBtn').onclick = () => pop.classList.toggle('hidden');
  document.addEventListener('pointerdown', (e) => {
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !$('emojiBtn').contains(e.target)) pop.classList.add('hidden');
  });

  function showTyping(v) {
    $('typing').textContent = v && peer ? `${peer.name} is typing…` : '';
  }

  return { add, system, reset, showTyping, setTab, focus: () => $('chatInput').focus({ preventScroll: true }) };
})();

/* =====================================================================
   Queue
   ===================================================================== */
const Queue = (() => {
  function render(list) {
    const ul = $('queueList');
    ul.textContent = '';
    list.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'q-item';
      const img = document.createElement('img');
      img.src = `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`; img.alt = ''; img.loading = 'lazy';
      const meta = document.createElement('div');
      meta.className = 'q-meta';
      const t = document.createElement('div'); t.className = 'q-title'; t.textContent = item.title;
      const by = document.createElement('div'); by.className = 'q-by'; by.textContent = 'Added by ' + item.by;
      meta.append(t, by);
      const play = document.createElement('button');
      play.className = 'icon-btn'; play.type = 'button'; play.title = 'Play now'; play.setAttribute('aria-label', 'Play now');
      play.innerHTML = '<svg class="ic sm"><use href="#i-play"/></svg>';
      play.onclick = () => socket.emit('queue:play', { id: item.id });
      const rm = document.createElement('button');
      rm.className = 'icon-btn'; rm.type = 'button'; rm.title = 'Remove'; rm.setAttribute('aria-label', 'Remove');
      rm.innerHTML = '<svg class="ic sm"><use href="#i-x"/></svg>';
      rm.onclick = () => socket.emit('queue:remove', { id: item.id });
      li.append(img, meta, play, rm);
      ul.append(li);
    });
    $('queueEmpty').classList.toggle('hidden', list.length > 0);
    const b = $('queueBadge');
    b.textContent = list.length;
    b.classList.toggle('hidden', !list.length);
  }
  return { render };
})();

/* =====================================================================
   Reactions
   ===================================================================== */
const REACTIONS = ['❤️', '😂', '😮', '👏', '🔥', '😢', '🥰', '😘', '🤗', '🎉'];
(() => {
  const bar = $('reactBar');
  REACTIONS.forEach((em) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'react-btn'; b.textContent = em; b.setAttribute('aria-label', 'React ' + em);
    b.onclick = () => { spawnReaction(em); if (socket && socket.connected) socket.emit('react', em); };
    bar.append(b);
  });
})();
function spawnReaction(emoji) {
  const layer = $('reactLayer');
  while (layer.children.length > 40) layer.firstChild.remove();
  const el = document.createElement('span');
  el.className = 'float'; el.textContent = emoji;
  el.style.left = (8 + Math.random() * 80) + '%';
  el.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
  el.style.fontSize = (1.8 + Math.random() * 1.2) + 'rem';
  layer.append(el);
  setTimeout(() => el.remove(), 3000);
}

/* =====================================================================
   Socket wiring
   ===================================================================== */
function onJoined(res, isRejoin) {
  myId = res.id;
  peer = res.peer;
  Peer.close();
  if (peer) Peer.create();
  Chat.reset(res.chat);
  Queue.render(res.queue || []);
  if (res.state) {
    Player.onRemote({ ...res.state, action: 'join' });
  }
  Media.render();
  if (socket) socket.emit('media:state', Media.state());
  renderPresence();
  if (isRejoin) { banner(''); toast('Back online'); }
}

function connect(pass) {
  return new Promise((resolve, reject) => {
    let first = true;
    const failTimer = setTimeout(() => {
      if (first) { first = false; reject(new Error("Can't reach the server. Try again.")); try { socket.disconnect(); } catch { /* */ } }
    }, 12000);

    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit('join', { room: roomCode, name: myName, clientId, pass }, (res) => {
        if (!res || !res.ok) {
          const msg = (res && res.error) || 'Could not join.';
          if (first) { first = false; clearTimeout(failTimer); socket.disconnect(); reject(new Error(msg)); }
          else { banner(msg, true); }
          return;
        }
        const wasFirst = first;
        first = false; clearTimeout(failTimer);
        onJoined(res, !wasFirst);
        if (wasFirst) resolve();
      });
    });
    socket.on('disconnect', (reason) => {
      if (first) return;
      if (reason !== 'io client disconnect') banner('Connection lost. Reconnecting…');
    });
    socket.on('kicked', () => banner('You opened this room somewhere else, so this tab was disconnected.', true));

    socket.on('peer-joined', (p) => {
      peer = p;
      Peer.create();
      renderPresence();
      toast(`${p.name} joined`);
      blip();
    });
    socket.on('peer-left', (p) => {
      if (peer && p.id !== peer.id) return;
      toast(`${(peer && peer.name) || p.name || 'Your partner'} left`);
      peer = null;
      Peer.close();
      Chat.showTyping(false);
      renderPresence();
    });
    socket.on('signal', (d) => Peer.onSignal(d));
    socket.on('media:state', (m) => { if (peer) { peer.media = m; renderPresence(); } });

    socket.on('sync:state', (st) => {
      Player.onRemote(st);
      const msg = Player.describe(st);
      if (msg) stageToast(msg);
    });
    socket.on('sync:tick', (st) => Player.onTick(st));

    socket.on('chat:msg', (m) => { Chat.add(m); if (m.cid !== clientId) Chat.showTyping(false); });
    socket.on('chat:typing', (v) => Chat.showTyping(v));
    socket.on('queue:update', (list) => {
      const before = Number($('queueBadge').textContent) || 0;
      Queue.render(list);
      if (list.length > before) toast('Added to the queue');
    });
    socket.on('react', ({ emoji }) => spawnReaction(emoji));
  });
}

/* =====================================================================
   UI actions
   ===================================================================== */
$('urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = parseYT($('urlInput').value);
  if (!v) return toast("That doesn't look like a YouTube link.", true);
  Player.playNow(v.id, v.start);
  $('urlInput').value = '';
});
$('queueBtn').onclick = () => {
  const v = parseYT($('urlInput').value);
  if (!v) return toast("Paste a YouTube link first.", true);
  $('urlInput').value = '';
  if (!Player.hasVideo()) return Player.playNow(v.id, v.start);
  socket.emit('queue:add', { videoId: v.id });
};

async function copyInvite() {
  const link = `${location.origin}/?room=${encodeURIComponent(roomCode)}`;
  try {
    if (navigator.share && matchMedia('(pointer:coarse)').matches) {
      await navigator.share({ title: 'Watch with me', text: 'Join me on Our Couch', url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    window.prompt('Copy this invite link:', link);
  }
}
$('roomPill').onclick = copyInvite;
$('inviteBtn').onclick = copyInvite;

$('focusBtn').onclick = () => $('app').classList.toggle('focus');

$('leaveBtn').onclick = () => {
  if (!confirm('Leave this room?')) return;
  try { socket.disconnect(); } catch { /* */ }
  Peer.close(); Media.stop();
  location.href = '/';
};

window.addEventListener('beforeunload', () => { try { socket && socket.disconnect(); } catch { /* */ } });
})();
