// tools.js — server-side tool implementations Harold can invoke via Claude tool-calling.
// Each tool takes (input, snapshot) and returns a plain JSON-serializable object.
// Numbers returned here are the ONLY numbers Harold is allowed to quote back.
//
// All persistent state reads from Postgres via data.js. NEVER read/write disk.
//
// HAROLD RECONCILES TO THE DASHBOARD. Every total/ranking/category number Harold
// quotes is sourced from the same `_buildActuals(year)` / `_buildIncome(year)`
// pipeline that backs the Dashboard. We lazy-require server.js inside the
// handlers (not at top level) to avoid a circular import at module load.
const db = require("./data");

// Lazy accessor — resolved on first call, after server.js's module.exports has
// been populated.
let _server = null;
function srv() {
  if (!_server) _server = require("./server");
  return _server;
}

// Categories are now managed via /api/categories (kv-stored). We read fresh
// each time so Harold sees newly-added categories without a server restart.
const CATEGORIES_KEY = "family-categories";
async function readCategoryKeys() {
  const list = await db.kvGet(CATEGORIES_KEY, null);
  if (Array.isArray(list) && list.length) return list.map(c => c.key);
  // Fallback list — matches DEFAULT_CATEGORIES in server.js.
  return [
    "housing", "utilities", "groceries", "dining", "transportation",
    "health", "shopping", "travel", "entertainment", "gifts_charity",
    "kids_activities", "childcare", "education",
    "childcare_babysitters", "childcare_nanny", "childcare_erev", "childcare_ronan", "childcare_caleb", "childcare_other",
    "taxes_professional", "needs_review",
    "other", "excluded",
  ];
}

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

// Resolve a year argument from a tool input. Defaults to current snapshot year.
// Accepts numbers (2025) or strings ("2025"). Returns string "YYYY".
function resolveYear(input) {
  const y = input && input.year;
  if (y == null || y === "") return snapshotYear();
  const n = Number(y);
  if (Number.isFinite(n) && n >= 2000 && n <= 2100) return String(n);
  return snapshotYear();
}

async function toolDefs() {
  const cats = await readCategoryKeys();
  return [
    {
      name: "find_transactions",
      description: "Search transactions across any year (current or prior). Returns a list of matching tx with date, amount, vendor, mask. NO exclusions applied — never use to rank.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive substring on description/merchant." },
          amount: { type: "number", description: "Exact match (absolute, ±$0.01)." },
          year: { type: "number", description: "4-digit year, e.g. 2025. Defaults to current year." },
          date_from: { type: "string", description: "YYYY-MM-DD inclusive. Overrides year." },
          date_to: { type: "string", description: "YYYY-MM-DD inclusive. Overrides year." },
          mask: { type: "string", description: "4-digit account mask." },
          limit: { type: "number", description: "Max results." },
        },
      },
    },
    {
      name: "get_vendor_total",
      description: "Exact total spend, count, date range for a vendor (case-insensitive substring match) for the given year.",
      input_schema: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          year: { type: "number", description: "4-digit year. Defaults to current." },
        },
        required: ["vendor"],
      },
    },
    {
      name: "get_category_breakdown",
      description: `Breakdown for a family category: actual for given year, forecast annual, vendors, optional by-month. Categories: ${cats.join(", ")}.`,
      input_schema: {
        type: "object",
        properties: {
          category: { type: "string" },
          year: { type: "number", description: "4-digit year. Defaults to current." },
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
          year: { type: "number", description: "4-digit year. Defaults to current. Ignored if month/date_from/date_to set." },
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
      description: "All family categories at once: forecast annual vs actual for the year vs remaining vs % consumed.",
      input_schema: {
        type: "object",
        properties: {
          year: { type: "number", description: "4-digit year. Defaults to current." },
        },
      },
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
      name: "write_to_harold_md",
      description: "Append one line to HAROLD.md. ONLY call when the user explicitly says 'write to harold.md' or 'remember this'.",
      input_schema: {
        type: "object",
        required: ["section", "entry"],
        properties: {
          section: { type: "string", enum: ["Facts", "Preferences", "Decisions", "Corrections"] },
          entry: { type: "string" },
        },
      },
    },
    {
      name: "get_investments",
      description: "Full investment position list — Rockefeller brokerage, Megan's 401k, individual real estate property equity, LLY stock, 529s, treasuries, etc. Returns each row with name and current value, plus the grand total. Use whenever Ben or Megan asks about the portfolio, net worth composition, real estate equity, or anything investment-related.",
      input_schema: { type: "object", properties: {} },
    },
  ];
}

