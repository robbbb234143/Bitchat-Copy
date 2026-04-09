const joinPanel = document.getElementById("joinPanel");
const chatPanel = document.getElementById("chatPanel");
const joinForm = document.getElementById("joinForm");
const joinError = document.getElementById("joinError");
const usernameInput = document.getElementById("usernameInput");
const roomInput = document.getElementById("roomInput");

const roomTitle = document.getElementById("roomTitle");
const identityText = document.getElementById("identityText");
const usersList = document.getElementById("usersList");
const messagesList = document.getElementById("messagesList");

const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");

const socket = io();
let activeRoom = "lobby";
let activeUser = "";
let identity = null;
let ownKeyBundle = null;
let peerBundlesReady = false;
let pendingHistory = [];
const peersByUsername = new Map();
const senderKeysByUsername = new Map();

const rtcPeers = new Map();
const pendingIceCandidatesByPeer = new Map();
const seenPacketIds = new Set();
const maxSeenPackets = 4000;
const meshTtl = 7;

const trustStorageKey = "bitchat.trusted-fingerprints.v1";

function loadTrustedFingerprints() {
  try {
    return JSON.parse(localStorage.getItem(trustStorageKey) || "{}");
  } catch {
    return {};
  }
}

function saveTrustedFingerprints(value) {
  localStorage.setItem(trustStorageKey, JSON.stringify(value));
}

function getPeer(username) {
  return peersByUsername.get(username) || null;
}

function verifyAndStoreTrust(username, fingerprint) {
  const trusted = loadTrustedFingerprints();
  const existing = trusted[username];

  if (!existing) {
    trusted[username] = fingerprint;
    saveTrustedFingerprints(trusted);
    return { trusted: true, firstSeen: true };
  }

  if (existing !== fingerprint) {
    return { trusted: false, changed: true };
  }

  return { trusted: true, firstSeen: false };
}

function closeMeshPeer(username) {
  const entry = rtcPeers.get(username);
  if (!entry) {
    return;
  }

  try {
    if (entry.channel) {
      entry.channel.close();
    }
  } catch {
    // no-op
  }

  try {
    entry.pc.close();
  } catch {
    // no-op
  }

  pendingIceCandidatesByPeer.delete(username);
  rtcPeers.delete(username);
}

function clearState() {
  peersByUsername.clear();
  senderKeysByUsername.clear();
  ownKeyBundle = null;
  peerBundlesReady = false;
  pendingHistory = [];
  seenPacketIds.clear();

  for (const username of rtcPeers.keys()) {
    closeMeshPeer(username);
  }
}

