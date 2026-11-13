'use strict';
/**
 * Our Couch: a private watch party server for two people.
 * Express serves the UI, Socket.IO handles rooms, playback sync, chat,
 * reactions and WebRTC signalling. State is kept in memory.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const MAX_MEMBERS = 2;
const MAX_CHAT = 200;
const MAX_QUEUE = 50;
const ROOM_TTL_MS = 30 * 60 * 1000; // keep an empty room's state for 30 min
const TICK_MS = 5000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  pingInterval: 10000,
  pingTimeout: 15000
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), fullscreen=(self)');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- small HTTP API ---------- */
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.get('/api/config', (req, res) => res.json({ passwordRequired: !!SITE_PASSWORD }));

app.get('/api/ice', (req, res) => {
  const list = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || ''
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(list);
});

const titleCache = new Map();
async function fetchTitle(id) {
  if (titleCache.has(id)) return titleCache.get(id);
  let info = { title: 'YouTube video', author: '' };
  try {
    const url = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      info = { title: String(j.title || info.title).slice(0, 200), author: String(j.author_name || '').slice(0, 100) };
      titleCache.set(id, info);
      if (titleCache.size > 500) titleCache.delete(titleCache.keys().next().value);
    }
  } catch (_) { /* offline or blocked: fall back to default */ }
  return info;
}

app.get('/api/title', async (req, res) => {
  const id = cleanVid(req.query.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  res.json(await fetchTitle(id));
});

/* ---------- helpers ---------- */
const rooms = new Map();

function cleanRoom(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}
function cleanName(v) {
  const n = String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
  return n || 'Guest';
}
function cleanVid(v) {
  const s = String(v || '');
  return /^[\w-]{11}$/.test(s) ? s : null;
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { code, members: [], video: null, queue: [], chat: [], timer: null };
    rooms.set(code, r);
  }
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  return r;
}
function scheduleCleanup(room) {
  if (room.members.length || room.timer) return;
  room.timer = setTimeout(() => {
    if (!room.members.length) rooms.delete(room.code);
  }, ROOM_TTL_MS);
}
function nowState(room) {
  const v = room.video;
  if (!v) return null;
  const time = v.playing ? v.time + (Date.now() - v.at) / 1000 : v.time;
  return { videoId: v.videoId, playing: v.playing, time };
}
function ctx(socket) {
  const code = socket.data.room;
  if (!code) return null;
  const room = rooms.get(code);
  if (!room) return null;
  const member = room.members.find((m) => m.sid === socket.id);
  return member ? { room, member } : null;
}
function limit(socket, max = 40) {
  const now = Date.now();
  const w = socket.data.win || (socket.data.win = { t: now, n: 0 });
  if (now - w.t > 1000) { w.t = now; w.n = 0; }
  return ++w.n <= max;
}
function removeMember(room, member, kick) {
  room.members = room.members.filter((m) => m !== member);
  const s = io.sockets.sockets.get(member.sid);
  if (s) {
    s.leave(room.code);
    s.data.room = null;
    if (kick) { s.emit('kicked'); s.disconnect(true); }
  }
  io.to(room.code).emit('peer-left', { id: member.sid, name: member.name });
  scheduleCleanup(room);
}
function setVideo(room, videoId, playing, time) {
  room.video = { videoId, playing, time, at: Date.now() };
}

