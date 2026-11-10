/**
 * Emission factors ported directly from "Calculadora GEI para IOI 2025.xlsx" (tab: Calculadora).
 * Every factor cites the spreadsheet row it came from, read programmatically from the cell
 * formula (not transcribed by hand). See README for how this maps to the original workbook.
 *
 * STATUS FLAGS:
 *   verified   -> read directly from an unambiguous spreadsheet formula
 *   pending    -> present in the sheet but flagged during scoping as needing a source check
 */

// ---- Flights (all traveler types share these tiers; distance is computed live per leg) ----
const FLIGHT_TIERS = [
  { name: "short", maxKm: 100, co2: 0.11, n2o: 0.00168, ch4: 0.00013, gwpMultiplier: 1, sourceRow: 6 },
  { name: "medium", maxKm: 1108, co2: 0.075, n2o: 0.00097, ch4: 0.00097, gwpMultiplier: 1.891, sourceRow: 7 },
  { name: "long", maxKm: Infinity, co2: 0.095, n2o: 0.0011, ch4: 0.00001, gwpMultiplier: 1.891, sourceRow: 8 },
];

// Default mainland <-> Baltra domestic leg, auto-assumed for every participant (Faculty/Group/
// Individual) even if they don't log it themselves. Editable/removable per person in the app.
// UIO (Quito) is the default gateway; staff can change to GYE (Guayaquil) per person.
const DEFAULT_MAINLAND_GATEWAY = "UIO";
const GALAPAGOS_AIRPORT = "GPS"; // Baltra

// ---- Accommodation ----
// Per your correction: homestay and volunteer house use the SAME factor (both non-hotel
// lodging with a family/shared house) — pending the real figure. Hotel is tracked separately.
// Utilities (electricity/water/gas at the volunteer house) are a SEPARATE Scope 2 line item
// entered by ground staff — no double counting, this mirrors how the office is also metered
// independently of any "nights" figure.
const ACCOMMODATION = {
  // Hotel: spreadsheet rows 62-63 ((20.82/4) kg CO2e per night). Used for ALL hotel nights
  // (participants, mainland, Galapagos, and staff). NOTE: spreadsheet row 11 (staff hotel stays)
  // uses 0.04 kg/night, which looks like a unit error and is deliberately NOT used.
  hotel: { label: "Hotel", co2PerNightKg: 20.82 / 4, status: "verified", sourceRow: 63 },
  // Homestay and volunteer house have NO fixed factor. They are DERIVED from the volunteer house
  // utilities entered in the app (see accommodationFactors() in server.js):
  //   homestay per night        = (electricity house + water house) / volunteer-house nights
  //   volunteer house per night = (electricity house + water house + laundry) / volunteer-house nights
  // Volunteer-house nights are already counted through the utilities, so they are NOT added to
  // gross totals again (only allocated to people for per-person / per-week analysis).
  // Fallback when the current data has no volunteer-house nights/utilities yet = 2025 baseline,
  // from the 2025 spreadsheet: row 64 ((G18+G24)/760 per night; 760 = volunteer-house nights).
  homestay: { label: "Homestay", status: "derived" },
  volunteer_house: { label: "Volunteer house", status: "derived" },
};
const BASELINE_2025 = {
  vhNights: 760,
  waterHouseT: 0.122512, electricityHouseT: 1.0384, laundryT: 1.04896,
};
const MEALS_KG_PER_MEAL = 0.006; // spreadsheet row 66, meals = 2 per participant-night

