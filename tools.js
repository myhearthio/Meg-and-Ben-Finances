// tools.js — server-side tool implementations Connor can invoke via Claude tool-calling.
// Each tool takes (input, snapshot) and returns a plain JSON-serializable object.
// Numbers returned here are the ONLY numbers Connor is allowed to quote back.
//
// All persistent state reads from Postgres via data.js. NEVER read/write disk.
const db = require("./data");

const FAMILY_CATS = [
  "housing", "utilities", "groceries", "dining", "transportation",
  "health", "shopping", "travel", "entertainment", "gifts_charity",
  "kids_activities", "childcare", "education",
  "taxes_professional", "needs_review",
  "other", "excluded",
];

const OVERRIDES_KEY = "family-overrides";
const FORECAST_KEY = "family-forecast";
const FORECAST_KEY_FOR = (year) => `family-forecast-${year}`;
const MEMORY_KEY = "connor_memory";

async function readOverrides() { return (await db.kvGet(OVERRIDES_KEY, {})) || {}; }
async function readForecast(year)  {
  const yr = String(year || new Date().getFullYear());
  const yearly = await db.kvGet(FORECAST_KEY_FOR(yr), null);
  if (yearly && Object.keys(yearly).length > 0) return yearly;
  if (yr === "2025") return (await db.kvGet(FORECAST_KEY, {})) || {};
  return {};
}
async function readMemory()    { return (await db.kvGet(MEMORY_KEY, { facts: [], preferences: [], history: [] })) || { facts: [], preferences: [], history: [] }; }
async function writeMemory(m)  { await db.kvSet(MEMORY_KEY, m); }

function round(n) { return Math.round(n * 100) / 100; }

function normalizeVendor(s) {
  return String(s || "")
    .replace(/ORIG CO NAME:[^\s]+\s*/gi, "")
    .replace(/^ZELLE[^\s]*\s*/i, "")
    .replace(/\*+\d*$/, "")
    .replace(/\d{7,}/g, "")
    .replace(/\s+[A-Z]{2}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function mkTxId(t) {
  return (t.date || "") + "|" + Number(t.amount) + "|" + String(t.name || "").slice(0, 60);
}

function snapshotYear() {
  return String(Number(process.env.SNAPSHOT_YEAR) || new Date().getFullYear());
}

function toolDefs() {
  return [
    {
      name: "find_transactions",
      description: "Search current-year transactions. Returns a list of matching tx with date, amount, vendor, mask. NO exclusions applied — never use to rank.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive substring on description/merchant." },
          amount: { type: "number", description: "Exact match (absolute, ±$0.01)." },
          date_from: { type: "string", description: "YYYY-MM-DD inclusive." },
          date_to: { type: "string", description: "YYYY-MM-DD inclusive." },
          mask: { type: "string", description: "4-digit account mask." },
          limit: { type: "number", description: "Max results." },
        },
      },
    },
    {
      name: "get_vendor_total",
      description: "Exact YTD total spend, count, date range for a vendor (case-insensitive substring match).",
      input_schema: {
        type: "object",
        properties: { vendor: { type: "string" } },
        required: ["vendor"],
      },
    },
    {
      name: "get_category_breakdown",
      description: `Breakdown for a family category: actual YTD, forecast annual, vendors, optional by-month. Categories: ${FAMILY_CATS.join(", ")}.`,
      input_schema: {
        type: "object",
        properties: {
          category: { type: "string" },
          by_month: { type: "boolean" },
        },
        required: ["category"],
      },
    },
    {
      name: "get_top_expenses",
      description: "Ranked largest expenses for a period, exclusions applied (CC autopay, internal transfers, user-flagged Excluded). USE FOR ANY RANKING — never rank from find_transactions.",
      input_schema: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM for a single month." },
          date_from: { type: "string" },
          date_to: { type: "string" },
          limit: { type: "number", description: "Default 10, cap 50." },
          group_by: { type: "string", enum: ["vendor", "transaction"] },
        },
      },
    },
    {
      name: "get_forecast_vs_actual",
      description: "All family categories at once: forecast annual vs actual YTD vs remaining vs % consumed.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "navigate",
      description: "Action chip for the frontend (clickable). Use to point Ben/Meg to a place in the app.",
      input_schema: {
        type: "object",
        properties: {
          label: { type: "string", description: "Button text, e.g. 'View in Budget'." },
          tab: { type: "string", enum: ["dashboard", "budget", "accounts"] },
          scroll_to: { type: "string", description: "Optional anchor: 'category:<key>', 'vendor:<key>', 'approval_queue'." },
        },
        required: ["label", "tab"],
      },
    },
    {
      name: "save_memory",
      description: "Persist a fact, preference, or observation across sessions.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["fact", "preference", "history"] },
          content: { type: "string" },
        },
        required: ["kind", "content"],
      },
    },
    {
      name: "read_memory",
      description: "Read all saved memory. Returns {facts, preferences, history}.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "write_to_connor_md",
      description: "Append one line to CONNOR.md. ONLY call when the user explicitly says 'write to connor.md' or 'remember this'.",
      input_schema: {
        type: "object",
        required: ["section", "entry"],
        properties: {
          section: { type: "string", enum: ["Facts", "Preferences", "Decisions", "Corrections"] },
          entry: { type: "string" },
        },
      },
    },
  ];
}

