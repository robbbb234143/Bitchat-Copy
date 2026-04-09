const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "chat.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    signature TEXT,
    private INTEGER NOT NULL DEFAULT 0,
    recipient TEXT,
    created_at INTEGER NOT NULL
  )
`);

const hasSignatureColumn = db
  .prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'signature'")
  .get();

if (!hasSignatureColumn) {
  db.exec("ALTER TABLE messages ADD COLUMN signature TEXT");
}

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (room, sender, body, signature, private, recipient, created_at)
  VALUES (@room, @sender, @body, @signature, @private, @recipient, @created_at)
`);

const recentMessagesStmt = db.prepare(`
  SELECT id, room, sender, body, signature, private, recipient, created_at
  FROM messages
  WHERE room = ? AND private = 0
  ORDER BY created_at DESC
  LIMIT ?
`);

function saveMessage({ room, sender, body, signature = null, privateMessage = false, recipient = null, createdAt = Date.now() }) {
  const payload = {
    room,
    sender,
    body,
    signature,
    private: privateMessage ? 1 : 0,
    recipient,
    created_at: Number(createdAt) || Date.now()
  };

  const result = insertMessageStmt.run(payload);

  return {
    id: result.lastInsertRowid,
    room: payload.room,
    sender: payload.sender,
    body: payload.body,
    signature: payload.signature,
    private: Boolean(payload.private),
    recipient: payload.recipient,
    createdAt: payload.created_at
  };
}

function getRecentMessages(room, limit = 50) {
  return recentMessagesStmt
    .all(room, limit)
    .map((row) => ({
      id: row.id,
      room: row.room,
      sender: row.sender,
      body: row.body,
      signature: row.signature,
      private: Boolean(row.private),
      recipient: row.recipient,
      createdAt: row.created_at
    }))
    .reverse();
}

module.exports = {
  db,
  saveMessage,
  getRecentMessages
};