// --- tool implementations ---
//
// All "money" tools (totals, rankings, vendor sums, category breakdowns) call
// _buildActuals(year) from server.js — the SAME function that powers the
// Dashboard's Budget tab. This guarantees every number Harold quotes matches
// what the user sees on the Dashboard for the same year. No parallel math.
//
// find_transactions is the lone exception: it's a search across raw tx (so
// users can find a charge by amount/keyword even if it's been excluded). It
// applies cleanDescription on output and labels excluded results so Harold
// never silently includes them in totals.

async function t_find_transactions(input, snap) {
  const { _buildActuals, _buildIncome, cleanDescription } = srv();
  const yr = resolveYear(input);
  const q = (input.query || "").toLowerCase();
  const amt = input.amount != null ? Math.abs(Number(input.amount)) : null;
  const df = input.date_from || `${yr}-01-01`;
  const dt = input.date_to   || `${yr}-12-31`;
  const mask = input.mask;
  const limit = input.limit ? Math.max(1, input.limit) : 50;

  // Pull tx from Dashboard pipelines so categorization + cleaned descriptions
  // are consistent with the UI.
  const actuals = await _buildActuals(yr);
  const income = await _buildIncome(yr);

  const hits = [];
  // Expenses (positive amounts)
  for (const v of actuals.vendors) {
    for (const t of v.txs) {
      if (!t.date || t.date < df || t.date > dt) continue;
      if (mask && t.mask !== mask) continue;
      const desc = (t.desc || "").toLowerCase();
      if (q && !desc.includes(q)) continue;
      if (amt != null && Math.abs(t.amount - amt) > 0.01) continue;
      hits.push({
        date: t.date, amount: round(t.amount), name: t.desc, mask: t.mask,
        category: t.cat, vendor: v.name, side: "expense",
      });
    }
  }
  // Income (negative-from-Plaid; _buildIncome flips sign so amount > 0)
  for (const v of income.vendors) {
    for (const t of v.txs) {
      if (!t.date || t.date < df || t.date > dt) continue;
      if (mask && t.mask !== mask) continue;
      const desc = (t.desc || "").toLowerCase();
      if (q && !desc.includes(q)) continue;
      if (amt != null && Math.abs(t.amount - amt) > 0.01) continue;
      hits.push({
        date: t.date, amount: round(t.amount), name: t.desc, mask: t.mask,
        category: t.cat, vendor: v.name, side: "income",
      });
    }
  }
  hits.sort((a, b) => b.date.localeCompare(a.date));
  return {
    count: hits.length,
    period: { from: df, to: dt },
    shown: Math.min(hits.length, limit),
    transactions: hits.slice(0, limit),
    note: "Includes Excluded tx — do NOT sum these for a total. For totals/rankings use get_top_expenses or get_category_breakdown.",
  };
}