/* ---------- realtime ---------- */
io.on('connection', (socket) => {
  socket.on('join', (p, ack) => {
    if (typeof ack !== 'function') return;
    p = p || {};
    if (socket.data.room) return ack({ ok: false, error: 'Already joined.' });

    const code = cleanRoom(p.room);
    const clientId = String(p.clientId || '').slice(0, 80);
    if (code.length < 4) return ack({ ok: false, error: 'Room code must be at least 4 letters or numbers.' });
    if (!clientId) return ack({ ok: false, error: 'Missing client id. Refresh and try again.' });
    if (SITE_PASSWORD && !safeEqual(String(p.pass || ''), SITE_PASSWORD)) {
      return ack({ ok: false, error: 'Wrong passcode.' });
    }

    const room = getRoom(code);
    // Same person reconnecting (refresh / flaky network): replace the stale socket.
    const dup = room.members.find((m) => m.clientId === clientId);
    if (dup) removeMember(room, dup, true);

    if (room.members.length >= MAX_MEMBERS) {
      scheduleCleanup(room);
      return ack({ ok: false, error: 'This room already has two people. Try a different room code.' });
    }

    const member = {
      sid: socket.id,
      clientId,
      name: cleanName(p.name),
      media: { mic: true, cam: true }
    };
    room.members.push(member);
    socket.join(code);
    socket.data.room = code;

    const other = room.members.find((m) => m !== member);
    socket.to(code).emit('peer-joined', { id: member.sid, name: member.name, media: member.media });

    ack({
      ok: true,
      id: socket.id,
      room: code,
      peer: other ? { id: other.sid, name: other.name, media: other.media } : null,
      state: nowState(room),
      queue: room.queue,
      chat: room.chat
    });
  });

  /* WebRTC signalling relay (only one possible peer) */
  socket.on('signal', (data) => {
    const c = ctx(socket);
    if (!c || !limit(socket, 300)) return;
    if (!data || typeof data !== 'object' || JSON.stringify(data).length > 20000) return;
    socket.to(c.room.code).emit('signal', data);
  });

  /* Playback sync */
  socket.on('sync:set', (p) => {
    const c = ctx(socket);
    if (!c || !limit(socket) || !p) return;
    const videoId = p.videoId ? cleanVid(p.videoId) : c.room.video && c.room.video.videoId;
    if (!videoId) return;
    const action = ['load', 'play', 'pause', 'seek'].includes(p.action) ? p.action : 'seek';
    const time = Math.max(0, Number(p.time) || 0);
    const playing = !!p.playing;
    setVideo(c.room, videoId, playing, time);
    socket.to(c.room.code).emit('sync:state', { videoId, playing, time, action, by: c.member.name });
  });

  socket.on('sync:ended', (p) => {
    const c = ctx(socket);
    if (!c || !p) return;
    const { room } = c;
    if (!room.video || room.video.videoId !== p.videoId) return; // already handled by partner
    const next = room.queue.shift();
    if (next) {
      setVideo(room, next.videoId, true, 0);
      io.to(room.code).emit('sync:state', { videoId: next.videoId, playing: true, time: 0, action: 'load', by: 'Queue' });
      io.to(room.code).emit('queue:update', room.queue);
    } else {
      room.video.playing = false;
      room.video.at = Date.now();
    }
  });

  /* Queue */
  socket.on('queue:add', async (p) => {
    const c = ctx(socket);
    if (!c || !limit(socket, 10) || !p) return;
    const videoId = cleanVid(p.videoId);
    if (!videoId || c.room.queue.length >= MAX_QUEUE) return;
    const info = await fetchTitle(videoId);
    c.room.queue.push({ id: crypto.randomUUID(), videoId, title: info.title, by: c.member.name });
    io.to(c.room.code).emit('queue:update', c.room.queue);
  });
  socket.on('queue:play', (p) => {
    const c = ctx(socket);
    if (!c || !limit(socket, 10) || !p) return;
    const i = c.room.queue.findIndex((q) => q.id === p.id);
    if (i < 0) return;
    const [item] = c.room.queue.splice(i, 1);
    setVideo(c.room, item.videoId, true, 0);
    io.to(c.room.code).emit('sync:state', { videoId: item.videoId, playing: true, time: 0, action: 'load', by: c.member.name });
    io.to(c.room.code).emit('queue:update', c.room.queue);
  });
  socket.on('queue:remove', (p) => {
    const c = ctx(socket);
    if (!c || !limit(socket, 10) || !p) return;
    c.room.queue = c.room.queue.filter((q) => q.id !== p.id);
    io.to(c.room.code).emit('queue:update', c.room.queue);
  });

  /* Chat, typing, reactions, media flags */
  socket.on('chat:send', (p) => {
    const c = ctx(socket);
    if (!c || !limit(socket, 10) || !p) return;
    const text = String(p.text || '').replace(/\r/g, '').trim().slice(0, 1000);
    if (!text) return;
    const msg = { id: crypto.randomUUID(), from: c.member.name, cid: c.member.clientId, text, ts: Date.now() };
    c.room.chat.push(msg);
    if (c.room.chat.length > MAX_CHAT) c.room.chat.shift();
    io.to(c.room.code).emit('chat:msg', msg);
  });
  socket.on('chat:typing', (v) => {
    const c = ctx(socket);
    if (!c || !limit(socket)) return;
    socket.to(c.room.code).emit('chat:typing', !!v);
  });
  socket.on('react', (emoji) => {
    const c = ctx(socket);
    if (!c || !limit(socket, 15)) return;
    emoji = String(emoji || '');
    if (!emoji || [...emoji].length > 4) return;
    socket.to(c.room.code).emit('react', { emoji, by: c.member.name });
  });
  socket.on('media:state', (p) => {
    const c = ctx(socket);
    if (!c || !limit(socket) || !p) return;
    c.member.media = { mic: !!p.mic, cam: !!p.cam };
    socket.to(c.room.code).emit('media:state', c.member.media);
  });

  socket.on('disconnect', () => {
    const c = ctx(socket);
    if (c) removeMember(c.room, c.member, false);
  });
});

/* Periodic drift-correction heartbeat for rooms that are playing. */
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.members.length === MAX_MEMBERS && room.video && room.video.playing) {
      io.to(room.code).emit('sync:tick', nowState(room));
    }
  }
}, TICK_MS).unref();

server.listen(PORT, () => console.log('Our Couch running on port ' + PORT));
