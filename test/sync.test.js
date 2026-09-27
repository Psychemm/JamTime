// End-to-end sync test: runs the real extension code in several mocked
// Spotify clients connected through in-memory fake MQTT relays.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'jamtime.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const X = 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
const Y = 'spotify:track:0DiWol3AO6WpXZgp0goxAV';
const Z = 'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp';
const W = 'spotify:track:7qiZfU4dY1lWllzX7mPBI3';

// ---------- fake MQTT broker (in memory, one per relay URL) ----------
const subs = new Map(); // "url|topic" -> Set<FakeWS>
const brokerDown = new Set(); // relay URLs that refuse new connections

class FakeWS {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.keys = new Set();
    setTimeout(() => {
      if (brokerDown.has(url)) return this.onerror?.(), this.onclose?.();
      this.readyState = 1;
      this.onopen?.();
    }, 5);
  }
  send(packet) {
    const b = Buffer.from(packet);
    const type = b[0] >> 4;
    let i = 1, len = 0, mult = 1, byte;
    do { byte = b[i++]; len += (byte & 127) * mult; mult *= 128; } while (byte & 128);
    const body = b.subarray(i, i + len);
    if (type === 1) this.deliver([0x20, 2, 0, 0]); // CONNECT -> CONNACK
    else if (type === 8) { // SUBSCRIBE -> SUBACK
      const key = this.url + '|' + body.subarray(4, 4 + body.readUInt16BE(2)).toString();
      if (!subs.has(key)) subs.set(key, new Set());
      subs.get(key).add(this);
      this.keys.add(key);
      this.deliver([0x90, 3, body[0], body[1], 0]);
    } else if (type === 3) { // PUBLISH -> forward to subscribers
      const key = this.url + '|' + body.subarray(2, 2 + body.readUInt16BE(0)).toString();
      for (const ws of subs.get(key) || []) ws.deliver(b);
    } else if (type === 14) this.close();
  }
  deliver(bytes) {
    const data = new Uint8Array(bytes).buffer;
    setTimeout(() => this.readyState === 1 && this.onmessage?.({ data }), 2);
  }
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    for (const k of this.keys) subs.get(k)?.delete(this);
    setTimeout(() => this.onclose?.(), 2);
  }
}

// ---------- fake Spotify ----------
function makeClient(label, uri, posSec, playing) {
  const p = { uri, pos: posSec * 1000, playing, at: Date.now(), dur: 200000 };
  const progress = () => Math.min(p.dur, p.pos + (p.playing ? Date.now() - p.at : 0));
  const freeze = () => ((p.pos = progress()), (p.at = Date.now()));
  const notifications = [];
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
  const ctx = {
    console: { ...console, warn() {} }, setTimeout, setInterval, clearTimeout, clearInterval, Promise, Date, Math, JSON,
    WebSocket: FakeWS, TextEncoder, TextDecoder,
    window: { addEventListener() {} },
    Spicetify: {
      Player,
      Topbar: { Button: class {} },
      PopupModal: { display() {} },
      ContextMenu: { Item: class { register() {} } },
      Platform: { UserAPI: { getUser: async () => ({ displayName: label }) } },
      CosmosAsync: {
        get: async (url) => ({
          tracks: url.split('ids=')[1].split(',').map((id) => ({
            uri: `spotify:track:${id}`, name: `Track ${id.slice(-4)}`, artists: [{ name: 'Band' }],
            album: { images: [{ url: 'https://i.scdn.co/image/x' }] }, duration_ms: 180000,
          })),
        }),
      },
      showNotification: (t) => notifications.push(t),
    },
  };
  // Expose internals so the test can drive them.
  const patched = src.replace(
    'const topbar =',
    'globalThis.__jt = { start, addSongs, endSession, get room() { return room; }, get session() { return session; } };\n  const topbar ='
  );
  vm.runInNewContext(patched, ctx);
  return { p, progress, player: Player, notifications, api: () => ctx.__jt };
}

const show = (c, label) => `${label}: ${c.p.uri.slice(-4)} ${c.p.playing ? '▶' : '⏸'} ${(c.progress() / 1000).toFixed(1)}s`;

(async () => {
  let fails = 0;
  const check = (name, cond, ...info) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  ' + info.join(' ')}`);
    if (!cond) fails++;
  };
  const close = (a, b) => Math.abs(a.progress() - b.progress()) < 2500;

  const A = makeClient('Alice', X, 30, true);
  const B = makeClient('Bob', Y, 0, true);
  const C = makeClient('Cara', Y, 0, false);
  await sleep(500);

  await A.api().start();
  await sleep(1500);
  const code = A.api().room?.code;
  check('host song becomes jam song', A.api().room?.current?.uri === X);

  await B.api().start('ZZZZZ');
  check('bad code gives a clear error', !B.api().session);

  await B.api().start(code);
  await sleep(2500);
  check('guest switches to host song', B.p.uri === X && close(A, B) && B.p.playing, show(A, 'A'), show(B, 'B'));
  check('names come from Spotify', A.api().room.members.map((m) => m.name).join() === 'Alice,Bob');

  await sleep(3500); // let grace periods pass
  A.player.pause();
  await sleep(2500);
  check('host pause reaches guest', !B.p.playing && !A.p.playing, show(A, 'A'), show(B, 'B'));

  await sleep(3500);
  A.player.play();
  A.player.seek(100000);
  await sleep(2500);
  check('host play+seek reaches guest', B.p.playing && B.progress() > 98000 && close(A, B), show(A, 'A'), show(B, 'B'));

  await sleep(3500);
  await B.player.playUri(Z);
  await sleep(2500);
  check('guest picking a song moves everyone', A.p.uri === Z && B.p.uri === Z && close(A, B), show(A, 'A'), show(B, 'B'));

  await B.api().addSongs(['https://open.spotify.com/track/7qiZfU4dY1lWllzX7mPBI3?si=abc']);
  await sleep(300);
  const q = A.api().room.queue[0];
  check('guest adds a song by link, with metadata', q?.uri === W && q.name === 'Track PBI3' && q.addedBy === 'Bob');

  brokerDown.add('wss://broker.emqx.io:8084/mqtt'); // Cara can only reach the backup relay
  await C.api().start(code);
  await sleep(2500);
  check('late joiner syncs up (via backup relay)', C.p.uri === Z && C.p.playing && close(A, C), show(A, 'A'), show(C, 'C'));

  await sleep(3500);
  A.player.seek(198500); // host skips to the end of the song
  await sleep(6000);
  check('queue advances at end of song', [A, B, C].every((c) => c.p.uri === W), show(A, 'A'), show(B, 'B'), show(C, 'C'));

  await A.api().session.request('toggleOpen');
  await sleep(3500);
  B.player.pause();
  await sleep(2500);
  check('host-only: guest pause is reverted', !A.api().room.openControl && B.p.playing && close(A, B), show(A, 'A'), show(B, 'B'));
  check('guest told they cannot control', B.notifications.some((n) => n.includes('Only the host')));

  C.api().endSession();
  await sleep(300);
  check('guest leaving updates members', A.api().room.members.length === 2);

  A.api().endSession();
  await sleep(300);
  check('host ending the jam ends it for guests', !B.api().session && B.notifications.some((n) => n.includes('ended')));

  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
