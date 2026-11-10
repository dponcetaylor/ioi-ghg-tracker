const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { db } = require("./db");

const SEED = path.join(__dirname, "../data/store.json");
const als = new AsyncLocalStorage(); // holds the logged-in user for the current request

const getStmt = db.prepare("SELECT value FROM kv WHERE key='main'");
const putStmt = db.prepare("INSERT INTO kv(key,value) VALUES('main',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");

if (!getStmt.get()) putStmt.run(fs.readFileSync(SEED, "utf8")); // first run: sample data

function read() { return JSON.parse(getStmt.get().value); }

// Every record without an author gets stamped with whoever is logged in ("system" for auto-generated).
function write(data) {
  const user = als.getStore() || "system";
  for (const v of Object.values(data)) {
    if (Array.isArray(v)) for (const r of v) {
      if (r && typeof r === "object" && r.enteredAt && !r.enteredBy) r.enteredBy = r.isAutoAssumed ? "system (auto)" : user;
    }
  }
  putStmt.run(JSON.stringify(data));
}

function nextId(list, prefix) { return `${prefix}${list.length + 1}_${Date.now().toString(36)}`; }
function runAs(username, fn) { return als.run(username, fn); }

module.exports = { read, write, nextId, runAs };
