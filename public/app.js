// ---- tab switching ----
document.querySelectorAll(".navbtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".navbtn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "report") loadReport();
    if (btn.dataset.tab === "participants") loadParticipants();
    if (btn.dataset.tab === "groundstaff") loadChecklist();
    if (btn.dataset.tab === "admin") loadAdmin();
  });
});

let SETTINGS = { agencies: [], homestayGroups: [], staff: [] };
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
async function loadSettings() { try { SETTINGS = await api("/api/settings"); } catch (e) {} }

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Please log in."); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function fmt(n) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 }); }
function showResult(el, ok, html) { el.innerHTML = `<div class="${ok ? "ok" : "err"}">${html}</div>`; }
function labelize(s) { return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }

const CATEGORY_LABELS = { faculty: "Faculty & Leader", group: "Group", individual: "Individual" };
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function wireAirportSearch(inputEl, listEl) {
  if (!inputEl) return;
  inputEl.addEventListener("input", async () => {
    const q = inputEl.value;
    if (q.length < 2) return;
    const results = await api(`/api/airports/search?q=${encodeURIComponent(q)}`);
    listEl.innerHTML = results.map((r) => `<option value="${r.code}">${r.city || r.name}, ${r.country} — ${r.name}</option>`).join("");
  });
}
wireAirportSearch(document.getElementById("sf-origin"), document.getElementById("sf-origin-list"));
wireAirportSearch(document.getElementById("sf-dest"), document.getElementById("sf-dest-list"));

let CATEGORIES = null;
async function loadCategoriesRef() {
  CATEGORIES = await api("/api/categories");
  document.getElementById("sf-reason").innerHTML = CATEGORIES.staffTravelReasons.map((r) => `<option value="${r}">${r}</option>`).join("");
  document.getElementById("sl-leg").innerHTML = ["bus_baltra_itabaca", "barcaza_itabaca_santacruz", "bus_itabaca_puertoayora", "ferry_puertoayora_isabela", "taxi_hostfamily", "taxi_itabaca_puertoayora"]
    .map((k) => `<option value="${k}">${labelize(k)}</option>`).join("");

  const uGroup = document.getElementById("gs-utility-group"), wGroup = document.getElementById("gs-waste-group"), mGroup = document.getElementById("gs-mitigation-group");
  uGroup.innerHTML = CATEGORIES.utilities.map((c) => `<option value="utility:${c}">${labelize(c)}</option>`).join("");
  wGroup.innerHTML = CATEGORIES.waste.map((c) => `<option value="waste:${c}">${labelize(c)} waste</option>`).join("");
  mGroup.innerHTML = CATEGORIES.mitigation.map((c) => `<option value="mitigation:${c}">${labelize(c)}</option>`).join("");
  updateUnitLabel();
}

async function loadStaffList() {
  const staff = await api("/api/staff");
  const opts = staff.map((s) => `<option value="${s.id}" data-name="${s.name}">${s.name}</option>`).join("");
  ["sf-staff", "sh-staff", "sl-staff"].forEach((id) => (document.getElementById(id).innerHTML = opts));
}

// ================= PARTICIPANTS TAB =================
let PARTICIPANTS_CACHE = { participants: [], flights: [], localTransport: [], nights: [] };
let EXPANDED_IDS = new Set();

async function loadParticipants() {
  const [participants, flights, localTransport, nights] = await Promise.all([
    api("/api/participants"), api("/api/flights"), api("/api/local-transport"), api("/api/nights"),
  ]);
  PARTICIPANTS_CACHE = { participants, flights, localTransport, nights };
  const ys = [...new Set(participants.map((p) => String(p.arrivalDate || "").slice(0, 4)).filter((y) => y.length === 4))].sort().reverse();
  const ysel = document.getElementById("participant-year"), cur = ysel.value;
  ysel.innerHTML = `<option value="">All</option>` + ys.map((y) => `<option ${y === cur ? "selected" : ""}>${y}</option>`).join("");
  if (cur === "" && !ysel.dataset.init && ys.length) { ysel.dataset.init = "1"; const c = String(new Date().getFullYear()); ysel.value = ys.includes(c) ? c : ys[0]; }
  renderParticipants();
}

document.getElementById("participant-search").addEventListener("input", renderParticipants);
document.getElementById("participant-year").addEventListener("change", renderParticipants);
document.getElementById("participant-filter").addEventListener("change", renderParticipants);
document.getElementById("expand-all-btn").addEventListener("click", () => {
  const filtered = filteredParticipants();
  if (EXPANDED_IDS.size >= filtered.length) EXPANDED_IDS.clear();
  else filtered.forEach((p) => EXPANDED_IDS.add(p.id));
  renderParticipants();
});

