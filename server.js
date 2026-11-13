const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const MAX_PER_ROOM = 4;

app.use(express.static('public'));

// ICE servers. Add a TURN server via env vars for bad mobile networks.
app.get('/ice', (req, res) => {
  const list = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS
    });
  }
  res.json(list);
});

const rooms = {}; // room -> { videoId, playing, time, at }

function current(r) {
  if (!r || !r.videoId) return null;
  const t = r.playing ? r.time + (Date.now() - r.at) / 1000 : r.time;
  return { videoId: r.videoId, playing: r.playing, time: t };
}

io.on('connection', (s) => {
  s.on('join', ({ room, name }) => {
    room = String(room || '').slice(0, 40);
    if (!room) return;
    const members = io.sockets.adapter.rooms.get(room);
    if (members && members.size >= MAX_PER_ROOM) return s.emit('full');
    s.join(room);
    s.data = { room, name: String(name || 'Guest').slice(0, 20) };
    const peers = [...(io.sockets.adapter.rooms.get(room) || [])]
      .filter((id) => id !== s.id)
      .map((id) => ({ id, name: io.sockets.sockets.get(id)?.data?.name || 'Guest' }));
    s.emit('joined', { id: s.id, peers, state: current(rooms[room]) });
    s.to(room).emit('peer-joined', { id: s.id, name: s.data.name });
  });

  s.on('signal', ({ to, data }) => io.to(to).emit('signal', { from: s.id, data }));

  s.on('video', (st) => {
    const room = s.data && s.data.room;
    if (!room || !st || !st.videoId) return;
    rooms[room] = { videoId: String(st.videoId), playing: !!st.playing, time: Number(st.time) || 0, at: Date.now() };
    s.to(room).emit('video', { videoId: rooms[room].videoId, playing: rooms[room].playing, time: rooms[room].time });
  });

  s.on('disconnect', () => {
    const room = s.data && s.data.room;
    if (!room) return;
    s.to(room).emit('peer-left', { id: s.id });
    if (!io.sockets.adapter.rooms.get(room)) delete rooms[room];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Watch party running on port ' + PORT));
