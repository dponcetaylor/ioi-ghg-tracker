const express = require("express");
const path = require("path");
const calc = require("./lib/calc");
const store = require("./lib/store");
const auth = require("./lib/auth");
const { db } = require("./lib/db");
const embark = require("./lib/embark");
const HISTORICAL = require("./data/historical.json"); // finalized 2024/2025 figures from the published reports + workbooks
const {
  UTILITIES, WASTE, MITIGATION, ACCOMMODATION, STAFF_TRAVEL_REASONS, BASELINE_2025, MEALS_KG_PER_MEAL,
  OFFSET_USD_PER_TON, VOLUNTARY_CONTRIBUTION_USD_PER_WEEK,
} = require("./data/factors");

const app = express();
app.set("trust proxy", 1); // behind Render's proxy
app.use(express.json({ limit: "50mb" }));
auth.ensureAdmin();

// ---- authentication: everything except the login page requires a session ----
const PUBLIC = new Set(["/login.html", "/style.css", "/api/login"]);
app.post("/api/login", auth.login);
app.use((req, res, next) => {
  if (PUBLIC.has(req.path)) return next();
  const user = auth.currentUser(req);
  if (!user) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Please log in." });
    return res.redirect("/login.html");
  }
  req.user = user;
  store.runAs(user.display_name, () => {
    if (req.method !== "GET") {
      res.on("finish", () => {
        if (res.statusCode < 400) auth.audit(user.display_name, `${req.method} ${req.path}`, JSON.stringify(req.body || {}));
      });
    }
    next();
  });
});
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/logout", auth.logout);
app.get("/api/me", (req, res) => res.json({ username: req.user.username, name: req.user.display_name, role: req.user.role }));

// ---- admin only: users, activity log, backup ----
function adminOnly(req, res, next) { return req.user.role === "admin" ? next() : res.status(403).json({ error: "Admins only." }); }
app.get("/api/admin/users", adminOnly, (req, res) =>
  res.json(db.prepare("SELECT id,username,display_name,role,active,created_at FROM users ORDER BY id").all()));
app.post("/api/admin/users", adminOnly, (req, res) => {
  const { username, displayName, password, role } = req.body || {};
  if (!username || !displayName || !password || password.length < 8) return res.status(400).json({ error: "Username, name and a password of 8+ characters are required." });
  try {
    db.prepare("INSERT INTO users(username,display_name,role,pw_hash,created_at) VALUES(?,?,?,?,?)")
      .run(username.trim().toLowerCase(), displayName.trim(), role === "admin" ? "admin" : "staff", auth.hashPassword(password), new Date().toISOString());
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: "That username already exists." }); }
});
app.patch("/api/admin/users/:id", adminOnly, (req, res) => {
  const id = Number(req.params.id), { password, active } = req.body || {};
  if (password !== undefined) {
    if (password.length < 8) return res.status(400).json({ error: "Password must be 8+ characters." });
    db.prepare("UPDATE users SET pw_hash=? WHERE id=?").run(auth.hashPassword(password), id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  }
  if (active !== undefined) {
    if (id === req.user.id) return res.status(400).json({ error: "You can't deactivate yourself." });
    db.prepare("UPDATE users SET active=? WHERE id=?").run(active ? 1 : 0, id);
    if (!active) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  }
  res.json({ ok: true });
});
app.get("/api/admin/audit", adminOnly, (req, res) =>
  res.json(db.prepare("SELECT at,username,action,detail FROM audit ORDER BY id DESC LIMIT 300").all()));
app.get("/api/admin/backup", adminOnly, (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="ioi-ghg-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), data: readData(), users: db.prepare("SELECT username,display_name,role,active FROM users").all() });
});


// ---- settings / one-time data migration (staff list, agencies, always-homestay groups) ----
const DEFAULT_SETTINGS = {
  homestayGroups: ["Tennessee", "Maryville", "UM", "Susquehanna"],
  agencies: ["IVHQ", "GoEco", "Working Abroad", "Natucate", "Volunteer World", "AEI", "Globalware", "Roots"],
  embark: {},
};
const DEFAULT_STAFF = ["Daniel Ponce-Taylor", "Monique Mancilla", "Johann Besserer", "Sara Luz", "Emilio", "Rafaela", "Fiorella", "Victor"];
function readData() {
  const data = store.read();
  let changed = false;
  if (!data.settings) { data.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); changed = true; }
  if (!data.meta?.staffSeeded) {
    data.staff = DEFAULT_STAFF.map((name, i) => ({ id: `s${i + 1}`, name }));
    data.meta = { ...(data.meta || {}), staffSeeded: true }; changed = true;
  }
  if (changed) store.write(data);
  return data;
}