function filteredParticipants() {
  const q = document.getElementById("participant-search").value.trim().toLowerCase();
  const cat = document.getElementById("participant-filter").value;
  return PARTICIPANTS_CACHE.participants.filter((p) => {
    if (cat && p.category !== cat) return false;
    const yv = document.getElementById("participant-year").value;
    if (yv && String(p.arrivalDate || "").slice(0, 4) !== yv) return false;
    if (!q) return true;
    const haystack = [p.name, p.institution, p.agencyName].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

function renderParticipants() {
  const { flights, localTransport, nights } = PARTICIPANTS_CACHE;
  const filtered = filteredParticipants();
  document.getElementById("participant-count").textContent = `Showing ${filtered.length} of ${PARTICIPANTS_CACHE.participants.length} participants`;

  const container = document.getElementById("participants-list");
  container.innerHTML = filtered.map((p) => renderParticipantCard(p, flights, localTransport, nights)).join("");
  wireParticipantCardEvents(container);
}

function personTotal(personId, flights, localTransport, nights) {
  const sum = (list) => list.filter((x) => x.personId === personId).reduce((a, x) => a + (x.emissionsTonsCO2e || 0), 0);
  return sum(flights) + sum(localTransport) + sum(nights);
}

function renderParticipantCard(p, flights, localTransport, nights) {
  const pFlights = flights.filter((f) => f.personId === p.id);
  const pLocal = localTransport.filter((e) => e.personId === p.id);
  const pNights = nights.filter((n) => n.personId === p.id);
  const total = personTotal(p.id, flights, localTransport, nights);
  const weeks = weeksBetween(p.arrivalDate, p.departureDate);
  const expanded = EXPANDED_IDS.has(p.id);

  const subLabel =
    p.category === "group" ? `Group — ${p.institution || "(institution not set)"}` :
    p.category === "individual" ? `Individual — ${p.bookingSource === "agency" ? `Agency: ${p.agencyName || "TBD"}` : "Direct booking"}` :
    `Faculty/Leader${p.institution ? " — " + p.institution : ""}`;

  const reviewBanner = p.needsReview
    ? `<div class="pending-note" style="margin:8px 0;">⚠ Embark dates changed since flights/nights were calculated (now ${p.arrivalDate} → ${p.departureDate}). Auto-records below may be stale.
        <button class="btn small" data-regenerate="${p.id}" style="margin-left:8px;">Regenerate from new dates</button></div>`
    : "";

  if (!expanded) {
    return `
      <div class="participant-card">
        <div class="participant-head" data-toggle="${p.id}" style="cursor:pointer;">
          <div><span class="participant-name">▸ ${p.name}</span><span class="tag">${subLabel}</span>${p.needsReview ? '<span class="tag amber">needs review</span>' : ""}</div>
          <div class="leg-meta">${weeks ? `${weeks} wks` : ""} · ${fmt(total)} t CO2e</div>
        </div>
      </div>`;
  }

  const flightRows = pFlights.map((f) => `
    <div class="leg-row">
      <span>${f.originLabel} → ${f.destLabel} <span class="leg-meta">(${f.distanceKm} km, ${f.tier}${f.tierForced ? " — fixed" : ""}${f.isAutoAssumed ? ", auto" : ""}${f.estimated ? ", estimated from home city" : ""})</span></span>
      <span>${fmt(f.emissionsTonsCO2e)} t &nbsp; <button class="btn small danger" data-del-flight="${f.id}">Remove</button></span>
    </div>`).join("") || `<p class="hint">No flights logged.</p>`;

  const localRows = pLocal.map((e) => `
    <div class="leg-row">
      <span>${e.label}${e.isAutoAssumed ? ' <span class="leg-meta">(auto, round trip)</span>' : ""}</span>
      <span>${fmt(e.emissionsTonsCO2e)} t &nbsp; <button class="btn small danger" data-del-local="${e.id}">Remove</button></span>
    </div>`).join("") || `<p class="hint">No local transport logged.</p>`;

  const nightsRows = pNights.map((n) => `
    <div class="leg-row">
      <span>${n.location === "mainland" ? "Mainland" : "Galápagos"} — ${labelize(n.accommodationType)}${n.isAutoAssumed ? ' <span class="leg-meta">(auto)</span>' : ""}</span>
      <span>
        <input type="number" min="0" value="${n.nights}" data-edit-nights="${n.id}" style="width:60px;display:inline-block;" disabled />
        nights = ${fmt(n.emissionsTonsCO2e)} t${n.countedInUtilities ? ' <span class="leg-meta" title="Already counted through house utilities; shown for per-person analysis only">(in utilities)</span>' : ""}
        &nbsp; <button class="btn small" data-toggle-nights="${n.id}" data-mode="locked">Edit</button>
        <button class="btn small danger" data-del-nights="${n.id}">Remove</button>
      </span>
    </div>`).join("");

  return `
    <div class="participant-card">
      <div class="participant-head" data-toggle="${p.id}" style="cursor:pointer;">
        <div><span class="participant-name">▾ ${p.name}</span><span class="tag">${subLabel}</span>${p.needsReview ? '<span class="tag amber">needs review</span>' : ""}</div>
        <div class="leg-meta">${p.arrivalDate || "?"} → ${p.departureDate || "?"} ${weeks ? `(${weeks} wks)` : ""} · ${fmt(total)} t CO2e</div>
      </div>
      ${reviewBanner}
      <div class="small-form" style="margin:6px 0 10px;">
        ${p.category === "individual" ? `<label>Booked via<select data-agency="${p.id}"><option value="">Direct booking</option>${(SETTINGS.agencies || []).concat(p.agencyName && !(SETTINGS.agencies || []).includes(p.agencyName) ? [p.agencyName] : []).map((ag) => `<option ${ag === p.agencyName ? "selected" : ""}>${esc(ag)}</option>`).join("")}</select></label>` : ""}
        <label>Accommodation on record<select data-acc="${p.id}">${["homestay", "volunteer_house", "hotel"].map((x) => `<option value="${x}" ${x === p.accommodationType ? "selected" : ""}>${labelize(x)}</option>`).join("")}</select></label>
        <span class="leg-meta">source: ${esc(p.source || "")}${p.source === "mock-embark" ? " (sample)" : ""}</span>
        <button class="btn small danger" data-del-participant="${p.id}" style="margin-left:auto;">Delete participant</button>
      </div>

      <h3>Flights (${pFlights.length})</h3>
      ${flightRows}
      <form class="add-flight-form small-form" data-person-id="${p.id}" data-person-name="${p.name}" data-category="${p.category}">
        <label>Origin<input list="al-origin-${p.id}" placeholder="airport code" required /><datalist id="al-origin-${p.id}"></datalist></label>
        <label>Destination<input list="al-dest-${p.id}" placeholder="airport code" required /><datalist id="al-dest-${p.id}"></datalist></label>
        <label>Date<input type="date" /></label>
        <button type="submit" class="btn small">Add flight manually</button>
      </form>

      <h3>Local transport (${pLocal.length})</h3>
      ${localRows}

      <h3>Nights (${pNights.length})</h3>
      ${nightsRows}
      <form class="add-nights-form small-form" data-person-id="${p.id}" data-person-name="${p.name}">
        <label>Location<select><option value="mainland">Mainland</option><option value="galapagos">Galápagos</option></select></label>
        <label>Type<select><option value="hotel">Hotel</option><option value="homestay">Homestay</option><option value="volunteer_house">Volunteer house</option></select></label>
        <label>Nights<input type="number" min="1" required /></label>
        <button type="submit" class="btn small">Add nights</button>
      </form>
    </div>`;
}

function wireParticipantCardEvents(container) {
  container.querySelectorAll("[data-toggle]").forEach((el) =>
    el.addEventListener("click", () => {
      const id = el.dataset.toggle;
      EXPANDED_IDS.has(id) ? EXPANDED_IDS.delete(id) : EXPANDED_IDS.add(id);
      renderParticipants();
    })
  );
  container.querySelectorAll("[data-regenerate]").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("This discards any manual edits to this person's auto-generated flights, local transport, and nights, and recalculates from their current Embark dates. Continue?")) return;
      await api(`/api/participants/${btn.dataset.regenerate}/regenerate`, { method: "POST" });
      loadParticipants();
    })
  );
  container.querySelectorAll("[data-agency]").forEach((sel) => sel.addEventListener("change", async () => {
    await api(`/api/participants/${sel.dataset.agency}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookingSource: sel.value ? "agency" : "direct", agencyName: sel.value }) });
    loadParticipants();
  }));
  container.querySelectorAll("[data-acc]").forEach((sel) => sel.addEventListener("change", async () => {
    await api(`/api/participants/${sel.dataset.acc}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accommodationType: sel.value }) });
    alert("Saved. This changes the record only — existing night entries are not changed. Edit them below, or use Regenerate if you want them recalculated.");
  }));
  container.querySelectorAll("[data-del-participant]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this participant and ALL their flights, nights and transport? If they come from Embark they will reappear at the next sync.")) return;
    await api(`/api/participants/${btn.dataset.delParticipant}`, { method: "DELETE" }); loadParticipants();
  }));
  container.querySelectorAll("[data-del-flight]").forEach((btn) =>
    btn.addEventListener("click", async (e) => { e.stopPropagation(); await api(`/api/flights/${btn.dataset.delFlight}`, { method: "DELETE" }); loadParticipants(); })
  );
  container.querySelectorAll("[data-del-local]").forEach((btn) =>
    btn.addEventListener("click", async (e) => { e.stopPropagation(); await api(`/api/local-transport/${btn.dataset.delLocal}`, { method: "DELETE" }); loadParticipants(); })
  );
  container.querySelectorAll("[data-del-nights]").forEach((btn) =>
    btn.addEventListener("click", async (e) => { e.stopPropagation(); await api(`/api/nights/${btn.dataset.delNights}`, { method: "DELETE" }); loadParticipants(); })
  );
  container.querySelectorAll("[data-toggle-nights]").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.toggleNights;
      const input = container.querySelector(`[data-edit-nights="${id}"]`);
      if (btn.dataset.mode === "locked") {
        input.disabled = false;
        input.classList.add("editing");
        input.focus();
        input.select();
        btn.textContent = "Save";
        btn.dataset.mode = "editing";
      } else {
        await api(`/api/nights/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nights: input.value }) });
        loadParticipants();
      }
    })
  );
  container.querySelectorAll("form.add-flight-form").forEach((form) => {
    const [origin, dest] = form.querySelectorAll("input[list]");
    wireAirportSearch(origin, document.getElementById(origin.getAttribute("list")));
    wireAirportSearch(dest, document.getElementById(dest.getAttribute("list")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const [originEl, destEl, dateEl] = form.querySelectorAll("input");
      await api("/api/flights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personType: "participant", personId: form.dataset.personId, personName: form.dataset.personName, category: form.dataset.category,
          originCode: originEl.value, destCode: destEl.value, date: dateEl.value,
        }),
      });
      loadParticipants();
    });
  });
  container.querySelectorAll("form.add-nights-form").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const [locationSel, typeSel, nightsInput] = form.querySelectorAll("select, input");
      await api("/api/nights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: form.dataset.personId, personName: form.dataset.personName, location: locationSel.value, accommodationType: typeSel.value, nights: nightsInput.value }),
      });
      loadParticipants();
    });
  });
}

function weeksBetween(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b) - new Date(a);
  return ms > 0 ? Math.round((ms / (1000 * 60 * 60 * 24 * 7)) * 100) / 100 : null;
}

// ================= STAFF TAB =================
document.getElementById("form-staff-flight").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sel = document.getElementById("sf-staff"), opt = sel.selectedOptions[0], el = document.getElementById("sf-result");
  try {
    const record = await api("/api/flights", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personType: "staff", personId: sel.value, personName: opt.dataset.name,
        reasonForTravel: document.getElementById("sf-reason").value,
        originCode: document.getElementById("sf-origin").value, destCode: document.getElementById("sf-dest").value,
        passengers: document.getElementById("sf-passengers").value, date: document.getElementById("sf-date").value,
      }),
    });
    showResult(el, true, `${record.originLabel} → ${record.destLabel} (${record.reasonForTravel}): <strong>${record.distanceKm} km</strong>, tier <strong>${record.tier}</strong> → <strong>${fmt(record.emissionsTonsCO2e)} tons CO2e</strong>`);
    e.target.reset();
  } catch (err) { showResult(el, false, err.message); }
});

document.getElementById("form-staff-hotel").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sel = document.getElementById("sh-staff"), opt = sel.selectedOptions[0], el = document.getElementById("sf-result");
  const record = await api("/api/staff-hotels", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ personId: sel.value, personName: opt.dataset.name, nights: document.getElementById("sh-nights").value, date: document.getElementById("sh-date").value }),
  });
  showResult(el, true, `${opt.dataset.name} — ${record.nights} night(s) hotel: <strong>${fmt(record.emissionsTonsCO2e)} tons CO2e</strong>`);
  e.target.reset();
});

document.getElementById("form-staff-local").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sel = document.getElementById("sl-staff"), opt = sel.selectedOptions[0], el = document.getElementById("sf-result");
  try {
    const record = await api("/api/local-transport", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId: sel.value, personName: opt.dataset.name, personType: "staff", legKey: document.getElementById("sl-leg").value, amount: document.getElementById("sl-amount").value }),
    });
    showResult(el, true, `${opt.dataset.name} — ${record.label}: <strong>${fmt(record.emissionsTonsCO2e)} tons CO2e</strong>`);
    e.target.reset();
  } catch (err) { showResult(el, false, err.message); }
});

// ================= EMISSIONS & MITIGATION MONTHLY TAB =================
document.getElementById("gs-month").innerHTML = MONTHS.map((m) => `<option value="${m}">${m}</option>`).join("");
document.getElementById("cl-month").innerHTML = MONTHS.map((m) => `<option value="${m}">${m}</option>`).join("");

function updateUnitLabel() {
  if (!CATEGORIES) return;
  const [cat, sub] = document.getElementById("gs-category").value.split(":");
  document.getElementById("gs-unit-label").textContent = `(${unitFor(cat, sub)})`;
}
function unitFor(cat, sub) {
  return (CATEGORIES.units && CATEGORIES.units[sub]) || "";
}
document.getElementById("gs-category").addEventListener("change", updateUnitLabel);

document.getElementById("form-groundstaff").addEventListener("submit", async (e) => {
  e.preventDefault();
  const [category, subtype] = document.getElementById("gs-category").value.split(":");
  const el = document.getElementById("gs-result");
  try {
    const record = await api("/api/ground-staff-entries", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        month: document.getElementById("gs-month").value, year: document.getElementById("gs-year").value,
        category, subtype, amount: document.getElementById("gs-amount").value,
      }),
    });
    const value = category === "mitigation" ? record.mitigationTonsCO2e : record.emissionsTonsCO2e;
    const verb = category === "mitigation" ? "mitigated" : "emitted";
    showResult(el, true, `${labelize(subtype)} — ${record.amount} ${record.unit}: <strong>${fmt(value)} tons CO2e ${verb}</strong>`);
    loadGroundStaffEntries();
    loadChecklist();
    document.getElementById("gs-amount").value = "";
  } catch (err) { showResult(el, false, err.message); }
});

async function loadGroundStaffEntries() {
  const entries = await api("/api/ground-staff-entries");
  const rows = entries.slice().reverse().map((e) => {
    const value = e.category === "mitigation" ? e.mitigationTonsCO2e : e.emissionsTonsCO2e;
    return `<tr>
      <td>${e.month} ${e.year}</td><td>${labelize(e.category)}</td><td>${labelize(e.subtype)}</td>
      <td><input type="number" step="any" value="${e.amount}" data-edit-gs="${e.id}" style="width:80px;" /> ${e.unit}</td>
      <td>${fmt(value)}</td><td>${e.enteredBy}</td>
      <td><button class="btn small" data-save-gs="${e.id}">Save</button> <button class="btn small danger" data-del-gs="${e.id}">Delete</button></td>
    </tr>`;
  }).join("");
  document.getElementById("gs-table").innerHTML = entries.length
    ? `<table><thead><tr><th>Month</th><th>Type</th><th>Category</th><th>Amount</th><th>tons CO2e</th><th>By</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="hint">No entries yet this session.</p>`;

  document.querySelectorAll("[data-del-gs]").forEach((btn) =>
    btn.addEventListener("click", async () => { await api(`/api/ground-staff-entries/${btn.dataset.delGs}`, { method: "DELETE" }); loadGroundStaffEntries(); loadChecklist(); })
  );
  document.querySelectorAll("[data-save-gs]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const input = document.querySelector(`[data-edit-gs="${btn.dataset.saveGs}"]`);
      await api(`/api/ground-staff-entries/${btn.dataset.saveGs}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: input.value }) });
      loadGroundStaffEntries(); loadChecklist();
    })
  );
}

