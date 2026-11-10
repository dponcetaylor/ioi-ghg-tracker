const { DatabaseSync } = require("node:sqlite"); // built into Node 22.13+ (no native build needed)
const fs = require("fs");
const path = require("path");

// DATA_DIR should point at the persistent disk in production (e.g. /var/data on Render).
const DIR = process.env.DATA_DIR || path.join(__dirname, "../data");
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, "ioi.db");

const db = new DatabaseSync(FILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  pw_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
);
`);
module.exports = { db, FILE, DIR };