// ---- years ----
const yr = (d) => { const y = Number(String(d || "").slice(0, 4)); return y >= 2000 && y <= 2100 ? y : null; };
function partYearMap(data) { return new Map(data.participants.map((p) => [p.id, yr(p.arrivalDate)])); }
// A record belongs to its participant's ARRIVAL year; staff trips to their date (else the year entered).
function yearOfRecord(r, pm) {
  if (r.personId && pm.has(r.personId)) return pm.get(r.personId);
  return yr(r.date) || yr(r.enteredAt);
}
function availableYears(data) {
  const set = new Set();
  data.participants.forEach((p) => yr(p.arrivalDate) && set.add(yr(p.arrivalDate)));
  data.groundStaffEntries.forEach((e) => e.year && set.add(Number(e.year)));
  const pm = partYearMap(data);
  [...data.flights, ...data.nights].forEach((r) => { const y = yearOfRecord(r, pm); if (y) set.add(y); });
  Object.keys(HISTORICAL).forEach((y) => set.add(Number(y)));
  return [...set].sort((a, b) => a - b);
}
function defaultYear(years) {
  const cur = new Date().getFullYear();
  return [...years].reverse().find((y) => y <= cur) || years[years.length - 1] || cur;
}
function filterByYear(data, year) {
  const pm = partYearMap(data), inY = (r) => yearOfRecord(r, pm) === year;
  return {
    ...data,
    participants: data.participants.filter((p) => yr(p.arrivalDate) === year),
    flights: data.flights.filter(inY), nights: data.nights.filter(inY),
    localTransportEntries: data.localTransportEntries.filter(inY),
    groundStaffEntries: data.groundStaffEntries.filter((e) => Number(e.year) === year),
  };
}

// ---- accommodation pricing (PER YEAR) ----
// Hotel = fixed factor (5.205 kg/night). Homestay / volunteer house are DERIVED each year:
//   homestay per night        = (volunteer-house electricity + water, that year) / volunteer-house nights (that year)
//   volunteer house per night = (electricity + water + laundry, that year) / volunteer-house nights (that year)
// then multiplied by that year's homestay (or volunteer-house) nights. With no volunteer-house
// data for the year yet, the 2025 baseline per-night values are used.
function accommodationFactors(yd) {
  const isVH = (n) => n.accommodationType === "volunteer_house" && n.personType !== "staff";
  const vhNights = yd.nights.filter(isVH).reduce((a, n) => a + (n.nights || 0), 0);
  const sumU = (sub) => yd.groundStaffEntries.filter((e) => e.category === "utility" && e.subtype === sub).reduce((a, e) => a + (e.emissionsTonsCO2e || 0), 0);
  const elec = sumU("electricity_house"), water = sumU("water_house"), laundry = sumU("electricity_laundry");
  const live = vhNights > 0 && elec + water > 0;
  const B = BASELINE_2025;
  return {
    source: live ? "calculated from that year's entered utilities" : "2025 baseline (no volunteer-house utilities/nights entered for this year yet)",
    vhNights, electricityHouseT: elec, waterHouseT: water, laundryT: laundry,
    homestayTPerNight: live ? (elec + water) / vhNights : (B.waterHouseT + B.electricityHouseT) / B.vhNights,
    volunteerHouseTPerNight: live ? (elec + water + laundry) / vhNights : (B.waterHouseT + B.electricityHouseT + B.laundryT) / B.vhNights,
    hotelTPerNight: ACCOMMODATION.hotel.co2PerNightKg / 1000,
  };
}
function applyPricing(data) {
  const pm = partYearMap(data), cache = {};
  const years = availableYears(data);
  for (const y of years) cache[y] = accommodationFactors(filterByYear(data, y));
  const none = accommodationFactors({ nights: [], groundStaffEntries: [] });
  for (const n of data.nights) {
    const f = cache[yearOfRecord(n, pm)] || none;
    const per = n.accommodationType === "volunteer_house" ? f.volunteerHouseTPerNight : n.accommodationType === "homestay" ? f.homestayTPerNight : f.hotelTPerNight;
    n.emissionsTonsCO2e = calc.round(per * (n.nights || 0));
    n.countedInUtilities = n.accommodationType === "volunteer_house" && n.personType !== "staff";
    n.factorStatus = n.accommodationType === "hotel" ? "verified" : "derived";
  }
  data._accByYear = cache; data._years = years;
  return data;
}