document.getElementById("cl-month").addEventListener("change", loadChecklist);
document.getElementById("cl-year").addEventListener("change", loadChecklist);
async function loadChecklist() {
  const month = document.getElementById("cl-month").value || MONTHS[0];
  const year = document.getElementById("cl-year").value || 2026;
  const cl = await api(`/api/ground-staff-entries/checklist?month=${encodeURIComponent(month)}&year=${year}`);
  const section = (title, items) => `
    <h3>${title}</h3>
    <div class="checklist-grid">
      ${items.map((i) => `<span class="check-item ${i.done ? "done" : "missing"}">${i.done ? "✅" : "❌"} ${labelize(i.subtype)}</span>`).join("")}
    </div>`;
  document.getElementById("checklist-content").innerHTML =
    section("Utilities", cl.utility) + section("Waste", cl.waste) + section("Mitigation", cl.mitigation);
}

// ================= REPORT TAB =================
let breakdownChart, categoryChart;
document.getElementById("report-year").addEventListener("change", loadReport);
document.getElementById("refresh-report").addEventListener("click", loadReport);
async function loadReport() {
  const ysel = document.getElementById("report-year");
  const r = await api("/api/report" + (ysel.value ? `?year=${ysel.value}` : ""));
  ysel.innerHTML = r.years.map((y) => `<option ${y === r.year ? "selected" : ""}>${y}</option>`).join("");
  loadCompare();
  const t = r.totals;
  const catRows = Object.values(r.byCategory).map((c) => `
    <tr>
      <td>${c.label}</td><td>${c.people}</td><td>${c.avgWeeksPerPerson ?? "—"}</td>
      <td>${fmt(c.grossTonsCO2e)}</td><td>${fmt(c.controllableTonsCO2e)}</td>
      <td>${c.grossPerWeek != null ? fmt(c.grossPerWeek) : "—"}</td>
      <td>${c.controllablePerWeek != null ? fmt(c.controllablePerWeek) : "—"}</td>
    </tr>`).join("");

  document.getElementById("report-content").innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="num">${fmt(t.grossTonsCO2e)}</div><div class="label">Gross tons CO2e</div></div>
      <div class="stat"><div class="num">${fmt(t.controllableTonsCO2e)}</div><div class="label">Controllable (excl. participant flights)</div></div>
      <div class="stat"><div class="num">${fmt(t.mitigationTonsCO2e)}</div><div class="label">Mitigation</div></div>
      <div class="stat"><div class="num">${fmt(t.netAfterMitigationTonsCO2e)}</div><div class="label">Net after mitigation</div></div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="num">${r.participantWeeks.total}</div><div class="label">Total participant-weeks</div></div>
      <div class="stat"><div class="num">${r.participantWeeks.grossPerWeek != null ? fmt(r.participantWeeks.grossPerWeek) : "—"}</div><div class="label">Gross tCO2e / week</div></div>
      <div class="stat"><div class="num">${r.participantWeeks.controllablePerWeek != null ? fmt(r.participantWeeks.controllablePerWeek) : "—"}</div><div class="label">Controllable tCO2e / week</div></div>
    </div>

    <div class="row">
      <div class="card" style="flex:1;min-width:280px;"><h2>Emissions by source</h2><canvas id="chart-breakdown" height="220"></canvas></div>
      <div class="card" style="flex:1;min-width:280px;"><h2>Gross tCO2e/week by category</h2><canvas id="chart-category" height="220"></canvas></div>
    </div>

    <h2>By category</h2>
    <table><thead><tr><th>Category</th><th>People</th><th>Avg weeks</th><th>Gross t</th><th>Controllable t</th><th>Gross t/wk</th><th>Controllable t/wk</th></tr></thead>
    <tbody>${catRows}</tbody></table>

    <h2>Breakdown</h2>
    <table><thead><tr><th>Source</th><th>tons CO2e</th></tr></thead><tbody>
      <tr><td>Participant flights</td><td>${fmt(t.participantFlights)}</td></tr>
      <tr><td>Staff flights</td><td>${fmt(t.staffFlights)}</td></tr>
      <tr><td>${r.finalized ? "Hotel nights" : "Nights — mainland"}</td><td>${fmt(t.mainlandNights)}</td></tr>
      <tr><td>${r.finalized ? "Homestay nights" : "Nights — Galápagos"}</td><td>${fmt(t.galapagosNights)}</td></tr>
      <tr><td>Local transport</td><td>${fmt(t.localTransport)}</td></tr>
      <tr><td>Utilities (Scope 2)</td><td>${fmt(t.utilities)}</td></tr>
      <tr><td>Waste</td><td>${fmt(t.waste)}</td></tr>
      <tr><td>Participant meals</td><td>${fmt(t.meals)}</td></tr>
    </tbody></table>

    <h2>Offsetting</h2>
    <p>${fmt(r.offset.tonsToOffset)} tons to offset × $${r.offset.usdPerTon}/ton = <strong>$${fmt(r.offset.estimatedCostUSD)}</strong>. Voluntary contribution: $${r.offset.voluntaryContributionUsdPerWeek}/participant-week.</p>

    ${r.pendingVerification.map((p) => `<div class="pending-note">⚠ ${p}</div>`).join("")}
  `;

  renderCharts(t, r.byCategory);
}

function renderCharts(t, byCategory) {
  if (typeof Chart === "undefined") return;
  const breakdownCtx = document.getElementById("chart-breakdown");
  const categoryCtx = document.getElementById("chart-category");
  if (breakdownChart) breakdownChart.destroy();
  if (categoryChart) categoryChart.destroy();

  breakdownChart = new Chart(breakdownCtx, {
    type: "doughnut",
    data: {
      labels: ["Participant flights", "Staff flights", "Nights (mainland)", "Nights (Galápagos)", "Local transport", "Utilities", "Waste", "Meals"],
      datasets: [{ data: [t.participantFlights, t.staffFlights, t.mainlandNights, t.galapagosNights, t.localTransport, t.utilities, t.waste, t.meals],
        backgroundColor: ["#2f6b3a", "#5a9367", "#d99a1b", "#e8c27a", "#7a9e8a", "#4a6b5c", "#a8bfae", "#c9d6cc"] }],
    },
    options: { plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } } },
  });

  const cats = Object.values(byCategory);
  categoryChart = new Chart(categoryCtx, {
    type: "bar",
    data: {
      labels: cats.map((c) => c.label),
      datasets: [
        { label: "Gross t/wk", data: cats.map((c) => c.grossPerWeek || 0), backgroundColor: "#2f6b3a" },
        { label: "Controllable t/wk", data: cats.map((c) => c.controllablePerWeek || 0), backgroundColor: "#d99a1b" },
      ],
    },
    options: { plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true } } },
  });
}

// ---- init ----
(async function init() {
  await loadSettings();
  fillAddParticipantForm();
  await loadCategoriesRef();
  await loadStaffList();
  await loadParticipants();
  await loadGroundStaffEntries();
  await loadChecklist();
})();


// ---- who am I / logout / admin ----
(async function initUser() {
  try {
    const me = await api("/api/me");
    document.getElementById("who").textContent = me.name;
    if (me.role === "admin") document.getElementById("admin-nav").style.display = "";
  } catch (e) {}
})();
document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }); location.href = "/login.html";
});

async function loadAdmin() {
  loadAdminExtras();
  const users = await api("/api/admin/users");
  document.getElementById("users-table").innerHTML = `<table><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr>` +
    users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td><td>${u.role}</td><td>${u.active ? "Active" : "Deactivated"}</td>
      <td><button class="btn small" data-reset="${u.id}">Reset password</button>
      <button class="btn small ${u.active ? "danger" : ""}" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? "Deactivate" : "Reactivate"}</button></td></tr>`).join("") + `</table>`;
  document.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", async () => {
    const pw = prompt("New password (8+ characters):"); if (!pw) return;
    try { await api(`/api/admin/users/${b.dataset.reset}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) }); alert("Password changed."); }
    catch (e) { alert(e.message); }
  }));
  document.querySelectorAll("[data-active]").forEach((b) => b.addEventListener("click", async () => {
    try { await api(`/api/admin/users/${b.dataset.active}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: b.dataset.to === "1" }) }); loadAdmin(); }
    catch (e) { alert(e.message); }
  }));
  const audit = await api("/api/admin/audit");
  document.getElementById("audit-table").innerHTML = `<table><tr><th>When</th><th>Who</th><th>Action</th></tr>` +
    audit.map((r) => `<tr><td>${esc(r.at.replace("T", " ").slice(0, 16))}</td><td>${esc(r.username)}</td><td>${esc(r.action)} <span class="leg-meta">${esc((r.detail || "").slice(0, 90))}</span></td></tr>`).join("") + `</table>`;
}
document.getElementById("user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const el = document.getElementById("user-msg");
  try {
    await api("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      username: document.getElementById("nu-username").value, displayName: document.getElementById("nu-name").value,
      password: document.getElementById("nu-pw").value, role: document.getElementById("nu-role").value }) });
    showResult(el, true, "Account created. Give them the username and password."); e.target.reset(); loadAdmin();
  } catch (err) { showResult(el, false, err.message); }
});


