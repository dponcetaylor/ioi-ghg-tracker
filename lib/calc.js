const fs = require("fs");
const path = require("path");
const {
  FLIGHT_TIERS, DEFAULT_MAINLAND_GATEWAY, GALAPAGOS_AIRPORT, ACCOMMODATION,
  LOCAL_TRANSPORT_LEGS, UTILITIES, WASTE, MITIGATION,
} = require("../data/factors");

const airports = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/airports.json"), "utf8"));

function findAirport(code) {
  if (!code) return null;
  return airports[code.toUpperCase()] || null;
}

function searchAirports(query, limit = 15) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const results = [];
  for (const [code, a] of Object.entries(airports)) {
    if (
      code.toLowerCase() === q ||
      code.toLowerCase().startsWith(q) ||
      (a.city && a.city.toLowerCase().includes(q)) ||
      (a.name && a.name.toLowerCase().includes(q))
    ) {
      results.push({ code, ...a });
      if (results.length >= limit) break;
    }
  }
  return results;
}

function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pickTier(km) {
  return FLIGHT_TIERS.find((t) => km < t.maxKm) || FLIGHT_TIERS[FLIGHT_TIERS.length - 1];
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * One flight leg. Mirrors the spreadsheet: (distance*pax*factor) per gas, kg->tons, x GWP mult.
 * Pass forceTierName ("short"|"medium"|"long") to lock the tier regardless of computed distance
 * — used for the mainland<->Baltra leg, which is fixed at medium tier per Daniel's instruction.
 */
function calcFlightLeg({ originCode, destCode, passengers = 1, date, forceTierName }) {
  const origin = findAirport(originCode);
  const dest = findAirport(destCode);
  if (!origin) throw new Error(`Unknown origin airport code: ${originCode}`);
  if (!dest) throw new Error(`Unknown destination airport code: ${destCode}`);

  const km = distanceKm(origin, dest);
  const tier = forceTierName ? FLIGHT_TIERS.find((t) => t.name === forceTierName) || pickTier(km) : pickTier(km);
  const paxKm = km * passengers;
  const co2 = paxKm * tier.co2, n2o = paxKm * tier.n2o, ch4 = paxKm * tier.ch4;
  const tonsCO2e = ((co2 + n2o + ch4) * tier.gwpMultiplier) / 1000;

  return {
    originCode: originCode.toUpperCase(),
    destCode: destCode.toUpperCase(),
    originLabel: `${origin.city || origin.name} (${originCode.toUpperCase()})`,
    destLabel: `${dest.city || dest.name} (${destCode.toUpperCase()})`,
    distanceKm: Math.round(km * 10) / 10,
    tier: tier.name,
    tierForced: !!forceTierName,
    passengers,
    date: date || null,
    emissionsTonsCO2e: round(tonsCO2e),
  };
}

/**
 * Auto-assumed mainland <-> Baltra round trip, generated for every participant by default.
 * Fixed at medium tier regardless of computed distance (per Daniel's instruction — the real
 * great-circle distance for both UIO and GYE gateways comes out over 1,108 km / "long" tier,
 * but this leg should always use the medium-tier factor).
 */
function defaultMainlandBaltraLegs(gatewayCode = DEFAULT_MAINLAND_GATEWAY) {
  const outbound = calcFlightLeg({ originCode: gatewayCode, destCode: GALAPAGOS_AIRPORT, passengers: 1, forceTierName: "medium" });
  const inbound = calcFlightLeg({ originCode: GALAPAGOS_AIRPORT, destCode: gatewayCode, passengers: 1, forceTierName: "medium" });
  return [
    { ...outbound, legType: "mainland_baltra", direction: "outbound", isAutoAssumed: true },
    { ...inbound, legType: "mainland_baltra", direction: "return", isAutoAssumed: true },
  ];
}

/** One local-transport leg, round trip (x2), from the fixed per-participant chain. */
function calcLocalTransportLeg(legKey) {
  const leg = LOCAL_TRANSPORT_LEGS[legKey];
  if (!leg) throw new Error(`Unknown local transport leg: ${legKey}`);
  const oneWayKg = leg.co2Kg + leg.n2oKg + leg.ch4Kg;
  const roundTripTons = (oneWayKg * 2) / 1000;
  return { legKey, label: leg.label, emissionsTonsCO2e: round(roundTripTons), sourceRow: leg.sourceRow };
}

/** The full default chain (5 legs, round trip each) for one participant. Individually editable/removable. */
function defaultLocalTransportChain() {
  return Object.keys(LOCAL_TRANSPORT_LEGS).map((key) => calcLocalTransportLeg(key));
}

/** Arbitrary number of ONE-WAY trips on a given leg (for staff manual entry, which varies). */
function calcLocalTransportTrips(legKey, oneWayTrips) {
  const leg = LOCAL_TRANSPORT_LEGS[legKey] || require("../data/factors").LOCAL_TRANSPORT_ALTERNATES[legKey];
  if (!leg) throw new Error(`Unknown local transport leg: ${legKey}`);
  const oneWayKg = leg.co2Kg + leg.n2oKg + leg.ch4Kg;
  return { legKey, label: leg.label, emissionsTonsCO2e: round((oneWayKg * oneWayTrips) / 1000), sourceRow: leg.sourceRow };
}

// Hotel is a fixed factor. Homestay / volunteer-house emissions are derived from the monthly
// utility data at report time (see server.js applyPricing), so 0 here is only a placeholder.
function calcNights(accommodationType, nights) {
  const f = ACCOMMODATION[accommodationType] || ACCOMMODATION.hotel;
  return { nights, emissionsTonsCO2e: f.co2PerNightKg ? round((f.co2PerNightKg * nights) / 1000) : 0, status: f.status };
}

/** Does this institution belong to the "always homestay" list? "UM" is matched as a whole word. */
function isHomestayGroup(institution, list) {
  const inst = String(institution || "").toLowerCase();
  if (!inst) return false;
  return (list || []).some((raw) => {
    const e = String(raw).trim().toLowerCase();
    if (!e) return false;
    if (e === "um") return /\bum\b/.test(inst) || inst.includes("michigan");
    return inst.includes(e);
  });
}

/** Whole nights between two ISO dates (departure - arrival, in days). */
function nightsBetween(arrivalDate, departureDate) {
  if (!arrivalDate || !departureDate) return 0;
  const ms = new Date(departureDate) - new Date(arrivalDate);
  if (isNaN(ms) || ms <= 0) return 0;
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/**
 * Auto-generate nights for a participant from their arrival/departure dates.
 * - Faculty & Leaders and Groups: 1 mainland-hotel night (everyone routes through the mainland
 *   gateway city), then the rest at the Galápagos destination as "hotel" (general-rule default).
 * - Individuals: NO mainland night assumed — 100% of their nights are in Galápagos, at
 *   whichever accommodation type is on their record (homestay, volunteer house, or hotel — all
 *   three are valid options for individuals; a hotel night costs the same as any other hotel
 *   night, just tracked under this person instead of a mainland trip).
 * Every record is independently editable/removable for exceptions either way.
 */
function defaultNightsForParticipant(participant, settings = {}) {
  const totalNights = nightsBetween(participant.arrivalDate, participant.departureDate);
  if (totalNights <= 0) return [];

  const assumesMainlandNight = participant.category === "faculty" || participant.category === "group";
  const mainlandNights = assumesMainlandNight ? Math.min(1, totalNights) : 0;
  const destinationNights = totalNights - mainlandNights;
  const destinationType =
    participant.category === "individual" ? participant.accommodationType || "homestay"
    : participant.category === "group" && isHomestayGroup(participant.institution, settings.homestayGroups) ? "homestay"
    // Faculty/professors travelling with a homestay group stay in the offices / volunteer house.
    : participant.category === "faculty" && isHomestayGroup(participant.institution, settings.homestayGroups) ? "volunteer_house"
    : "hotel";

  const records = [];
  if (mainlandNights > 0) {
    const result = calcNights("hotel", mainlandNights);
    records.push({ location: "mainland", accommodationType: "hotel", nights: mainlandNights, emissionsTonsCO2e: result.emissionsTonsCO2e, factorStatus: result.status });
  }
  if (destinationNights > 0) {
    const result = calcNights(destinationType, destinationNights);
    records.push({ location: "galapagos", accommodationType: destinationType, nights: destinationNights, emissionsTonsCO2e: result.emissionsTonsCO2e, factorStatus: result.status });
  }
  return records;
}

function calcUtility(category, amount) {
  const f = UTILITIES[category];
  if (!f) throw new Error(`Unknown utility category: ${category}`);
  if (f.tons) return round(f.tons(amount));
  const kg = f.co2PerKwh ? amount * f.co2PerKwh : f.co2PerM3 ? amount * f.co2PerM3 : amount * f.co2PerLiter;
  return round(kg / 1000);
}

function calcWaste(category, grams) {
  const f = WASTE[category];
  if (!f) throw new Error(`Unknown waste category: ${category}`);
  return round(f.tonsPerGram(grams));
}

/** Mitigation credit (tons CO2e avoided/sequestered) for one monthly entry. */
function calcMitigation(category, amount) {
  const f = MITIGATION[category];
  if (!f) throw new Error(`Unknown mitigation category: ${category}`);
  const perUnit = f.co2PerKg || f.co2PerHectare || f.co2PerUnit || 0;
  return round(perUnit * amount);
}

/** Duration in weeks (decimal) between two ISO dates. */
function weeksBetween(arrivalDate, departureDate) {
  if (!arrivalDate || !departureDate) return null;
  const ms = new Date(departureDate) - new Date(arrivalDate);
  if (isNaN(ms) || ms < 0) return null;
  return round(ms / (1000 * 60 * 60 * 24 * 7));
}

module.exports = {
  findAirport, searchAirports, distanceKm,
  calcFlightLeg, defaultMainlandBaltraLegs,
  calcLocalTransportLeg, defaultLocalTransportChain, calcLocalTransportTrips,
  calcNights, isHomestayGroup, nightsBetween, defaultNightsForParticipant,
  calcUtility, calcWaste, calcMitigation,
  weeksBetween, round,
};
