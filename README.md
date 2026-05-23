# OK IRL Monitoring Tool (Web)

A lightweight replacement for Loopy SRT Monitor with a **local web UI** for settings and live stream status. It connects to OBS via WebSocket 5.x, watches your SRT **Media Source**, and switches scenes when the stream fails or recovers.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- OBS Studio with [obs-websocket](https://github.com/obsproject/obs-websocket) enabled (Tools → WebSocket Server Settings)
- An OBS **Media Source** named **OK IRL CAM SOURCE** pointed at your SRT URL

## Quick start

> **After `git pull`:** Stop the running monitor (`Ctrl+C` in the terminal) and run `npm start` again. An old Node process will not pick up new API routes (e.g. **Test relay / ffmpeg** may return HTML instead of JSON).

> **Tip:** If this folder lives on Google Drive, copy `srt-obs-monitor-web` to a local path (e.g. `C:\Tools\srt-obs-monitor-web`) before running `npm install`. Drive sync often breaks `node_modules`.

1. Open this folder: `srt-obs-monitor-web`
2. Double-click **`start.cmd`** or **`start.ps1`** (installs npm packages on first run)
3. In the web UI, set your OBS WebSocket **password** and confirm scene / media source names
4. Click **Save settings**

Default URLs (HTTPS only on port **9000**):

- Control UI (local): **https://127.0.0.1:9000**
- Phone GPS / widgets (LAN): **https://YOUR_LAN_IP:9000** — first start may auto-create a self-signed cert in `data/certs/`; accept the certificate warning once in your browser, on the phone, and in OBS Browser Source properties.

Settings are stored in `data/settings.json` (JSON, not INI). Edit via the web page or the file directly.

## How it works

| Mode | When |
|------|------|
| **intro** | No healthy stream yet (startup) |
| **ok** | Media source playing; switches to your live scene |
| **fail** | Stream down/frozen for `streamFailDelaySeconds` → BRB scene |
| **low-bitrate** | Optional LBR scene (`OK scene` + suffix, e.g. `IRL LBR`) |
| **bypass** | You manually picked a bypass scene — auto switching paused |

**OBS Media Source (recommended)** — matches your current setup:

- Monitors `GetMediaInputStatus` (state + playback cursor)
- Detects stopped/ended/error and **frozen** video (cursor not advancing while “playing”)

**SRT relay via ffmpeg (optional)** — enable **Route through monitor** on the **SRT stream** tab:

| Hop | Endpoint |
|-----|----------|
| Phone → Monitor | `srt://YOUR_PC_IP:8000?mode=caller` (UDP forward 8000 on router) |
| Monitor → OBS | `srt://127.0.0.1:8001?mode=caller` in Media Source (ffmpeg listens on 8001) |

The relay starts and stops with **Start SRT monitoring**. Requires [ffmpeg](https://ffmpeg.org/) on PATH (or set `relay.ffmpegPath`). Bitrate thresholds use relay ingest stats (`srtLiveServer.bitrateLowKbps` / `bitrateFailKbps` in settings JSON).

**Do not** test ffmpeg by writing MPEG-TS to `live.ts` (or `test-*.ts`, `multi.ts`, etc.) in the project root — a left-running capture can grow to tens of GB. Use a temp path outside this folder, or run `scripts/cleanup-ts-dumps.ps1` to remove stray root dumps.

Direct mode (relay off) is unchanged: phone calls OBS listener on port 8000.

## Location & weather (phone GPS)

**SRT video does not carry GPS.** To auto-update the weather bar place, open the **phone location reporter** URL on your phone (HTTPS), not the SRT encoder URL.

### Why there is no “Allow location” popup

`navigator.geolocation` only works in a **secure context**: **HTTPS**, or **`http://localhost`** on a PC. URLs like `http://192.168.1.10:9000` or `http://YOUR_PUBLIC_IP:9000` are **not** secure on iPhone/Android — the API fails **silently** (no permission dialog). The reporter page must be **HTTPS**.

**Do not** use the OBS weather bar URL (`http://…:9001/widgets/weather-bar`) on your phone for GPS — that URL is for **OBS on the stream PC** only. The phone GPS reporter is **`https://<WAN-IP>:9000/widgets/phone-location.html?autostart=1&keepalive=1`** (or LAN IP on the same network).

### Chrome: “This site can’t ask for your permission…”

That text is **Chrome on Android**, not OK IRL Monitoring. Chrome could not show the location prompt (often chat bubbles, PiP, split-screen, or another app overlay). Close overlays, then tap **Allow location again** on the reporter page, or open the HTTPS reporter URL in Chrome/Safari first.

Some in-app browsers block or delay geolocation. If GPS fails inside an app, open the copied HTTPS URL in Chrome/Safari → accept cert → allow location, then return to the app or keep the browser tab open while streaming. Use **Send test location** on the reporter page if needed.

**Reset permissions (Chrome Android):** ⋮ → Settings → Site settings → Location → remove blocked entries for your monitor IP, or reset all site permissions, then reopen the HTTPS reporter URL.

### Option A — Built-in HTTPS (recommended on LAN, default)

1. **Server** tab → **Bind host** = your PC **LAN IP** (not `127.0.0.1`) → Save → restart the app (`npm start` or `start.cmd`).
2. On first start the app tries to create `data/certs/cert.pem` + `key.pem` (needs **OpenSSL** on PATH). If that fails, run `npm run https:cert` or use mkcert (below).
3. **Widgets** tab → **Copy** the **Phone GPS reporter** URL (`https://192.168.x.x:9000/widgets/phone-location.html?autostart=1&keepalive=1`).
4. On the phone, open that URL in Chrome/Safari once → accept the **certificate warning** → allow **location** when prompted.
5. Forward TCP **9000** on your router for cellular/WAN (use WAN URL from **Widgets** tab).

**OBS weather bar** (Widgets → Create/update widget):

- OBS uses **HTTP** on port **9001**: `http://<LAN-IP>:9001/widgets/weather-bar?…` — no TLS cert in OBS. Set **Web server → LAN host** (auto-detected if empty). Browser source height **~96–120px**. Allow TCP **9001** in Windows Firewall if OBS is on another PC.

Phone GPS reporter: `https://<WAN-IP>:9000/widgets/phone-location.html?autostart=1&keepalive=1` (Widgets tab **Copy** — starts GPS and wake lock; extra battery; background GPS is still limited by the OS).

#### Edge Canary on Android (background GPS)

Browsers pause background tabs; there is no perfect in-tab fix. Best results:

1. **Edge** → site settings for your monitor host → **Battery** → **Unrestricted** (wording may vary).
2. Disable **sleeping tabs** / tab discard for Edge if your build has it.
3. Keep the reporter tab **visible** (or pinned) while streaming.
4. The Widgets reporter URL already includes `?keepalive=1`; you can also check **Keep screen awake** on this page (wake lock + heartbeat — higher battery use).

### Option B — ngrok (public HTTPS for phone GPS)

```bash
ngrok http https://127.0.0.1:9000
```

Use `https://….ngrok-free.app/widgets/phone-location.html` on your phone when you need a **public HTTPS URL with a valid cert** (no self-signed warning). No router forward; keep ngrok running. See `scripts/ngrok-reporter-url.ps1` for a reminder.

### Option C — mkcert (green lock in Edge on this PC)

Install [mkcert](https://github.com/FiloSottile/mkcert) once, then from the project folder:

```bash
winget install FiloSottile.mkcert
npm run https:mkcert
npm start
```

The script runs `mkcert -install` (one-time CA in Windows trust store), then writes `data/certs/cert.pem` and `key.pem` for `localhost`, `127.0.0.1`, `::1`, and your LAN IP from **Server** → **LAN host** / auto-detect. Refresh Edge at `https://127.0.0.1:9000` and `https://192.168.x.x:9000` — the lock should show **secure** on this PC.

After changing LAN IP: `npm run https:mkcert` again, then restart.

**Phones** do not use your PC’s mkcert CA; they still need to accept the cert once, or use ngrok (Option B).

### Workflow

1. **Server** tab → LAN IP (or ngrok) → Save → restart.
2. **Widgets** tab → copy reporter URL → open on phone and allow location.
3. Enable **Use phone GPS** (default on). **Place** and weather overlay follow POSTs every ~15s.

If GPS is blocked, the reporter page shows **Send test location** with manual lat/lon. Optional API: `POST /api/widgets/location` with `{"lat":52.37,"lon":4.89,"label":"Amsterdam"}`.

## Camera feed tab

When **SRT relay** is enabled, the **Camera feed** tab shows:

- Live MJPEG preview from the ffmpeg relay (`GET /api/camera/feed.mjpeg`)
- Stereo VU meters from ffmpeg `astats` (`GET /api/camera/audio-levels`, polled ~100 ms while relay runs). UI distinguishes **no audio track**, **silent**, and **active** levels.

**Steps:** enable relay on **SRT stream** → Save settings → **Start SRT monitoring** → stream from phone to listen port (e.g. UDP **8000**) → open **Camera feed** tab. **ffmpeg** must be on PATH.

## SRT in OBS (cheat sheet)

1. Add **Media Source** → uncheck “Restart playback when source becomes active”
2. Example listener URL on the PC receiving the phone:

   `srt://0.0.0.0:9000?mode=listener&latency=3000000&timeout=5000000`

3. Set reconnect delay to **1–2 seconds** in the source properties (relay mode uses 2 s via **Create cam source**). Match **SRT latency** in the Media Source URL to stream settings; relay uses a **lower latency on the loopback hop** (127.0.0.1:obsPort) than the phone ingest port. **Create cam source** sets **buffering** to 1 MB in relay mode (was 4 MB) to reduce OBS-side delay.

## Migrating from Loopy SRT Monitor

| Loopy `config.ini` | This app |
|--------------------|----------|
| `WebSocketAddress` | OBS tab → Host + Port |
| `WebSocketPassword` | OBS tab → Password |
| `SceneOK` / `SceneFail` / `SceneIntro` | Scenes tab |
| `MediaSource1` | Streams tab → Media source name |
| `StreamFailDelay` | Monitor tab → Fail delay |
| `SceneBypass` | Scenes tab → Bypass (comma-separated) |

Your old program can keep running in parallel until you are happy with this one.

## Commands

```bash
npm install
npm start
```

Development with auto-restart: `npm run dev`

Regenerate TLS cert after changing LAN IP (includes localhost, 127.0.0.1, and `server.lanHost`):

```bash
npm run https:cert -- --force
```

Trusted HTTPS in Edge on this PC (green lock): `npm run https:mkcert` — requires [mkcert](https://github.com/FiloSottile/mkcert) (`winget install FiloSottile.mkcert`).

### Site still running after closing the terminal?

`npm start`, `start.cmd`, and `start.ps1` run the server in the **foreground** — closing that window should stop it.

If the UI stays up, another **Node** process is still listening (often port **9000**), e.g. from a **Cursor agent background shell** or an old `npm run dev` (`node --watch`). Stop it in PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 9000 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Or find the PID: `netstat -ano | findstr ":9000"` then `taskkill /PID <pid> /F`.

### HTTPS shows "Not secure" (red lock)

Normal for the default **self-signed** cert. To get a **green lock in Edge on this PC**:

1. Install mkcert: `winget install FiloSottile.mkcert` (or `choco install mkcert`)
2. Run `npm run https:mkcert` (approve the one-time Windows CA prompt if asked)
3. `npm start` and refresh `https://127.0.0.1:9000` and your LAN URL

**Without mkcert:** open the site → lock → **Certificate is not valid** → proceed (repeat on phone and OBS Browser Source). Alternative: `.\scripts\trust-https-cert.ps1` imports the current `cert.pem` into your user Trusted Root (local dev only).

If the name does not match (e.g. after changing PC IP), run `npm run https:cert -- --force` or `npm run https:mkcert`, then restart.

## Streaming topology

**Direct (default):** Phone (SRT caller) → OBS Media Source (listener on `0.0.0.0:8000`).

**Monitor relay:** Phone (caller) → **ffmpeg** on `0.0.0.0:8000` → **ffmpeg** listener on `127.0.0.1:8001` → OBS Media Source (caller to `127.0.0.1:8001`).

### Relay setup checklist

1. **SRT stream** tab → enable **Route through monitor** → Save settings (listen port **8000**, OBS port **8001** by default).
2. Phone encoder: `srt://YOUR_PC_LAN_IP:8000?mode=caller` (UDP **8000** forwarded on the router).
3. OBS **OK IRL CAM SOURCE**: `srt://127.0.0.1:8001?mode=caller` (use **Create cam source** in the UI or paste from SRT preview).
4. Uncheck **Restart playback when source becomes active**; reconnect delay **2 s** is applied when relay is on.
5. Click **Start SRT monitoring** — ffmpeg relay starts with monitoring (not when OBS alone is connected).
6. Live status: **Relay ingest** = phone → ffmpeg; **OBS media** = debounced OBS state (may show `playing (ended)` if OBS flickers while ingest is fine).

Do **not** point the phone at port **8001** or OBS at **8000** while relay is enabled — that creates two competing listeners.

**Stream state flickering `playing` ↔ `ended` every second:** OBS caller mode often reports brief `ended`/`stopped` between SRT reconnects while **Mode** stays **ok** (fail delay). The monitor debounces OBS media (~2.5 s), shows raw OBS state in parentheses when it differs, and when **Relay ingest** is **connected** treats ingest as healthy and keeps stream state at **playing**. Check **Relay ingest** first; if it says **waiting**, the phone is not reaching ffmpeg on the listen port.

**Camera feed tab blank:** The ffmpeg relay used to print audio `astats` metadata to **stdout** (`ametadata … file=-`), which corrupted the MJPEG preview on the same pipe. Metadata now uses `ametadata=mode=print` (stderr only; do not use `file=pipe:2` on Windows — the colon breaks the filter graph). Copy-to-OBS runs first with a simpler preview encode (`-r 10 -vf scale=854:-2`).

**OBS much later than Camera preview:** Preview is 10 fps MJPEG (decode path, no extra SRT hop). OBS receives full-rate MPEG-TS over a **second SRT leg** (ffmpeg listener on obsPort) plus OBS Media Source buffering. Relay now uses **lower SRT latency on 127.0.0.1:obsPort**, **muxdelay/muxpreload 0**, smaller mux queue, and **1 MB** OBS buffering in relay mode. Match phone and OBS URL latency to **SRT settings**; optional `relay.obsLatencyMs` overrides the loopback hop only.

Manual ffmpeg one-liner (same as the app uses): `GET /api/relay/manual-command` after saving relay settings.

## Files

- `data/settings.json` — all configuration
- `data/connections.log` — optional log (enable on Monitor tab)
- `public/` — web UI
- `src/` — server, OBS client, monitor loop, `srt-relay.js` (ffmpeg child)

## Security

The web server binds to **127.0.0.1** by default and listens on **HTTPS only** (self-signed cert in `data/certs/`). Fine on LAN; do not expose port **9000** to the internet without your own authentication.
# IRL-MEUK