// ---- add participant manually (backup to Embark) ----
function fillAddParticipantForm() {
  const sel = document.getElementById("np-agency");
  if (sel) sel.innerHTML = `<option value="">Direct booking</option>` + (SETTINGS.agencies || []).map((x) => `<option>${esc(x)}</option>`).join("");
}
const npForm = document.getElementById("np-form");
if (npForm) {
  const cat = document.getElementById("np-category");
  const toggle = () => {
    document.getElementById("np-agency-wrap").style.display = cat.value === "individual" ? "" : "none";
    document.getElementById("np-inst-wrap").style.display = cat.value === "individual" ? "none" : "";
  };
  cat.addEventListener("change", toggle); toggle();
  npForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const el = document.getElementById("np-msg"), v = (id) => document.getElementById(id).value;
    try {
      await api("/api/participants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        name: v("np-name"), category: v("np-category"), institution: v("np-institution"), bookingSource: v("np-agency") ? "agency" : "direct",
        agencyName: v("np-agency"), accommodationType: v("np-acc"), arrivalDate: v("np-arrival"), departureDate: v("np-departure"), mainlandGateway: v("np-gateway") }) });
      showResult(el, true, "Participant added. Flights, transport and nights were generated automatically."); npForm.reset(); toggle(); loadParticipants();
    } catch (err) { showResult(el, false, err.message); }
  });
}

