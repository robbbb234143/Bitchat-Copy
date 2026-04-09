# Bitchat-Copy

A working BitChat-style chat replica built with:

- Express + Socket.IO backend
- SQLite persistence for room messages
- Browser client served by the same server
- Browser-side end-to-end encryption for room messages
- Browser mesh transport via WebRTC data channels (node-to-node forwarding)
- ECDH + ECDSA key-based authentication and encrypted direct messages

## Features

- Realtime room chat
- Passphrase-free key-authenticated join
- Presence list (online users in room)
- Room message history on join (persisted in SQLite)
- Simple private messages using `/dm <username> <message>`
- Mesh packet forwarding with TTL + dedupe (packets hop peer-to-peer)
- Mobile + desktop responsive UI

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```

3. Open in your browser:

```text
http://localhost:3000
```

## Send Messages Across Devices

To chat between two devices, both must reach the same server over your LAN.

1. Start server on the host machine (already binds to `0.0.0.0` by default).
2. Find host machine IP (example: `192.168.1.20`).
3. On each device, open:

```text
http://192.168.1.20:3000
```

4. Join same room with different usernames and message each other.

If it does not connect, allow inbound TCP `3000` in your firewall/router.

## Project Structure

- `server/index.js`: Express app + Socket.IO realtime events
- `server/db.js`: SQLite schema and message queries
- `public/index.html`: Chat UI
- `public/crypto.js`: Browser cryptography helpers
- `public/style.css`: Styling
- `public/app.js`: Browser socket client logic

## Notes

- Public room messages are persisted.
- Every room message is encrypted in the browser with a per-sender key before it reaches the server.
- Direct messages are encrypted in the browser using ECDH-derived keys and are never stored.
- Each client has persistent local identity keys and signs key bundles/messages for authentication.
- The app uses TOFU (trust on first use): first seen fingerprint is pinned in browser storage.
- If a pinned fingerprint changes, the user is marked `unverified` and messages from that identity are treated as suspicious.
- Private `/dm` messages are realtime only (not persisted).
- Live chat now prefers mesh data channels (WebRTC) and only falls back to Socket.IO when peer links are unavailable.
- This implementation is browser-based and does **not** use native Bluetooth radio APIs.
- Signaling still uses Socket.IO; after peers connect, message payloads are routed peer-to-peer.

## What Each Machine Needs

- A modern browser with WebCrypto support (current Chrome, Edge, Firefox, Safari).
- No extra crypto software installation is required on client machines.
- Access to the same server URL.

For strongest transport security, serve over HTTPS/WSS in production.