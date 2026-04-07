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
  li.className = `message-item${message.private ? " message-private" : ""}`;

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
  users.forEach((username) => {
    const li = document.createElement("li");
    li.textContent = username;
    usersList.appendChild(li);
  });
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const username = usernameInput.value.trim();
  const room = roomInput.value.trim() || "lobby";

  if (!username) {
    joinError.textContent = "Enter a username.";
    return;
  }

  socket.emit("join", { username, room }, (result) => {
    if (!result?.ok) {
      joinError.textContent = result?.error || "Unable to join.";
      return;
    }

    activeUser = result.username;
    activeRoom = result.room;

    roomTitle.textContent = `#${activeRoom}`;
    identityText.textContent = `Signed in as ${activeUser}`;
    joinError.textContent = "";
    joinPanel.classList.add("hidden");
    chatPanel.classList.remove("hidden");
    messageInput.focus();
  });
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const body = messageInput.value.trim();
  if (!body) {
    return;
  }

  socket.emit("chat_message", { body }, (result) => {
    if (!result?.ok) {
      appendSystemMessage(result?.error || "Message failed to send.");
      return;
    }

    messageInput.value = "";
    messageInput.focus();
  });
});

socket.on("message_history", (history) => {
  messagesList.innerHTML = "";
  if (!Array.isArray(history) || history.length === 0) {
    appendSystemMessage(`No recent messages in #${activeRoom}.`);
    return;
  }

  history.forEach(appendChatMessage);
});

socket.on("chat_message", appendChatMessage);

socket.on("system_message", (systemMessage) => {
  appendSystemMessage(systemMessage.body, systemMessage.createdAt);
});

socket.on("room_state", ({ room, users }) => {
  if (room !== activeRoom) {
    return;
  }

  setRoomUsers(users || []);
});
