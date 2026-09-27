// FreeJam sync server. Keeps each room's "what's playing" state and shared
// queue, and relays it to the Spicetify extension running in everyone's Spotify.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { toTrackUri, trackMeta, TRACK_URI } = require('./lib/spotify');

const PORT = process.env.PORT || 3000;
const MAX_QUEUE = 300;
const ROOM_TTL_MS = 10 * 60 * 1000; // empty rooms live this long
const END_GRACE = 4; // seconds from the end at which a track change counts as "song finished"

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`FreeJam server is running. ${rooms.size} room(s) open.\n`);
});
const wss = new WebSocketServer({ server });

/** @type {Map<string, any>} */
const rooms = new Map();

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const str = (v, n) => String(v ?? '').slice(0, n);
const cleanName = (name) => str(name, 24).trim() || 'Guest';

function position(room) {
  if (!room.current) return 0;
  return room.playing ? (Date.now() - room.startedAt) / 1000 : room.pausedPos;
}

function snapshot(room) {
  return {
    t: 'state',
    code: room.code,
    hostId: room.hostId,
    openControl: room.openControl,
    members: [...room.members.values()].map((m) => ({ id: m.id, name: m.name })),
    current: room.current,
    queue: room.queue,
    playing: room.playing,
    position: position(room),
    serverTime: Date.now(),
  };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  const msg = snapshot(room);
  for (const m of room.members.values()) send(m.ws, msg);
}

function toast(room, text) {
  for (const m of room.members.values()) send(m.ws, { t: 'toast', text });
}

function makeTrack(raw, member) {
  const duration = Number(raw.duration);
  return {
    id: crypto.randomUUID(),
    uri: raw.uri,
    name: str(raw.name, 200) || 'Unknown track',
    artist: str(raw.artist, 200),
    image: /^https:\/\//.test(raw.image) ? str(raw.image, 300) : null,
    duration: duration > 0 && duration < 7200 ? duration : null,
    addedBy: member.name,
    addedById: member.id,
  };
}

function startTrack(room, track, pos = 0, playing = !!track) {
  room.current = track;
  room.playing = !!track && playing;
  room.startedAt = Date.now() - pos * 1000;
  room.pausedPos = pos;
  scheduleEnd(room);
}

// The server decides when a song is over, so the queue advances even if
// nobody's Spotify reports it.
function scheduleEnd(room) {
  clearTimeout(room.endTimer);
  const t = room.current;
  if (!t || !room.playing || !t.duration) return;
  const remaining = t.duration - position(room) + 1.5;
  room.endTimer = setTimeout(() => {
    if (room.current === t && room.playing) advance(room);
  }, Math.max(remaining, 0.5) * 1000);
}

function advance(room) {
  if (room.current) {
    room.history.push(room.current);
    if (room.history.length > 50) room.history.shift();
  }
  startTrack(room, room.queue.shift() || null);
  broadcast(room);
}

// Tracks reported by a client already carry metadata; fill in whatever is
// missing (usually duration) from Spotify's public page in the background.
async function fillMeta(room, track) {
  if (track.duration && track.image && track.artist) return;
  const meta = await trackMeta(track.uri);
  track.duration ??= meta.duration;
  track.image ??= meta.image;
  track.artist ||= meta.artist;
  if (room.current === track) scheduleEnd(room);
  broadcast(room);
}

const canControl = (room, member) => room.openControl || room.hostId === member.id;

// ---------- message handlers ----------
// Each handler gets (room, member, msg) and may return a reply object.
const needsControl = new Set(['play', 'pause', 'seek', 'next', 'prev', 'playNow', 'move', 'shuffle']);