function escapeHtml(unsafeText) {
  return unsafeText
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function appendSystemMessage(body, createdAt = Date.now()) {
  const li = document.createElement("li");
  li.className = "message-system";
  li.textContent = `${body} (${formatTime(createdAt)})`;
  messagesList.appendChild(li);
  messagesList.scrollTop = messagesList.scrollHeight;
}

function appendChatMessage(message) {
  const li = document.createElement("li");
  const ownershipClass = message.sender === activeUser ? " message-own" : " message-received";
  li.className = `message-item${ownershipClass}${message.private ? " message-private" : ""}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  if (message.private) {
    meta.textContent = `${message.sender} -> ${message.recipient} (private) at ${formatTime(message.createdAt)}`;
  } else {
    meta.textContent = `${message.sender} at ${formatTime(message.createdAt)}`;
  }

  const body = document.createElement("div");
  body.innerHTML = escapeHtml(message.body);

  li.appendChild(meta);
  li.appendChild(body);
  messagesList.appendChild(li);
  messagesList.scrollTop = messagesList.scrollHeight;
}

function setRoomUsers(users) {
  usersList.innerHTML = "";
  users.forEach((user) => {
    const li = document.createElement("li");
    const username = typeof user === "string" ? user : user.username;
    const peer = getPeer(username);
    li.textContent = peer && peer.trusted === false ? `${username} (unverified)` : username;
    usersList.appendChild(li);
  });
}

function getUsernameFromMention(commandBody) {
  const parts = commandBody.split(" ");
  return parts[1] ? parts[1].trim() : "";
}

function isCiphertext(value) {
  try {
    return JSON.parse(value)?.v === 1;
  } catch {
    return false;
  }
}

function generatePacketId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function markPacketSeen(packetId) {
  seenPacketIds.add(packetId);
  if (seenPacketIds.size > maxSeenPackets) {
    const first = seenPacketIds.values().next();
    if (!first.done) {
      seenPacketIds.delete(first.value);
    }
  }
}

function getOpenMeshPeerCount() {
  let open = 0;
  for (const entry of rtcPeers.values()) {
    if (entry.channel?.readyState === "open") {
      open += 1;
    }
  }

  return open;
}

function sendRtcSignal(recipient, signal) {
  socket.emit("rtc_signal", { recipient, signal }, () => {});
}

function shouldInitiateConnection(peerUsername) {
  return activeUser.localeCompare(peerUsername) < 0;
}

function setupDataChannel(peerUsername, channel) {
  const entry = rtcPeers.get(peerUsername);
  if (!entry) {
    return;
  }

  entry.channel = channel;
  channel.onopen = () => {
    appendSystemMessage(`Mesh link active with ${peerUsername}.`);
  };
  channel.onclose = () => {
    appendSystemMessage(`Mesh link closed with ${peerUsername}.`);
  };
  channel.onerror = () => {
    appendSystemMessage(`Mesh channel error with ${peerUsername}.`);
  };
  channel.onmessage = (event) => {
    try {
      const packet = JSON.parse(String(event.data || ""));
      handleMeshPacket(packet, peerUsername).catch(() => {
        appendSystemMessage("Failed to process incoming mesh packet.");
      });
    } catch {
      appendSystemMessage("Received malformed mesh packet.");
    }
  };
}

function getOrCreateRtcPeer(peerUsername) {
  const existing = rtcPeers.get(peerUsername);
  if (existing) {
    return existing;
  }

  const pc = new RTCPeerConnection({ iceServers: [] });
  const entry = { pc, channel: null };
  rtcPeers.set(peerUsername, entry);

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    sendRtcSignal(peerUsername, {
      type: "ice",
      candidate: event.candidate
    });
  };

  pc.ondatachannel = (event) => {
    setupDataChannel(peerUsername, event.channel);
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      closeMeshPeer(peerUsername);
    }
  };

  return entry;
}

async function flushPendingIce(peerUsername) {
  const queued = pendingIceCandidatesByPeer.get(peerUsername) || [];
  if (queued.length === 0) {
    return;
  }

  const entry = rtcPeers.get(peerUsername);
  if (!entry) {
    return;
  }

  for (const candidate of queued) {
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // Ignore stale candidate errors.
    }
  }

  pendingIceCandidatesByPeer.delete(peerUsername);
}

async function createMeshOffer(peerUsername) {
  const entry = getOrCreateRtcPeer(peerUsername);
  if (!entry.channel) {
    const channel = entry.pc.createDataChannel("mesh");
    setupDataChannel(peerUsername, channel);
  }

  const offer = await entry.pc.createOffer();
  await entry.pc.setLocalDescription(offer);
  sendRtcSignal(peerUsername, {
    type: "offer",
    sdp: entry.pc.localDescription
  });
}

async function handleRtcSignal(sender, signal) {
  if (!sender || !signal || typeof signal !== "object") {
    return;
  }

  const entry = getOrCreateRtcPeer(sender);

  if (signal.type === "offer" && signal.sdp) {
    await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    await flushPendingIce(sender);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    sendRtcSignal(sender, {
      type: "answer",
      sdp: entry.pc.localDescription
    });
    return;
  }

  if (signal.type === "answer" && signal.sdp) {
    await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    await flushPendingIce(sender);
    return;
  }

  if (signal.type === "ice" && signal.candidate) {
    if (!entry.pc.remoteDescription) {
      const queued = pendingIceCandidatesByPeer.get(sender) || [];
      queued.push(signal.candidate);
      pendingIceCandidatesByPeer.set(sender, queued);
      return;
    }

    await entry.pc.addIceCandidate(signal.candidate);
  }
}

async function ensureMeshPeers(users) {
  const targets = new Set(
    users
      .map((user) => (typeof user === "string" ? user : user.username))
      .filter((username) => username && username !== activeUser)
  );

  for (const username of rtcPeers.keys()) {
    if (!targets.has(username)) {
      closeMeshPeer(username);
    }
  }

  for (const username of targets) {
    getOrCreateRtcPeer(username);
    if (shouldInitiateConnection(username)) {
      const entry = rtcPeers.get(username);
      if (entry?.pc.signalingState === "stable") {
        try {
          await createMeshOffer(username);
        } catch {
          // Ignore and allow future room updates to retry.
        }
      }
    }
  }
}

function sendPacketToMesh(packet, exceptUsername = "") {
  const encoded = JSON.stringify(packet);

  for (const [username, entry] of rtcPeers.entries()) {
    if (username === exceptUsername) {
      continue;
    }

    if (entry.channel?.readyState !== "open") {
      continue;
    }

    try {
      entry.channel.send(encoded);
    } catch {
      // Ignore transient send failures.
    }
  }
}

function emitMeshPacket(kind, destination, payload, ttl = meshTtl) {
  if (!activeUser || getOpenMeshPeerCount() === 0) {
    return false;
  }

  const packet = {
    id: generatePacketId(),
    kind,
    source: activeUser,
    destination,
    room: activeRoom,
    createdAt: Date.now(),
    ttl,
    payload
  };

  markPacketSeen(packet.id);
  sendPacketToMesh(packet);
  return true;
}

function shouldForwardPacket(packet) {
  if (packet.ttl <= 1) {
    return false;
  }

  if (packet.destination === "*") {
    return true;
  }

  return packet.destination !== activeUser;
}

async function verifyGroupMessage(message) {
  const peer = getPeer(message.sender);
  if (!message.signature) {
    return null;
  }

  if (!peer || !peer.bundle?.signingPublicKeyJwk) {
    return null;
  }

  const payload = {
    kind: "room",
    room: message.room,
    body: message.body,
    createdAt: message.createdAt
  };

  return window.ChatCrypto.verifyPayload(peer.bundle.signingPublicKeyJwk, payload, message.signature);
}

async function appendDecryptedMessage(message) {
  let body = message.body;

  if (message.sender !== activeUser) {
    const signatureOk = await verifyGroupMessage(message);
    if (signatureOk === false) {
      body = "[Signature verification failed]";
    } else if (signatureOk === null && isCiphertext(body)) {
      body = "[Waiting for trusted identity/signature]";
    } else {
      const senderKey = senderKeysByUsername.get(message.sender);
      if (!senderKey) {
        body = "[Encrypted message: waiting for sender key]";
      } else {
        try {
          body = await window.ChatCrypto.decryptWithSenderKey(senderKey, body);
        } catch {
          body = "[Encrypted message could not be decrypted]";
        }
      }
    }
  } else if (isCiphertext(body)) {
    const ownSenderKey = senderKeysByUsername.get(activeUser);
    if (ownSenderKey) {
      try {
        body = await window.ChatCrypto.decryptWithSenderKey(ownSenderKey, body);
      } catch {
        body = "[Encrypted message could not be decrypted]";
      }
    }
  }

  appendChatMessage({
    ...message,
    body
  });
}

async function appendDirectMessage(message) {
  let body = message.body;
  const peer = getPeer(message.sender);

  if (!peer || !peer.bundle?.ecdhPublicKeyJwk || !peer.bundle?.signingPublicKeyJwk) {
    body = "[Direct message could not be verified]";
  } else if (message.recipient === activeUser && identity) {
    try {
      const payload = {
        kind: "dm",
        room: message.room,
        to: message.recipient,
        body: message.body,
        createdAt: message.createdAt
      };

      const verified = await window.ChatCrypto.verifyPayload(
        peer.bundle.signingPublicKeyJwk,
        payload,
        message.signature
      );

      if (!verified) {
        body = "[Direct message signature check failed]";
      } else {
        body = await window.ChatCrypto.decryptFromPeer(identity, peer.bundle.ecdhPublicKeyJwk, message.body);
      }
    } catch {
      body = "[Unable to decrypt direct message]";
    }
  }

  appendChatMessage({
    ...message,
    body
  });
}

async function acceptPeerBundle(username, keyBundle) {
  if (!username || username === activeUser || !keyBundle) {
    return;
  }

  const verified = await window.ChatCrypto.verifySignedBundle(keyBundle);
  if (!verified.ok) {
    appendSystemMessage(`Rejected key bundle for ${username}: ${verified.reason}`);
    return;
  }

  const trust = verifyAndStoreTrust(username, verified.fingerprint);
  if (trust.changed) {
    appendSystemMessage(`Warning: key fingerprint changed for ${username}. Marking as unverified.`);
  }

  peersByUsername.set(username, {
    username,
    bundle: keyBundle,
    trusted: trust.trusted
  });
}

async function handleSenderKeyPayload(payload) {
  if (!identity || payload.recipient !== activeUser) {
    return;
  }

  const peer = getPeer(payload.sender);
  if (!peer || peer.trusted === false) {
    return;
  }

  const verifyPayload = {
    kind: "sender-key",
    room: activeRoom,
    to: payload.recipient,
    body: payload.body,
    createdAt: payload.createdAt
  };

  const verified = await window.ChatCrypto.verifyPayload(
    peer.bundle.signingPublicKeyJwk,
    verifyPayload,
    payload.signature
  );

  if (!verified) {
    appendSystemMessage(`Rejected sender key from ${payload.sender}: signature failed.`);
    return;
  }

  const senderKey = await window.ChatCrypto.decryptFromPeer(
    identity,
    peer.bundle.ecdhPublicKeyJwk,
    payload.body
  );

  senderKeysByUsername.set(payload.sender, senderKey);
}

async function handleMeshPacket(packet, fromPeer) {
  if (!packet || typeof packet !== "object") {
    return;
  }

  if (typeof packet.id !== "string" || !packet.id || seenPacketIds.has(packet.id)) {
    return;
  }

  if (packet.room !== activeRoom) {
    return;
  }

  markPacketSeen(packet.id);

  if (packet.kind === "room-message" && packet.destination === "*" && packet.payload) {
    await appendDecryptedMessage(packet.payload);
  }

  if (packet.kind === "direct-message" && packet.payload?.recipient === activeUser) {
    await appendDirectMessage(packet.payload);
  }

  if (packet.kind === "sender-key" && packet.payload?.recipient === activeUser) {
    await handleSenderKeyPayload(packet.payload);
  }

  if (packet.kind === "request-sender-keys") {
    const requester = packet.payload?.requester;
    if (requester && requester !== activeUser) {
      await shareSenderKeyWith(requester);
    }
  }

  if (shouldForwardPacket(packet)) {
    sendPacketToMesh({ ...packet, ttl: packet.ttl - 1 }, fromPeer);
  }
}

async function shareSenderKeyWith(username) {
  if (!identity || !activeUser || username === activeUser) {
    return;
  }

  const peer = getPeer(username);
  if (!peer || peer.trusted === false) {
    return;
  }

  const ownSenderKey = senderKeysByUsername.get(activeUser);
  if (!ownSenderKey) {
    return;
  }

  const wrappedKey = await window.ChatCrypto.encryptForPeer(
    identity,
    peer.bundle.ecdhPublicKeyJwk,
    ownSenderKey
  );
  const createdAt = Date.now();
  const signPayload = {
    kind: "sender-key",
    room: activeRoom,
    to: username,
    body: wrappedKey,
    createdAt
  };
  const signature = await window.ChatCrypto.signPayload(identity, signPayload);
  const senderKeyPayload = {
    sender: activeUser,
    recipient: username,
    body: wrappedKey,
    createdAt,
    signature
  };

  const meshSent = emitMeshPacket("sender-key", username, senderKeyPayload);
  if (!meshSent) {
    socket.emit("sender_key", {
      recipient: username,
      body: wrappedKey,
      createdAt,
      signature
    });
  }
}

async function shareSenderKeyWithAll() {
  const users = [...peersByUsername.keys()];
  for (const username of users) {
    await shareSenderKeyWith(username);
  }
}

function requestSenderKeys() {
  const meshSent = emitMeshPacket("request-sender-keys", "*", {
    requester: activeUser
  });

  if (!meshSent) {
    socket.emit("request_sender_keys", { requester: activeUser });
  }
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const username = usernameInput.value.trim();
  const room = roomInput.value.trim() || "lobby";

  if (!username) {
    joinError.textContent = "Enter a username.";
    return;
  }

  window.ChatCrypto.getOrCreateIdentity().then(async (loadedIdentity) => {
    identity = loadedIdentity;
    ownKeyBundle = await window.ChatCrypto.buildSignedBundle(identity, username);

    socket.emit("join", { username, room, keyBundle: ownKeyBundle }, (result) => {
      if (!result?.ok) {
        clearState();
        joinError.textContent = result?.error || "Unable to join.";
        return;
      }

      activeUser = result.username;
      activeRoom = result.room;
      peerBundlesReady = false;
      pendingHistory = [];

      peersByUsername.clear();
      senderKeysByUsername.clear();
      senderKeysByUsername.set(activeUser, window.ChatCrypto.generateSenderKey());

      Promise.all((result.users || []).map((user) => acceptPeerBundle(user.username, user.keyBundle))).then(() => {
        peerBundlesReady = true;
        setRoomUsers(result.users || []);
        ensureMeshPeers(result.users || []).then(() => {
          shareSenderKeyWithAll();
          requestSenderKeys();
        });

        if (pendingHistory.length > 0) {
          const historyToRender = pendingHistory;
          pendingHistory = [];
          (async () => {
            for (const message of historyToRender) {
              await appendDecryptedMessage(message);
            }
          })().catch(() => {
            appendSystemMessage("Unable to decrypt room history.");
          });
        }
      });

      roomTitle.textContent = `#${activeRoom}`;
      identityText.textContent = `Signed in as ${activeUser} | fingerprint ${identity.fingerprint}`;
      joinError.textContent = "";
      joinPanel.classList.add("hidden");
      chatPanel.classList.remove("hidden");
      messageInput.focus();
      appendSystemMessage("Mesh mode enabled: chat messages prefer peer-to-peer routing.");
    });
  }).catch(() => {
    clearState();
    joinError.textContent = "Unable to prepare encryption keys.";
  });
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const body = messageInput.value.trim();
  if (!body) {
    return;
  }

  (async () => {
    if (body.startsWith("/dm ")) {
      const recipient = getUsernameFromMention(body);
      const directText = body.split(" ").slice(2).join(" ").trim();

      if (!recipient || !directText) {
        appendSystemMessage("Usage: /dm <username> <message>");
        return;
      }

      const peer = getPeer(recipient);
      if (!peer || peer.trusted === false) {
        appendSystemMessage(`No trusted key material available for ${recipient}.`);
        return;
      }

      const encryptedBody = await window.ChatCrypto.encryptForPeer(
        identity,
        peer.bundle.ecdhPublicKeyJwk,
        directText
      );
      const createdAt = Date.now();
      const payload = {
        kind: "dm",
        room: activeRoom,
        to: recipient,
        body: encryptedBody,
        createdAt
      };
      const signature = await window.ChatCrypto.signPayload(identity, payload);
      const dmMessage = {
        room: activeRoom,
        sender: activeUser,
        recipient,
        body: encryptedBody,
        signature,
        private: true,
        createdAt
      };

      const meshSent = emitMeshPacket("direct-message", recipient, dmMessage);
      if (meshSent) {
        appendChatMessage({
          room: activeRoom,
          sender: activeUser,
          recipient,
          body: directText,
          private: true,
          createdAt
        });
        messageInput.value = "";
        messageInput.focus();
        return;
      }

      socket.emit("direct_message", {
        recipient,
        body: encryptedBody,
        createdAt,
        signature
      }, (result) => {
        if (!result?.ok) {
          appendSystemMessage(result?.error || "Direct message failed to send.");
          return;
        }

        appendChatMessage({
          room: activeRoom,
          sender: activeUser,
          recipient,
          body: directText,
          private: true,
          createdAt: Date.now()
        });

        messageInput.value = "";
        messageInput.focus();
      });

      return;
    }

    const senderKey = senderKeysByUsername.get(activeUser);
    if (!senderKey) {
      appendSystemMessage("Missing sender key for this session.");
      return;
    }

    const encryptedBody = await window.ChatCrypto.encryptWithSenderKey(senderKey, body);
    const createdAt = Date.now();
    const payload = {
      kind: "room",
      room: activeRoom,
      body: encryptedBody,
      createdAt
    };
    const signature = await window.ChatCrypto.signPayload(identity, payload);
    const roomMessage = {
      room: activeRoom,
      sender: activeUser,
      body: encryptedBody,
      signature,
      createdAt
    };

    const meshSent = emitMeshPacket("room-message", "*", roomMessage);
    if (meshSent) {
      await appendDecryptedMessage(roomMessage);
      messageInput.value = "";
      messageInput.focus();
      return;
    }

    socket.emit("chat_message", { body: encryptedBody, createdAt, signature }, (result) => {
      if (!result?.ok) {
        appendSystemMessage(result?.error || "Message failed to send.");
        return;
      }

      messageInput.value = "";
      messageInput.focus();
    });
  })().catch(() => {
    appendSystemMessage("Encryption failed before sending.");
  });
});