async function t_get_vendor_total(input, snap) {
  const { _buildActuals } = srv();
  const yr = resolveYear(input);
  const q = String(input.vendor || "").toLowerCase();
  if (!q) return { vendor: input.vendor, year: yr, found: false, count: 0, total: 0 };

  const actuals = await _buildActuals(yr);
  // Match against vendor name (post-cleanup) — substring, case-insensitive.
  const matches = actuals.vendors.filter(v =>
    (v.name || "").toLowerCase().includes(q) ||
    (v.key || "").toLowerCase().includes(q)
  );
  if (!matches.length) return { vendor: input.vendor, year: yr, found: false, count: 0, total: 0 };

  // Aggregate across matching vendors. Excluded tx are dropped from total.
  let total = 0, count = 0;
  let first = null, last = null;
  const sample = [];
  const cats = {};
  for (const v of matches) {
    for (const t of v.txs) {
      if (t.cat === "excluded") continue;
      total += t.amount; count++;
      cats[t.cat] = (cats[t.cat] || 0) + t.amount;
      if (!first || t.date < first) first = t.date;
      if (!last  || t.date > last)  last  = t.date;
      if (sample.length < 20) sample.push({ date: t.date, amount: round(t.amount), desc: t.desc, category: t.cat });
    }
  }
  return {
    vendor: input.vendor, year: yr, found: count > 0, count,
    total: round(total),
    date_range: first ? { first, last } : null,
    by_category: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, round(v)])),
    matched_vendors: matches.map(v => ({ name: v.name, key: v.key, total_excluding_excluded: round(v.txs.filter(t => t.cat !== "excluded").reduce((s, t) => s + t.amount, 0)) })),
    transactions: sample,
    note: "Excluded tx removed from total. Numbers match what the Dashboard shows for this vendor in this year.",
  };
}

async function t_get_category_breakdown(input, snap) {
  const { _buildActuals } = srv();
  const yr = resolveYear(input);
  const requestedCat = input.category;
  const forecast = await readForecast(yr);

  const actuals = await _buildActuals(yr);
  let total = 0, count = 0;
  const byMonth = {};
  const vendorMap = {};
  for (const v of actuals.vendors) {
    for (const t of v.txs) {
      if (t.cat !== requestedCat) continue;
      total += t.amount; count++;
      const m = (t.date || "").slice(0, 7);
      if (m) byMonth[m] = (byMonth[m] || 0) + t.amount;
      if (!vendorMap[v.key]) vendorMap[v.key] = { name: v.name, total: 0, count: 0 };
      vendorMap[v.key].total += t.amount;
      vendorMap[v.key].count++;
    }
  }
  const forecastAnnual = forecast[requestedCat] || 0;
  const vendors = Object.values(vendorMap).map(v => ({ ...v, total: round(v.total) })).sort((a, b) => b.total - a.total);
  const out = {
    category: requestedCat, year: yr,
    actual: round(total), charge_count: count,
    forecast_annual: forecastAnnual,
    remaining: round(forecastAnnual - total),
    pct_consumed: forecastAnnual ? Math.round((total / forecastAnnual) * 100) : null,
    top_vendors: vendors.slice(0, 10),
    note: "Sourced from the same pipeline as the Dashboard's Budget tab.",
  };
  if (input.by_month) out.by_month = Object.fromEntries(Object.entries(byMonth).map(([k, v]) => [k, round(v)]));
  return out;
}