// ---- admin: settings + Embark ----
async function loadAdminExtras() {
  await loadSettings();
  document.getElementById("set-staff").value = (SETTINGS.staff || []).map((s) => s.name).join("\n");
  document.getElementById("set-agencies").value = (SETTINGS.agencies || []).join("\n");
  document.getElementById("set-homestay").value = (SETTINGS.homestayGroups || []).join("\n");
  const st = await api("/api/admin/embark/status");
  document.getElementById("embark-status").innerHTML = `<p class="hint">Live API: <strong>${st.apiConfigured ? "configured" : "not configured yet"}</strong>. ` +
    (st.lastSync ? `Last sync: ${esc(st.lastSync.replace("T", " ").slice(0, 16))} (${esc(st.mode)})${st.lastError ? ` — <span style="color:#a02020">error: ${esc(st.lastError)}</span>` : st.lastResult ? ` — ${st.lastResult.created} new, ${st.lastResult.updated} updated, ${st.lastResult.unchanged} unchanged` : ""}` : "No sync yet.") + `</p>`;
}
document.getElementById("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const el = document.getElementById("settings-msg");
  try {
    await api("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      staff: document.getElementById("set-staff").value, agencies: document.getElementById("set-agencies").value, homestayGroups: document.getElementById("set-homestay").value }) });
    showResult(el, true, "Saved."); await loadSettings(); fillAddParticipantForm(); loadStaffList();
  } catch (err) { showResult(el, false, err.message); }
});
let EMBARK_CSV = "";
document.getElementById("embark-file").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  EMBARK_CSV = await f.text(); await embarkImport(false);
});
async function embarkImport(apply) {
  const el = document.getElementById("embark-result");
  try {
    const r = await api("/api/admin/embark/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv: EMBARK_CSV, apply, submittedOnly: document.getElementById("embark-submitted").checked, fromYear: document.getElementById("embark-fromyear").value }) });
    el.innerHTML = `<div class="ok"><strong>${apply ? "Imported" : "Preview"}:</strong> ${r.rows} rows — ${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.skipped} skipped, ${r.flights} flight legs${r.estimatedFlights ? ` (${r.estimatedFlights} estimated from home city)` : ""}.
      <br><span class="leg-meta">Skipped: ${Object.entries(r.skippedBy || {}).map(([k, v]) => `${esc(k)}: ${v.count} (e.g. ${v.examples.slice(0, 2).map(esc).join(", ")})`).join(" · ") || "none"}</span>
      <br><span class="leg-meta">Columns found: ${r.columns.map(esc).join(", ")}</span>
      ${r.warnings.length ? `<br>⚠ ${r.warnings.slice(0, 10).map(esc).join("<br>⚠ ")}${r.warnings.length > 10 ? `<br>…and ${r.warnings.length - 10} more` : ""}` : ""}
      ${apply ? "" : `<br><button class="btn small" id="embark-apply" style="margin-top:8px;">Apply import</button>`}</div>`;
    const b = document.getElementById("embark-apply"); if (b) b.addEventListener("click", async () => { await embarkImport(true); loadAdminExtras(); loadParticipants(); });
  } catch (err) { showResult(el, false, err.message); }
}
document.getElementById("embark-sync-btn").addEventListener("click", async () => {
  const el = document.getElementById("embark-result");
  try { const r = await api("/api/admin/embark/sync", { method: "POST" }); showResult(el, true, `Synced: ${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged.`); loadParticipants(); }
  catch (err) { showResult(el, false, err.message); }
  loadAdminExtras();
});
document.getElementById("clear-sample-btn").addEventListener("click", async () => {
  if (!confirm("Remove the 4 sample participants and all their records? Do this once, before entering real data.")) return;
  const r = await api("/api/admin/clear-sample", { method: "POST" }); alert(`Removed ${r.removed} sample participants.`); loadParticipants();
});


async function loadCompare() {
  const rows = await api("/api/report/compare");
  const pct = (cur, prev) => (prev ? ` <span class="leg-meta">(${cur >= prev ? "+" : ""}${Math.round(((cur - prev) / prev) * 100)}%)</span>` : "");
  document.getElementById("report-compare").innerHTML = `<table><tr><th>Year</th><th>People</th><th>Participant-weeks</th><th>Gross t</th><th>Controllable t</th><th>Gross t/week</th><th>Controllable t/week</th><th>Mitigation t</th><th>Net t</th></tr>` +
    rows.map((r, i) => { const p = rows[i - 1]; return `<tr><td><strong>${r.year}</strong>${r.finalized ? ' <span class="tag">final</span>' : ' <span class="tag amber">live</span>'}</td><td>${r.people}</td><td>${fmt(r.participantWeeks)}</td><td>${fmt(r.gross)}</td><td>${fmt(r.controllable)}</td>
      <td>${r.grossPerWeek != null ? fmt(r.grossPerWeek) : "—"}${p && p.grossPerWeek ? pct(r.grossPerWeek, p.grossPerWeek) : ""}</td>
      <td>${r.controllablePerWeek != null ? fmt(r.controllablePerWeek) : "—"}${p && p.controllablePerWeek ? pct(r.controllablePerWeek, p.controllablePerWeek) : ""}</td>
      <td>${fmt(r.mitigation)}</td><td>${fmt(r.net)}</td></tr>`; }).join("") + `</table><p class="hint">“final” = published report figures (2024, 2025); “live” = calculated by this tool from entered data. Controllable = gross minus participant flights (the 2026 definition) for every year, so years are comparable. As published for 2024–2025 (excluding ALL flights): ${rows.filter((r) => r.finalized).map((r) => `${r.year}: ${r.controllableExAllFlightsPerWeek} t/week`).join(", ")}.</p>`;
}
