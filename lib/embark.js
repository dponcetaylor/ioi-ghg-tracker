// Embark -> app mapping. Works from (a) a CSV export uploaded by an admin, or (b) a live API/JSON
// feed when Embark provides one (EMBARK_API_URL / EMBARK_API_TOKEN). Both go through mapRow().
const calc = require("./calc");

function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const delim = [",", ";", "\t"].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim());
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
// Header recognition: regexes tested against the header with spaces/punctuation removed. First non-empty value wins.
// Covers the real Embark export ("First Name - (givenName)", "Program Start Date", ...) and simple custom headers.
const PAT = {
  id: [/^campusid$/, /^embarkid$|^applicantid$|^participantid$|^recordid$/, /^emailaddress$|^email$/],
  first: [/^firstnamegivenname$/, /^firstname$|^givenname$/],
  last: [/^lastnamesurname$/, /^lastname$|^surname$/],
  name: [/^name$|^fullname$|^participantname$/],
  role: [/participatingwithioi/, /^participanttype$|^category$|^role$|^travelertype$/],
  university: [/^universitynameuniversitynamevol$/, /^universitynameuniversitynamestudy$/, /^universityname$|^university$|^institution$|^groupname$|^group$|^school$/],
  universityOther: [/^pleasespecifyuniversitynameother$/],
  tripGroup: [/^servicelearningtripgroup$/],
  tripGroupOther: [/^pleasespecifyservicelearningtripgroupother$/],
  arrival: [/^programstartdate$/, /^arrivaldate$|^arrival$|^programstart$/],
  departure: [/^programenddate$/, /^departuredate$|^departure$|^programend$/],
  housing: [/staying.*(hostfamily|volunteerhouse|hotel)/, /^accommodation(type)?$|^housing(type)?$|^lodging$/],
  agentAgency: [/^agentsagencyname$/, /^agencyname$|^agency$|^bookingsource$/],
  heard: [/^howdidyouhearaboutus$/],
  homeCity: [/^whatcityareyoustartingyourtripfrom$/, /^homecity$|^departurecity$/],
  homeCountry: [/^whatcountryareyoustartingyourtripfrom$/, /^homecountry$|^departurecountry$/],
  homeAirport: [/^homeairport(iata)?$|^departureairport(iata)?$|^startingairport(iata)?$/],
  gateway: [/^gateway$|^mainlandairport$|^mainlandcity$|^entrycity$|^entryairport$|^arrivalcityinecuador$/],
  inbound: [/^inboundflightroute$|^inboundflights?$|^arrivalflightroute$/],
  outbound: [/^outboundflightroute$|^outboundflights?$|^departureflightroute$/],
  flights: [/^flights$|^flightlegs$|^internationalflights$/],
  status: [/^status$/],
};
function pick(row, key) {
  const idx = {}; for (const k of Object.keys(row)) idx[norm(k)] = row[k];
  for (const re of PAT[key]) for (const k of Object.keys(idx)) if (re.test(k) && String(idx[k]).trim() !== "") return String(idx[k]).trim();
  return "";
}
function pickAll(row, key) { // every non-empty value among matching columns (housing appears in two columns)
  const out = []; const seen = new Set();
  for (const re of PAT[key]) for (const k of Object.keys(row)) { const n = norm(k); if (re.test(n) && !seen.has(k) && String(row[k]).trim()) { seen.add(k); out.push(String(row[k]).trim()); } }
  return out;
}

function parseDate(s) {
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/); // month/day/year (US) unless day > 12
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += 2000;
    const [mo, d] = a > 12 ? [b, a] : [a, b];
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const t = Date.parse(s); return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

