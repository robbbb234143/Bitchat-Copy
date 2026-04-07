# Bitchat-Copy

A working BitChat-style chat replica built with:

- Express + Socket.IO backend
- SQLite persistence for room messages
- OpenPGP-backed message encryption at rest in the backend
- Browser client served by the same server

## Features

- Realtime room chat
- Presence list (online users in room)
- Room message history on join (persisted in SQLite)
- Simple private messages using `/dm <username> <message>`
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
- `public/style.css`: Styling
- `public/app.js`: Browser socket client logic

## Notes

- Public room messages are persisted.
- The server encrypts room messages with an OpenPGP keypair before saving them to SQLite.
- On first launch, the server creates local PGP key material under `server/.pgp/` and reuses it on later runs.
- Private `/dm` messages are realtime only (not persisted).