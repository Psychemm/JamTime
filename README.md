# JamTime

**Spotify Jam for free accounts.** Start a jam, share the 5-letter code, and everyone who joins hears the same song at the same moment on their own Spotify. Anyone can add songs to a shared queue.

JamTime is a [Spicetify](https://spicetify.app) extension plus a small sync server. It works with free and Premium accounts.

---

## Quick start

There are two roles:

| | Host (one person) | Everyone (host included) |
|---|---|---|
| Runs the server | ✅ | |
| Installs the extension | ✅ | ✅ |

### Everyone: install the extension

You need the **Spotify desktop app** downloaded from [spotify.com/download](https://www.spotify.com/download). The Microsoft Store version doesn't work with Spicetify.

**Step 1: Install Spicetify** (skip this if you already have it)

Windows, in PowerShell:
```powershell
iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex
```
macOS / Linux, in Terminal:
```bash
curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh
```
Close and reopen your terminal afterwards. If anything goes wrong, see the [Spicetify install guide](https://spicetify.app/docs/getting-started).

**Step 2: Install JamTime**

Windows, in PowerShell:
```powershell
iwr -useb https://raw.githubusercontent.com/Psychemm/JamTime/main/install.ps1 | iex
```
macOS / Linux, in Terminal:
```bash
curl -fsSL https://raw.githubusercontent.com/Psychemm/JamTime/main/install.sh | sh
```

Spotify restarts, and a **JamTime** button (two dots with arcs) appears in the top bar.

### Host: run the server

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/Psychemm/JamTime.git
cd JamTime
npm install
npm start
```

Leave that window open. The server runs on port 3000. How friends reach it depends on where they are:

- **Same Wi-Fi as you:** they use `ws://YOUR-LAN-IP:3000`. On Windows, find your IP with `ipconfig` (the "IPv4 Address" line).
- **Anywhere else:** install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run this in a second window:
  ```bash
  cloudflared tunnel --url http://localhost:3000
  ```
  It prints an address like `https://random-words.trycloudflare.com`. Send that to your friends. It changes every time you run the command.
- **Always on:** deploy the repo to any Node host (Render, Railway, Fly.io…). `render.yaml` is included for one-click Render deploys. Everyone then uses that site's address.

### Start jamming

1. Click **JamTime** in Spotify's top bar.
2. Fill in:
   - **Your name**
   - **Server:** `ws://localhost:3000` for the host. Friends use the address the host sent them.
3. The host clicks **Start a jam** and shares the code. Friends type the code and click **Join**.
4. Play music the way you normally would:
   - Play, pause, seek or pick a song, and everyone follows.
   - Right-click any song → **Add to JamTime queue** (select several songs to add them all at once).
   - Paste a Spotify song link in the JamTime window to queue it.
   - The host can untick **Let everyone control playback** so only they control what plays.

---

## How it works

```
 Spotify + JamTime extension ─┐
 Spotify + JamTime extension ─┼── WebSocket ──  JamTime server (Node)
 Spotify + JamTime extension ─┘                 rooms, queue, clock
```

- The **extension** runs inside each person's Spotify desktop app. It watches what that Spotify is playing and controls it through Spicetify's player API. That API is local to the app, so unlike Spotify's Web API it doesn't need Premium.
- The **server** holds each room's state: current song, play/pause, position and queue. Clients sync their clocks with it and correct any drift over 2.5 s.
- A change you make in your own Spotify is reported to the room, and everyone else follows. A change made by someone else is applied to your Spotify.
- If the room is empty, whatever the host plays becomes the jam. When a song ends, the queue goes first. If the queue is empty, the host's Spotify autoplay keeps the jam going.

## Limitations

- **Ads:** a free listener drops out of sync during an ad and catches up automatically when it ends.
- **Songs only:** podcasts and local files aren't synced. Whole albums or playlists can't be queued in one go yet; multi-select the songs instead.
- **Your own Spotify queue:** following the jam replaces what your Spotify was playing.
- **Terms of service:** Spicetify modifies the Spotify client, which Spotify's terms don't allow. It's widely used, but use it at your own risk.

## Troubleshooting

- **No JamTime button:** run `spicetify apply`. If Spotify recently updated itself, run `spicetify backup apply`.
- **"Can't reach the server":** check that the host's `npm start` window is still open and the address is typed exactly. Tunnel addresses change every time `cloudflared` restarts.
- **Out of sync:** it corrects itself within a few seconds. After an ad, give it a moment.

## Uninstall

```bash
spicetify config extensions jamtime.js-
spicetify apply
```

## Development

```bash
npm run dev   # server with auto-restart
npm test      # end-to-end sync test with mocked Spotify players
```

After editing `extension/jamtime.js`, run `spicetify apply`, or `spicetify watch -e` to live-reload.
