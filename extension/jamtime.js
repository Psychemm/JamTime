// NAME: JamTime
// AUTHOR: Psychemm
// DESCRIPTION: Spotify Jam-style listening parties for free accounts. Everyone's Spotify plays the same song at the same time, with a shared queue.

(async function JamTime() {
  while (!Spicetify?.Player?.data || !Spicetify.Topbar || !Spicetify.PopupModal || !Spicetify.ContextMenu) {
    await new Promise((r) => setTimeout(r, 300));
  }

  const Player = Spicetify.Player;
  const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;
  const DRIFT_LIMIT = 2.5; // seconds out of sync before we correct
  const APPLY_GRACE = 3000; // ms to ignore local changes after we change the player ourselves
  const END_GRACE = 4; // must match the server

  // ---------- settings ----------
  const store = {
    get: (k, d) => Spicetify.LocalStorage.get(`jamtime:${k}`) ?? d,
    set: (k, v) => Spicetify.LocalStorage.set(`jamtime:${k}`, v),
  };

  // ---------- state ----------
  let ws = null;
  let room = null; // latest state from server
  let me = null; // our member id
  let roomCode = null; // for reconnecting
  let clockOffset = 0; // serverTime - localTime
  let lastApply = 0;
  let synced = false; // local player snapshot from the last time it matched the room
  let applying = false;
  let lastTick = null;
  let lastDenied = 0;
  let wantOpen = false; // keep reconnecting while true
  const pending = new Map();
  let nextId = 1;

  const notify = (text, isError) => Spicetify.showNotification(`JamTime: ${text}`, isError);
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
    return {
      uri: item?.uri || null,
      playing: Player.isPlaying(),
      pos: (Player.getProgress() || 0) / 1000,
    };
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

  // ---------- connection ----------
  function serverUrl() {
    let url = store.get('server', 'ws://localhost:3000').trim();
    if (!/^[a-z]+:\/\//i.test(url)) url = `wss://${url}`;
    return url.replace(/^http/i, 'ws');
  }

  function request(t, body = {}) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve({ error: 'Not connected to the server' });
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ t, id, ...body }));
      setTimeout(() => pending.delete(id) && resolve({ error: 'Server did not respond' }), 15000);
    });
  }

  const sendCmd = (t, body = {}) => request(t, body).then((r) => r.error && notify(r.error, true));

  function connect() {
    return new Promise((resolve) => {
      if (ws && ws.readyState === WebSocket.OPEN) return resolve(true);
      try {
        ws = new WebSocket(serverUrl());
      } catch {
        return resolve(false);
      }
      ws.onopen = async () => {
        await syncClock();
        resolve(true);
      };
      ws.onerror = () => resolve(false);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.t === 'ack') {
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        } else if (msg.t === 'state') {
          room = msg;
          renderUI();
          tick();
        } else if (msg.t === 'toast') {
          notify(msg.text);
        }
      };
      ws.onclose = () => {
        const wasInRoom = !!room;
        room = null;
        renderUI();
        if (!wantOpen) return;
        if (wasInRoom) notify('Lost connection, reconnecting…', true);
        setTimeout(reconnect, 3000);
      };
    });
  }

  async function reconnect() {
    if (!wantOpen) return;
    if (!(await connect())) return setTimeout(reconnect, 5000);
    if (roomCode) {
      const res = await request('join', { code: roomCode, name: store.get('name', '') });
      if (res.error) {
        notify('The jam has ended', true);
        leave();
      } else {
        me = res.you;
        synced = false;
      }
    }
  }

  // Use the fastest of several round trips to estimate the clock offset.
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const res = await request('time');
      const t1 = Date.now();
      if (res.error) return;
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: res.serverTime - (t0 + t1) / 2 };
    }
    clockOffset = best.offset;
  }

  async function startOrJoin(code) {
    wantOpen = true;
    if (!(await connect())) {
      wantOpen = false;
      return notify(`Can't reach the server at ${serverUrl()}`, true);
    }
    const res = code
      ? await request('join', { code, name: store.get('name', '') })
      : await request('create', { name: store.get('name', '') });
    if (res.error) return notify(res.error, true);
    me = res.you;
    roomCode = res.code;
    synced = false;
    lastTick = null;
    // Starting a jam while music is playing: that song becomes the first one.
    if (!code) {
      const L = local();
      if (TRACK_URI.test(L.uri || '')) {
        request('track', { uri: L.uri, pos: L.pos, playing: L.playing, meta: localMeta() });
      }
    }
    notify(code ? `Joined jam ${res.code}` : `Jam started, code ${res.code}`);
  }

  function leave() {
    wantOpen = false;
    roomCode = null;
    room = null;
    if (ws) {
      request('leave');
      ws.close();
    }
    renderUI();
  }

  // ---------- sync loop ----------
  // Compares the local player with the room. If they differ, either the user
  // did something (report it to the room) or we drifted (correct ourselves).
  async function tick() {
    if (!room || applying) return;
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
      // Empty room: whatever the host plays becomes the jam.
      if (amHost() && L.playing && !inGrace) {
        lastApply = now;
        request('track', { uri: L.uri, pos: L.pos, playing: true, meta: localMeta() });
      }
      return;
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
    // Otherwise the user touched their own Spotify.
    const userChanged = synced && (L.uri !== synced.uri || L.playing !== synced.playing || jumped);

    // Our Spotify moved on at the end of the song; the server is about to advance.
    const nearEnd = cur.duration && exp >= cur.duration - END_GRACE;

    if (userChanged && canControl()) {
      synced = false;
      lastApply = now; // give the server a moment to answer
      if (!sameTrack) {
        return request('track', { uri: L.uri, pos: L.pos, playing: L.playing, meta: localMeta() });
      }
      if (L.playing !== room.playing) return request(L.playing ? 'play' : 'pause', { pos: L.pos });
      if (jumped) return request('seek', { pos: L.pos });
    } else if (userChanged && !nearEnd && now - lastDenied > 10000) {
      lastDenied = now;
      notify('Only the host can control this jam');
    }

    if (!sameTrack && nearEnd) return;
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
        for (let i = 0; i < 50 && local().uri !== cur.uri; i++) await new Promise((r) => setTimeout(r, 100));
        seekTo(expectedPos() + 0.2);
        if (!room.playing) Player.pause();
      } else {
        const L = local();
        if (L.playing !== room.playing) room.playing ? Player.play() : Player.pause();
        if (Math.abs(L.pos - expectedPos()) >= DRIFT_LIMIT) seekTo(expectedPos() + 0.2);
      }
    } catch (err) {
      console.error('[JamTime] could not apply room state', err);
    } finally {
      lastApply = Date.now();
      lastTick = null;
      applying = false;
    }
  }

  setInterval(tick, 1000);
  Player.addEventListener('songchange', () => setTimeout(tick, 300));
  Player.addEventListener('onplaypause', () => setTimeout(tick, 300));

  // ---------- right-click menu ----------
  new Spicetify.ContextMenu.Item(
    'Add to JamTime queue',
    (uris) => request('add', { uris }).then((r) => notify(r.error || `Queued ${r.added}`, !!r.error)),
    (uris) => !!room && uris.every((u) => TRACK_URI.test(u)),
    'queue'
  ).register();

  // ---------- UI ----------
  const ICON = `<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="8" r="2.2"/><circle cx="12" cy="8" r="2.2"/><path d="M4 3.5a4.5 4.5 0 0 1 8 0l-1.2.7a3.1 3.1 0 0 0-5.6 0z"/><path d="M4 12.5a4.5 4.5 0 0 0 8 0l-1.2-.7a3.1 3.1 0 0 1-5.6 0z"/></svg>`;
  const topbar = new Spicetify.Topbar.Button('JamTime', ICON, openModal);

  let container = null;

  const CSS = `
    .fj { display: grid; gap: 14px; font-size: 14px; }
    .fj input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--spice-button-disabled, #555); background: var(--spice-main-elevated, #242424); color: var(--spice-text); }
    .fj label { display: grid; gap: 4px; font-size: 12px; opacity: .8; }
    .fj .row { display: flex; gap: 8px; align-items: center; }
    .fj .row > input { flex: 1; }
    .fj button { padding: 8px 16px; border-radius: 999px; border: 1px solid var(--spice-button-disabled, #555); background: transparent; color: var(--spice-text); cursor: pointer; font-weight: 600; white-space: nowrap; }
    .fj button:hover:not(:disabled) { border-color: var(--spice-text); }
    .fj button:disabled { opacity: .4; cursor: default; }
    .fj button.primary { background: var(--spice-button, #1ed760); color: #000; border: 0; }
    .fj .code { font-size: 22px; font-weight: 800; letter-spacing: 4px; }
    .fj .muted { opacity: .65; font-size: 12px; }
    .fj .now { display: flex; gap: 12px; align-items: center; background: var(--spice-card, #282828); padding: 10px; border-radius: 8px; }
    .fj .now img { width: 56px; height: 56px; border-radius: 4px; object-fit: cover; }
    .fj h3 { margin: 0; font-size: 14px; }
    .fj ul { list-style: none; margin: 0; padding: 0; max-height: 280px; overflow-y: auto; }
    .fj li { display: flex; gap: 10px; align-items: center; padding: 6px; border-radius: 6px; }
    .fj li:hover { background: var(--spice-card, #282828); }
    .fj li img { width: 36px; height: 36px; border-radius: 3px; object-fit: cover; }
    .fj .meta { flex: 1; min-width: 0; }
    .fj .ellip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fj .acts button { padding: 2px 8px; border: 0; opacity: .7; }
    .fj .acts button:hover { opacity: 1; }
    .fj .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .fj .chip { background: var(--spice-card, #282828); border-radius: 999px; padding: 3px 10px; font-size: 12px; }
    .fj .chip.me { outline: 1px solid var(--spice-button, #1ed760); }
  `;

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null && c !== false));
    return node;
  }

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function openModal() {
    container = el('div', { className: 'fj' });
    renderUI();
    Spicetify.PopupModal.display({ title: 'JamTime', content: container, isLarge: true });
  }

  function renderUI() {
    try {
      topbar.active = !!room;
    } catch {}
    if (!container || !container.isConnected && container.childNodes.length) return;
    container.replaceChildren(el('style', { textContent: CSS }), ...(room ? roomView() : lobbyView()));
  }

  function lobbyView() {
    const name = el('input', { value: store.get('name', ''), maxLength: 24, placeholder: 'Your name' });
    const server = el('input', { value: store.get('server', 'ws://localhost:3000'), placeholder: 'ws://localhost:3000' });
    const code = el('input', { placeholder: 'CODE', maxLength: 5, style: 'text-transform:uppercase;letter-spacing:3px' });
    const save = () => {
      store.set('name', name.value.trim());
      store.set('server', server.value.trim());
    };
    return [
      el('div', { className: 'muted', textContent: 'Start a jam and share the code. Everyone who joins hears the same song at the same time on their own Spotify.' }),
      el('label', {}, 'Your name', name),
      el('label', {}, 'Server', server),
      el('button', { className: 'primary', textContent: 'Start a jam', onclick: () => (save(), startOrJoin()) }),
      el('div', { className: 'row' }, code,
        el('button', {
          textContent: 'Join',
          onclick: () => {
            save();
            if (code.value.trim()) startOrJoin(code.value.trim().toUpperCase());
          },
        })),
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
    const link = el('input', { placeholder: 'Paste a Spotify track link' });
    const addLink = () =>
      request('add', { uris: [link.value] }).then((r) => {
        notify(r.error || `Queued ${r.added}`, !!r.error);
        if (!r.error) link.value = '';
      });

    return [
      el('div', { className: 'row', style: 'justify-content:space-between' },
        el('div', {},
          el('div', { className: 'muted', textContent: 'Jam code' }),
          el('div', { className: 'code', textContent: room.code })),
        el('div', { className: 'row' },
          el('button', {
            textContent: 'Copy code',
            onclick: () =>
              (Spicetify.Platform?.ClipboardAPI?.copy(room.code) ?? navigator.clipboard.writeText(room.code))
                .then(() => notify('Code copied')),
          }),
          el('button', { textContent: 'Leave', onclick: leave }))),

      el('div', { className: 'now' },
        cur?.image && el('img', { src: cur.image, alt: '' }),
        el('div', { className: 'meta' },
          el('div', { className: 'muted', textContent: room.playing ? 'Now playing' : cur ? 'Paused' : 'Nothing playing' }),
          el('div', { className: 'ellip', style: 'font-weight:700', textContent: cur ? cur.name : amHost() ? 'Play something on Spotify, or queue a song' : 'Waiting for the host…' }),
          cur && el('div', { className: 'muted ellip', textContent: cur.artist })),
        el('div', { className: 'row' },
          el('button', { textContent: '⏮', title: 'Previous', disabled: !ctl || !cur, onclick: () => sendCmd('prev') }),
          el('button', { textContent: room.playing ? '⏸' : '▶', disabled: !ctl || !cur, onclick: () => sendCmd(room.playing ? 'pause' : 'play') }),
          el('button', { textContent: '⏭', title: 'Skip', disabled: !ctl || !cur, onclick: () => sendCmd('next') }))),

      el('div', { className: 'row', style: 'justify-content:space-between' },
        el('h3', { textContent: `Up next${room.queue.length ? ` (${room.queue.length})` : ''}` }),
        el('button', { textContent: 'Shuffle', disabled: !ctl || room.queue.length < 2, onclick: () => sendCmd('shuffle') })),
      room.queue.length
        ? el('ul', {}, ...room.queue.map((t, i) => {
            const acts = el('div', { className: 'acts row' });
            const btn = (label, title, fn) => acts.append(el('button', { textContent: label, title, onclick: fn }));
            if (ctl) {
              btn('▶', 'Play now', () => sendCmd('playNow', { id: t.id }));
              if (i > 0) btn('↑', 'Move up', () => sendCmd('move', { id: t.id, to: i - 1 }));
              if (i < room.queue.length - 1) btn('↓', 'Move down', () => sendCmd('move', { id: t.id, to: i + 1 }));
            }
            if (ctl || t.addedById === me) btn('✕', 'Remove', () => sendCmd('remove', { id: t.id }));
            return trackRow(t, acts);
          }))
        : el('div', { className: 'muted', textContent: 'Right-click any song in Spotify → "Add to JamTime queue", or paste a link below.' }),
      el('div', { className: 'row' }, link, el('button', { textContent: 'Add', onclick: addLink })),

      el('h3', { textContent: `Listening (${room.members.length})` }),
      el('div', { className: 'chips' }, ...room.members.map((m) =>
        el('span', { className: `chip${m.id === me ? ' me' : ''}`, textContent: m.name + (m.id === room.hostId ? ' ★' : '') }))),
      amHost() && el('label', { className: 'row', style: 'display:flex;font-size:13px;opacity:1;cursor:pointer' },
        el('input', { type: 'checkbox', checked: room.openControl, style: 'width:auto', onchange: () => sendCmd('toggleOpen') }),
        'Let everyone control playback'),
    ];
  }
})();