const handlers = {
  // play/pause may carry the reporter's position so a seek made at the same
  // moment isn't lost.
  play(room, _m, { pos }) {
    if (!room.current || room.playing) return;
    if (Number.isFinite(pos) && pos >= 0) room.pausedPos = pos;
    room.startedAt = Date.now() - room.pausedPos * 1000;
    room.playing = true;
    scheduleEnd(room);
  },

  pause(room, _m, { pos }) {
    if (!room.current || !room.playing) return;
    room.pausedPos = Number.isFinite(pos) && pos >= 0 ? pos : position(room);
    room.playing = false;
    clearTimeout(room.endTimer);
  },

  seek(room, _m, { pos }) {
    pos = Number(pos);
    if (!room.current || !Number.isFinite(pos) || pos < 0) return;
    room.pausedPos = pos;
    room.startedAt = Date.now() - pos * 1000;
    scheduleEnd(room);
  },

  // Someone's Spotify started a different song (they picked it themselves,
  // or their Spotify auto-advanced at the end of the previous one).
  track(room, member, { uri, pos, playing, meta = {} }) {
    if (!TRACK_URI.test(uri)) return;
    pos = Math.max(0, Number(pos) || 0);
    const cur = room.current;
    if (cur && cur.uri === uri) return canControl(room, member) && handlers.seek(room, member, { pos });

    const nearEnd = cur && cur.duration && position(room) >= cur.duration - END_GRACE;
    if (nearEnd && room.queue.length) return advance(room); // queue beats Spotify's autoplay
    if ((nearEnd || !cur) && member.id !== room.hostId) return; // only the host's autoplay continues the jam
    if (!canControl(room, member)) return;

    if (cur) room.history.push(cur);
    const track = makeTrack({ ...meta, uri }, member);
    startTrack(room, track, pos, playing !== false);
    fillMeta(room, track);
  },

  next: (room) => advance(room),

  prev(room) {
    if (position(room) > 5 || !room.history.length) return startTrack(room, room.current, 0);
    if (room.current) room.queue.unshift(room.current);
    startTrack(room, room.history.pop());
  },

  playNow(room, _m, { id }) {
    const i = room.queue.findIndex((t) => t.id === id);
    if (i === -1) return;
    const [t] = room.queue.splice(i, 1);
    if (room.current) room.history.push(room.current);
    startTrack(room, t);
  },

  move(room, _m, { id, to }) {
    const from = room.queue.findIndex((t) => t.id === id);
    to = Math.max(0, Math.min(room.queue.length - 1, Math.trunc(Number(to))));
    if (from === -1 || !Number.isInteger(to)) return;
    const [t] = room.queue.splice(from, 1);
    room.queue.splice(to, 0, t);
  },

  shuffle(room) {
    for (let i = room.queue.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [room.queue[i], room.queue[j]] = [room.queue[j], room.queue[i]];
    }
  },

  // Anyone can remove songs they added; controllers can remove anything.
  remove(room, member, { id }) {
    const i = room.queue.findIndex((t) => t.id === id);
    if (i === -1) return;
    if (!canControl(room, member) && room.queue[i].addedById !== member.id) return;
    room.queue.splice(i, 1);
  },

  toggleOpen(room, member) {
    if (room.hostId === member.id) room.openControl = !room.openControl;
  },

  async add(room, member, { uris }) {
    uris = [...new Set((Array.isArray(uris) ? uris : [uris]).map(toTrackUri).filter(Boolean))];
    if (!uris.length) return { error: 'Only Spotify tracks can be added' };
    uris = uris.slice(0, Math.max(0, MAX_QUEUE - room.queue.length));
    if (!uris.length) return { error: 'Queue is full' };
    const tracks = await Promise.all(
      uris.map(async (uri) => makeTrack({ uri, ...(await trackMeta(uri)) }, member))
    );
    if (!rooms.has(room.code)) return;
    for (const t of tracks) {
      if (!room.current) startTrack(room, t);
      else room.queue.push(t);
    }
    return { added: tracks.length === 1 ? tracks[0].name : `${tracks.length} songs` };
  },
};

// ---------- connections ----------
wss.on('connection', (ws) => {
  const member = { id: crypto.randomUUID(), name: 'Guest', ws };
  let room = null;

  function enter(r, name) {
    clearTimeout(r.deleteTimer);
    room = r;
    member.name = cleanName(name);
    if (!r.members.has(r.hostId)) r.hostId = member.id;
    r.members.set(member.id, member);
    broadcast(r);
  }

  function leave() {
    if (!room) return;
    const r = room;
    room = null;
    r.members.delete(member.id);
    if (r.hostId === member.id && r.members.size) {
      r.hostId = r.members.keys().next().value; // longest-present member
      toast(r, `${r.members.get(r.hostId).name} is now the host`);
    }
    if (r.members.size) {
      toast(r, `${member.name} left`);
      broadcast(r);
    } else {
      r.deleteTimer = setTimeout(() => {
        clearTimeout(r.endTimer);
        rooms.delete(r.code);
      }, ROOM_TTL_MS);
    }
  }

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const reply = (body) => msg.id != null && send(ws, { t: 'ack', id: msg.id, ...body });

    switch (msg.t) {
      case 'time':
        return reply({ serverTime: Date.now() });

      case 'create': {
        if (room) leave();
        const r = {
          code: newCode(),
          hostId: member.id,
          openControl: true,
          members: new Map(),
          queue: [],
          history: [],
          current: null,
          playing: false,
          startedAt: 0,
          pausedPos: 0,
        };
        rooms.set(r.code, r);
        enter(r, msg.name);
        return reply({ code: r.code, you: member.id });
      }

      case 'join': {
        const r = rooms.get(str(msg.code, 10).trim().toUpperCase());
        if (!r) return reply({ error: 'Room not found' });
        if (room) leave();
        enter(r, msg.name);
        toast(r, `${member.name} joined`);
        return reply({ code: r.code, you: member.id });
      }

      case 'leave':
        leave();
        return reply({});
    }

    const handler = Object.hasOwn(handlers, msg.t) && handlers[msg.t];
    if (!room || !handler) return reply({ error: 'Not in a room' });
    if (needsControl.has(msg.t) && !canControl(room, member)) {
      return reply({ error: 'Only the host can control this jam' });
    }
    try {
      const r = room;
      const result = await handler(r, member, msg);
      broadcast(r);
      reply(result || {});
    } catch (err) {
      reply({ error: err.message || 'Something went wrong' });
    }
  });

  ws.on('close', leave);

  // Drop connections that stop answering pings (sleeping laptops etc.).
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`FreeJam server listening on port ${PORT}`);
});