async function t_get_top_expenses(input, snap) {
  const { _buildActuals } = srv();
  const yr = resolveYear(input);
  const limit = Math.min(input.limit || 10, 50);
  const groupBy = input.group_by || "vendor";

  let df = input.date_from, dt = input.date_to;
  if (input.month) {
    df = input.month + "-01";
    const [y, m] = input.month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    dt = `${input.month}-${String(lastDay).padStart(2, "0")}`;
  }
  if (!df) df = `${yr}-01-01`;
  if (!dt) dt = `${yr}-12-31`;

  const actuals = await _buildActuals(yr);

  if (groupBy === "transaction") {
    const txList = [];
    let grand = 0, count = 0;
    for (const v of actuals.vendors) {
      for (const t of v.txs) {
        if (t.cat === "excluded") continue;
        if (!t.date || t.date < df || t.date > dt) continue;
        grand += t.amount; count++;
        txList.push({ date: t.date, amount: round(t.amount), name: t.desc, mask: t.mask, vendor: v.name, category: t.cat });
      }
    }
    txList.sort((a, b) => b.amount - a.amount);
    return {
      period: { from: df, to: dt },
      total_expenses: round(grand), tx_count: count,
      top: txList.slice(0, limit),
    };
  }

  // group_by vendor (default): aggregate over date window, drop excluded.
  const vendorMap = {};
  let grand = 0, count = 0;
  for (const v of actuals.vendors) {
    for (const t of v.txs) {
      if (t.cat === "excluded") continue;
      if (!t.date || t.date < df || t.date > dt) continue;
      grand += t.amount; count++;
      if (!vendorMap[v.key]) vendorMap[v.key] = { vendor: v.name, total: 0, count: 0, first: t.date, last: t.date };
      const row = vendorMap[v.key];
      row.total += t.amount; row.count++;
      if (t.date < row.first) row.first = t.date;
      if (t.date > row.last)  row.last  = t.date;
    }
  }
  const vendors = Object.values(vendorMap).map(v => ({ ...v, total: round(v.total) })).sort((a, b) => b.total - a.total);
  return {
    period: { from: df, to: dt },
    total_expenses: round(grand), tx_count: count, vendor_count: vendors.length,
    top: vendors.slice(0, limit),
    note: "Excluded tx removed. Total matches the Dashboard's Expenses figure for this period.",
  };
}

async function t_get_forecast_vs_actual(input, snap) {
  const { _buildActuals } = srv();
  const yr = resolveYear(input);
  const cats = await readCategoryKeys();
  const forecast = await readForecast(yr);
  const actuals = await _buildActuals(yr);

  // Sum tx by category from the Dashboard pipeline.
  const byCat = {};
  for (const v of actuals.vendors) {
    for (const t of v.txs) {
      byCat[t.cat] = (byCat[t.cat] || 0) + t.amount;
    }
  }

  const out = [];
  let totalForecast = 0, totalActual = 0;
  for (const c of cats) {
    if (c === "excluded") continue;
    const actualVal = round(byCat[c] || 0);
    const forecastVal = forecast[c] || 0;
    totalForecast += forecastVal;
    totalActual += actualVal;
    out.push({
      category: c, forecast: forecastVal, actual: actualVal,
      remaining: round(forecastVal - actualVal),
      pct_consumed: forecastVal ? Math.round((actualVal / forecastVal) * 100) : null,
    });
  }
  return {
    year: yr,
    categories: out,
    total_forecast: round(totalForecast),
    total_actual: round(totalActual),
    total_remaining: round(totalForecast - totalActual),
    excluded_total: round(byCat["excluded"] || 0),
    note: "total_actual matches the Dashboard's Expenses YTD/year figure (excluded amount is reported separately for context).",
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

async function t_write_to_harold_md(input, snap) {
  const { appendToHaroldMd } = require("./chat");
  await appendToHaroldMd(input.section, input.entry);
  return { ok: true, section: input.section, entry: input.entry };
}

async function t_get_investments(input, snap) {
  const list = (await db.kvGet("family-investments", [])) || [];
  const rows = (Array.isArray(list) ? list : []).map(x => ({
    name: x.name,
    value: Math.round(Number(x.value) || 0),
    note: x.note || "",
    updated_at: x.updated_at,
  })).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return { count: rows.length, total, investments: rows };
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
  write_to_harold_md: t_write_to_harold_md,
  // legacy alias — old conversations may still emit the old name
  write_to_connor_md: t_write_to_harold_md,
  get_investments: t_get_investments,
};

async function runTool(name, input, snap) {
  const h = handlers[name];
  if (!h) return { error: `unknown tool: ${name}` };
  return h(input, snap);
}

module.exports = { getToolDefinitions: toolDefs, runTool };