socket.on("message_history", (history) => {
  messagesList.innerHTML = "";
  if (!Array.isArray(history) || history.length === 0) {
    appendSystemMessage(`No recent messages in #${activeRoom}.`);
    return;
  }

  if (!peerBundlesReady) {
    pendingHistory = history;
    return;
  }

  (async () => {
    for (const message of history) {
      await appendDecryptedMessage(message);
    }
  })().catch(() => {
    appendSystemMessage("Unable to decrypt room history.");
  });
});

// Socket transport remains as fallback when mesh links are unavailable.
socket.on("chat_message", (message) => {
  appendDecryptedMessage(message).catch(() => {
    appendSystemMessage("Unable to decrypt incoming room message.");
  });
});

socket.on("direct_message", (message) => {
  appendDirectMessage(message).catch(() => {
    appendSystemMessage("Unable to decrypt incoming direct message.");
  });
});

socket.on("sender_key", (payload) => {
  handleSenderKeyPayload(payload).catch(() => {
    appendSystemMessage("Unable to import sender key.");
  });
});

socket.on("request_sender_keys", ({ requester }) => {
  if (!requester || requester === activeUser) {
    return;
  }

  shareSenderKeyWith(requester).catch(() => {
    appendSystemMessage(`Failed to share sender key with ${requester}.`);
  });
});

socket.on("rtc_signal", ({ sender, signal }) => {
  handleRtcSignal(sender, signal).catch(() => {
    appendSystemMessage(`Unable to process RTC signal from ${sender}.`);
  });
});

socket.on("system_message", (systemMessage) => {
  appendSystemMessage(systemMessage.body, systemMessage.createdAt);
});

socket.on("room_state", ({ room, users }) => {
  if (room !== activeRoom) {
    return;
  }

  const normalizedUsers = Array.isArray(users) ? users : [];
  Promise.all(
    normalizedUsers.map((user) => {
      if (typeof user === "string") {
        return Promise.resolve();
      }

      return acceptPeerBundle(user.username, user.keyBundle);
    })
  ).then(() => {
    setRoomUsers(normalizedUsers);
    ensureMeshPeers(normalizedUsers).then(() => {
      shareSenderKeyWithAll();
    });
  }).catch(() => {
    appendSystemMessage("Failed to process updated room keys.");
  });
});