// ---- ensure every participant has their auto-assumed legs (flight + local transport + nights) ----
//
// IMPORTANT: auto-records are only generated ONCE per participant (the first time they appear).
// If their Embark dates change afterward, this does NOT silently regenerate/overwrite — that
// would blow away any manual edits staff made. Instead we stamp the dates the auto-records were
// generated FROM (`_autoGeneratedFor`), and flag a mismatch as `needsReview` so staff can decide
// whether to regenerate. See "how sync should work" in README.md for the reasoning.
function ensureAutoLegs(data) {
  let changed = false;
  for (const p of data.participants) {
    const hasAutoFlights = data.flights.some((f) => f.personId === p.id && f.isAutoAssumed);
    const hasLocalTransport = data.localTransportEntries.some((e) => e.personId === p.id);
    const hasAutoNights = data.nights.some((n) => n.personId === p.id && n.isAutoAssumed);

    if (!hasAutoFlights) {
      const legs = calc.defaultMainlandBaltraLegs(p.mainlandGateway || undefined);
      for (const leg of legs) {
        data.flights.push({
          id: store.nextId(data.flights, "fl"),
          personType: "participant", personId: p.id, personName: p.name, category: p.category,
          ...leg, enteredAt: new Date().toISOString(),
        });
      }
      changed = true;
    }
    if (!hasLocalTransport) {
      const chain = p.localTransportOverride || calc.defaultLocalTransportChain();
      for (const leg of chain) {
        data.localTransportEntries.push({
          id: store.nextId(data.localTransportEntries, "lt"),
          personId: p.id, personName: p.name, category: p.category,
          ...leg, isAutoAssumed: true, enteredAt: new Date().toISOString(),
        });
      }
      changed = true;
    }
    if (!hasAutoNights) {
      const nightsRecords = calc.defaultNightsForParticipant(p, data.settings);
      for (const n of nightsRecords) {
        data.nights.push({
          id: store.nextId(data.nights, "nt"),
          personId: p.id, personName: p.name, category: p.category,
          ...n, isAutoAssumed: true, enteredAt: new Date().toISOString(),
        });
      }
      changed = true;
    }
    // Stamp the dates auto-records were generated from, the first time any of them are created.
    if ((!hasAutoFlights || !hasLocalTransport || !hasAutoNights) && !p._autoGeneratedFor) {
      p._autoGeneratedFor = { arrivalDate: p.arrivalDate, departureDate: p.departureDate };
      changed = true;
    }
  }
  if (changed) store.write(data);
  return data;
}

// Flag participants whose Embark dates have moved since their auto-records were calculated,
// without touching any data — this is informational so staff can choose to regenerate.
function withReviewFlags(data) {
  return {
    ...data,
    participants: data.participants.map((p) => {
      const snap = p._autoGeneratedFor;
      const needsReview = !!snap && (snap.arrivalDate !== p.arrivalDate || snap.departureDate !== p.departureDate);
      return { ...p, needsReview };
    }),
  };
}

function loadData() { return applyPricing(ensureAutoLegs(readData())); }

// ---- reference data ----

app.get("/api/participants", (req, res) => res.json(withReviewFlags(loadData()).participants));

// Regenerate a participant's auto-legs from their CURRENT dates — call this after confirming
// you want to discard any manual edits to their auto-generated flights/nights/local transport.
app.post("/api/participants/:id/regenerate", (req, res) => {
  const data = readData();
  const p = data.participants.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  data.flights = data.flights.filter((f) => !(f.personId === p.id && f.isAutoAssumed));
  data.localTransportEntries = data.localTransportEntries.filter((e) => !(e.personId === p.id && e.isAutoAssumed));
  data.nights = data.nights.filter((n) => !(n.personId === p.id && n.isAutoAssumed));
  delete p._autoGeneratedFor;
  store.write(data);
  ensureAutoLegs(readData());
  res.json({ ok: true });
});

// ---- settings (staff list, agencies, always-homestay groups) ----
app.get("/api/settings", (req, res) => { const d = readData(); res.json({ ...d.settings, staff: d.staff }); });
app.put("/api/admin/settings", adminOnly, (req, res) => {
  const d = readData();
  const lines = (v) => (Array.isArray(v) ? v : String(v || "").split("\n")).map((x) => String(x).trim()).filter(Boolean);
  if (req.body.agencies !== undefined) d.settings.agencies = lines(req.body.agencies);
  if (req.body.homestayGroups !== undefined) d.settings.homestayGroups = lines(req.body.homestayGroups);
  if (req.body.staff !== undefined) {
    const old = new Map(d.staff.map((x) => [x.name, x.id]));
    d.staff = lines(req.body.staff).map((name, i) => ({ id: old.get(name) || `s${Date.now().toString(36)}${i}`, name }));
  }
  store.write(d);
  res.json({ ok: true });
});

