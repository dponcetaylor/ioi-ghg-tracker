const crypto = require("crypto");
const { db } = require("./db");

const SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hashHex, "hex"));
}

function ensureAdmin() {
  const n = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const pw = process.env.ADMIN_PASSWORD;
  if (n === 0) {
    if (!pw) { console.warn("No users exist. Set ADMIN_PASSWORD to create the first admin ('admin')."); return; }
    db.prepare("INSERT INTO users(username,display_name,role,pw_hash,created_at) VALUES('admin','Administrator','admin',?,?)")
      .run(hashPassword(pw), new Date().toISOString());
    console.log("Created admin user 'admin'.");
  }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const i = c.indexOf("="); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

const attempts = new Map(); // simple brute-force guard: 8 tries / 10 min per IP+username
function tooMany(key) {
  const now = Date.now(), a = (attempts.get(key) || []).filter((t) => now - t < 600000);
  attempts.set(key, a); return a.length >= 8;
}

function login(req, res) {
  const { username = "", password = "" } = req.body || {};
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (tooMany(key)) return res.status(429).json({ error: "Too many attempts. Try again in 10 minutes." });
  const u = db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(username.trim());
  if (!u || !u.active || !verifyPassword(password, u.pw_hash)) {
    attempts.get(key).push(Date.now());
    return res.status(401).json({ error: "Wrong username or password." });
  }
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(token, u.id, Date.now() + SESSION_MS);
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${req.secure ? "; Secure" : ""}`);
  audit(u.username, "login");
  res.json({ ok: true });
}

function logout(req, res) {
  const t = parseCookies(req).sid;
  if (t) db.prepare("DELETE FROM sessions WHERE token=?").run(t);
  res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
}

function currentUser(req) {
  const t = parseCookies(req).sid; if (!t) return null;
  const row = db.prepare(`SELECT u.id,u.username,u.display_name,u.role,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(t);
  if (!row || !row.active || row.expires_at < Date.now()) return null;
  return row;
}

function audit(username, action, detail) {
  db.prepare("INSERT INTO audit(at,username,action,detail) VALUES(?,?,?,?)")
    .run(new Date().toISOString(), username, action, detail ? String(detail).slice(0, 500) : null);
}

module.exports = { hashPassword, ensureAdmin, login, logout, currentUser, audit };