// --- home city -> airport (best effort, used ONLY when no structured flight route is given) ---
const CITY_ALIAS = { nyc: "new york", "new york city": "new york", "washington dc": "washington", "washington d.c.": "washington", "la": "los angeles", "sf": "san francisco", "saopaulo": "sao paulo" };
const COUNTRY_CODE = { "united states": "US", usa: "US", us: "US", "united states of america": "US", uk: "GB", "united kingdom": "GB", england: "GB", scotland: "GB", wales: "GB", canada: "CA", germany: "DE", france: "FR", spain: "ES", italy: "IT", netherlands: "NL", switzerland: "CH", sweden: "SE", norway: "NO", denmark: "DK", australia: "AU", "new zealand": "NZ", ireland: "IE", belgium: "BE", austria: "AT", mexico: "MX", colombia: "CO", ecuador: "EC", brazil: "BR", argentina: "AR", chile: "CL", peru: "PE", japan: "JP", china: "CN", india: "IN", "south africa": "ZA", israel: "IL", poland: "PL", portugal: "PT", finland: "FI", romania: "RO", czechia: "CZ", "czech republic": "CZ", hungary: "HU", greece: "GR", turkey: "TR" };
let AIRPORT_INDEX = null;
function airportForCity(city, country) {
  if (!city) return null;
  if (!AIRPORT_INDEX) {
    AIRPORT_INDEX = new Map();
    const all = require("fs").readFileSync(require("path").join(__dirname, "../data/airports.json"), "utf8");
    for (const [code, a] of Object.entries(JSON.parse(all))) {
      const k = norm(a.city || ""); if (!k) continue;
      (AIRPORT_INDEX.get(k) || AIRPORT_INDEX.set(k, []).get(k)).push({ code, ...a });
    }
  }
  const c = String(city).toLowerCase().replace(/\(.*?\)/g, "").split(",")[0].trim();
  const words = (CITY_ALIAS[c] || c).split(/\s+/);
  let list = null;
  for (let n = words.length; n >= 1 && !list; n--) { // "Spokane Washington" -> "spokane"
    const k = norm(words.slice(0, n).join(" "));
    list = AIRPORT_INDEX.get(k);
    if (!list && k.length >= 5) { const hit = [...AIRPORT_INDEX.keys()].filter((x) => x.startsWith(k)); // "frankfurt" -> "frankfurtammain"
      if (hit.length) list = hit.flatMap((x) => AIRPORT_INDEX.get(x)); }
  }
  if (!list) return null;
  const cc = COUNTRY_CODE[String(country || "").toLowerCase().trim()];
  if (cc && list.some((a) => a.country === cc)) list = list.filter((a) => a.country === cc);
  const score = (a) => (/international/i.test(a.name) ? 3 : 0) + (/heliport|seaplane|base|field|strip|military|air force/i.test(a.name) ? -5 : 0) + (/airport/i.test(a.name) ? 1 : 0);
  return list.sort((x, y) => score(y) - score(x) || x.code.localeCompare(y.code))[0].code;
}

function legsFromRoute(text, warnings, name) {
  const legs = [];
  for (const part of String(text || "").split(/[;|\n,]+/).map((x) => x.trim()).filter(Boolean)) {
    const codes = part.split(/\s*(?:>|->|→|-|to)\s*/i).map((c) => c.trim().toUpperCase());
    if (codes.length >= 2 && codes.every((c) => /^[A-Z]{3}$/.test(c))) { // "MAD>MIA>UIO" = two legs
      for (let i = 0; i < codes.length - 1; i++) legs.push({ originCode: codes[i], destCode: codes[i + 1] });
    } else warnings.push(`${name}: couldn't read flight route "${part}"`);
  }
  return legs;
}

const cleanInst = (s) => String(s || "").replace(/\s*\((semester abroad|short term study abroad|.*?)\)\s*$/i, "").trim();

function mapRow(row, settings = {}) {
  const warnings = [];
  const name = pick(row, "name") || [pick(row, "first"), pick(row, "last")].filter(Boolean).join(" ");
  if (!name) return { skip: "no name" };
  const role = pick(row, "role").toLowerCase();
  if (/^agent/.test(role)) return { skip: "agent (not a traveler)" };
  let institution = pick(row, "university");
  if (/^other$/i.test(institution)) institution = pick(row, "universityOther");
  if (!institution || /^(na|n\/a|none|-)$/i.test(institution)) {
    const tg = pick(row, "tripGroup"); institution = /^other$/i.test(tg) ? pick(row, "tripGroupOther") : tg;
  }
  institution = cleanInst(institution);
  if (/^(na|n\/a|none|-|other)$/i.test(institution)) institution = "";
  institution = institution || null;
  const category = /professor|faculty|leader|instructor/.test(role) ? "faculty"
    : /study abroad|service learning|group/.test(role) ? "group"
    : /volunteer|intern|individual/.test(role) ? "individual"
    : institution ? "group" : "individual";
  const arrivalDate = parseDate(pick(row, "arrival")), departureDate = parseDate(pick(row, "departure"));
  let skip = null;
  if (!arrivalDate) skip = "no program start date";
  else if (!departureDate) skip = "no program end date";
  else if (departureDate <= arrivalDate) skip = "end date is not after start date";
  else if ((new Date(departureDate) - new Date(arrivalDate)) / 86400000 > 400) skip = "program longer than 400 days (check dates)";
  const housing = pickAll(row, "housing").join(" ").toLowerCase();
  const accommodationType = /hotel/.test(housing) ? "hotel" : /volunteer/.test(housing) ? "volunteer_house" : /host|home|family/.test(housing) ? "homestay" : null;

  // booking source: agent's agency, else "how did you hear" if it is one of our agencies
  const agents = settings.agencies || [];
  const findAgency = (raw) => agents.find((a) => norm(a) === norm(raw) || (norm(a).length > 4 && norm(raw).includes(norm(a))));
  let agencyName = null;
  const agentRaw = pick(row, "agentAgency"), heard = pick(row, "heard");
  if (agentRaw && !/^(direct|none|n\/a|no|-)$/i.test(agentRaw)) agencyName = findAgency(agentRaw) || agentRaw;
  else if (heard && findAgency(heard)) agencyName = findAgency(heard);
  const bookingSource = agencyName ? "agency" : "direct";

  const gw = pick(row, "gateway").toLowerCase();
  const mainlandGateway = /gye|guayaquil/.test(gw) ? "GYE" : "UIO";

  // flights: structured routes if given, otherwise an ESTIMATE from the home city
  let legs = [...legsFromRoute(pick(row, "inbound"), warnings, name), ...legsFromRoute(pick(row, "outbound"), warnings, name), ...legsFromRoute(pick(row, "flights"), warnings, name)];
  let estimated = false;
  if (!legs.length && !skip) {
    let home = pick(row, "homeAirport").toUpperCase();
    if (!/^[A-Z]{3}$/.test(home)) home = airportForCity(pick(row, "homeCity"), pick(row, "homeCountry")) || "";
    if (home) { legs = [{ originCode: home, destCode: mainlandGateway }, { originCode: mainlandGateway, destCode: home }]; estimated = true; }
    else warnings.push(`${name}: no flight route and home city "${pick(row, "homeCity")}" not matched to an airport`);
  }
  return { skip, embarkId: pick(row, "id") || null, name, category, institution, arrivalDate, departureDate, accommodationType, bookingSource, agencyName, mainlandGateway, legs, estimated, status: pick(row, "status"), warnings };
}