// ---- participants: manual add (backup to Embark), edit, delete ----
const CATS = ["faculty", "group", "individual"], ACCS = ["homestay", "volunteer_house", "hotel"];
app.post("/api/participants", (req, res) => {
  const b = req.body || {}, d = readData();
  if (!b.name || !CATS.includes(b.category)) return res.status(400).json({ error: "Name and category are required." });
  if (!b.arrivalDate || !b.departureDate || calc.nightsBetween(b.arrivalDate, b.departureDate) <= 0) return res.status(400).json({ error: "Valid arrival and departure dates are required (departure after arrival)." });
  d.participants.push({
    id: store.nextId(d.participants, "pm"), category: b.category, name: b.name.trim(),
    bookingSource: b.category === "individual" && b.bookingSource === "agency" ? "agency" : "direct",
    agencyName: b.category === "individual" && b.bookingSource === "agency" ? (b.agencyName || null) : null,
    institution: b.institution || null, accommodationType: ACCS.includes(b.accommodationType) ? b.accommodationType : "homestay",
    arrivalDate: b.arrivalDate, departureDate: b.departureDate, mainlandGateway: b.mainlandGateway === "GYE" ? "GYE" : "UIO",
    localTransportOverride: null, source: "manual",
  });
  store.write(d); res.json({ ok: true });
});
app.patch("/api/participants/:id", (req, res) => {
  const d = readData(), p = d.participants.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  for (const k of ["institution", "bookingSource", "agencyName", "accommodationType", "mainlandGateway"]) if (req.body[k] !== undefined) p[k] = req.body[k] || null;
  if (p.bookingSource === "direct") p.agencyName = null;
  store.write(d); res.json({ ok: true });
});
app.delete("/api/participants/:id", (req, res) => {
  const d = readData(), id = req.params.id;
  d.participants = d.participants.filter((p) => p.id !== id);
  d.flights = d.flights.filter((f) => f.personId !== id);
  d.nights = d.nights.filter((n) => n.personId !== id);
  d.localTransportEntries = d.localTransportEntries.filter((e) => e.personId !== id);
  store.write(d); res.json({ ok: true });
});
app.post("/api/admin/clear-sample", adminOnly, (req, res) => {
  const d = readData(), ids = new Set(d.participants.filter((p) => p.source === "mock-embark").map((p) => p.id));
  d.participants = d.participants.filter((p) => !ids.has(p.id));
  d.flights = d.flights.filter((f) => !ids.has(f.personId));
  d.nights = d.nights.filter((n) => !ids.has(n.personId));
  d.localTransportEntries = d.localTransportEntries.filter((e) => !ids.has(e.personId));
  store.write(d); res.json({ removed: ids.size });
});

