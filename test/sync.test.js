// End-to-end sync test: runs the real extension code against mocked Spotify
// players connected to a real server. Needs network access for track metadata.
const fs = require('fs');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = require('path').join(__dirname, '..');
const src = fs.readFileSync(`${ROOT}/extension/jamtime.js`, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const X = 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
const Y = 'spotify:track:0DiWol3AO6WpXZgp0goxAV';
const Z = 'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp';
const W = 'spotify:track:7qiZfU4dY1lWllzX7mPBI3';

function makeClient(label, uri, posSec, playing) {
  const p = { uri, pos: posSec * 1000, playing, at: Date.now(), dur: 200000 };
  const progress = () => Math.min(p.dur, p.pos + (p.playing ? Date.now() - p.at : 0));
  const freeze = () => ((p.pos = progress()), (p.at = Date.now()));
  const Player = {
    get data() { return { item: { uri: p.uri, name: 'Song ' + p.uri.slice(-4), artists: [{ name: 'Artist' }], images: [] } }; },
    getProgress: progress,
    getDuration: () => p.dur,
    isPlaying: () => p.playing,
    seek: (ms) => (freeze(), (p.pos = ms)),
    play: () => (freeze(), (p.playing = true)),
    pause: () => (freeze(), (p.playing = false)),
    playUri: async (u) => { await sleep(150); p.uri = u; p.pos = 0; p.at = Date.now(); p.playing = true; },
    addEventListener() {},
  };
  const ls = new Map();
  const ctx = {
    console, setTimeout, setInterval, clearTimeout, WebSocket, Promise, Date, Math, JSON,
    Spicetify: {
      Player,
      Topbar: { Button: class { constructor(l, i, cb) { ctx.openModal = cb; } } },
      PopupModal: { display() {} },
      ContextMenu: { Item: class { register() {} } },
      LocalStorage: { get: (k) => ls.get(k) ?? null, set: (k, v) => ls.set(k, v) },
      showNotification: (t) => console.log(`  [${label} notif] ${t}`),
    },
  };
  ls.set('jamtime:server', 'ws://localhost:3999');
  ls.set('jamtime:name', label);
  // Expose internals for driving the test.
  const patched = src.replace('const topbar =', 'globalThis.__fj = { startOrJoin, toggle: () => request("toggleOpen"), get room() { return room; } };\n  const topbar =')
    .replace('if (inGrace) return;', 'if (DBG) console.log("  tick", LABEL, { synced, inGrace, sameTrack, lp: L.playing, rp: room.playing, pos: L.pos.toFixed(1), exp: exp.toFixed(1) }); if (inGrace) return;');
  ctx.DBG = !!process.env.DBG; ctx.LABEL = label;
  vm.runInNewContext(patched, ctx);
  return { p, progress, ctx, api: () => ctx.__fj };
}

const show = (c, label) =>
  `${label}: ${c.p.uri.slice(-4)} ${c.p.playing ? '▶' : '⏸'} ${(c.progress() / 1000).toFixed(1)}s`;

(async () => {
  const srv = spawn(process.execPath, [`${ROOT}/server.js`], { env: { ...process.env, PORT: '3999' }, stdio: 'inherit' });
  await sleep(800);
  let fails = 0;
  const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };
  const close = (a, b) => Math.abs(a.progress() - b.progress()) < 2500;

  try {
    const A = makeClient('A', X, 30, true);
    const B = makeClient('B', Y, 0, true);
    await sleep(500);

    await A.api().startOrJoin();
    await sleep(1500);
    const code = A.api().room.code;
    check('host song becomes jam song', A.api().room.current?.uri === X);

    await B.api().startOrJoin(code);
    await sleep(2500);
    console.log(' ', show(A, 'A'), '|', show(B, 'B'));
    check('guest switches to host song', B.p.uri === X && close(A, B) && B.p.playing);

    await sleep(3500); // let grace periods pass
    A.ctx.Spicetify.Player.pause();
    await sleep(2500);
    console.log(' ', show(A, 'A'), '|', show(B, 'B'));
    check('host pause reaches guest', !B.p.playing && !A.p.playing);

    await sleep(3500);
    A.ctx.Spicetify.Player.play();
    A.ctx.Spicetify.Player.seek(100000);
    await sleep(2500);
    console.log(' ', show(A, 'A'), '|', show(B, 'B'));
    check('host play+seek reaches guest', B.p.playing && B.progress() > 98000 && close(A, B));

    await sleep(3500);
    await B.ctx.Spicetify.Player.playUri(Z);
    await sleep(2500);
    console.log(' ', show(A, 'A'), '|', show(B, 'B'));
    check('guest picking a song moves everyone (open control)', A.p.uri === Z && B.p.uri === Z && close(A, B));

    const r = await new Promise((res) => {
      const ws = new WebSocket('ws://localhost:3999');
      ws.onopen = () => ws.send(JSON.stringify({ t: 'join', id: 1, code, name: 'C' }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === 1) ws.send(JSON.stringify({ t: 'add', id: 2, uris: [W] }));
        if (m.id === 2) { ws.close(); res(m); }
      };
    });
    console.log('  add ->', JSON.stringify(r));
    await sleep(500);
    check('queued song has metadata', A.api().room.queue[0]?.uri === W && A.api().room.queue[0].name !== 'Unknown track');

    await sleep(3000);
    // Simulate Spotify autoplay at the end of the song on the host: queue should win.
    A.p.pos = 198500; A.p.at = Date.now(); B.p.pos = 198500; B.p.at = Date.now();
    await new Promise((res) => {
      const ws = new WebSocket('ws://localhost:3999');
      ws.onopen = () => ws.send(JSON.stringify({ t: 'join', id: 1, code, name: 'D' }));
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { ws.send(JSON.stringify({ t: 'seek', id: 2, pos: 198.5 })); } if (m.id === 2) { ws.close(); res(); } };
    });
    await sleep(3500);
    console.log(' ', show(A, 'A'), '|', show(B, 'B'));
    check('queue advances at end of song', A.p.uri === W && B.p.uri === W);

    // Host-only mode: a guest's own changes get reverted.
    await new Promise((res) => {
      const s = new WebSocket('ws://localhost:3999');
      s.onopen = () => s.send(JSON.stringify({ t: 'join', id: 1, code, name: 'E' }));
      s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { s.close(); res(); } };
    });
    await A.api().toggle();
    await sleep(3500);
    B.ctx.Spicetify.Player.pause();
    await sleep(2500);
    console.log(' ', show(A, 'A'), '|', show(B, 'B'), 'open:', A.api().room.openControl);
    check('host-only: guest pause is reverted', !A.api().room.openControl && A.p.playing && B.p.playing && close(A, B));
  } finally {
    srv.kill();
    console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
    process.exit(fails ? 1 : 0);
  }
})();
