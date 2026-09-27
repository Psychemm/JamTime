// NAME: JamTime
// AUTHOR: Psychemm
// VERSION: 2.1.0
// DESCRIPTION: Spotify Jam for free accounts. Start a jam, share the code, and everyone hears the same song at the same time.
// Built from https://github.com/Psychemm/JamTime (src/jamtime.js).

// JamTime: Spotify Jam-style listening parties for free accounts.
//
// No server of our own: the host's Spotify runs the jam, and guests talk to
// it through free public MQTT brokers (small JSON messages), so it works
// between any two networks.
//
//   host Spotify ── Room (state, queue, clock) ──┬── guest Spotify
//                                                └── guest Spotify
//
// Every Spotify (host included) runs the same sync loop: compare the local
// player with the room, report the user's own changes, follow everyone else's.

(async function JamTime() {
  while (!Spicetify?.Player?.data || !Spicetify.Topbar || !Spicetify.PopupModal || !Spicetify.ContextMenu) {
    await new Promise((r) => setTimeout(r, 300));
  }

  const Player = Spicetify.Player;
  const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;
  // Free public MQTT brokers used as message relays. The host listens on all
  // of them; a guest uses the first one that reaches the host.
  const RELAYS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081'];
  const TOPIC_PREFIX = 'jamtime/v2/';
  const DRIFT_LIMIT = 2.5; // seconds out of sync before we correct
  const APPLY_GRACE = 3000; // ms to ignore local changes after we change the player ourselves
  const END_GRACE = 4; // seconds from the end at which a track change counts as "song finished"
  const HEARTBEAT_MS = 4000;
  const TIMEOUT_MS = 15000; // no messages for this long = connection lost
  const MAX_QUEUE = 300;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const str = (v, n) => String(v ?? '').slice(0, n);

  // =====================================================================
  // Room: the jam's state. Only exists on the host's Spotify.
  // =====================================================================
  function createRoom(code) {
    const room = {
      code,
      hostId: null,
      openControl: true,
      members: new Map(), // id -> { id, name, send(msg), lastSeen }
      queue: [],
      history: [],
      current: null,
      playing: false,
      startedAt: 0,
      pausedPos: 0,
      endTimer: null,
    };

    const position = () => {
      if (!room.current) return 0;
      return room.playing ? (Date.now() - room.startedAt) / 1000 : room.pausedPos;
    };

    function snapshot() {
      return {
        t: 'state',
        code: room.code,
        hostId: room.hostId,
        openControl: room.openControl,
        members: [...room.members.values()].map((m) => ({ id: m.id, name: m.name })),
        current: room.current,
        queue: room.queue,
        playing: room.playing,
        position: position(),
        serverTime: Date.now(),
      };
    }

    function broadcast() {
      const msg = snapshot();
      for (const m of room.members.values()) m.send(msg);
    }

    function toast(text, except) {
      for (const m of room.members.values()) if (m.id !== except) m.send({ t: 'toast', text });
    }

    function makeTrack(raw, member) {
      const duration = Number(raw.duration);
      return {
        id: uid(),
        uri: raw.uri,
        name: str(raw.name, 200) || 'Unknown track',
        artist: str(raw.artist, 200),
        image: /^https:\/\//.test(raw.image || '') ? str(raw.image, 300) : null,
        duration: duration > 0 && duration < 7200 ? duration : null,
        addedBy: member.name,
        addedById: member.id,
      };
    }

    function startTrack(track, pos = 0, playing = !!track) {
      room.current = track;
      room.playing = !!track && playing;
      room.startedAt = Date.now() - pos * 1000;
      room.pausedPos = pos;
      scheduleEnd();
    }

    // The room decides when a song is over, so the queue advances even if
    // nobody's Spotify reports it (ads, paused tabs, etc).
    function scheduleEnd() {
      clearTimeout(room.endTimer);
      const t = room.current;
      if (!t || !room.playing || !t.duration) return;
      const remaining = t.duration - position() + 1.5;
      room.endTimer = setTimeout(() => {
        if (room.current === t && room.playing) advance();
      }, Math.max(remaining, 0.5) * 1000);
    }

    function advance() {
      if (room.current) {
        room.history.push(room.current);
        if (room.history.length > 50) room.history.shift();
      }
      startTrack(room.queue.shift() || null);
      broadcast();
    }

    const canControl = (m) => room.openControl || room.hostId === m.id;
    const needsControl = new Set(['play', 'pause', 'seek', 'next', 'prev', 'playNow', 'move', 'shuffle']);

    const handlers = {
      time: () => ({ serverTime: Date.now() }),
      ping: () => ({}),

      // play/pause may carry the reporter's position so a simultaneous seek isn't lost.
      play(m, { pos }) {
        if (!room.current || room.playing) return;
        if (Number.isFinite(pos) && pos >= 0) room.pausedPos = pos;
        room.startedAt = Date.now() - room.pausedPos * 1000;
        room.playing = true;
        scheduleEnd();
      },

      pause(m, { pos }) {
        if (!room.current || !room.playing) return;
        room.pausedPos = Number.isFinite(pos) && pos >= 0 ? pos : position();
        room.playing = false;
        clearTimeout(room.endTimer);
      },

      seek(m, { pos }) {
        pos = Number(pos);
        if (!room.current || !Number.isFinite(pos) || pos < 0) return;
        room.pausedPos = pos;
        room.startedAt = Date.now() - pos * 1000;
        scheduleEnd();
      },

      // Someone's Spotify started a different song (they picked it, or their
      // Spotify auto-advanced at the end of the previous one).
      track(m, { uri, pos, playing, meta = {} }) {
        if (!TRACK_URI.test(uri)) return;
        pos = Math.max(0, Number(pos) || 0);
        const cur = room.current;
        if (cur && cur.uri === uri) return canControl(m) && handlers.seek(m, { pos });

        const nearEnd = cur && cur.duration && position() >= cur.duration - END_GRACE;
        if (nearEnd && room.queue.length) return advance(); // queue beats Spotify's autoplay
        if ((nearEnd || !cur) && m.id !== room.hostId) return; // only the host's autoplay continues the jam
        if (!canControl(m)) return;

        if (cur) room.history.push(cur);
        startTrack(makeTrack({ ...meta, uri }, m), pos, playing !== false);
      },

      next: () => advance(),

      prev() {
        if (position() > 5 || !room.history.length) return startTrack(room.current, 0);
        if (room.current) room.queue.unshift(room.current);
        startTrack(room.history.pop());
      },

      playNow(m, { id }) {
        const i = room.queue.findIndex((t) => t.id === id);
        if (i === -1) return;
        const [t] = room.queue.splice(i, 1);
        if (room.current) room.history.push(room.current);
        startTrack(t);
      },

      move(m, { id, to }) {
        const from = room.queue.findIndex((t) => t.id === id);
        to = Math.max(0, Math.min(room.queue.length - 1, Math.trunc(Number(to))));
        if (from === -1 || !Number.isInteger(to)) return;
        const [t] = room.queue.splice(from, 1);
        room.queue.splice(to, 0, t);
      },

      shuffle() {
        for (let i = room.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [room.queue[i], room.queue[j]] = [room.queue[j], room.queue[i]];
        }
      },

      // Anyone can remove songs they added; controllers can remove anything.
      remove(m, { id }) {
        const i = room.queue.findIndex((t) => t.id === id);
        if (i === -1) return;
        if (!canControl(m) && room.queue[i].addedById !== m.id) return;
        room.queue.splice(i, 1);
      },

      toggleOpen(m) {
        if (room.hostId === m.id) room.openControl = !room.openControl;
      },

      add(m, { tracks }) {
        tracks = (Array.isArray(tracks) ? tracks : []).filter((t) => TRACK_URI.test(t?.uri || ''));
        if (!tracks.length) return { error: 'Only songs can be added' };
        tracks = tracks.slice(0, Math.max(0, MAX_QUEUE - room.queue.length));
        if (!tracks.length) return { error: 'The queue is full' };
        const made = tracks.map((t) => makeTrack(t, m));
        for (const t of made) {
          if (!room.current) startTrack(t);
          else room.queue.push(t);
        }
        return { added: made.length === 1 ? made[0].name : `${made.length} songs` };
      },
    };

    return {
      get state() {
        return room;
      },
      join(member, name) {
        member.name = str(name, 40).trim() || 'Guest';
        member.lastSeen = Date.now();
        if (!room.hostId) room.hostId = member.id;
        room.members.set(member.id, member);
        if (member.id !== room.hostId) toast(`${member.name} joined`, member.id);
        broadcast();
      },
      leave(id) {
        const m = room.members.get(id);
        if (!m || !room.members.delete(id)) return;
        toast(`${m.name} left`);
        broadcast();
      },
      // Handle a request from a member. Returns the reply body.
      handle(member, msg) {
        member.lastSeen = Date.now();
        const handler = Object.hasOwn(handlers, msg.t) && handlers[msg.t];
        if (!handler) return { error: 'Unknown request' };
        if (needsControl.has(msg.t) && !canControl(member)) return { error: 'Only the host can control this jam' };
        const reply = handler(member, msg) || {};
        if (msg.t !== 'time' && msg.t !== 'ping') broadcast();
        return reply;
      },
      // The host's Spotify learns a song's exact length once it plays it.
      setDuration(trackId, duration) {
        if (room.current?.id === trackId && !room.current.duration && duration > 0) {
          room.current.duration = duration;
          scheduleEnd();
          broadcast();
        }
      },
      // Drop guests that stopped sending heartbeats.
      sweep() {
        for (const m of room.members.values()) {
          if (m.id !== room.hostId && Date.now() - m.lastSeen > TIMEOUT_MS) {
            m.close?.();
            this.leave(m.id);
          }
        }
      },
      end() {
        clearTimeout(room.endTimer);
        for (const m of room.members.values()) if (m.id !== room.hostId) m.send({ t: 'ended' });
      },
    };
  }

  // =====================================================================
  // Connection: host (runs a Room) or guest (talks to the host via a relay)
  // =====================================================================
  let session = null; // { role, code, request(t, body), close() }
  let room = null; // latest room state (a 'state' message)
  let me = null; // our member id
  let clockOffset = 0; // host clock - local clock

  const notify = (text, isError) => Spicetify.showNotification(`JamTime: ${text}`, isError);

  function newCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  }

  async function myName() {
    try {
      const user = await Spicetify.Platform?.UserAPI?.getUser?.();
      if (user?.displayName) return user.displayName;
    } catch {}
    return 'Someone';
  }

  function onMessage(msg) {
    if (msg.t === 'state') {
      room = msg;
      renderUI();
      tick();
    } else if (msg.t === 'toast') {
      notify(msg.text);
    } else if (msg.t === 'ended') {
      endSession('The host ended the jam');
    }
  }

  // ---------- minimal MQTT 3.1.1 client over WebSocket (QoS 0 only) ----------
  function mqttConnect(url) {
    return new Promise((resolve, reject) => {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      let ws;
      try {
        ws = new WebSocket(url, 'mqtt');
      } catch (err) {
        return reject(err);
      }
      ws.binaryType = 'arraybuffer';
      let buf = new Uint8Array(0);
      let ready = false;
      let pinger = null;
      let nextPid = 1;
      const subacks = new Map();

      const mqttStr = (s) => {
        const b = enc.encode(s);
        return [b.length >> 8, b.length & 255, ...b];
      };
      function send(header, body) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const len = [];
        let n = body.length;
        do {
          let digit = n % 128;
          n = Math.floor(n / 128);
          if (n > 0) digit |= 128;
          len.push(digit);
        } while (n > 0);
        const packet = new Uint8Array(1 + len.length + body.length);
        packet[0] = header;
        packet.set(len, 1);
        packet.set(body, 1 + len.length);
        ws.send(packet);
      }

      const client = {
        url,
        closed: false,
        onMessage: () => {},
        onClose: () => {},
        subscribe(topic) {
          const pid = nextPid++ & 0xffff || nextPid++;
          send(0x82, [pid >> 8, pid & 255, ...mqttStr(topic), 0]);
          return new Promise((res) => {
            subacks.set(pid, res);
            setTimeout(() => subacks.delete(pid) && res(), 5000);
          });
        },
        publish(topic, obj) {
          const payload = enc.encode(JSON.stringify(obj));
          const t = mqttStr(topic);
          const body = new Uint8Array(t.length + payload.length);
          body.set(t);
          body.set(payload, t.length);
          send(0x30, body);
        },
        close() {
          client.closed = true;
          clearInterval(pinger);
          try {
            send(0xe0, []);
            ws.close();
          } catch {}
        },
      };

      function handle(header, body) {
        const type = header >> 4;
        if (type === 2) {
          // CONNACK
          if (body[1] !== 0) return reject(new Error('Relay refused the connection'));
          ready = true;
          pinger = setInterval(() => send(0xc0, []), 20000);
          resolve(client);
        } else if (type === 3) {
          // PUBLISH
          const qos = (header >> 1) & 3;
          const tlen = (body[0] << 8) | body[1];
          const topic = dec.decode(body.subarray(2, 2 + tlen));
          const payload = body.subarray(2 + tlen + (qos ? 2 : 0));
          let msg;
          try {
            msg = JSON.parse(dec.decode(payload));
          } catch {
            return;
          }
          client.onMessage(topic, msg);
        } else if (type === 9) {
          // SUBACK
          const pid = (body[0] << 8) | body[1];
          subacks.get(pid)?.();
          subacks.delete(pid);
        }
      }

      ws.onopen = () => send(0x10, [...mqttStr('MQTT'), 4, 2, 0, 60, ...mqttStr('jt' + uid().slice(0, 20))]);
      ws.onmessage = (e) => {
        const d = new Uint8Array(e.data);
        const merged = new Uint8Array(buf.length + d.length);
        merged.set(buf);
        merged.set(d, buf.length);
        buf = merged;
        // A WebSocket frame can hold several MQTT packets, or part of one.
        for (;;) {
          if (buf.length < 2) return;
          let len = 0;
          let mult = 1;
          let i = 1;
          let byte;
          do {
            if (i >= buf.length) return;
            byte = buf[i++];
            len += (byte & 127) * mult;
            mult *= 128;
          } while (byte & 128);
          if (buf.length < i + len) return;
          const header = buf[0];
          const body = buf.slice(i, i + len);
          buf = buf.slice(i + len);
          handle(header, body);
        }
      };
      ws.onerror = () => !ready && reject(new Error('Relay unreachable'));
      ws.onclose = () => {
        clearInterval(pinger);
        if (!ready) reject(new Error('Relay unreachable'));
        else if (!client.closed) client.onClose();
      };
      setTimeout(() => {
        if (ready) return;
        reject(new Error('Relay timed out'));
        try {
          ws.close();
        } catch {}
      }, 8000);
    });
  }

  // A relay connection that stays subscribed to one topic and reconnects
  // by itself if it drops.
  function relayLink(url, topic, onMessage) {
    const link = {
      url,
      client: null,
      closed: false,
      publish: (t, obj) => link.client?.publish(t, obj),
      close() {
        link.closed = true;
        link.client?.close();
      },
    };
    async function open() {
      const c = await mqttConnect(url);
      if (link.closed) return c.close();
      c.onMessage = (t, msg) => onMessage(link, msg);
      c.onClose = () => {
        link.client = null;
        retry();
      };
      await c.subscribe(topic);
      link.client = c;
    }
    function retry() {
      if (!link.closed) setTimeout(() => open().catch(retry), 3000);
    }
    link.retry = retry;
    link.ready = open();
    return link;
  }

  const CONNECT_ERROR = 'Could not connect. Check your internet connection.';

  async function hostJam() {
    const code = newCode();
    const base = TOPIC_PREFIX + code;
    const jam = createRoom(code);

    const onGuestMessage = (link, msg) => {
      if (!msg || typeof msg !== 'object' || typeof msg.from !== 'string' || msg.from.length > 40) return;
      const reply = (body) => msg.id != null && link.publish(`${base}/g/${msg.from}`, { t: 'ack', id: msg.id, ...body });
      let member = jam.state.members.get(msg.from);
      if (msg.t === 'join') {
        if (!member) {
          member = { id: msg.from, lastSeen: Date.now() };
          member.send = (m) => member.link.publish(`${base}/g/${member.id}`, m);
        }
        member.link = link;
        jam.join(member, msg.name);
        return reply({ you: member.id, code });
      }
      if (!member) return reply({ error: 'Not in the jam' });
      member.link = link;
      if (msg.t === 'leave') {
        jam.leave(member.id);
        return reply({});
      }
      reply(jam.handle(member, msg));
    };

    // Listen on every relay so guests can use whichever one they reach.
    const links = RELAYS.map((url) => relayLink(url, `${base}/h`, onGuestMessage));
    const results = await Promise.allSettled(links.map((l) => l.ready));
    if (!results.some((r) => r.status === 'fulfilled')) {
      links.forEach((l) => l.close());
      throw new Error(CONNECT_ERROR);
    }
    // Relays that failed keep retrying in the background.
    links.forEach((l, i) => results[i].status === 'rejected' && l.retry());

    const self = { id: uid(), send: (msg) => setTimeout(() => onMessage(msg)) };
    me = self.id;
    clockOffset = 0;
    jam.join(self, await myName());

    const sweeper = setInterval(() => jam.sweep(), HEARTBEAT_MS);
    session = {
      role: 'host',
      code,
      jam,
      request: async (t, body = {}) => jam.handle(self, { t, ...body }),
      close() {
        clearInterval(sweeper);
        jam.end();
        setTimeout(() => links.forEach((l) => l.close()), 500); // let "ended" go out
      },
    };
    return code;
  }

  async function joinJam(code) {
    const base = TOPIC_PREFIX + code;
    const myId = uid();
    const pending = new Map();
    let nextId = 1;
    let lastHeard = Date.now();
    let link = null;

    const onHostMessage = (_link, msg) => {
      lastHeard = Date.now();
      if (msg?.t === 'ack') {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      } else if (msg && typeof msg === 'object') onMessage(msg);
    };

    const request = (t, body = {}, timeout = 10000) =>
      new Promise((resolve) => {
        if (!link?.client) return resolve({ error: 'Not connected' });
        const id = nextId++;
        pending.set(id, resolve);
        link.publish(`${base}/h`, { t, id, from: myId, ...body });
        setTimeout(() => pending.delete(id) && resolve({ error: 'The host did not respond' }), timeout);
      });

    // Try each relay until the host answers on one of them.
    const name = await myName();
    let reached = false;
    let res = null;
    for (const url of RELAYS) {
      const l = relayLink(url, `${base}/g/${myId}`, onHostMessage);
      try {
        await l.ready;
      } catch {
        l.close();
        continue;
      }
      reached = true;
      link = l;
      res = await request('join', { name }, 6000);
      if (!res.error) break;
      l.close();
      link = null;
    }
    if (!link) throw new Error(reached ? 'No jam found with that code. Check the code, and make sure the host still has the jam open.' : CONNECT_ERROR);

    const heartbeat = setInterval(() => {
      if (Date.now() - lastHeard > TIMEOUT_MS) return endSession('Lost connection to the jam');
      request('ping');
    }, HEARTBEAT_MS);

    session = {
      role: 'guest',
      code,
      request,
      close() {
        clearInterval(heartbeat);
        link.publish(`${base}/h`, { t: 'leave', from: myId });
        setTimeout(() => link.close(), 300);
      },
    };
    me = res.you;
    await syncClock();
  }

  // Use the fastest of several round trips to estimate the host's clock.
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 6; i++) {
      const t0 = Date.now();
      const res = await session.request('time');
      const t1 = Date.now();
      if (res.error) return;
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: res.serverTime - (t0 + t1) / 2 };
    }
    clockOffset = best.offset;
  }

  let busy = false;
  async function start(code) {
    if (busy || session) return;
    busy = true;
    renderUI(code ? 'Joining…' : 'Starting…');
    try {
      synced = false;
      lastTick = null;
      if (code) {
        await joinJam(code);
        notify(`You joined the jam`);
      } else {
        await hostJam();
        // Starting a jam while music is playing: that song becomes the first one.
        const L = local();
        if (TRACK_URI.test(L.uri || '')) {
          session.request('track', { uri: L.uri, pos: L.pos, playing: L.playing, meta: localMeta() });
        }
      }
    } catch (err) {
      console.warn('[JamTime]', err);
      renderUI(null, err.message || 'Something went wrong');
      busy = false;
      return;
    }
    busy = false;
    renderUI();
  }

  function endSession(reason) {
    if (!session) return;
    const s = session;
    session = null;
    room = null;
    me = null;
    s.close();
    if (reason) notify(reason, true);
    renderUI();
  }

  const send = (t, body) => session?.request(t, body).then((r) => r?.error && notify(r.error, true));

  // =====================================================================
  // Sync loop: keeps this Spotify in step with the room
  // =====================================================================
  let lastApply = 0;
  let synced = false; // local player snapshot from the last time it matched the room
  let applying = false;
  let lastTick = null;
  let lastDenied = 0;

  const serverNow = () => Date.now() + clockOffset;
  const amHost = () => room && room.hostId === me;
  const canControl = () => room && (room.openControl || amHost());
  const expectedPos = () => {
    if (!room?.current) return 0;
    return room.playing ? room.position + (serverNow() - room.serverTime) / 1000 : room.position;
  };

  function spotifyImage(url) {
    if (!url) return null;
    if (url.startsWith('spotify:image:')) return `https://i.scdn.co/image/${url.slice(14)}`;
    return url.startsWith('https://') ? url : null;
  }

  function local() {
    const item = Player.data?.item || Player.data?.track;
    return { uri: item?.uri || null, playing: Player.isPlaying(), pos: (Player.getProgress() || 0) / 1000 };
  }

  function localMeta() {
    const item = Player.data?.item || Player.data?.track;
    if (!item) return {};
    const md = item.metadata || {};
    return {
      name: item.name || md.title,
      artist: (item.artists || []).map((a) => a.name).join(', ') || md.artist_name,
      image: spotifyImage(item.images?.[0]?.url || item.album?.images?.[0]?.url || md.image_url),
      duration: (Player.getDuration() || 0) / 1000,
    };
  }

  function seekTo(sec) {
    const ms = Math.round(sec * 1000);
    Player.seek(ms > 1 ? ms : 0); // values <= 1 are treated as a percentage
  }

  // Compares the local player with the room. If they differ, either the user
  // did something (report it) or the room changed / we drifted (follow it).
  async function tick() {
    if (!session || !room || applying) return;
    const L = local();
    const cur = room.current;
    const now = Date.now();
    const inGrace = now - lastApply < APPLY_GRACE;

    // A jump in position that isn't explained by normal playback = user seek.
    const expectedDelta = lastTick?.playing ? (now - lastTick.at) / 1000 : 0;
    const jumped = lastTick && lastTick.uri === L.uri && Math.abs(L.pos - lastTick.pos - expectedDelta) > DRIFT_LIMIT;
    lastTick = { ...L, at: now };

    // Ads, podcasts, nothing loaded: wait it out, then resync.
    if (!TRACK_URI.test(L.uri || '')) {
      synced = false;
      return;
    }

    if (!cur) {
      // Empty jam: whatever the host plays becomes the jam.
      if (amHost() && L.playing && !inGrace) {
        lastApply = now;
        session.request('track', { uri: L.uri, pos: L.pos, playing: true, meta: localMeta() });
      }
      return;
    }

    // The host's Spotify fills in song lengths the room doesn't know yet.
    if (session.role === 'host' && L.uri === cur.uri && !cur.duration) {
      session.jam.setDuration(cur.id, (Player.getDuration() || 0) / 1000);
    }

    const exp = expectedPos();
    const sameTrack = L.uri === cur.uri;
    if (sameTrack && L.playing === room.playing && Math.abs(L.pos - exp) < DRIFT_LIMIT) {
      synced = { uri: L.uri, playing: L.playing };
      return;
    }
    if (inGrace) return;

    // Out of sync. If our player is unchanged since we were last in sync, the
    // room changed (someone else did something) and we just follow it.
    const userChanged = synced && (L.uri !== synced.uri || L.playing !== synced.playing || jumped);
    const nearEnd = cur.duration && exp >= cur.duration - END_GRACE;

    if (userChanged && canControl()) {
      synced = false;
      lastApply = now; // give the room a moment to answer
      if (!sameTrack) {
        return session.request('track', { uri: L.uri, pos: L.pos, playing: L.playing, meta: localMeta() });
      }
      if (L.playing !== room.playing) return session.request(L.playing ? 'play' : 'pause', { pos: L.pos });
      if (jumped) return session.request('seek', { pos: L.pos });
    } else if (userChanged && !nearEnd && now - lastDenied > 10000) {
      lastDenied = now;
      notify('Only the host can control this jam');
    }

    if (!sameTrack && nearEnd) return; // the room is about to move on anyway
    await apply();
  }

  async function apply() {
    const cur = room?.current;
    if (!cur) return;
    applying = true;
    synced = false;
    try {
      if (local().uri !== cur.uri) {
        await Player.playUri(cur.uri);
        for (let i = 0; i < 50 && local().uri !== cur.uri; i++) await sleep(100);
        seekTo(expectedPos() + 0.2);
        if (!room.playing) Player.pause();
      } else {
        const L = local();
        // When we're resuming or pausing anyway, line up more precisely too.
        const toggled = L.playing !== room.playing;
        if (toggled) room.playing ? Player.play() : Player.pause();
        if (Math.abs(L.pos - expectedPos()) >= (toggled ? 0.5 : DRIFT_LIMIT)) seekTo(expectedPos() + (room.playing ? 0.2 : 0));
      }
    } catch (err) {
      console.error('[JamTime] could not sync player', err);
    } finally {
      lastApply = Date.now();
      lastTick = null;
      applying = false;
    }
  }

  setInterval(tick, 1000);
  Player.addEventListener('songchange', () => setTimeout(tick, 300));
  Player.addEventListener('onplaypause', () => setTimeout(tick, 300));
  window.addEventListener('beforeunload', () => endSession());

  // =====================================================================
  // Adding songs
  // =====================================================================
  function toTrackUri(input) {
    input = String(input || '').trim();
    if (TRACK_URI.test(input)) return input;
    const m = input.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/);
    return m ? `spotify:track:${m[1]}` : null;
  }

  // Look up names/artwork using this Spotify's own session.
  async function trackInfo(uris) {
    const out = new Map(uris.map((uri) => [uri, { uri }]));
    for (let i = 0; i < uris.length; i += 50) {
      const ids = uris.slice(i, i + 50).map((u) => u.split(':')[2]);
      try {
        const res = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks?ids=${ids.join(',')}`);
        for (const t of res?.tracks || []) {
          if (!t) continue;
          out.set(t.uri, {
            uri: t.uri,
            name: t.name,
            artist: t.artists.map((a) => a.name).join(', '),
            image: t.album?.images?.at(-1)?.url || t.album?.images?.[0]?.url,
            duration: t.duration_ms / 1000,
          });
        }
      } catch {}
    }
    // Fallback for anything the API didn't return.
    await Promise.all(
      [...out.values()]
        .filter((t) => !t.name)
        .slice(0, 20)
        .map(async (t) => {
          try {
            const r = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${t.uri.split(':')[2]}`);
            const d = await r.json();
            t.name = d.title;
            t.image = d.thumbnail_url;
          } catch {}
        })
    );
    return [...out.values()];
  }

  async function addSongs(uris) {
    uris = [...new Set(uris.map(toTrackUri).filter(Boolean))];
    if (!uris.length) return notify('Paste a Spotify song link', true);
    const res = await session.request('add', { tracks: await trackInfo(uris) });
    notify(res.error || `Added ${res.added} to the queue`, !!res.error);
    return !res.error;
  }

  new Spicetify.ContextMenu.Item(
    'Add to JamTime queue',
    (uris) => addSongs(uris),
    (uris) => !!session && uris.every((u) => TRACK_URI.test(u)),
    'queue'
  ).register();

  // =====================================================================
  // UI
  // =====================================================================
  const ICON = `<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="8" r="2.2"/><circle cx="12" cy="8" r="2.2"/><path d="M4 3.5a4.5 4.5 0 0 1 8 0l-1.2.7a3.1 3.1 0 0 0-5.6 0z"/><path d="M4 12.5a4.5 4.5 0 0 0 8 0l-1.2-.7a3.1 3.1 0 0 1-5.6 0z"/></svg>`;
  const topbar = new Spicetify.Topbar.Button('JamTime', ICON, openModal);

  let container = null;

  const CSS = `
    .jt { display: grid; gap: 16px; font-size: 14px; }
    .jt input { width: 100%; padding: 12px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,.15); background: var(--spice-main-elevated, #242424); color: var(--spice-text); font-size: 15px; }
    .jt input:focus { outline: 2px solid var(--spice-button, #1ed760); outline-offset: -1px; }
    .jt .row { display: flex; gap: 8px; align-items: center; }
    .jt .row > input { flex: 1; }
    .jt button { padding: 10px 20px; border-radius: 999px; border: 1px solid rgba(255,255,255,.3); background: transparent; color: var(--spice-text); cursor: pointer; font-weight: 700; font-size: 14px; white-space: nowrap; }
    .jt button:hover:not(:disabled) { border-color: var(--spice-text); transform: scale(1.03); }
    .jt button:disabled { opacity: .4; cursor: default; }
    .jt button.primary { background: var(--spice-button, #1ed760); color: #000; border: 0; }
    .jt button.big { padding: 16px; font-size: 16px; width: 100%; }
    .jt .hero { text-align: center; padding: 8px 0; }
    .jt .hero h2 { margin: 0 0 6px; font-size: 26px; }
    .jt .or { text-align: center; opacity: .6; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
    .jt .code-in { text-transform: uppercase; letter-spacing: 6px; text-align: center; font-size: 20px; font-weight: 700; }
    .jt .err { color: #ff6b6b; text-align: center; min-height: 1em; }
    .jt .muted { opacity: .65; font-size: 12px; }
    .jt .code-box { text-align: center; background: var(--spice-card, #282828); border-radius: 12px; padding: 16px; }
    .jt .code { font-size: 38px; font-weight: 800; letter-spacing: 8px; margin: 2px 0 10px; }
    .jt .now { display: flex; gap: 12px; align-items: center; background: var(--spice-card, #282828); padding: 12px; border-radius: 12px; }
    .jt .now img { width: 64px; height: 64px; border-radius: 6px; object-fit: cover; }
    .jt h3 { margin: 0; font-size: 15px; }
    .jt ul { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; }
    .jt li { display: flex; gap: 10px; align-items: center; padding: 6px; border-radius: 6px; }
    .jt li:hover { background: var(--spice-card, #282828); }
    .jt li img { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
    .jt .meta { flex: 1; min-width: 0; }
    .jt .ellip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .jt .acts button { padding: 4px 8px; border: 0; opacity: .7; }
    .jt .acts button:hover { opacity: 1; }
    .jt .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .jt .chip { background: var(--spice-card, #282828); border-radius: 999px; padding: 4px 12px; font-size: 13px; }
    .jt .chip.me { outline: 1px solid var(--spice-button, #1ed760); }
    .jt .toggle { display: flex; gap: 8px; align-items: center; cursor: pointer; font-size: 13px; }
    .jt .toggle input { width: auto; }
  `;

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null && c !== false));
    return node;
  }

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function openModal() {
    container = el('div', { className: 'jt' });
    renderUI();
    Spicetify.PopupModal.display({ title: 'JamTime', content: container, isLarge: true });
  }

  let status = null;
  let error = null;

  function renderUI(newStatus = null, newError = null) {
    status = newStatus;
    error = newError;
    try {
      topbar.active = !!session;
    } catch {}
    // Redraw after the current click has finished. Replacing the clicked button
    // mid-click makes Spotify think the click landed outside the popup and close it.
    clearTimeout(renderTimer);
    renderTimer = setTimeout(draw);
  }

  let renderTimer = null;
  function draw() {
    if (!container || (!container.isConnected && container.childNodes.length)) return;
    const parts = session && room ? roomView() : lobbyView();
    container.replaceChildren(el('style', { textContent: CSS }), ...parts.filter(Boolean));
  }

  function lobbyView() {
    const code = el('input', { className: 'code-in', placeholder: 'CODE', maxLength: 5, disabled: !!status });
    const join = () => code.value.trim().length === 5 && start(code.value.trim().toUpperCase());
    code.addEventListener('keydown', (e) => e.key === 'Enter' && join());
    code.addEventListener('input', () => (joinBtn.disabled = !!status || code.value.trim().length !== 5));
    const joinBtn = el('button', { textContent: 'Join', disabled: true, onclick: join });
    return [
      el('div', { className: 'hero' },
        el('h2', { textContent: 'Listen together' }),
        el('div', { className: 'muted', textContent: 'Everyone hears the same song at the same time and adds to one queue.' })),
      el('button', { className: 'primary big', textContent: status === 'Starting…' ? 'Starting…' : 'Start a jam', disabled: !!status, onclick: () => start() }),
      el('div', { className: 'or', textContent: 'or join a friend' }),
      el('div', { className: 'row' }, code, joinBtn),
      status === 'Joining…' && el('div', { className: 'muted', style: 'text-align:center', textContent: 'Joining…' }),
      el('div', { className: 'err', textContent: error || '' }),
    ];
  }

  function trackRow(t, actions) {
    return el('li', {},
      t.image && el('img', { src: t.image, alt: '' }),
      el('div', { className: 'meta' },
        el('div', { className: 'ellip', textContent: t.name, title: t.name }),
        el('div', { className: 'muted ellip', textContent: `${t.artist}${t.duration ? ' · ' + fmt(t.duration) : ''} · added by ${t.addedBy}` })),
      actions);
  }

  function roomView() {
    const cur = room.current;
    const ctl = canControl();
    const link = el('input', { placeholder: 'Paste a Spotify song link to add it' });
    const addLink = async () => (await addSongs([link.value])) && (link.value = '');
    link.addEventListener('keydown', (e) => e.key === 'Enter' && addLink());
    const copy = (text) =>
      (Spicetify.Platform?.ClipboardAPI?.copy(text) ?? navigator.clipboard.writeText(text)).then(() => notify('Copied!'));

    return [
      el('div', { className: 'code-box' },
        el('div', { className: 'muted', textContent: amHost() ? 'Your jam code. Share it with friends' : 'Jam code' }),
        el('div', { className: 'code', textContent: room.code }),
        el('div', { className: 'row', style: 'justify-content:center' },
          el('button', { className: 'primary', textContent: 'Copy invite', onclick: () => copy(`Join my JamTime on Spotify! Code: ${room.code}`) }),
          el('button', { textContent: amHost() ? 'End jam' : 'Leave', onclick: () => endSession() }))),

      el('div', { className: 'now' },
        cur?.image && el('img', { src: cur.image, alt: '' }),
        el('div', { className: 'meta' },
          el('div', { className: 'muted', textContent: room.playing ? 'Now playing' : cur ? 'Paused' : 'Nothing playing yet' }),
          el('div', { className: 'ellip', style: 'font-weight:700;font-size:15px', textContent: cur ? cur.name : amHost() ? 'Play anything on Spotify to start' : 'Waiting for the host to play something…' }),
          cur && el('div', { className: 'muted ellip', textContent: cur.artist })),
        el('div', { className: 'row' },
          el('button', { textContent: '⏮', title: 'Previous', disabled: !ctl || !cur, onclick: () => send('prev') }),
          el('button', { textContent: room.playing ? '⏸' : '▶', disabled: !ctl || !cur, onclick: () => send(room.playing ? 'pause' : 'play') }),
          el('button', { textContent: '⏭', title: 'Skip', disabled: !ctl || !cur, onclick: () => send('next') }))),

      el('div', { className: 'row', style: 'justify-content:space-between' },
        el('h3', { textContent: `Up next${room.queue.length ? ` (${room.queue.length})` : ''}` }),
        room.queue.length > 1 && ctl && el('button', { textContent: 'Shuffle', onclick: () => send('shuffle') })),
      room.queue.length
        ? el('ul', {}, ...room.queue.map((t, i) => {
            const acts = el('div', { className: 'acts row' });
            const btn = (label, title, fn) => acts.append(el('button', { textContent: label, title, onclick: fn }));
            if (ctl) {
              btn('▶', 'Play now', () => send('playNow', { id: t.id }));
              if (i > 0) btn('↑', 'Move up', () => send('move', { id: t.id, to: i - 1 }));
              if (i < room.queue.length - 1) btn('↓', 'Move down', () => send('move', { id: t.id, to: i + 1 }));
            }
            if (ctl || t.addedById === me) btn('✕', 'Remove', () => send('remove', { id: t.id }));
            return trackRow(t, acts);
          }))
        : el('div', { className: 'muted', textContent: 'Right-click any song in Spotify and choose "Add to JamTime queue".' }),
      el('div', { className: 'row' }, link, el('button', { textContent: 'Add', onclick: addLink })),

      el('h3', { textContent: `Listening (${room.members.length})` }),
      el('div', { className: 'chips' }, ...room.members.map((m) =>
        el('span', { className: `chip${m.id === me ? ' me' : ''}`, textContent: `${m.name}${m.id === room.hostId ? ' ★' : ''}${m.id === me ? ' (you)' : ''}` }))),
      amHost() && el('label', { className: 'toggle' },
        el('input', { type: 'checkbox', checked: room.openControl, onchange: () => send('toggleOpen') }),
        'Let everyone control playback'),
    ];
  }
})();