// ---- Embark sync: CSV export upload (works today) + live API feed (when Embark provides one) ----
function recordSync(d, mode, result, error) {
  d.settings.embark = { ...(d.settings.embark || {}), lastSync: new Date().toISOString(), mode, lastResult: result || null, lastError: error || null };
}
app.post("/api/admin/embark/import", adminOnly, (req, res) => {
  try {
    const rows = embark.parseCSV(String(req.body.csv || ""));
    if (!rows.length) return res.status(400).json({ error: "No rows found in that file." });
    const d = readData(), dry = req.body.apply !== true;
    const result = embark.applyRows(d, rows, d.settings, store.nextId, dry, { submittedOnly: req.body.submittedOnly !== false, fromYear: Number(req.body.fromYear) || 0 });
    result.rows = rows.length; result.columns = Object.keys(rows[0]);
    if (!dry) { recordSync(d, "csv", { ...result, warnings: result.warnings.slice(0, 20) }); store.write(d); }
    res.json({ dryRun: dry, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
async function syncFromApi() {
  const d = readData();
  try {
    const rows = await embark.fetchApiRows();
    const result = embark.applyRows(d, rows, d.settings, store.nextId, false, { submittedOnly: true });
    recordSync(d, "api", { ...result, warnings: result.warnings.slice(0, 20) });
    store.write(d); return { ok: true, ...result };
  } catch (e) { recordSync(d, "api", null, e.message); store.write(d); return { ok: false, error: e.message }; }
}
app.post("/api/admin/embark/sync", adminOnly, async (req, res) => {
  const r = await syncFromApi(); res.status(r.ok ? 200 : 400).json(r);
});
app.get("/api/admin/embark/status", adminOnly, (req, res) =>
  res.json({ apiConfigured: !!process.env.EMBARK_API_URL, ...(readData().settings.embark || {}) }));
if (process.env.EMBARK_API_URL) {
  const mins = Number(process.env.EMBARK_SYNC_MINUTES) || 60;
  store.runAs("embark-sync", () => syncFromApi());
  setInterval(() => store.runAs("embark-sync", () => syncFromApi()), mins * 60000);
}

app.get("/api/staff", (req, res) => res.json(readData().staff));
app.get("/api/airports/search", (req, res) => res.json(calc.searchAirports(req.query.q || "")));
app.get("/api/categories", (req, res) => {
  res.json({
    utilities: Object.keys(UTILITIES),
    waste: Object.keys(WASTE),
    mitigation: Object.keys(MITIGATION),
    accommodation: ACCOMMODATION,
    staffTravelReasons: STAFF_TRAVEL_REASONS,
    units: Object.fromEntries([...Object.entries(UTILITIES), ...Object.entries(WASTE), ...Object.entries(MITIGATION)].map(([k, v]) => [k, v.unit])),
  });
});

// ---- flights ----

app.post("/api/flights", (req, res) => {
  try {
    const { personType, personId, personName, category, originCode, destCode, passengers, date, reasonForTravel } = req.body;
    const leg = calc.calcFlightLeg({ originCode, destCode, passengers: Number(passengers) || 1, date });
    const data = readData();
    const record = {
      id: store.nextId(data.flights, "fl"),
      personType, personId: personId || null, personName, category: category || personType,
      legType: "international", isAutoAssumed: false,
      reasonForTravel: personType === "staff" ? (reasonForTravel || "Other") : undefined,
      ...leg, enteredAt: new Date().toISOString(),
    };
    data.flights.push(record);
    store.write(data);
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/flights", (req, res) => res.json(loadData().flights));

app.delete("/api/flights/:id", (req, res) => {
  const data = readData();
  data.flights = data.flights.filter((f) => f.id !== req.params.id);
  store.write(data);
  res.json({ ok: true });
});

// ---- local transport ----

app.post("/api/local-transport", (req, res) => {
  try {
    const { personId, personName, personType, legKey, amount, date } = req.body;
    const data = readData();
    let record;
    if (personType === "staff") {
      const leg = calc.calcLocalTransportTrips(legKey, Number(amount) || 1);
      record = {
        id: store.nextId(data.localTransportEntries, "lt"),
        personId: personId || null, personName, personType: "staff", legKey,
        label: leg.label, oneWayTrips: Number(amount) || 1, emissionsTonsCO2e: leg.emissionsTonsCO2e,
        date: date || null, isAutoAssumed: false, enteredAt: new Date().toISOString(),
      };
    } else {
      const leg = calc.calcLocalTransportLeg(legKey);
      record = {
        id: store.nextId(data.localTransportEntries, "lt"),
        personId, personName, personType: "participant", legKey,
        label: leg.label, emissionsTonsCO2e: leg.emissionsTonsCO2e,
        isAutoAssumed: false, enteredAt: new Date().toISOString(),
      };
    }
    data.localTransportEntries.push(record);
    store.write(data);
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/local-transport", (req, res) => res.json(loadData().localTransportEntries));

app.delete("/api/local-transport/:id", (req, res) => {
  const data = readData();
  data.localTransportEntries = data.localTransportEntries.filter((e) => e.id !== req.params.id);
  store.write(data);
  res.json({ ok: true });
});

// ---- nights (auto-generated: 1 mainland + rest at destination; fully editable) ----
// location: "mainland" | "galapagos". Mainland and Galápagos hotel nights use the same hotel
// factor but are tracked as separate records for analysis and so exceptions (extra mainland
// nights, no mainland night, etc.) can be edited individually.

app.post("/api/nights", (req, res) => {
  try {
    const { personId, personName, accommodationType, nights, location, personType } = req.body;
    const result = calc.calcNights(accommodationType, Number(nights));
    const data = readData();
    const record = {
      id: store.nextId(data.nights, "nt"),
      personId: personId || null, personName, personType: personType || "participant",
      location: location || "galapagos", accommodationType,
      nights: Number(nights), emissionsTonsCO2e: result.emissionsTonsCO2e,
      factorStatus: result.status, isAutoAssumed: false, enteredAt: new Date().toISOString(),
    };
    data.nights.push(record);
    store.write(data);
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/nights", (req, res) => res.json(loadData().nights));

app.patch("/api/nights/:id", (req, res) => {
  try {
    const data = readData();
    const record = data.nights.find((n) => n.id === req.params.id);
    if (!record) return res.status(404).json({ error: "not found" });
    const newNights = Number(req.body.nights);
    const result = calc.calcNights(record.accommodationType, newNights);
    record.nights = newNights;
    record.emissionsTonsCO2e = result.emissionsTonsCO2e;
    store.write(data);
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/nights/:id", (req, res) => {
  const data = readData();
  data.nights = data.nights.filter((n) => n.id !== req.params.id);
  store.write(data);
  res.json({ ok: true });
});

// ---- staff hotels (same hotel factor, kept as a distinct label for staff trips) ----

app.post("/api/staff-hotels", (req, res) => {
  try {
    const { personId, personName, nights, date } = req.body;
    const result = calc.calcNights("hotel", Number(nights));
    const data = readData();
    const record = {
      id: store.nextId(data.nights, "nt"),
      personId: personId || null, personName, accommodationType: "hotel", personType: "staff",
      location: "staff_trip", nights: Number(nights), date: date || null,
      emissionsTonsCO2e: result.emissionsTonsCO2e, factorStatus: result.status,
      isAutoAssumed: false, enteredAt: new Date().toISOString(),
    };
    data.nights.push(record);
    store.write(data);
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- ground staff monthly entries (utilities + waste + mitigation) ----

app.post("/api/ground-staff-entries", (req, res) => {
  try {
    const { month, year, category, subtype, amount } = req.body;
    const amt = Number(amount);
    let value, unit, isMitigation = false;

    if (category === "utility") { value = calc.calcUtility(subtype, amt); unit = UTILITIES[subtype]?.unit; }
    else if (category === "waste") { value = calc.calcWaste(subtype, amt); unit = WASTE[subtype]?.unit; }
    else if (category === "mitigation") { value = calc.calcMitigation(subtype, amt); unit = MITIGATION[subtype]?.unit; isMitigation = true; }
    else return res.status(400).json({ error: "category must be 'utility', 'waste', or 'mitigation'" });

    const data = readData();
    const record = {
      id: store.nextId(data.groundStaffEntries, "gs"),
      month, year: Number(year), category, subtype, amount: amt, unit,
      emissionsTonsCO2e: isMitigation ? 0 : value,
      mitigationTonsCO2e: isMitigation ? value : 0,
      enteredAt: new Date().toISOString(),
    };
    data.groundStaffEntries.push(record);
    store.write(data);
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/ground-staff-entries", (req, res) => res.json(readData().groundStaffEntries));

app.patch("/api/ground-staff-entries/:id", (req, res) => {
  try {
    const data = readData();
    const record = data.groundStaffEntries.find((e) => e.id === req.params.id);
    if (!record) return res.status(404).json({ error: "not found" });
    const amt = Number(req.body.amount);
    let value;
    if (record.category === "utility") value = calc.calcUtility(record.subtype, amt);
    else if (record.category === "waste") value = calc.calcWaste(record.subtype, amt);
    else value = calc.calcMitigation(record.subtype, amt);
    record.amount = amt;
    if (record.category === "mitigation") record.mitigationTonsCO2e = value;
    else record.emissionsTonsCO2e = value;
    store.write(data);
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/ground-staff-entries/:id", (req, res) => {
  const data = readData();
  data.groundStaffEntries = data.groundStaffEntries.filter((e) => e.id !== req.params.id);
  store.write(data);
  res.json({ ok: true });
});

// Monthly checklist: which categories already have an entry for the given month/year.
app.get("/api/ground-staff-entries/checklist", (req, res) => {
  const { month, year } = req.query;
  const data = readData();
  const entries = data.groundStaffEntries.filter((e) => e.month === month && String(e.year) === String(year));
  const build = (cat, keys) => keys.map((k) => ({
    subtype: k,
    done: entries.some((e) => e.category === cat && e.subtype === k),
  }));
  res.json({
    month, year,
    utility: build("utility", Object.keys(UTILITIES)),
    waste: build("waste", Object.keys(WASTE)),
    mitigation: build("mitigation", Object.keys(MITIGATION)),
  });
});

// ---- report ----

const CATEGORY_LABELS = { faculty: "Faculty & Leaders", group: "Groups", individual: "Individuals", staff: "IOI Staff" };

function computeReport(data) {
  const sum = (list, f) => list.reduce((a, x) => a + (x[f] || 0), 0);

  const flightsTotal = sum(data.flights, "emissionsTonsCO2e");
  const participantFlightsTotal = sum(data.flights.filter((f) => f.personType === "participant"), "emissionsTonsCO2e");
  const staffFlightsTotal = sum(data.flights.filter((f) => f.personType === "staff"), "emissionsTonsCO2e");

  // Volunteer-house nights are already counted through the house utilities -> excluded here.
  const countedNights = data.nights.filter((n) => !n.countedInUtilities);
  const nightsTotal = sum(countedNights, "emissionsTonsCO2e");
  const mainlandNightsTotal = sum(countedNights.filter((n) => n.location === "mainland" || n.location === "staff_trip"), "emissionsTonsCO2e");
  const galapagosNightsTotal = sum(countedNights.filter((n) => n.location === "galapagos"), "emissionsTonsCO2e");
  // Meals: 2 per participant-night (spreadsheet row 66)
  const participantNightsCount = (list) => list.filter((n) => n.personType !== "staff" && n.location !== "staff_trip").reduce((a, n) => a + (n.nights || 0), 0);
  const mealsOf = (list) => calc.round((participantNightsCount(list) * 2 * MEALS_KG_PER_MEAL) / 1000);
  const mealsTotal = mealsOf(data.nights);
  const localTransportTotal = sum(data.localTransportEntries, "emissionsTonsCO2e");
  const utilitiesTotal = sum(data.groundStaffEntries.filter((e) => e.category === "utility"), "emissionsTonsCO2e");
  const wasteTotal = sum(data.groundStaffEntries.filter((e) => e.category === "waste"), "emissionsTonsCO2e");
  const mitigationTotal = sum(data.groundStaffEntries.filter((e) => e.category === "mitigation"), "mitigationTonsCO2e");

  const grossTotal = flightsTotal + nightsTotal + localTransportTotal + utilitiesTotal + wasteTotal + mealsTotal;
  const controllableTotal = grossTotal - participantFlightsTotal;
  const netAfterMitigation = grossTotal - mitigationTotal;

  const categories = ["faculty", "group", "individual"];
  const byCategory = {};
  for (const cat of categories) {
    const people = data.participants.filter((p) => p.category === cat);
    const weeksList = people.map((p) => calc.weeksBetween(p.arrivalDate, p.departureDate)).filter((w) => w !== null);
    const totalWeeks = weeksList.reduce((a, w) => a + w, 0);
    const avgWeeks = weeksList.length ? calc.round(totalWeeks / weeksList.length) : null;

    const personIds = new Set(people.map((p) => p.id));
    const catFlights = data.flights.filter((f) => personIds.has(f.personId));
    const catParticipantFlights = catFlights.filter((f) => f.personType === "participant");
    const catNights = data.nights.filter((n) => personIds.has(n.personId));
    const catLocalTransport = data.localTransportEntries.filter((e) => personIds.has(e.personId));

    const catGross = sum(catFlights, "emissionsTonsCO2e") + sum(catNights, "emissionsTonsCO2e") + sum(catLocalTransport, "emissionsTonsCO2e") + mealsOf(catNights);
    const catControllable = catGross - sum(catParticipantFlights, "emissionsTonsCO2e");

    byCategory[cat] = {
      label: CATEGORY_LABELS[cat],
      people: people.length,
      totalWeeks: calc.round(totalWeeks),
      avgWeeksPerPerson: avgWeeks,
      grossTonsCO2e: calc.round(catGross),
      controllableTonsCO2e: calc.round(catControllable),
      grossPerWeek: totalWeeks ? calc.round(catGross / totalWeeks) : null,
      controllablePerWeek: totalWeeks ? calc.round(catControllable / totalWeeks) : null,
    };
  }

  const allWeeks = data.participants.map((p) => calc.weeksBetween(p.arrivalDate, p.departureDate)).filter((w) => w !== null);
  const totalParticipantWeeks = calc.round(allWeeks.reduce((a, w) => a + w, 0));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      grossTonsCO2e: calc.round(grossTotal),
      controllableTonsCO2e: calc.round(controllableTotal),
      mitigationTonsCO2e: calc.round(mitigationTotal),
      netAfterMitigationTonsCO2e: calc.round(netAfterMitigation),
      flights: calc.round(flightsTotal),
      participantFlights: calc.round(participantFlightsTotal),
      staffFlights: calc.round(staffFlightsTotal),
      nights: calc.round(nightsTotal),
      mainlandNights: calc.round(mainlandNightsTotal),
      galapagosNights: calc.round(galapagosNightsTotal),
      localTransport: calc.round(localTransportTotal),
      utilities: calc.round(utilitiesTotal),
      waste: calc.round(wasteTotal),
      meals: calc.round(mealsTotal),
    },
    accommodation: (({ source, vhNights, homestayTPerNight, volunteerHouseTPerNight, hotelTPerNight }) => ({ source, vhNights, homestayKgPerNight: calc.round(homestayTPerNight * 1000), volunteerHouseKgPerNight: calc.round(volunteerHouseTPerNight * 1000), hotelKgPerNight: calc.round(hotelTPerNight * 1000) }))(data._accFactors),
    participantWeeks: {
      total: totalParticipantWeeks,
      grossPerWeek: totalParticipantWeeks ? calc.round(grossTotal / totalParticipantWeeks) : null,
      controllablePerWeek: totalParticipantWeeks ? calc.round(controllableTotal / totalParticipantWeeks) : null,
    },
    byCategory,
    offset: {
      tonsToOffset: calc.round(netAfterMitigation),
      estimatedCostUSD: calc.round(netAfterMitigation * OFFSET_USD_PER_TON),
      usdPerTon: OFFSET_USD_PER_TON,
      voluntaryContributionUsdPerWeek: VOLUNTARY_CONTRIBUTION_USD_PER_WEEK,
    },
    pendingVerification: [
      `Homestay / volunteer-house nights: per-night factor ${calc.round(data._accFactors.homestayTPerNight * 1000)} / ${calc.round(data._accFactors.volunteerHouseTPerNight * 1000)} kg CO2e (${data._accFactors.source}). Volunteer-house nights are counted through the house utilities, not added again.`,
      "Staff hotel nights use the hotel factor (5.205 kg/night). The 2025 workbook's staff-hotel row (row 11) uses 0.04 kg/night, which looks like a unit error — please confirm.",
    ],
  };
}




// Finalized years (2024, 2025): headline numbers come from the published report, breakdown from the
// workbook. They are read-only and take precedence over anything calculated in the tool for that year.
function historicalReport(h) {
  const L = h.lines, R = h.reported, t = (x) => calc.round(x);
  const gross = R.gross, partFlights = L.participantFlights;
  const weeks = R.participantWeeks;
  const controllable = gross - partFlights; // 2026 definition: gross minus PARTICIPANT flights
  const mitigation = R.mitigation, net = R.net;
  return {
    generatedAt: new Date().toISOString(), finalized: true, year: h.year,
    totals: {
      grossTonsCO2e: t(gross), controllableTonsCO2e: t(controllable), mitigationTonsCO2e: t(mitigation), netAfterMitigationTonsCO2e: t(net),
      flights: t(partFlights + L.teamFlights), participantFlights: t(partFlights), staffFlights: t(L.teamFlights),
      nights: t(L.hotelNights + L.homestayNights), mainlandNights: t(L.hotelNights), galapagosNights: t(L.homestayNights),
      localTransport: t(L.localTransport), utilities: t(L.utilities + L.staffTravelOther + L.agriTransport + L.shipping),
      waste: t(L.waste), meals: t(L.meals),
    },
    scopes: { scope1: h.scope1, scope2: h.scope2, scope3: h.scope3 },
    participantWeeks: { total: weeks, participants: R.participants, avgWeeksPerPerson: t(weeks / R.participants), grossPerWeek: t(gross / weeks), controllablePerWeek: t(controllable / weeks),
      controllableExAllFlightsPerWeek: t((gross - partFlights - L.teamFlights) / weeks) },
    byCategory: {},
    accommodation: { source: "published report", vhNights: null, homestayKgPerNight: null, volunteerHouseKgPerNight: null, hotelKgPerNight: null },
    offset: { tonsToOffset: t(net), estimatedCostUSD: t(net * OFFSET_USD_PER_TON), usdPerTon: OFFSET_USD_PER_TON, voluntaryContributionUsdPerWeek: VOLUNTARY_CONTRIBUTION_USD_PER_WEEK },
    pendingVerification: [
      `Finalized ${h.year} figures from the published IOI GHG Report and the ${h.year} workbook — read-only. Headline totals are the published ones; the breakdown comes from the workbook.`,
      `Hotel nights: ${h.nights.hotel}${h.nights.homestay != null ? `, homestay nights: ${h.nights.homestay}` : " (2024 used a single accommodation rate)"}. Regenerative agriculture: ${h.regenHectares} ha.`,
    ],
  };
}

function reportForYear(full, year) {
  if (HISTORICAL[year]) { const r = historicalReport(HISTORICAL[year]); r.years = full._years; return r; }
  const d = filterByYear(full, year);
  d._accFactors = full._accByYear[year] || accommodationFactors(d);
  const r = computeReport(d);
  r.year = year; r.years = full._years;
  return r;
}
app.get("/api/report", (req, res) => {
  const full = loadData();
  const year = Number(req.query.year) || defaultYear(full._years);
  res.json(reportForYear(full, year));
});
// Year-over-year comparison table
app.get("/api/report/compare", (req, res) => {
  const full = loadData();
  res.json(full._years.map((y) => {
    const r = reportForYear(full, y), t = r.totals;
    return { year: y, people: r.finalized ? r.participantWeeks.participants : Object.values(r.byCategory).reduce((a, c) => a + c.people, 0), participantWeeks: r.participantWeeks.total,
      gross: t.grossTonsCO2e, controllable: t.controllableTonsCO2e, mitigation: t.mitigationTonsCO2e, net: t.netAfterMitigationTonsCO2e,
      grossPerWeek: r.participantWeeks.grossPerWeek, controllablePerWeek: r.participantWeeks.controllablePerWeek,
      participantFlights: t.participantFlights, nights: t.nights, utilities: t.utilities,
      finalized: !!r.finalized, controllableExAllFlightsPerWeek: r.participantWeeks.controllableExAllFlightsPerWeek ?? null };
  }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IOI GHG app running at http://localhost:${PORT}`));
