const path = require("path");
const http = require("http");
const https = require("https");
const fs = require("fs/promises");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { saveMessage, getRecentMessages } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

let io;

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
  return String(value || "").trim().slice(0, 20000);
}

function normalizeSignature(value) {
  return String(value || "").trim().slice(0, 12000);
}

function normalizeTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }

  return Math.trunc(parsed);
}

function normalizeKeyBundle(input) {
  return {
    username: normalizeName(input?.username),
    fingerprint: String(input?.fingerprint || "").trim().slice(0, 200),
    signingPublicKeyJwk: input?.signingPublicKeyJwk && typeof input.signingPublicKeyJwk === "object" ? input.signingPublicKeyJwk : null,
    ecdhPublicKeyJwk: input?.ecdhPublicKeyJwk && typeof input.ecdhPublicKeyJwk === "object" ? input.ecdhPublicKeyJwk : null,
    signature: normalizeSignature(input?.signature)
  };
}

function emitRoomState(room) {
  const users = [...usersBySocket.values()]
    .filter((user) => user.room === room)
    .map((user) => ({
      username: user.username,
      keyBundle: user.keyBundle
    }))
    .sort((a, b) => a.username.localeCompare(b.username));

  io.to(room).emit("room_state", { room, users });
}

function addUsernameSocket(username, socketId) {
  const existing = socketsByUsername.get(username) || new Set();
  existing.add(socketId);
  socketsByUsername.set(username, existing);
}