// --- tool implementations ---

async function t_find_transactions(input, snap) {
  const tx = snap._plaidTx || [];
  const q = (input.query || "").toLowerCase();
  const amt = input.amount != null ? Math.abs(Number(input.amount)) : null;
  const df = input.date_from, dt = input.date_to;
  const mask = input.mask;
  const limit = input.limit ? Math.max(1, input.limit) : Infinity;
  const yr = snapshotYear();

  const hits = [];
  for (const t of tx) {
    if (!t.date || !t.date.startsWith(yr)) continue;
    if (mask && t.account_mask !== mask) continue;
    if (df && t.date < df) continue;
    if (dt && t.date > dt) continue;
    const desc = ((t.name || "") + " " + (t.merchant_name || "") + " " + (t.original_description || "")).toLowerCase();
    if (q && !desc.includes(q)) continue;
    if (amt != null && Math.abs(Math.abs(t.amount) - amt) > 0.01) continue;
    hits.push({ date: t.date, amount: round(t.amount), name: t.name, mask: t.account_mask });
  }
  hits.sort((a, b) => b.date.localeCompare(a.date));
  return {
    count: hits.length,
    total: round(hits.reduce((s, h) => s + h.amount, 0)),
    shown: Math.min(hits.length, limit),
    transactions: hits.slice(0, limit),
  };
}

async function t_get_vendor_total(input, snap) {
  const result = await t_find_transactions({ query: input.vendor }, snap);
  const positive = result.transactions.filter(t => t.amount > 0);
  if (!positive.length) return { vendor: input.vendor, found: false, count: 0, total: 0 };
  const dates = positive.map(t => t.date).sort();
  return {
    vendor: input.vendor, found: true, count: positive.length,
    total: round(positive.reduce((s, t) => s + t.amount, 0)),
    date_range: { first: dates[0], last: dates[dates.length - 1] },
    transactions: positive.slice(0, 20),
  };
}

async function t_get_category_breakdown(input, snap) {
  const ov = await readOverrides();
  const forecast = await readForecast();
  const requestedCat = input.category;
  const tx = snap._plaidTx || [];
  const txOv = ov.__tx || {};
  const yr = snapshotYear();

  let total = 0, count = 0;
  const byMonth = {};
  const vendorMap = {};

  for (const t of tx) {
    if (!t.date || !t.date.startsWith(yr)) continue;
    if (t.amount <= 0) continue;
    const vKey = normalizeVendor(t.name);
    const txId = mkTxId(t);
    const cat = txOv[txId] || ov[vKey] || "other";
    if (cat !== requestedCat) continue;
    total += t.amount; count++;
    const m = t.date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + t.amount;
    vendorMap[vKey] = (vendorMap[vKey] || { name: vKey, total: 0, count: 0 });
    vendorMap[vKey].total += t.amount;
    vendorMap[vKey].count++;
  }

  const forecastAnnual = forecast[requestedCat] || 0;
  const vendors = Object.values(vendorMap).map(v => ({ ...v, total: round(v.total) })).sort((a, b) => b.total - a.total);

  const out = {
    category: requestedCat,
    actual_ytd: round(total),
    charge_count: count,
    forecast_annual: forecastAnnual,
    remaining: round(forecastAnnual - total),
    pct_consumed: forecastAnnual ? Math.round((total / forecastAnnual) * 100) : null,
    top_vendors: vendors.slice(0, 10),
  };
  if (input.by_month) out.by_month = Object.fromEntries(Object.entries(byMonth).map(([k, v]) => [k, round(v)]));
  return out;
}

