# FreeJam

Spotify Jam–style listening parties for **free** Spotify accounts, built on [Spicetify](https://spicetify.app).

Start a jam, share the 5-letter code, and everyone who joins hears the same song at the same moment on their own Spotify desktop app. There's a shared queue anyone can add to.

## How it works

```
 Spotify + FreeJam extension ─┐
 Spotify + FreeJam extension ─┼── WebSocket ──  FreeJam server (Node)
 Spotify + FreeJam extension ─┘                 rooms, queue, clock
```

- The **extension** runs inside each person's Spotify desktop app. It watches what that Spotify is playing and controls it through Spicetify's player API. That API is local to the app, so unlike Spotify's Web API it doesn't need Premium.
- The **server** holds the room: current song, play/pause, position and queue. Clients sync their clocks with it and correct any drift over 2.5 s.
- When someone plays, pauses, seeks or picks a song in their own Spotify, it's reported to the room and everyone follows. With "Let everyone control playback" turned off, only the host can do this, and guests get pulled back into sync.
- If the room is empty, whatever the host plays becomes the jam. When a song ends, the queue goes first. If the queue is empty, the host's Spotify autoplay keeps the jam going.

## Setup

You need [Node.js](https://nodejs.org) 18+ for the server. Everyone who joins needs the Spotify **desktop** app with [Spicetify](https://spicetify.app/docs/getting-started) installed.

### 1. Run the server (one person)

```bash
npm install
npm start
```

It listens on port 3000 (set `PORT` to change it).

- **Same Wi-Fi:** friends use `ws://<your-LAN-IP>:3000`.
- **Friends elsewhere:** expose it with a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
  ```bash
  cloudflared tunnel --url http://localhost:3000
  ```
  Share the `https://….trycloudflare.com` address it prints. The extension accepts it as-is.
- **Always-on:** deploy to any Node host (Render, Railway, Fly.io…) with `npm start`. `render.yaml` is included for Render.

### 2. Install the extension (everyone)

Windows (PowerShell):

```powershell
./install.ps1
```

Manually, on any OS: copy `extension/freejam.js` into your Spicetify `Extensions` folder (`spicetify path userdata`), then run:

```bash
spicetify config extensions freejam.js
spicetify apply
```

### 3. Jam

1. Click the **FreeJam** button in Spotify's top bar.
2. Enter your name and the server address, then **Start a jam**, or type a code and **Join**.
3. Add songs: right-click any track → **Add to FreeJam queue**, or paste a Spotify track link in the FreeJam window.
4. Just use Spotify normally. Play, pause, seek and pick songs, and the room follows.

## Limitations

- **Ads:** a free listener drops out of sync during an ad and catches up automatically when it ends.
- **Tracks only:** podcasts and local files aren't synced. Adding a whole album or playlist to the queue isn't supported yet (you can multi-select tracks and right-click).
- **Your own Spotify queue:** following the jam replaces what your Spotify was playing.
- **Terms of service:** Spicetify modifies the Spotify client, which Spotify's terms don't allow. It's widely used, but use it at your own risk.

## Development

```bash
npm run dev   # server with auto-restart
```

After editing the extension, run `spicetify apply` again, or `spicetify watch -e` to live-reload.