// ---- Local transport chain (Galápagos ground/sea legs) ----
// Each participant (Faculty/Group/Individual) gets ONE round trip through this chain by
// default — "every participant goes in and out once." Values below are PER ONE-WAY TRIP in kg;
// the app doubles them for the round trip. Each leg is independently editable/removable per
// person (e.g. for groups with different logistics), matching spreadsheet rows 44-49 / 51-56
// (identical formulas for individuals and groups).
const LOCAL_TRANSPORT_LEGS = {
  bus_baltra_itabaca: {
    label: "Bus: Baltra Airport → Itabaca Channel",
    sourceRow: 44,
    co2Kg: 0.03228 * 12.6,
    n2oKg: 0.00018 * 12.6,
    ch4Kg: 0.00015 * 12.6,
  },
  barcaza_itabaca_santacruz: {
    label: "Barge crossing: Itabaca Channel (Baltra → Santa Cruz)",
    sourceRow: 45,
    co2Kg: 0.9371 * 1.3,
    n2oKg: (338 * 1.3) / 1000,
    ch4Kg: (6 * 1.3) / 1000,
  },
  bus_itabaca_puertoayora: {
    label: "Bus: Itabaca Channel → Puerto Ayora",
    sourceRow: 46,
    co2Kg: 0.03228 * 41.2,
    n2oKg: 0.00018 * 41.2,
    ch4Kg: 0.00015 * 41.2,
  },
  ferry_puertoayora_isabela: {
    label: "Ferry: Puerto Ayora (Santa Cruz) → Puerto Villamil (Isabela)",
    sourceRow: 48,
    co2Kg: 0.152 * 81,
    n2oKg: 0,
    ch4Kg: 0,
  },
  taxi_hostfamily: {
    label: "Taxi: dock/airport → host family or IOI facility",
    sourceRow: 49,
    co2Kg: 0.1429 * 1.5,
    n2oKg: 0.00124 * 1.4,
    ch4Kg: 0.0013 * 1.5,
  },
};
// Alternate mode, not in the default chain — available if staff swap it in for a specific group:
const LOCAL_TRANSPORT_ALTERNATES = {
  taxi_itabaca_puertoayora: {
    label: "Taxi (alternate to bus): Itabaca Channel → Puerto Ayora",
    sourceRow: 47,
    co2Kg: 0.1429 * 41.2,
    n2oKg: 0.00124 * 41.2,
    ch4Kg: 0.0013 * 41.2,
  },
};

// ---- IOI staff: reason for travel (new field, for future analysis) ----
const STAFF_TRAVEL_REASONS = ["Ecuador admin", "Conference", "Site visit", "Emergency", "Other"];

// ---- Utilities (ground staff monthly) ----
const UTILITIES = {
  electricity_office: { co2PerKwh: 0.32, unit: "kWh", sourceRow: 23 },
  electricity_house: { co2PerKwh: 0.32, unit: "kWh", sourceRow: 24 },
  electricity_laundry: { co2PerKwh: 0.32, unit: "kWh", sourceRow: 25 },
  water_house: { co2PerM3: 0.26, unit: "m3", sourceRow: 18 },
  water_office: { co2PerM3: 0.32, unit: "m3", sourceRow: 19 },
  gas: { co2PerLiter: 1.473, unit: "liters", sourceRow: 13 },
  // --- added from the 2025 workbook (rows 15,16,21,28-31,68) ---
  vehicle_car: { unit: "km", sourceRow: 15, tons: (a) => ((0.0002 + 0.00028 + 0.00184) * a) / 1000 },
  vehicle_pickup: { unit: "km", sourceRow: 16, tons: (a) => ((0.0003 + 0.00031 + 0.00184) * a) / 1000 },
  commuting_car: { unit: "passenger trips (Puerto Villamil)", sourceRow: 21, tons: (a) => ((0.1944 * 4 + 0.0049 + 0.0043) * a) / 1000 },
  agri_transport: { unit: "passenger-km (bus/moto/taxi)", sourceRow: 68, tons: (a) => ((0.00197 * 15 + 0.008 * 29.6 + 0.0236 * 29.6) * a) / 1000 },
  shipping_air_short: { unit: "tons shipped (domestic air <463 km)", sourceRow: 28, tons: (a) => ((1.9191 + 0.0182 + 0.0014) * a) / 1000 },
  shipping_air_medium: { unit: "tons shipped (air, medium)", sourceRow: 29, tons: (a) => ((140.441 + 0.01382 + 0.0008) * a * 1.891) / 1000 },
  shipping_air_long: { unit: "tons shipped (air, long)", sourceRow: 30, tons: (a) => ((0.59487 + 0.00585 + 0.00003) * a * 1.891) / 1000 },
  // CONFIRMED by Daniel for use (row 32 of the workbook is blank): general cargo ship, UK DESNZ/DEFRA ~0.01321 kg CO2e per
  // tonne-km (tank-to-wheel total; per-gas split not published in the sources found), x an assumed
  // 1,000 km mainland -> Galapagos sea route. Input = tons shipped.
  shipping_ship_long: { unit: "tons shipped (cargo ship >100 km)", sourceRow: 32, tons: (a) => (0.01321 * 1000 * a) / 1000 },
  shipping_boat_short: { unit: "tons shipped (boat <100 km)", sourceRow: 31, tons: (a) => ((69.5 + 18 + 0.01) * a) / 1000 },
};