async function t_get_top_expenses(input, snap) {
  const tx = snap._plaidTx || [];
  const ov = await readOverrides();
  const txOv = ov.__tx || {};
  const limit = Math.min(input.limit || 10, 50);
  const groupBy = input.group_by || "vendor";
  const yr = snapshotYear();

  let df = input.date_from, dt = input.date_to;
  if (input.month) {
    df = input.month + "-01";
    const [y, m] = input.month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    dt = `${input.month}-${String(lastDay).padStart(2, "0")}`;
  }

  const excludedVendors = new Set();
  for (const [k, v] of Object.entries(ov)) {
    if (k.startsWith("__")) continue;
    if (v === "excluded") excludedVendors.add(k);
  }

  const vendorMap = {};
  const txList = [];
  let grand = 0, count = 0;

  for (const t of tx) {
    if (!t.date || !t.date.startsWith(yr)) continue;
    if (df && t.date < df) continue;
    if (dt && t.date > dt) continue;
    if (t.amount <= 0) continue;

    const vKey = normalizeVendor(t.name);
    const tid = mkTxId(t);
    if (txOv[tid] === "excluded") continue;
    if (excludedVendors.has(vKey) && !txOv[tid]) continue;

    grand += t.amount; count++;
    if (!vendorMap[vKey]) vendorMap[vKey] = { vendor: vKey, total: 0, count: 0, first: t.date, last: t.date };
    vendorMap[vKey].total += t.amount;
    vendorMap[vKey].count++;
    if (t.date < vendorMap[vKey].first) vendorMap[vKey].first = t.date;
    if (t.date > vendorMap[vKey].last) vendorMap[vKey].last = t.date;
    txList.push({ date: t.date, amount: round(t.amount), name: t.name, mask: t.account_mask });
  }

  const vendors = Object.values(vendorMap).map(v => ({ ...v, total: round(v.total) })).sort((a, b) => b.total - a.total);

  if (groupBy === "transaction") {
    txList.sort((a, b) => b.amount - a.amount);
    return {
      period: { from: df || `${yr}-01-01`, to: dt || "today" },
      total_expenses: round(grand), tx_count: count, top: txList.slice(0, limit),
    };
  }
  return {
    period: { from: df || `${yr}-01-01`, to: dt || "today" },
    total_expenses: round(grand), tx_count: count, vendor_count: vendors.length,
    top: vendors.slice(0, limit),
  };
}

async function t_get_forecast_vs_actual(input, snap) {
  const out = [];
  for (const c of FAMILY_CATS) {
    if (c === "excluded") continue;
    const b = await t_get_category_breakdown({ category: c }, snap);
    out.push({
      category: c, forecast: b.forecast_annual, actual: b.actual_ytd,
      remaining: b.remaining, pct_consumed: b.pct_consumed,
    });
  }
  const totalForecast = out.reduce((s, x) => s + x.forecast, 0);
  const totalActual = out.reduce((s, x) => s + x.actual, 0);
  return {
    categories: out,
    total_forecast: round(totalForecast),
    total_actual: round(totalActual),
    total_remaining: round(totalForecast - totalActual),
  };
}

async function t_navigate(input, snap) {
  return {
    __action: { kind: "navigate", label: input.label, tab: input.tab, scroll_to: input.scroll_to },
    ok: true,
  };
}

async function t_save_memory(input, snap) {
  const mem = await readMemory();
  const bucket = input.kind === "fact" ? "facts" : (input.kind === "preference" ? "preferences" : "history");
  mem[bucket] = mem[bucket] || [];
  mem[bucket].push({ content: input.content, saved_at: new Date().toISOString() });
  if (mem[bucket].length > 100) mem[bucket] = mem[bucket].slice(-100);
  await writeMemory(mem);
  return { ok: true, bucket, total_in_bucket: mem[bucket].length };
}

async function t_read_memory(input, snap) {
  return await readMemory();
}

async function t_write_to_connor_md(input, snap) {
  const { appendToConnorMd } = require("./chat");
  await appendToConnorMd(input.section, input.entry);
  return { ok: true, section: input.section, entry: input.entry };
}

const handlers = {
  find_transactions: t_find_transactions,
  get_vendor_total: t_get_vendor_total,
  get_category_breakdown: t_get_category_breakdown,
  get_top_expenses: t_get_top_expenses,
  get_forecast_vs_actual: t_get_forecast_vs_actual,
  navigate: t_navigate,
  save_memory: t_save_memory,
  read_memory: t_read_memory,
  write_to_connor_md: t_write_to_connor_md,
};

async function runTool(name, input, snap) {
  const h = handlers[name];
  if (!h) return { error: `unknown tool: ${name}` };
  return h(input, snap);
}

module.exports = { getToolDefinitions: toolDefs, runTool };