/** Apply mapped rows to the data. dryRun = report only. Core fields are refreshed from Embark;
 *  manually-added flights/nights/edits are left alone. */
function applyRows(data, rows, settings, nextId, dryRun, opts = {}) {
  const res = { created: 0, updated: 0, unchanged: 0, skipped: 0, skippedBy: {}, flights: 0, estimatedFlights: 0, warnings: [] };
  const skipIt = (why, ex) => { res.skipped++; const b = res.skippedBy[why] || (res.skippedBy[why] = { count: 0, examples: [] }); b.count++; if (b.examples.length < 5) b.examples.push(ex); };
  for (const row of rows) {
    const m = mapRow(row, settings);
    if (m.skip) { skipIt(m.skip, m.name || "(unnamed)"); continue; }
    if (opts.submittedOnly && m.status && !/^submitted$/i.test(m.status)) { skipIt("application not submitted", m.name); continue; }
    const y = Number(m.arrivalDate.slice(0, 4));
    if ((opts.fromYear && y < opts.fromYear) || y > 2100) { skipIt(`outside year range`, `${m.name} (${m.arrivalDate})`); continue; }
    res.warnings.push(...m.warnings);
    let p = data.participants.find((x) => (m.embarkId && x.embarkId === m.embarkId) || (!m.embarkId && x.name === m.name && x.arrivalDate === m.arrivalDate));
    const core = { name: m.name, category: m.category, institution: m.institution, arrivalDate: m.arrivalDate, departureDate: m.departureDate,
      bookingSource: m.bookingSource, agencyName: m.agencyName, mainlandGateway: m.mainlandGateway };
    if (m.accommodationType) core.accommodationType = m.accommodationType;
    if (!p) {
      res.created++;
      if (dryRun) continue;
      p = { id: nextId(data.participants, "pe"), accommodationType: "homestay", localTransportOverride: null, embarkId: m.embarkId, source: "embark", ...core };
      data.participants.push(p);
    } else {
      const changed = Object.keys(core).filter((k) => p[k] !== core[k] && !(core[k] == null && p[k] == null));
      if (!changed.length) res.unchanged++; else res.updated++;
      if (!dryRun) { Object.assign(p, core); p.embarkId = m.embarkId || p.embarkId; if (p.source !== "manual") p.source = "embark"; }
    }
    if (!dryRun && m.legs.length) {
      data.flights = data.flights.filter((f) => !(f.personId === p.id && f.source === "embark"));
      if (m.estimated) res.estimatedFlights += m.legs.length;
      for (const l of m.legs) {
        try {
          const leg = calc.calcFlightLeg({ ...l, passengers: 1 });
          data.flights.push({ id: nextId(data.flights, "fl"), personType: "participant", personId: p.id, personName: p.name, category: p.category,
            legType: "international", isAutoAssumed: false, source: "embark", estimated: m.estimated || undefined, ...leg, enteredAt: new Date().toISOString() });
          res.flights++;
        } catch (e) { res.warnings.push(`${m.name}: ${e.message}`); }
      }
    } else if (dryRun) res.flights += m.legs.length;
  }
  return res;
}

async function fetchApiRows() {
  const url = process.env.EMBARK_API_URL, token = process.env.EMBARK_API_TOKEN;
  if (!url) throw new Error("EMBARK_API_URL is not set");
  const headerName = process.env.EMBARK_API_HEADER || "Authorization";
  const headers = { Accept: "application/json" };
  if (token) headers[headerName] = headerName === "Authorization" && !/^(Bearer|Basic) /.test(token) ? `Bearer ${token}` : token;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Embark API answered HTTP ${r.status}`);
  let body = await r.json();
  for (const k of (process.env.EMBARK_ROWS_PATH || "").split(".").filter(Boolean)) body = body?.[k];
  if (!Array.isArray(body)) throw new Error("Embark API response is not a list (set EMBARK_ROWS_PATH, e.g. data.items)");
  return body;
}

module.exports = { parseCSV, mapRow, applyRows, fetchApiRows };