// Waste factors operate on grams and produce tons directly (formulas already bake in /1,000,000).
const WASTE = {
  organic: { unit: "grams", sourceRow: 34, tonsPerGram: (g) => (0.11*g)/1e6 + (0.000138*g*310)/1e6 + (0.0000125*g*21)/1e6 },
  paper: { unit: "grams", sourceRow: 35, tonsPerGram: (g) => (0.11*g)/1e6 + (0.00000306*g*310)/1e6 + (0.00062*g*21)/1e6 },
  plastic: { unit: "grams", sourceRow: 36, tonsPerGram: (g) => (1.3*g)/1e6 + (0.000000704*g*310)/1e6 + (0.000602*g*21)/1e6 },
  aluminum: { unit: "grams", sourceRow: 37, tonsPerGram: (g) => (0.066*g)/1e6 },
  mixed: { unit: "grams", sourceRow: 38, tonsPerGram: (g) => (0.363625*g)/1e6 + (g*0.0000354458*310)/1e6 + (0.0002104*g*21)/1e6 },
};

// ---- Mitigation (active offsetting) — ground staff monthly, matches spreadsheet rows 70-81 ----
// "Avoided import" crops/livestock: kg harvested locally x factor = tCO2e avoided vs. mainland
// shipping. Regenerative agriculture: hectares x sequestration rate. All mitigationTonsCO2e
// values SUBTRACT from gross emissions to produce the net/active-offsetting figure.
const MITIGATION = {
  milk: { label: "Milk", unit: "kg harvested", sourceRow: 70, co2PerKg: 32.0397 / 562100 },
  beef: { label: "Beef cattle", unit: "kg harvested", sourceRow: 71, co2PerKg: 0 }, // tracked, not yet counted per source doc (matures 2036)
  tomato: { label: "Tomato", unit: "kg harvested", sourceRow: 72, co2PerKg: 0.20041086 / 3515.98 },
  pepper: { label: "Pepper", unit: "kg harvested", sourceRow: 73, co2PerKg: 0.236778 / 4154 },
  cucumber: { label: "Cucumber", unit: "kg harvested", sourceRow: 74, co2PerKg: 0.089946 / 1578 },
  cilantro: { label: "Cilantro", unit: "kg harvested", sourceRow: 75, co2PerKg: 0.382242 / 6706 },
  plantain: { label: "Plantain/Banana", unit: "kg harvested", sourceRow: 76, co2PerKg: 1.242429 / 21797 },
  regenerative_ag: { label: "Regenerative agriculture area", unit: "hectares (cumulative)", sourceRow: 77, co2PerHectare: 94.99086 / 105.5454, isAreaBasis: true },
  pest_control: { label: "Pest & invasive species control", unit: "m2 managed", sourceRow: 78, co2PerUnit: 0 }, // not yet quantified per source doc
  mangrove_nursery: { label: "Mangrove nursery (hectares transplanted)", unit: "hectares transplanted", sourceRow: 81, co2PerUnit: 0 }, // tracked, NOT counted in the 2025 workbook total (353 t/ha shown in row 81 but excluded from row 85)
  reforested_ha: { label: "Hectares reforested (from nursery)", unit: "hectares reforested", sourceRow: 82, co2PerHectare: 211 },
  bicycle: { label: "Bicycle trips (zero-emission transport)", unit: "km cycled", sourceRow: 70, co2PerUnit: 21 / 10000000 },
  beach_cleanup: { label: "Beach & marine debris clean-up", unit: "kg collected", sourceRow: 81, co2PerKg: 0.011366033 / 2264.15 },
};

const OFFSET_USD_PER_TON = 15; // "1 bono = 15 USD", spreadsheet row 85
const VOLUNTARY_CONTRIBUTION_USD_PER_WEEK = 15; // per finalized 2025 report §5.7

module.exports = {
  FLIGHT_TIERS,
  DEFAULT_MAINLAND_GATEWAY,
  GALAPAGOS_AIRPORT,
  ACCOMMODATION, BASELINE_2025, MEALS_KG_PER_MEAL,
  LOCAL_TRANSPORT_LEGS,
  LOCAL_TRANSPORT_ALTERNATES,
  STAFF_TRAVEL_REASONS,
  UTILITIES,
  WASTE,
  MITIGATION,
  OFFSET_USD_PER_TON,
  VOLUNTARY_CONTRIBUTION_USD_PER_WEEK,
};