function getRoomUsers(room) {
  return [...usersBySocket.values()]
    .filter((user) => user.room === room)
    .map((user) => ({
      username: user.username,
      keyBundle: user.keyBundle
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
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

function registerSocketHandlers() {
  io.on("connection", (socket) => {
    socket.on("join", ({ username, room, keyBundle }, ack = () => {}) => {
      try {
        const normalizedUsername = normalizeName(username);
        const normalizedRoom = normalizeRoom(room);
        const normalizedBundle = normalizeKeyBundle(keyBundle);

        if (!normalizedUsername) {
          ack({ ok: false, error: "Username is required." });
          return;
        }

        if (
          !normalizedBundle.username ||
          normalizedBundle.username !== normalizedUsername ||
          !normalizedBundle.signingPublicKeyJwk ||
          !normalizedBundle.ecdhPublicKeyJwk ||
          !normalizedBundle.signature
        ) {
          ack({ ok: false, error: "Signed key bundle is required." });
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
          room: normalizedRoom,
          keyBundle: normalizedBundle
        });
        addUsernameSocket(normalizedUsername, socket.id);

        socket.emit("message_history", getRecentMessages(normalizedRoom));

        io.to(normalizedRoom).emit("system_message", {
          body: `${normalizedUsername} joined #${normalizedRoom}`,
          createdAt: Date.now()
        });

        emitRoomState(normalizedRoom);
        ack({
          ok: true,
          room: normalizedRoom,
          username: normalizedUsername,
          keyBundle: normalizedBundle,
          users: getRoomUsers(normalizedRoom)
        });
      } catch {
        ack({ ok: false, error: "Unable to join right now." });
      }
    });

    socket.on("chat_message", ({ body, signature, createdAt }, ack = () => {}) => {
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

        const normalizedSignature = normalizeSignature(signature);
        const normalizedCreatedAt = normalizeTimestamp(createdAt);

        const saved = saveMessage({
          room: currentUser.room,
          sender: currentUser.username,
          body: normalizedBody,
          signature: normalizedSignature,
          createdAt: normalizedCreatedAt
        });

        io.to(currentUser.room).emit("chat_message", saved);
        ack({ ok: true });
      } catch {
        ack({ ok: false, error: "Unable to send that message." });
      }
    });

    socket.on("direct_message", ({ recipient, body, createdAt, signature }, ack = () => {}) => {
      try {
        const currentUser = usersBySocket.get(socket.id);

        if (!currentUser) {
          ack({ ok: false, error: "Join a room before sending messages." });
          return;
        }

        const normalizedRecipient = normalizeName(recipient);
        const normalizedBody = normalizeMessage(body);
        const normalizedSignature = normalizeSignature(signature);

        if (!normalizedRecipient || !normalizedBody || !normalizedSignature) {
          ack({ ok: false, error: "Direct message payload is invalid." });
          return;
        }

        const targetSockets = socketsByUsername.get(normalizedRecipient);
        if (!targetSockets || targetSockets.size === 0) {
          ack({ ok: false, error: `User ${normalizedRecipient} is not online.` });
          return;
        }

        const dmPayload = {
          room: currentUser.room,
          sender: currentUser.username,
          recipient: normalizedRecipient,
          body: normalizedBody,
          signature: normalizedSignature,
          private: true,
          createdAt: Number(createdAt) || Date.now()
        };

        for (const targetSocket of targetSockets) {
          io.to(targetSocket).emit("direct_message", dmPayload);
        }

        ack({ ok: true });
      } catch {
        ack({ ok: false, error: "Unable to send direct message." });
      }
    });

    socket.on("sender_key", ({ recipient, body, signature, createdAt }, ack = () => {}) => {
      try {
        const currentUser = usersBySocket.get(socket.id);
        if (!currentUser) {
          ack({ ok: false, error: "Join a room before key exchange." });
          return;
        }

        const normalizedRecipient = normalizeName(recipient);
        const normalizedBody = normalizeMessage(body);
        const normalizedSignature = normalizeSignature(signature);
        const normalizedCreatedAt = normalizeTimestamp(createdAt);

        if (!normalizedRecipient || !normalizedBody || !normalizedSignature) {
          ack({ ok: false, error: "Sender key payload is invalid." });
          return;
        }

        const targetSockets = socketsByUsername.get(normalizedRecipient);
        if (!targetSockets || targetSockets.size === 0) {
          ack({ ok: false, error: `User ${normalizedRecipient} is not online.` });
          return;
        }

        const payload = {
          sender: currentUser.username,
          recipient: normalizedRecipient,
          body: normalizedBody,
          signature: normalizedSignature,
          createdAt: normalizedCreatedAt
        };

        for (const targetSocket of targetSockets) {
          io.to(targetSocket).emit("sender_key", payload);
        }

        ack({ ok: true });
      } catch {
        ack({ ok: false, error: "Unable to relay sender key." });
      }
    });

    socket.on("request_sender_keys", ({ requester }, ack = () => {}) => {
      try {
        const currentUser = usersBySocket.get(socket.id);
        if (!currentUser) {
          ack({ ok: false, error: "Join a room before requesting keys." });
          return;
        }

        const normalizedRequester = normalizeName(requester || currentUser.username);
        io.to(currentUser.room).emit("request_sender_keys", {
          requester: normalizedRequester
        });

        ack({ ok: true });
      } catch {
        ack({ ok: false, error: "Unable to request sender keys." });
      }
    });

    socket.on("rtc_signal", ({ recipient, signal }, ack = () => {}) => {
      try {
        const currentUser = usersBySocket.get(socket.id);
        if (!currentUser) {
          ack({ ok: false, error: "Join a room before signaling peers." });
          return;
        }

        const normalizedRecipient = normalizeName(recipient);
        if (!normalizedRecipient || !signal || typeof signal !== "object") {
          ack({ ok: false, error: "Signal payload is invalid." });
          return;
        }

        const targetSockets = socketsByUsername.get(normalizedRecipient);
        if (!targetSockets || targetSockets.size === 0) {
          ack({ ok: false, error: `User ${normalizedRecipient} is not online.` });
          return;
        }

        for (const targetSocket of targetSockets) {
          const targetUser = usersBySocket.get(targetSocket);
          if (!targetUser || targetUser.room !== currentUser.room) {
            continue;
          }

          io.to(targetSocket).emit("rtc_signal", {
            sender: currentUser.username,
            signal
          });
        }

        ack({ ok: true });
      } catch {
        ack({ ok: false, error: "Unable to relay rtc signal." });
      }
    });

    socket.on("disconnect", () => {
      const currentUser = usersBySocket.get(socket.id);
      if (!currentUser) {
        return;
      }

      usersBySocket.delete(socket.id);
      removeUsernameSocket(currentUser.username, socket.id);

      currentUser.keyBundle = null;

      io.to(currentUser.room).emit("system_message", {
        body: `${currentUser.username} left #${currentUser.room}`,
        createdAt: Date.now()
      });

      emitRoomState(currentUser.room);
    });
  });
}

async function createTransportServer() {
  const keyPath = process.env.TLS_KEY_PATH || path.join(__dirname, "certs", "server.key");
  const certPath = process.env.TLS_CERT_PATH || path.join(__dirname, "certs", "server.crt");

  try {
    await Promise.all([fs.access(keyPath), fs.access(certPath)]);
    const [key, cert] = await Promise.all([
      fs.readFile(keyPath),
      fs.readFile(certPath)
    ]);

    return {
      server: https.createServer({ key, cert }, app),
      protocol: "https"
    };
  } catch {
    return {
      server: http.createServer(app),
      protocol: "http"
    };
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

async function start() {
  const { server, protocol } = await createTransportServer();
  io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || false
    }
  });

  registerSocketHandlers();

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`BitChat replica running at ${protocol}://${HOST}:${PORT}`);
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to initialize secure server:", error);
  process.exitCode = 1;
});
