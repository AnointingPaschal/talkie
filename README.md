# 📻 LAN Walkie-Talkie

A real-time, radio-themed voice + text communication app that runs **entirely offline** over your local Wi-Fi network. No internet connection required after setup.

---

## ✅ Prerequisites

- **Node.js v18+** — download from https://nodejs.org
- All devices must be connected to the **same Wi-Fi network**

---

## 🚀 Quick Start (3 steps)

### Step 1 — Install dependencies (run once)

Open a terminal in the `lan-walkie-talkie` folder and run:

```bash
npm install
```

### Step 2 — Start the server

```bash
npm start
```

You'll see output like:

```
┌──────────────────────────────────────────────────┐
│    🎙️  LAN Walkie-Talkie  –  Server Ready         │
├──────────────────────────────────────────────────┤
│  ► Local  :  http://localhost:3000               │
│  ► Network:  http://192.168.1.42:3000            │
└──────────────────────────────────────────────────┘
```

The **Network** URL (e.g. `http://192.168.1.42:3000`) is the address
other devices on your Wi-Fi will use to connect.

### Step 3 — Connect from any device

On **any phone, tablet, or laptop** on the same Wi-Fi:

1. Open a browser (Chrome or Edge recommended for best WebRTC support)
2. Navigate to `http://192.168.1.42:3000` ← use YOUR server's IP
3. Enter a callsign and grant microphone access
4. Join a channel and talk!

---

## 🔎 Finding Your LAN IP (if not shown)

| OS | Command |
|----|---------|
| **Windows** | `ipconfig` → look for **IPv4 Address** under your Wi-Fi adapter |
| **macOS** | `ifconfig en0 \| grep inet` or System Settings → Wi-Fi → Details |
| **Linux** | `ip addr show` or `hostname -I` |

The IP typically looks like `192.168.x.x` or `10.0.x.x`.

---

## 🎙️ How to Use

### Channels
| Action | How |
|--------|-----|
| Join a channel | Type a channel number (e.g. `7`) in the Channel Control box → **JOIN** |
| Create a public channel | Just join a channel number nobody else is using |
| Create a private channel | Check **Private channel**, set a password, then JOIN |
| Quick-join | Click any channel in the **Active Channels** list on the left |
| Leave | Click **✕ LEAVE** |
| Scan | Click **⟳ SCAN** — auto-joins the first active public channel |

### Transmitting
| Method | Action |
|--------|--------|
| **PTT mode** (default) | Hold the big button **or** hold `Spacebar` |
| **Toggle mode** | Click the button once to open mic, click again to close |
| Switch mode | Click **PTT** or **TOGGLE** under the big button |
| Mute incoming | Click **🔊** button to silence other users' audio |

### Text Chat
- Runs alongside voice on any channel you've joined
- Press `Enter` or click **Send**
- Chat history is saved for the session

---

## 🏗️ Architecture

```
Device A (server host)          Device B               Device C
┌─────────────────────┐         ┌────────────┐         ┌────────────┐
│  Node.js + Express  │◄──WS───►│  Browser   │         │  Browser   │
│  Socket.io signaling│◄──WS──────────────────────────►│            │
│  (serves HTML/JS)   │         └────┬───────┘         └────┬───────┘
└─────────────────────┘              │                       │
                                     │◄──── WebRTC P2P ─────►│
                                     │   (direct audio/data) │
```

- **Signaling server**: Socket.io relays WebRTC offers, answers, and ICE candidates
- **Audio transport**: WebRTC peer-to-peer directly between browsers on LAN (no relay needed)
- **Mesh topology**: Every user connects directly to every other user in the channel
- **No STUN/TURN**: Not needed on a LAN — connections use local IP addresses (host ICE candidates)

### Scaling note
Mesh topology is ideal for **up to ~8–10 users per channel**. For larger groups, an SFU (like mediasoup or Janus) would be needed. The signaling server code is structured to make that upgrade straightforward.

---

## 🔒 Security

- The server listens on all network interfaces (`0.0.0.0`) — **only share the URL with trusted people on your network**
- Private channels use a simple password sent over the WebSocket — this is sufficient for LAN use but not encrypted at the application layer
- For encrypted use, serve over HTTPS using a self-signed certificate or a tool like `mkcert`

### Optional: Run with HTTPS (required for some mobile browsers)

```bash
# Install mkcert
brew install mkcert   # macOS
# or: https://github.com/FiloSottile/mkcert

mkcert -install
mkcert localhost 192.168.1.42   # replace with your IP

# Then update server.js to use https module with the generated cert files
```

---

## 🛠️ Development Mode (auto-restart)

```bash
npm run dev
```

---

## 📁 File Structure

```
lan-walkie-talkie/
├── server.js          ← Node.js + Socket.io signaling server
├── package.json
├── README.md
└── public/
    ├── index.html     ← App shell (setup screen + main UI)
    ├── style.css      ← Radio-themed styles
    └── app.js         ← WebRTC, PTT, scanner, chat logic
```

---

## 🐛 Troubleshooting

| Problem | Fix |
|---------|-----|
| "Microphone access denied" | Click the 🔒 icon in browser address bar → allow mic |
| Other device can't connect | Ensure same Wi-Fi; try disabling firewall temporarily; use IP not hostname |
| No audio from others | Check your speaker volume; click 🔊 button to unmute |
| Voice is choppy | Move closer to router; close bandwidth-heavy apps |
| Mobile Chrome no audio | Tap anywhere on the page first (browser autoplay policy) |
| Connection drops | Check Wi-Fi stability; server auto-reconnects |
