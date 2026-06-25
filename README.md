# VoiceMatch

> **Anonymous, interest-matched peer-to-peer voice calls — with real-time games, icebreaker questions, and zero accounts.**

VoiceMatch connects two strangers over WebRTC audio based on shared interests, drops them into a structured conversation with AI-curated icebreakers, and lets them play games together — all from a single HTML file and a lightweight Node.js backend. No signups, no persistent data, no recordings.

---

## Table of Contents

- [Live Demo](#live-demo)
- [How It Works](#how-it-works)
- [Feature Overview](#feature-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [Environment Variables](#environment-variables)
- [Architecture Deep Dive](#architecture-deep-dive)
- [Games System](#games-system)
- [Audio Pipeline](#audio-pipeline)
- [Admin Panel](#admin-panel)
- [Known Constraints](#known-constraints)

---

## Live Demo

| Service | URL |
|---|---|
| Frontend (Vercel) | https://project-8uivg.vercel.app |
| Backend (Render) | https://voicematch-backend-rure.onrender.com |

---

## How It Works

```
User A                     Server                     User B
  │                           │                           │
  ├── POST /api/matchmake ────►│                           │
  │   { socketId, interests } │                           │
  │                           │◄── POST /api/matchmake ───┤
  │                           │    { socketId, interests }│
  │                           │                           │
  │◄── socket: peer-ready ────┤── socket: peer-ready ────►│
  │    { roomId, role:'A' }   │   { roomId, role:'B' }    │
  │                           │                           │
  ├── initAudio() + initPC() ─┤─ initAudio() + initPC()  ─┤
  │                           │                           │
  ├── createOffer() ──────────►─── lab-signal relay ──────►│
  │                           │                           │
  │◄────────── createAnswer() ◄─── lab-signal relay ───────┤
  │                           │                           │
  ├──────── ICE candidates ───►◄────── ICE candidates ─────┤
  │         (STUN + TURN)     │       (STUN + TURN)        │
  │                           │                           │
  ╔═══════════ WebRTC P2P audio channel established ══════╗
  ║                  Call is live                         ║
  ╚═══════════════════════════════════════════════════════╝
```

The matchmaking flow uses **HTTP polling** (not pure WebSocket) for discovery so the backend stays stateless enough to run on Render's free tier. Once a room is formed, all signaling (SDP offer/answer, ICE candidates, game moves, reactions, skip votes) flows through a single `lab-signal` Socket.io relay event — the server is purely a relay and never inspects or stores media.

---

## Feature Overview

### Connection & Matching

- **Interest-based matching** — users tag up to N interests (Coding, Gaming, Music, Art, Chill, etc.) before connecting; the matchmaker scores pairs by overlap and picks the highest-scoring available peer
- **Mood selection** — a secondary signal (Chill, Deep Talk, Random, Night Owl) further characterises intent without being a hard filter
- **STUN + TURN ICE** — Google STUN servers for direct P2P, OpenRelay TURN servers as fallback relay for symmetric NAT, strict firewalls, mobile data, and corporate VPN environments
- **Glare-free WebRTC** — role `A` always creates the offer; role `B` always answers, preventing the simultaneous-offer ICE deadlock that breaks most naive WebRTC implementations
- **15-second connection watchdog** — surfaces a real error and a Retry button instead of hanging forever if ICE negotiation fails

### In-Call UI

- **Identicon avatars** — each peer is assigned a unique emoji avatar for the session; displayed in Discord-style bubbles with speaking-ring animations driven by an analyser node
- **Live waveform** — a canvas-drawn frequency visualiser animates during speech
- **Connection quality indicator** — derived from RTCStatsReport data (RTT, packet loss, jitter) shown as a coloured bar and label
- **Call timer** — elapsed time shown in the status bar
- **Interest tags** — the shared interests that caused the match are surfaced as chips between the avatars

### Icebreaker System

- **50 curated conversation questions** — randomly assigned per room at match time, tracked server-side so both peers always see the same question
- **Turn-based answering** — the server designates whose turn it is to answer first; a pill shows "Your Turn" (red) / "Their Turn" (amber)
- **Unique question codes** — each question has a hash-like code (`#qLe841`) so both sides can unambiguously reference it
- **Typewriter reveal effect** — new questions type out character-by-character with a synthesised hacker keystroke sound
- **Mutual skip voting** — either peer can propose skipping; the question advances only when both agree (2/2 votes), preventing one-sided pressure
- **Icebreaker hidden during games** — the question card collapses when a game is active to reclaim vertical space

### Reactions

- **8 emoji reactions** — 👍 😂 🔥 ❤️ 🤯 👏 ✨ 💯
- **Floating animation** — reacted emoji floats upward from the reaction tray with a physics-style arc
- **Real-time sync** — reactions are relayed via `lab-signal` so the peer sees them instantly

### Audio Controls

- **Mute / unmute** — toggle microphone with full visual feedback on both avatars
- **Neural noise suppression** — powered by `@workadventure/noise-suppression` (DTLN WASM model running in an AudioWorklet), enabled by default; falls back to a spectral noise gate if the WASM fails to load
- **Microphone selector** — right-click the Mute button to switch input device mid-call
- **Speaker selector** — right-click the Audio button to switch output device and adjust remote volume
- **Remote audio block** — left-click the Audio button to mute the remote stream (without muting your own mic)
- **Background music widget** — ambient lo-fi music player that auto-pauses when a call starts and resumes when it ends

### Reporting & Safety

- **In-call report flow** — report reasons: Harassment, Explicit Content, Spam, Other; optional free-text description; stored server-side with IP, socket ID, and timestamp
- **Safe-space reminder** on the connect screen

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS — single file (`index.html`) |
| Fonts & Icons | Space Grotesk + Space Mono (Google Fonts), Tabler Icons |
| Audio processing | Web Audio API, `@workadventure/noise-suppression` (DTLN WASM) |
| Real-time comms | WebRTC (audio), Socket.io (signaling + game state relay) |
| Chess engine | `chess.js` v1.0.0 (loaded as ES module via dynamic `import()`) |
| Backend runtime | Node.js |
| Backend framework | `http` (stdlib) + `socket.io` |
| Frontend hosting | Vercel |
| Backend hosting | Render (free tier) |
| ICE / TURN | Google STUN, OpenRelay TURN (free public relay) |

**Zero external databases.** All state is in-memory on the backend process. This is intentional — there is no user data to persist, and a cold restart simply clears the matchmaking queue.

---

## Project Structure

```
voicematch/
├── index.html          # Entire frontend — one self-contained file
│                       # (HTML structure, all CSS, all JS)
│
├── server.js           # Backend — Node.js HTTP + Socket.io
│                       # Matchmaking, signaling relay, admin API,
│                       # icebreaker state, reporting
│
└── README.md           # This file
```

The frontend is deliberately a single file. This makes deployment trivial (drop on any static host), removes any build step, and keeps the entire codebase readable in one place. The tradeoff is that the file is large (~3300 lines); this was accepted as the right call for a solo-developer project at this scale.

---

## Local Development

### Prerequisites

- Node.js 18+
- npm

### 1. Clone & install

```bash
git clone https://github.com/your-username/voicematch.git
cd voicematch
npm install socket.io
```

### 2. Set environment variables

```bash
export ADMIN_SECRET=your_admin_key_here
export CLIENT_ORIGIN=http://localhost:3000
```

Or create a `.env` file and load it with `dotenv` if you add that dependency.

### 3. Start the backend

```bash
node server.js
```

Server starts at `http://localhost:3000`.

### 4. Serve the frontend

Since the frontend is a single HTML file, you can serve it any way you like:

```bash
# Option A: Python simple server (no install needed)
python3 -m http.server 8080
# Then open http://localhost:8080/index.html

# Option B: npx serve
npx serve . -p 8080

# Option C: VS Code Live Server extension
# Right-click index.html → Open with Live Server
```

### 5. Update the backend URL in index.html

Search for `voicematch-backend-rure.onrender.com` and replace it with `localhost:3000` for local testing:

```bash
sed -i 's/voicematch-backend-rure.onrender.com/localhost:3000/g' index.html
```

Remember to revert this before deploying.

### 6. Test with two tabs

Open two browser tabs (or two different browsers) both pointing at `index.html`. On both tabs:
1. Select at least one matching interest
2. Click **Start Talking**
3. Both should connect via WebRTC within a few seconds

> **Note:** Both peers must be on the same machine for local testing since `localhost:3000` only resolves locally. For cross-device testing, expose the backend via ngrok: `ngrok http 3000`, then update the backend URL in `index.html`.

---

## Deployment

### Frontend → Vercel

1. Push `index.html` to a GitHub repo
2. Import the repo in Vercel
3. Set the root directory to `/` (or wherever `index.html` lives)
4. Deploy — Vercel serves static files out of the box
5. No build command needed

### Backend → Render

1. Push `server.js` (and a minimal `package.json`) to a GitHub repo

Minimum `package.json`:
```json
{
  "name": "voicematch-backend",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "socket.io": "^4.7.0" }
}
```

2. Create a new **Web Service** on Render, point it at the repo
3. Set Start Command: `node server.js`
4. Add environment variables (see below)
5. Deploy

> Render free tier spins down after 15 minutes of inactivity. The first connection after spin-down takes ~30 seconds. The frontend shows "Scanning the pool..." while the backend wakes up — no special handling needed.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_SECRET` | Yes | Password to access the admin panel at `/admin?key=...` |
| `CLIENT_ORIGIN` | No | Your Vercel frontend URL, used for CORS and root redirect. Defaults to `/`. Example: `https://project-8uivg.vercel.app` |
| `PORT` | No | Port the server listens on. Render sets this automatically. Defaults to `3000`. |

---

## Architecture Deep Dive

### Matchmaking

The `/api/matchmake` HTTP POST endpoint is called with the client's `socket.id` (established separately via Socket.io before the POST). The server:

1. Checks if the socket is already in an active call (prevents re-queuing)
2. Looks for a waiting peer in `matchingPool`
3. If no peer is waiting: adds this socket to the pool, returns `{ action: 'wait' }`
4. If a peer is waiting: scores all waiting peers by interest overlap, picks the highest scorer, calls `doMatch()`, and emits `peer-ready` to **both** sockets

The critical fix that makes this work: `peer-ready` must be emitted to **both** peers via Socket.io events. Earlier versions only emitted it to the already-waiting peer (A) and relied on the HTTP response to inform the newly-arrived peer (B) — but B's frontend couldn't create a `RTCPeerConnection` from an HTTP response, so B's ICE state would sit at `new` forever while A's offer arrived and silently no-op'd.

### WebRTC Signaling

All SDP and ICE traffic flows through a single `lab-signal` Socket.io event that the server relays to the other room member via `socket.to(roomId).emit(...)`. The server never parses the content — it's a blind relay.

**Offer/answer roles:**
- Role `A` (the peer who was already waiting) creates the offer after a 600ms delay (giving role B time to finish `initAudio()` + `initPC()`)
- Role `B` waits to receive the offer, then creates and sends an answer
- This prevents "glare" — the signaling deadlock that occurs when both peers simultaneously call `createOffer()` and then can't `setRemoteDescription()` because they're both already in `have-local-offer` state

### ICE Configuration

```javascript
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 4
};
```

STUN handles direct P2P (same network, open NAT). TURN is the relay fallback for everything else. Without TURN, roughly 15–20% of real-world connection pairs fail silently due to symmetric NAT or strict firewall configurations.

### Room State

The server maintains per-room state in memory:

```javascript
roomState[roomId] = {
  questionIndex,    // current icebreaker question (0–49)
  turnSocketId,     // whose turn it is to answer
  members,          // [socketIdA, socketIdB]
  skipVotes,        // Set of socket IDs that have voted to skip
  questionsShown,   // history of question indices shown
};
```

On `callLive` (emitted by the frontend once `ontrack` fires), the server pushes the full room state to both peers so they're in sync on questions and turns even if there was a brief timing difference during connection setup.

---

## Games System

Games are built on top of the same `lab-signal` relay — no new backend events needed. All game state lives on the frontend.

### How games start

1. Either peer opens the **Play Game** panel (floating button on the right edge of the call column)
2. They pick a game — this emits `{ gamePickSignal: 'ttt' }` to their partner
3. The partner sees a half-filled progress bar on that game card and a notification badge on the Play Game button
4. When the partner picks the **same** game, both sides call `startGame()` simultaneously
5. Game roles are assigned deterministically: the peer with the lexicographically lower `socket.id` is always player 1 — no negotiation needed

### Implemented games

| Game | Description | Win condition |
|---|---|---|
| **Tic Tac Toe** | Classic 3×3 grid | Three in a row |
| **Connect Four** | 6×7 drop grid | Four in a row in any direction |
| **Snake & Ladder** | 10×10 board, 1–6 dice | Reach square 100 first |
| **Chess** | Full 8×8 chess | Checkmate |

### Chess implementation note

`chess.js` ships exclusively as an ES module (even on npm). A classic `<script src>` tag cannot execute `export` syntax. The fix is dynamic `import()`:

```javascript
const mod = await import('https://cdn.jsdelivr.net/npm/chess.js@1.0.0/dist/esm/chess.js');
const Chess = mod.Chess || mod.default?.Chess || mod.default;
```

Three CDN sources are tried in sequence (jsDelivr → esm.sh → Skypack). The library is pre-warmed as soon as the lobby opens so it's cached before the user clicks Chess.

### Snake & Ladder animations

The token doesn't teleport to the final position. Movement is step-by-step:
1. Dice roll: random faces cycle for ~500ms before settling on the actual value
2. Token walk: the emoji steps square-by-square at 140ms per square
3. Snake/ladder: a separate animation phase plays on the landing cell, then the token jumps to the destination
4. All phases emit sound via Web Audio synthesis (no external audio files)

### Sound effects

All game sounds are synthesised live using `OscillatorNode` + `GainNode` — no files, no external requests, nothing to 404. Synthesis functions are in the `gameSfx` object:

```javascript
gameSfx.place()   // piece placed
gameSfx.drop()    // connect four drop
gameSfx.dice()    // dice rattle (4 random tones)
gameSfx.ladder()  // ascending 4-note arpeggio
gameSfx.snake()   // descending sawtooth wail
gameSfx.win()     // 4-note fanfare
gameSfx.lose()    // descending sad tone
gameSfx.move()    // chess move
gameSfx.capture() // chess capture
gameSfx.check()   // double-pulse alert
```

---

## Audio Pipeline

```
getUserMedia (16kHz, echoCancellation, noiseSuppression: false)
      │
      ▼
MediaStreamSource
      │
      ▼
AnalyserNode (for waveform + speaking detection)
      │
      ▼
DTLN AudioWorklet (neural noise suppression, WASM)
  └─ fallback: ScriptProcessor noise gate
      │
      ▼
GainNode
      │
      ▼
MediaStreamDestination → processedStream
      │
      ▼
RTCPeerConnection.addTrack(processedStream)
      │
      ▼  (WebRTC P2P)
      │
Remote peer's RTCPeerConnection
      │
      ▼
<audio id="remoteAudio"> → speaker output device
```

**Why 16kHz?** The DTLN model requires a 16kHz sample rate. The browser's WebRTC stack internally resamples to 48kHz for Opus encoding before sending — this is transparent and handled automatically by the browser.

**DTLN vs noise gate fallback:** If the `@workadventure/noise-suppression` WASM fails to load (slow connection, CSP restrictions, etc.), the pipeline falls back to a `ScriptProcessor`-based spectral noise gate. The gate is a much simpler threshold-based approach but still meaningfully reduces keyboard noise and background hum.

---

## Admin Panel

The backend exposes a full admin panel at `/admin?key=YOUR_ADMIN_SECRET`.

**Features:**
- Live dashboard with total sessions, matched pairs, active calls, queue depth, reports, avg duration
- Live calls list with peer socket IDs, IPs, questions shown, and a Kill button per call
- Matchmaking queue viewer
- Call history log (last 200 calls)
- Report log with Ban IP shortcut
- IP ban / unban management
- Homepage stats editor (active users count, avg match time, etc.) — changes take effect live without a redeploy
- Broadcast message — push a banner to all connected users instantly
- Interest heatmap — visualises which interests are most commonly selected

All data is in-memory and resets on server restart.

---

## Known Constraints

**In-memory state only.** The backend stores all call state in JavaScript objects. A Render free-tier restart (which can happen at any time) drops all active calls and the matchmaking queue. Users get a "Connection failed" toast and can reconnect.

**No end-to-end encryption.** Audio travels encrypted over DTLS (WebRTC's mandatory transport layer), but the server can theoretically intercept signaling. There is no additional application-layer encryption. For a casual anonymous chat product this is an acceptable tradeoff.

**TURN relay bandwidth.** OpenRelay's free public TURN service has no SLA. Under high load, TURN relay latency may increase. For production scale, replace with a paid TURN service (Twilio, Metered, Xirsys) and update `rtcConfig`.

**Single-process backend.** There is no Redis or shared state. Horizontal scaling (multiple Render instances) would break matchmaking since the pool is per-process. This is fine for the current scale; a Redis adapter for Socket.io + a shared matchmaking queue would be needed to scale horizontally.

**Chess.js loading.** Chess requires a dynamic ES module import from a CDN. In extremely restricted network environments (some enterprise firewalls block all CDN domains), Chess may be unavailable. The other three games (Tic Tac Toe, Connect Four, Snake & Ladder) have no external dependencies and always work.

---

## License

MIT — do whatever you want with it.

---

*Built by [healer](https://github.com/healer) · , India · 2026*
