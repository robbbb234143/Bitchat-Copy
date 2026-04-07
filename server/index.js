const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { saveMessage, getRecentMessages } = require("./db");
const { initializeCrypto, encryptText, decryptText } = require("./pgp");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const usersBySocket = new Map();
const socketsByUsername = new Map();

function normalizeName(value, fallback = "") {
  return String(value || fallback).trim().slice(0, 24);
}

function normalizeRoom(value) {
  const room = String(value || "lobby").trim().slice(0, 32);
  return room || "lobby";
}

function normalizeMessage(value) {
  return String(value || "").trim().slice(0, 500);
}

async function hydrateMessage(row) {
  return {
    ...row,
    body: await decryptText(row.body)
  };
}

function emitRoomState(room) {
  const users = [...usersBySocket.values()]
    .filter((user) => user.room === room)
    .map((user) => user.username)
    .sort((a, b) => a.localeCompare(b));

  io.to(room).emit("room_state", { room, users });
}

function addUsernameSocket(username, socketId) {
  const existing = socketsByUsername.get(username) || new Set();
  existing.add(socketId);
  socketsByUsername.set(username, existing);
}

function removeUsernameSocket(username, socketId) {
  const existing = socketsByUsername.get(username);
  if (!existing) {
    return;
  }

  existing.delete(socketId);
  if (existing.size === 0) {
    socketsByUsername.delete(username);
  }
}

io.on("connection", (socket) => {
  socket.on("join", async ({ username, room }, ack = () => {}) => {
    try {
      const normalizedUsername = normalizeName(username);
      const normalizedRoom = normalizeRoom(room);

      if (!normalizedUsername) {
        ack({ ok: false, error: "Username is required." });
        return;
      }

      if (socketsByUsername.has(normalizedUsername)) {
        ack({ ok: false, error: "Username is already in use." });
        return;
      }

      socket.join(normalizedRoom);
      usersBySocket.set(socket.id, {
        socketId: socket.id,
        username: normalizedUsername,
        room: normalizedRoom
      });
      addUsernameSocket(normalizedUsername, socket.id);

      const history = await Promise.all(
        getRecentMessages(normalizedRoom).map((message) => hydrateMessage(message))
      );
      socket.emit("message_history", history);

      io.to(normalizedRoom).emit("system_message", {
        body: `${normalizedUsername} joined #${normalizedRoom}`,
        createdAt: Date.now()
      });

      emitRoomState(normalizedRoom);
      ack({ ok: true, room: normalizedRoom, username: normalizedUsername });
    } catch {
      ack({ ok: false, error: "Unable to join securely right now." });
    }
  });

  socket.on("chat_message", async ({ body }, ack = () => {}) => {
    try {
      const currentUser = usersBySocket.get(socket.id);

      if (!currentUser) {
        ack({ ok: false, error: "Join a room before sending messages." });
        return;
      }

      const normalizedBody = normalizeMessage(body);
      if (!normalizedBody) {
        ack({ ok: false, error: "Message cannot be empty." });
        return;
      }

      if (normalizedBody.startsWith("/dm ")) {
        const parts = normalizedBody.split(" ");
        const target = normalizeName(parts[1]);
        const directBody = normalizeMessage(parts.slice(2).join(" "));

        if (!target || !directBody) {
          ack({ ok: false, error: "Usage: /dm <username> <message>" });
          return;
        }

        const targetSockets = socketsByUsername.get(target);
        if (!targetSockets || targetSockets.size === 0) {
          ack({ ok: false, error: `User ${target} is not online.` });
          return;
        }

        const dmPayload = {
          id: null,
          room: currentUser.room,
          sender: currentUser.username,
          body: directBody,
          private: true,
          recipient: target,
          createdAt: Date.now()
        };

        socket.emit("chat_message", dmPayload);
        for (const targetSocket of targetSockets) {
          io.to(targetSocket).emit("chat_message", dmPayload);
        }

        ack({ ok: true });
        return;
      }

      const encryptedBody = await encryptText(normalizedBody);
      const saved = saveMessage({
        room: currentUser.room,
        sender: currentUser.username,
        body: encryptedBody
      });

      io.to(currentUser.room).emit("chat_message", {
        ...saved,
        body: normalizedBody
      });
      ack({ ok: true });
    } catch {
      ack({ ok: false, error: "Unable to secure that message." });
    }
  });

  socket.on("disconnect", () => {
    const currentUser = usersBySocket.get(socket.id);
    if (!currentUser) {
      return;
    }

    usersBySocket.delete(socket.id);
    removeUsernameSocket(currentUser.username, socket.id);

    io.to(currentUser.room).emit("system_message", {
      body: `${currentUser.username} left #${currentUser.room}`,
      createdAt: Date.now()
    });

    emitRoomState(currentUser.room);
  });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

async function start() {
  await initializeCrypto();

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`BitChat replica running at http://${HOST}:${PORT}`);
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to initialize crypto:", error);
  process.exitCode = 1;
});
