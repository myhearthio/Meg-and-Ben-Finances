// Meg & Ben Finance — Express backend.
// All persistent state in Postgres via data.js. NEVER write to local disk.
//
// Endpoints:
//   GET  /api/snapshot           — cached 60s, full dashboard state
//   POST /api/chat               — Harold proxy
//   POST /api/plaid/link         — create link token
//   POST /api/plaid/exchange     — exchange public token
//   GET  /api/plaid/status       — { connected: bool }
//   POST /api/upload/csv?mask=&kind=  — Chase CSV upload
//   GET  /api/upload/status
//   GET/POST /api/forecast       — annual forecast amounts per category
//   GET/POST /api/actuals        — vendor + per-tx category overrides
//   GET  /api/version            — running commit SHA
//   GET  /api/harold/md
//   GET  /api/harold/history
//   POST /api/harold/history/clear
//   (legacy aliases /api/connor/* still work)
//   GET  /api/debug/find
//   GET  /oauth-return

const express = require("express");
const cors = require("cors");
const path = require("path");

const db = require("./data");
const plaid = require("./plaid");
const csv = require("./csv");
const { buildSnapshot } = require("./snapshot");
const { chat, readHaroldMd, readHistory, writeHistory } = require("./chat");

const app = express();
const BOOT_TIME = new Date().toISOString();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const frontendDir = path.join(__dirname, "frontend");
app.use("/", express.static(frontendDir));

// ---- snapshot cache (60s, invalidated on every write) — keyed by year ----
let snapCache = new Map(); // year -> { data, ts, inflight }
const CACHE_MS = 60_000;
function invalidateCache() { snapCache = new Map(); }

// ---- categories (Postgres-backed; client-managed) ----
// kv key "family-categories" stores the full ordered list. If empty, we seed
// with DEFAULT_CATEGORIES. Schema per item: { key, label, parent?, isExcluded? }
const CATEGORIES_KEY = "family-categories";
const DEFAULT_CATEGORIES = [
  { key: "housing", label: "Housing" },
  { key: "utilities", label: "Utilities" },
  { key: "groceries", label: "Groceries" },
  { key: "dining", label: "Dining & Takeout" },
  { key: "transportation", label: "Transportation" },
  { key: "health", label: "Health" },
  { key: "health_megan", label: "Megan", parent: "health" },
  { key: "health_ben", label: "Ben", parent: "health" },
  { key: "health_children", label: "Children", parent: "health" },
  { key: "shopping", label: "Shopping" },
  { key: "shopping_megan", label: "Megan", parent: "shopping" },
  { key: "shopping_ben", label: "Ben", parent: "shopping" },
  { key: "shopping_children", label: "Children", parent: "shopping" },
  { key: "kids_activities", label: "Children's Activities" },
  { key: "childcare", label: "Childcare" },
  { key: "childcare_babysitters", label: "Babysitters", parent: "childcare" },
  { key: "childcare_nanny", label: "Nanny", parent: "childcare" },
  { key: "childcare_erev", label: "Erev", parent: "childcare" },
  { key: "childcare_ronan", label: "Ronan", parent: "childcare" },
  { key: "childcare_caleb", label: "Caleb", parent: "childcare" },
  { key: "childcare_other", label: "Other", parent: "childcare" },
  { key: "education", label: "Education" },
  { key: "travel", label: "Travel & Vacation" },
  { key: "travel_general", label: "General (lodging, flights, etc.)", parent: "travel" },
  { key: "travel_dining", label: "Dining", parent: "travel" },
  { key: "travel_activities", label: "Activities", parent: "travel" },
  { key: "travel_childcare", label: "Childcare", parent: "travel" },
  { key: "entertainment", label: "Entertainment & Subscriptions" },
  { key: "gifts_charity", label: "Gifts & Charity" },
  { key: "taxes_professional", label: "Taxes & Professional Services" },
  { key: "needs_review", label: "Needs Review" },
  { key: "other", label: "Other" },
  { key: "excluded", label: "Excluded (paid from savings/investments)", isExcluded: true },
];
async function _readCategories() {
  const saved = await db.kvGet(CATEGORIES_KEY, null);
  if (Array.isArray(saved) && saved.length) return saved;
  await db.kvSet(CATEGORIES_KEY, DEFAULT_CATEGORIES);
  return DEFAULT_CATEGORIES;
}
async function _writeCategories(list) { await db.kvSet(CATEGORIES_KEY, list); }

// ---- override + forecast plumbing (Postgres-backed) ----
const OVERRIDES_KEY = "family-overrides";
const FORECAST_KEY = "family-forecast"; // legacy, treated as 2025
const FORECAST_KEY_FOR = (year) => `family-forecast-${year}`;

async function _readOverrides() { return (await db.kvGet(OVERRIDES_KEY, {})) || {}; }
async function _writeOverrides(obj) { await db.kvSet(OVERRIDES_KEY, obj); }
async function _readForecast(year) {
  const yr = String(year || new Date().getFullYear());
  // Try year-specific key first; fall back to legacy single-blob (which is 2025 historically).
  const yearly = await db.kvGet(FORECAST_KEY_FOR(yr), null);
  if (yearly && Object.keys(yearly).length > 0) return yearly;
  if (yr === "2025") return (await db.kvGet(FORECAST_KEY, {})) || {};
  return {};
}
async function _writeForecast(obj, year) {
  const yr = String(year || new Date().getFullYear());
  await db.kvSet(FORECAST_KEY_FOR(yr), obj);
}

// Single-promise queue serializes override writes against concurrent requests.
let _writeQueue = Promise.resolve();
function _queueOverrideUpdate(mutator) {
  _writeQueue = _writeQueue.then(async () => {
    const obj = await _readOverrides();
    await mutator(obj);
    await _writeOverrides(obj);
  }).catch(e => { console.log("override queue err:", e.message); });
  return _writeQueue;
}

// ---- income overrides (separate namespace from expense overrides) ----
// Same shape as the expense overrides blob:
//   { [vendorKey]: "megan"|"ben"|"excluded", __tx: { [txId]: cat }, __names: {...}, __tx_desc: {...} }
// Unknown vendors default to "excluded" so transfers/refunds don't inflate income totals
// until the user explicitly tags them as Megan or Ben.
const INCOME_OVERRIDES_KEY = "family-income-overrides";
async function _readIncomeOverrides() { return (await db.kvGet(INCOME_OVERRIDES_KEY, {})) || {}; }
async function _writeIncomeOverrides(obj) { await db.kvSet(INCOME_OVERRIDES_KEY, obj); }
let _incomeWriteQueue = Promise.resolve();
function _queueIncomeOverrideUpdate(mutator) {
  _incomeWriteQueue = _incomeWriteQueue.then(async () => {
    const obj = await _readIncomeOverrides();
    await mutator(obj);
    await _writeIncomeOverrides(obj);
  }).catch(e => { console.log("income override queue err:", e.message); });
  return _incomeWriteQueue;
}

// Strip noise reference numbers from raw bank/Plaid descriptions while
// preserving real content (names of payees/payers, cities, "TO/FROM",
// purpose words). Applied at display time only — the raw description stays
// intact in storage so we can re-derive vendor keys etc.
//
// Examples:
//   "VENMO PAYMENT 1043619564310 : ACH Electronic Debit"   → "VENMO PAYMENT : ACH Electronic Debit"
//   "ZELLE PAYMENT TO JOHN SMITH 1234567890"                → "ZELLE PAYMENT TO JOHN SMITH"
//   "CHASE CREDIT CRD AUTOPAY PPD ID: 4760039224"           → "CHASE CREDIT CRD AUTOPAY"
//   "Online Transfer to chk 7500 transaction#: 22587410876" → "Online Transfer to chk 7500"
//   "ACH Debit ORIG CO NAME:CENTRAL LOAN ADM ORIG ID:1234567890" → "ACH Debit ORIG CO NAME:CENTRAL LOAN ADM"
function cleanDescription(raw) {
  if (!raw) return "";
  let s = String(raw);
  // Drop "PPD ID:", "WEB ID:", "CCD ID:" and the digits after them.
  s = s.replace(/\b(PPD|WEB|CCD|TEL|ARC)\s*ID:\s*\d+/gi, "");
  // Drop "ORIG ID:1234567890" etc.
  s = s.replace(/\bORIG\s*ID:\s*\d+/gi, "");
  // Drop "REF#1234567" / "REF# 1234567" / "Ref:1234567"
  s = s.replace(/\bREF\s*[:#]\s*\d+/gi, "");
  // Drop "transaction#: 22587410876" / "trans#:1234567"
  s = s.replace(/\b(transaction|trans|trace|conf(irmation)?)\s*[#:]\s*\d+/gi, "");
  // Drop "DESC DATE:240130" style.
  s = s.replace(/\bDESC\s*DATE:\s*\d+/gi, "");
  // Drop standalone long digit blobs (7+ chars). These are ACH trace IDs,
  // Venmo payment IDs, Plaid web IDs, check numbers in the middle of text.
  // Use word-boundary so it doesn't eat dollar amounts (those have decimals).
  s = s.replace(/\b\d{7,}\b/g, "");
  // Collapse leftover punctuation islands like " :  " or "  -  ".
  s = s.replace(/\s*:\s*:\s*/g, " : ");
  s = s.replace(/\s+/g, " ").trim();
  // Trim a trailing colon/comma/dash that's now dangling.
  s = s.replace(/[\s:,\-]+$/, "");
  return s;
}

function normalizeVendor(raw) {
  if (!raw) return "UNKNOWN";
  let s = String(raw).toUpperCase().trim();
  // Zelle/JPM per-payment reference codes (e.g. JPM99CCOFJLS) are unique per
  // payment — if they survive into the vendor key, every payment to the same
  // person becomes a "new vendor" and per-vendor learning never sticks.
  // Strip them up front, before any matching.
  s = s.replace(/\s+JPM[A-Z0-9]{8,}\b/g, "").trim();
  let m = s.match(/ORIG CO NAME:\s*([A-Z0-9&.\- ]+?)(?:\s+ORIG ID|\s+DESC DATE|$)/);
  if (m) return m[1].replace(/\s+/g, " ").trim();
  // Name class includes digits, parens, comma, & and / so descriptions like
  // "LESLIE (SITTER)" or "J&J LANDSCAPING" keep their full name.
  m = s.match(/ZELLE PAYMENT TO\s+([A-Z0-9\s.,'()&\/-]+?)$/);
  if (m) return "ZELLE: " + m[1].replace(/\s+\d{5,}\s*$/, "").replace(/\s+/g, " ").trim();
  m = s.match(/ONLINE ACH PAYMENT TO\s+([A-Z0-9 ]+?)\s*\(/);
  if (m) return m[1].replace(/\s+/g, " ").trim();
  if (/ONLINE TRANSFER TO CHK/.test(s)) return "ONLINE TRANSFER TO CHK";
  if (/^CHECK\b/.test(s)) return "CHECK";
  if (/^ATM WITHDRAWAL/.test(s)) return "ATM WITHDRAWAL";
  if (/VENMO/.test(s)) return "VENMO";
  // Known multi-format merchants — collapse all variants into a single vendor key
  // so per-order codes and POS-debit prefixes don't fragment the same merchant
  // across many vendor rows.
  if (/AMAZON|AMZN/.test(s)) return "AMAZON";
  if (/ANTHROPIC/.test(s)) return "ANTHROPIC";
  s = s.replace(/^(TST\*|SQ\s*\*|SP\s+|PAYPAL\s*\*|PP\*|IN\s*\*)/i, "");
  s = s.replace(/\s*\*\s*-?\d{4,}\s*$/, "");
  s = s.replace(/\s*REF#?\s*\d+\s*$/i, "");
  s = s.replace(/\s*-\d{6,}[A-Z]*\s*$/, "");
  s = s.replace(/\s+[A-Z]{2}\s*$/, "");
  s = s.replace(/\s+[A-Z][A-Z\s]+\s+[A-Z]{2}\s*$/, "");
  s = s.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, "");
  s = s.replace(/\s+\d{4,}\s*/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s || "UNKNOWN";
}

async function gatherSnapshot(year) {
  let accounts = [], plaidTx = [];
  try { accounts = await plaid.getAccounts(); } catch (e) { console.log("plaid accounts err:", e.message); }
  try { plaidTx = await plaid.getYTDTransactions(); } catch (e) { console.log("plaid tx err:", e.message); }

  const acctById = {};
  for (const a of accounts) acctById[a.account_id] = a;
  for (const t of plaidTx) {
    const a = acctById[t.account_id];
    if (a) {
      t.account_mask = a.mask;
      t.account_type = a.type;
      t.account_subtype = a.subtype;
    }
  }

  // ---- Personal-accounts allow-list ----
  // Hardcoded. Anything not in this list (e.g. business accounts the user re-linked
  // through Plaid) is filtered out before snapshot building. Family CFO is for
  // personal finances only — business accounts must never appear in Income,
  // Expenses, the Approval Queue, KPIs, or the sidebar.
  // 0485 Ben checking, 5538 Ben credit, 6002 Megan checking, 4547 Megan credit.
  // Excluded: 5814 (dupe of 5538), 5706 (ignore), 7500 (business).
  const ALLOWED_MASKS = new Set(["0485", "5538", "6002", "4547"]);
  accounts = accounts.filter(a => ALLOWED_MASKS.has(a.mask));
  plaidTx = plaidTx.filter(t => ALLOWED_MASKS.has(t.account_mask));

  const finalTx = [...plaidTx];
  const accountsWithCsv = [...accounts];
  const masks = csv.listMasks();
  for (const mask of masks) {
    if (!ALLOWED_MASKS.has(mask)) continue; // skip phased-out / business CSVs
    const csvRes = csv.loadCsvTx(mask);
    const plaidForMask = plaidTx.filter(t => t.account_mask === mask);
    const plaidMinDate = plaidForMask.reduce((m, t) => (!m || t.date < m) ? t.date : m, null);
    const realAcct = accounts.find(a => a.mask === mask);
    const acctId = realAcct ? realAcct.account_id : `csv-${mask}`;
    const kind = csv.getKind(mask) || (realAcct ? realAcct.type : "depository");
    for (const t of csvRes.transactions) {
      if (plaidMinDate && t.date >= plaidMinDate) continue;
      finalTx.push({
        account_id: acctId,
        amount: t.amount, name: t.name, date: t.date,
        account_mask: mask, account_type: kind, source: "csv",
      });
    }
    if (!realAcct) {
      accountsWithCsv.push({
        account_id: `csv-${mask}`, mask,
        name: `Account ${mask} (CSV)`,
        type: kind, subtype: kind === "credit" ? "credit card" : "checking",
        balances: { current: 0 },
      });
    }
  }

  const overrides = await _readOverrides();
  const incomeOverrides = await _readIncomeOverrides();
  const excludedTxIds = new Set();
  {
    const txOv = overrides.__tx || {};
    const vendorExcluded = new Set();
    for (const [k, cat] of Object.entries(overrides)) {
      if (k.startsWith("__")) continue;
      if (cat === "excluded") vendorExcluded.add(k);
    }
    // Income-side excludes: vendors and per-tx tagged "excluded" in the income namespace.
    // Income unknowns default to excluded too (so deposits don't inflate income until
    // the user explicitly tags them as megan/ben).
    const incomeTxOv = incomeOverrides.__tx || {};
    const incomeVendorCat = {};
    for (const [k, cat] of Object.entries(incomeOverrides)) {
      if (k.startsWith("__")) continue;
      incomeVendorCat[k] = cat;
    }
    for (const t of finalTx) {
      const raw = String(t.name || "").trim();
      const txId = (t.date || "") + "|" + Number(t.amount) + "|" + raw.slice(0, 60);
      // Deposit (income side): negative amount in a depository account.
      const isDeposit = t.amount < 0 && (t.account_type || "").toLowerCase() === "depository";
      if (isDeposit) {
        const perTx = incomeTxOv[txId];
        if (perTx === "excluded") { excludedTxIds.add(txId); continue; }
        if (perTx) continue; // megan/ben → counts as income
        const vKey = normalizeVendor(raw);
        const vCat = incomeVendorCat[vKey];
        if (vCat === "excluded") { excludedTxIds.add(txId); continue; }
        if (vCat) continue; // megan/ben → counts
        // Unknown income vendor → default excluded
        excludedTxIds.add(txId);
        continue;
      }
      // Expense side (existing logic)
      const perTx = txOv[txId];
      if (perTx === "excluded") { excludedTxIds.add(txId); continue; }
      if (perTx) continue;
      const vKey = normalizeVendor(raw);
      if (vendorExcluded.has(vKey)) excludedTxIds.add(txId);
    }
  }

  const snap = await buildSnapshot({ accounts: accountsWithCsv, plaidTx: finalTx, excludedTxIds, year });
  snap._plaidTx = finalTx;

  // Investments total (sum of /api/investments rows). Add to kpis so frontend
  // can compute net worth = cash_on_hand + investments_total.
  try {
    const invList = await db.kvGet(INVESTMENTS_KEY, []);
    const invTotal = (Array.isArray(invList) ? invList : []).reduce((s, x) => s + (Number(x.value) || 0), 0);
    snap.kpis = snap.kpis || {};
    snap.kpis.investments_total = Math.round(invTotal * 100) / 100;
    snap.kpis.net_worth = Math.round((snap.kpis.cash_on_hand + invTotal) * 100) / 100;
  } catch (e) { console.log("inv total err:", e.message); }

  return snap;
}

async function gatherSnapshotForYear(year) {
  // re-build the same finalTx + excludedTxIds plumbing but pass year through
  return await gatherSnapshot(year);
}

async function getSnapshot(force = false, year) {
  const Y = Number(year) || new Date().getFullYear();
  const slot = snapCache.get(Y) || { data: null, ts: 0, inflight: null };
  const now = Date.now();
  if (!force && slot.data && (now - slot.ts) < CACHE_MS) return slot.data;
  if (slot.inflight) return slot.inflight;
  slot.inflight = (async () => {
    try {
      const snap = await gatherSnapshotForYear(Y);
      slot.data = snap; slot.ts = Date.now();
      snapCache.set(Y, slot);
      return snap;
    } finally { slot.inflight = null; }
  })();
  snapCache.set(Y, slot);
  return slot.inflight;
}

// ---- endpoints ----
app.get("/api/snapshot", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const year = req.query.year;
    const snap = await getSnapshot(force, year);
    const { _plaidTx, ...safe } = snap;
    res.json(safe);
  } catch (e) { console.log("snapshot err:", e); res.status(500).json({ error: e.message }); }
});

app.post("/api/chat", async (req, res) => {
  try {
    const snap = await getSnapshot(false);
    const incoming = req.body.messages || [];
    const result = await chat(incoming, snap);
    const assistantMsg = { role: "assistant", content: result.text, actions: result.actions || [], ts: Date.now() };
    const fullHistory = [...incoming.map(m => ({ role: m.role, content: m.content })), assistantMsg];
    try { await writeHistory(fullHistory); } catch (e) { console.log("history write err:", e.message); }
    res.json({
      text: result.text, actions: result.actions || [],
      tool_calls: (result.toolCalls || []).map(tc => ({ name: tc.name, input: tc.input })),
    });
  } catch (e) { console.log("chat err:", e); res.status(500).json({ error: e.message }); }
});

app.get("/api/harold/md", async (req, res) => {
  try { res.type("text/plain").send(await readHaroldMd()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/harold/history", async (req, res) => {
  try { res.json({ messages: await readHistory() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/harold/history/clear", async (req, res) => {
  try { await writeHistory([]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy aliases — keep so old clients / cached assets don't break.
app.get("/api/connor/md", async (req, res) => {
  try { res.type("text/plain").send(await readHaroldMd()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/connor/history", async (req, res) => {
  try { res.json({ messages: await readHistory() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/connor/history/clear", async (req, res) => {
  try { await writeHistory([]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/plaid/link", async (req, res) => {
  try {
    const token = await plaid.createLinkToken();
    res.json({ link_token: token });
  } catch (e) {
    console.log("plaid link err:", e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error_message || e.message });
  }
});

app.post("/api/plaid/exchange", async (req, res) => {
  try {
    await plaid.exchange(req.body.public_token);
    invalidateCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/plaid/status", async (req, res) => {
  await plaid.ensureTokenLoaded();
  const items = plaid.getItems().map(it => ({
    item_id: it.item_id,
    institution_name: it.institution_name,
    added_at: it.added_at,
  }));
  res.json({ connected: items.length > 0, items });
});

app.post("/api/plaid/remove", async (req, res) => {
  try {
    const itemId = (req.body && req.body.item_id) || "";
    if (!itemId) return res.status(400).json({ error: "item_id required" });
    await plaid.removeItem(itemId);
    invalidateCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/upload/csv", express.text({ type: "*/*", limit: "25mb" }), async (req, res) => {
  try {
    const mask = String(req.query.mask || "").trim();
    const kind = String(req.query.kind || "depository").trim();
    if (!/^\d{4}$/.test(mask)) return res.status(400).json({ error: "mask must be 4 digits" });
    if (!["depository", "credit"].includes(kind)) return res.status(400).json({ error: "kind must be depository or credit" });
    const csvText = req.body;
    if (!csvText || typeof csvText !== "string" || csvText.length < 10) {
      return res.status(400).json({ error: "empty or missing CSV body" });
    }
    const parsed = csv.parseChaseCsv(csvText, mask);
    if (!parsed.format) return res.status(400).json({ error: parsed.error || "unrecognized CSV format" });
    await csv.saveCsv(mask, csvText, kind);
    invalidateCache();
    res.json({
      ok: true, mask, kind, format: parsed.format, count: parsed.transactions.length,
      date_range: {
        min: parsed.transactions.reduce((m, t) => !m || t.date < m ? t.date : m, null),
        max: parsed.transactions.reduce((m, t) => !m || t.date > m ? t.date : m, null),
      },
    });
  } catch (e) { console.log("csv upload err:", e); res.status(500).json({ error: e.message }); }
});

app.get("/api/upload/csv/:mask", async (req, res) => {
  try {
    const row = await db.csvGet(req.params.mask);
    if (!row) return res.status(404).json({ error: "not found" });
    res.type("text/plain").send(row.csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/upload/status", (req, res) => {
  const out = {};
  for (const m of csv.listMasks()) {
    const r = csv.loadCsvTx(m);
    out[m] = {
      has_csv: csv.hasCsv(m), kind: csv.getKind(m), format: r.format,
      count: r.transactions.length,
      max_date: r.transactions.reduce((mx, t) => !mx || t.date > mx ? t.date : mx, null),
    };
  }
  res.json(out);
});

app.get("/api/forecast", async (req, res) => res.json(await _readForecast(req.query.year)));
app.post("/api/forecast", async (req, res) => {
  try {
    const { category, amount, year } = req.body || {};
    if (!category) return res.status(400).json({ error: "category required" });
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "amount must be a non-negative number" });
    const cur = await _readForecast(year);
    cur[category] = Math.round(n);
    await _writeForecast(cur, year);
    invalidateCache();
    res.json({ ok: true, forecast: cur });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Income forecast (year-keyed, person-keyed) ----
// Keys: "megan", "ben". Same shape as expense forecast.
const INCOME_FORECAST_KEY_FOR = (year) => `family-income-forecast-${year}`;
async function _readIncomeForecast(year) {
  const yr = String(year || new Date().getFullYear());
  return (await db.kvGet(INCOME_FORECAST_KEY_FOR(yr), {})) || {};
}
async function _writeIncomeForecast(obj, year) {
  const yr = String(year || new Date().getFullYear());
  await db.kvSet(INCOME_FORECAST_KEY_FOR(yr), obj);
}
app.get("/api/income-forecast", async (req, res) => {
  res.json(await _readIncomeForecast(req.query.year));
});
app.post("/api/income-forecast", async (req, res) => {
  try {
    const { person, amount, year } = req.body || {};
    if (!person) return res.status(400).json({ error: "person required" });
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "amount must be a non-negative number" });
    const cur = await _readIncomeForecast(year);
    cur[String(person).toLowerCase()] = Math.round(n);
    await _writeIncomeForecast(cur, year);
    res.json({ ok: true, forecast: cur });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- Auto-categorization (suggestions only — never silently writes) -----
// Maps Plaid's personal_finance_category + vendor keywords to family categories.
// Returns a category key (e.g. "groceries") or "" if no confident guess.
function guessCategory(t) {
  const desc = String(t.desc || "").toUpperCase();
  const pfc = t.pfcDetailed || "";
  const primary = t.pfcPrimary || "";

  // 1) Vendor keyword overrides (highest priority — most accurate for our use)
  const KW = [
    [/WHOLE FOODS|TRADER JOE|ALDI|WEGMANS|SAFEWAY|KROGER|SHOPRITE|FAIRWAY|GRISTEDES|PUBLIX|FRESH DIRECT|GOPUFF|H MART|SPROUTS/, "groceries"],
    [/UBER EATS|DOORDASH|GRUBHUB|SEAMLESS|CHIPOTLE|SWEETGREEN|CAVA|DUNKIN|STARBUCKS|MCDONALD|CHICK-FIL-A|SHAKE SHACK|JOE.S? COFFEE|BLUE BOTTLE|PANERA|TST\*|TOAST/, "dining"],
    [/UBER\b|LYFT|REVEL|CITIBIKE|MTA|METRO|NJ TRANSIT|AMTRAK|SHELL|EXXON|MOBIL|BP\b|CHEVRON|PARKING|GARAGE|TOLL|EZPASS|E-?ZPASS/, "transportation"],
    [/CON ?ED|CONSOLIDATED EDISON|NATIONAL GRID|SPECTRUM|VERIZON|XFINITY|COMCAST|T-MOBILE|AT&T|OPTIMUM|RCN|ATLANTIC BROADBAND/, "utilities"],
    [/RENT|MORTGAGE|HOA|HOMEOWNERS|LANDLORD/, "housing"],
    [/CVS|WALGREENS|RITE AID|DUANE READE|PHARMACY|ONE MEDICAL|CITYMD|MOUNT SINAI|NYU LANGONE|HOSPITAL|DENTAL|DENTIST|VISION|EYE.*DOCTOR|OPTOMETR|ZOCDOC/, "health"],
    [/AMAZON|TARGET|WALMART|COSTCO|BEST BUY|HOME DEPOT|LOWES|IKEA|WAYFAIR|MACY|NORDSTROM|BLOOMINGDALE|UNIQLO|ZARA|H&M|GAP\b|OLD NAVY|SEPHORA|ULTA|REI\b|DICK.S/, "shopping"],
    [/AIRBNB|MARRIOTT|HILTON|HYATT|EXPEDIA|BOOKING\.COM|UNITED AIR|AMERICAN AIR|DELTA|JETBLUE|SOUTHWEST|FLIGHT|HOTEL/, "travel"],
    [/NETFLIX|HULU|SPOTIFY|APPLE\.COM|APPLE TV|DISNEY|HBO|PARAMOUNT|PEACOCK|YOUTUBE PREMIUM|AUDIBLE|KINDLE|GOOGLE ?ONE|ICLOUD|CHATGPT|OPENAI|ANTHROPIC|MIDJOURNEY|NYTIMES|WSJ|SUBSTACK|PATREON/, "entertainment"],
    [/IRS\b|H&R BLOCK|TURBOTAX|TAX |CPA|ACCOUNTANT|LEGALZOOM|LAWYER|ATTORNEY/, "taxes_professional"],
    [/CHURCH|SYNAGOGUE|MOSQUE|TEMPLE|CHARITY|DONAT|GOFUNDME|CHABAD|JCC|UJA/, "gifts_charity"],
  ];
  for (const [re, cat] of KW) if (re.test(desc)) return cat;

  // 2) Plaid's personal_finance_category mapping (detailed)
  const PFC = {
    "FOOD_AND_DRINK_GROCERIES": "groceries",
    "FOOD_AND_DRINK_RESTAURANT": "dining",
    "FOOD_AND_DRINK_FAST_FOOD": "dining",
    "FOOD_AND_DRINK_COFFEE": "dining",
    "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR": "dining",
    "TRANSPORTATION_TAXIS_AND_RIDE_SHARES": "transportation",
    "TRANSPORTATION_PUBLIC_TRANSIT": "transportation",
    "TRANSPORTATION_GAS": "transportation",
    "TRANSPORTATION_PARKING": "transportation",
    "TRANSPORTATION_TOLLS": "transportation",
    "TRAVEL_FLIGHTS": "travel",
    "TRAVEL_LODGING": "travel",
    "TRAVEL_RENTAL_CARS": "travel",
    "RENT_AND_UTILITIES_RENT": "housing",
    "RENT_AND_UTILITIES_INTERNET_AND_CABLE": "utilities",
    "RENT_AND_UTILITIES_TELEPHONE": "utilities",
    "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY": "utilities",
    "RENT_AND_UTILITIES_WATER": "utilities",
    "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT": "utilities",
    "MEDICAL_PRIMARY_CARE": "health",
    "MEDICAL_DENTAL_CARE": "health",
    "MEDICAL_EYE_CARE": "health",
    "MEDICAL_PHARMACIES_AND_SUPPLEMENTS": "health",
    "MEDICAL_VETERINARY_SERVICES": "health",
    "MEDICAL_NURSING_CARE": "health",
    "MEDICAL_OTHER_MEDICAL": "health",
    "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES": "shopping",
    "GENERAL_MERCHANDISE_DEPARTMENT_STORES": "shopping",
    "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES": "shopping",
    "GENERAL_MERCHANDISE_SUPERSTORES": "shopping",
    "GENERAL_MERCHANDISE_ELECTRONICS": "shopping",
    "GENERAL_MERCHANDISE_OFFICE_SUPPLIES": "shopping",
    "GENERAL_MERCHANDISE_SPORTING_GOODS": "shopping",
    "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS": "shopping",
    "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES": "shopping",
    "ENTERTAINMENT_TV_AND_MOVIES": "entertainment",
    "ENTERTAINMENT_MUSIC_AND_AUDIO": "entertainment",
    "ENTERTAINMENT_VIDEO_GAMES": "entertainment",
    "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS": "entertainment",
    "ENTERTAINMENT_CASINOS_AND_GAMBLING": "entertainment",
    "PERSONAL_CARE_HAIR_AND_BEAUTY": "shopping",
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS": "health",
    "GENERAL_SERVICES_CHILDCARE": "childcare",
    "GENERAL_SERVICES_EDUCATION": "education",
    "HOME_IMPROVEMENT_HARDWARE": "shopping",
    "HOME_IMPROVEMENT_FURNITURE": "shopping",
  };
  if (PFC[pfc]) return PFC[pfc];

  // 3) Coarse Plaid primary category fallback
  const PRIMARY = {
    "FOOD_AND_DRINK": "dining",
    "TRANSPORTATION": "transportation",
    "TRAVEL": "travel",
    "RENT_AND_UTILITIES": "utilities",
    "MEDICAL": "health",
    "ENTERTAINMENT": "entertainment",
    "GENERAL_MERCHANDISE": "shopping",
    "PERSONAL_CARE": "shopping",
    "HOME_IMPROVEMENT": "shopping",
  };
  if (PRIMARY[primary]) return PRIMARY[primary];

  return "";
}

async function _buildActuals(yearOverride) {
  const snap = await getSnapshot(false);
  const tx = snap._plaidTx || [];
  const overrides = await _readOverrides();
  const txOv = overrides.__tx || {};
  const nameOv = overrides.__names || {};
  const txDescOv = overrides.__tx_desc || {};

  const yr = String(yearOverride || Number(process.env.SNAPSHOT_YEAR) || new Date().getFullYear());
  const unrolledPrefixes = [/^CHECK\b/i];
  const txList = [];
  let txIdx = 0;
  for (const t of tx) {
    if (!t.date || !t.date.startsWith(yr)) continue;
    let kind = (t.account_type || "").toLowerCase();
    if (!kind && t.account_mask) kind = csv.getKind(t.account_mask) || "";
    if (!kind) continue;
    const isExpense = (kind === "depository" && t.amount > 0) || (kind === "credit" && t.amount > 0);
    if (!isExpense) continue;
    const rawDesc = String(t.name || "").trim();
    const isUnrolled = unrolledPrefixes.some(re => re.test(rawDesc));
    const normName = normalizeVendor(rawDesc);
    const vendorKey = isUnrolled ? (normName + "#" + txIdx) : normName;
    const txId = (t.date || "") + "|" + Number(t.amount) + "|" + rawDesc.slice(0, 60);
    // Plaid category data (used for auto-guess)
    const pfc = t.personal_finance_category || null;
    const pfcPrimary = pfc ? String(pfc.primary || "").toUpperCase() : "";
    const pfcDetailed = pfc ? String(pfc.detailed || "").toUpperCase() : "";
    const plaidCats = Array.isArray(t.category) ? t.category.map(c => String(c).toUpperCase()) : [];
    txList.push({ id: txId, date: (t.date || "").slice(0, 10), desc: cleanDescription(rawDesc), amount: Number(t.amount), vendorKey, vendorNorm: normName, mask: t.account_mask || "", pfcPrimary, pfcDetailed, plaidCats });
    txIdx++;
  }
  const byVendor = {};
  for (const t of txList) {
    const txCat = txOv[t.id] || null;
    const vOverride = overrides[t.vendorKey] || null;
    const autoGuess = vOverride ? null : guessCategory(t);
    const cat = txCat || vOverride || "other";
    let v = byVendor[t.vendorKey];
    if (!v) v = byVendor[t.vendorKey] = { key: t.vendorKey, name: nameOv[t.vendorKey] || t.vendorNorm, rawSample: t.desc, amount: 0, count: 0, cat: vOverride || "other", vendorSaved: !!vOverride, txs: [] };
    v.amount += t.amount;
    v.count += 1;
    const userSet = !!(txCat || vOverride);
    const suggestion = vOverride || autoGuess || "";
    v.txs.push({ id: t.id, date: t.date, desc: txDescOv[t.id] || t.desc, amount: t.amount, cat, userSet, suggestion });
  }
  const vendors = Object.values(byVendor).sort((a, b) => b.amount - a.amount);
  vendors.forEach(v => v.txs.sort((a, b) => (b.date || "").localeCompare(a.date || "")));
  const byCategory = {};
  let total = 0;
  for (const v of vendors) for (const tx of v.txs) { byCategory[tx.cat] = (byCategory[tx.cat] || 0) + tx.amount; total += tx.amount; }
  return { vendors, byCategory, total };
}

app.get("/api/actuals", async (req, res) => {
  try { res.json(await _buildActuals(req.query.year ? String(req.query.year) : null)); }
  catch (e) { console.log("actuals err:", e); res.status(500).json({ error: e.message }); }
});

app.post("/api/actuals", async (req, res) => {
  try {
    const body = req.body || {};
    let handled = true;
    await _queueOverrideUpdate(async (obj) => {
      if (body.tx_id && body.desc !== undefined) {
        obj.__tx_desc = obj.__tx_desc || {};
        if (body.desc) obj.__tx_desc[body.tx_id] = body.desc;
        else delete obj.__tx_desc[body.tx_id];
      } else if (body.tx_id && body.category) {
        obj.__tx = obj.__tx || {};
        obj.__tx[body.tx_id] = body.category;
      } else if (body.vendor_key && body.name !== undefined) {
        obj.__names = obj.__names || {};
        if (body.name) obj.__names[body.vendor_key] = body.name;
        else delete obj.__names[body.vendor_key];
      } else if (body.vendor_key && body.category) {
        obj[body.vendor_key] = body.category;
        // Clear any per-tx overrides for this vendor so the new vendor cat
        // actually applies. (Otherwise stale per-tx settings — e.g. from when
        // the vendor used to be "excluded" — keep individual txs frozen.)
        if (obj.__tx) {
          const snap = await getSnapshot(false).catch(() => null);
          const plaidTx = (snap && snap._plaidTx) || [];
          const vendorTxIds = new Set();
          for (const t of plaidTx) {
            const raw = String(t.name || "").trim();
            const vKey = normalizeVendor(raw);
            if (vKey === body.vendor_key) {
              const txId = (t.date || "") + "|" + Number(t.amount) + "|" + raw.slice(0, 60);
              vendorTxIds.add(txId);
            }
          }
          for (const id of vendorTxIds) delete obj.__tx[id];
        }
      } else if (body.vendor && body.category) {
        obj[body.vendor] = body.category;
      } else { handled = false; }
    });
    if (!handled) return res.status(400).json({ error: "bad payload" });
    invalidateCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- income (deposits) ----
// Mirrors _buildActuals but for deposits (depository, amount < 0).
// Categories: megan / ben / excluded. Default for unknown = excluded
// (deposits we haven't seen before don't get counted as income until tagged).
async function _buildIncome(yearOverride) {
  const snap = await getSnapshot(false);
  const tx = snap._plaidTx || [];
  const overrides = await _readIncomeOverrides();
  const txOv = overrides.__tx || {};
  const nameOv = overrides.__names || {};
  const txDescOv = overrides.__tx_desc || {};

  const yr = String(yearOverride || Number(process.env.SNAPSHOT_YEAR) || new Date().getFullYear());
  const txList = [];
  for (const t of tx) {
    if (!t.date || !t.date.startsWith(yr)) continue;
    const kind = (t.account_type || "").toLowerCase();
    if (kind !== "depository") continue;
    if (!(t.amount < 0)) continue; // deposits are negative in Plaid
    const rawDesc = String(t.name || "").trim();
    const normName = normalizeVendor(rawDesc);
    const vendorKey = normName;
    const txId = (t.date || "") + "|" + Number(t.amount) + "|" + rawDesc.slice(0, 60);
    // For income, "amount" should display as a positive deposit value.
    const amt = -Number(t.amount);
    txList.push({ id: txId, date: (t.date || "").slice(0, 10), desc: cleanDescription(rawDesc), amount: amt, vendorKey, vendorNorm: normName, mask: t.account_mask || "" });
  }

  const byVendor = {};
  for (const t of txList) {
    const txCat = txOv[t.id] || null;
    const vOverride = overrides[t.vendorKey] || null;
    // No auto-guess heuristics for income — default unknown to "excluded".
    const cat = txCat || vOverride || "excluded";
    let v = byVendor[t.vendorKey];
    if (!v) v = byVendor[t.vendorKey] = { key: t.vendorKey, name: nameOv[t.vendorKey] || t.vendorNorm, rawSample: t.desc, amount: 0, count: 0, cat: vOverride || "excluded", vendorSaved: !!vOverride, txs: [] };
    v.amount += t.amount;
    v.count += 1;
    // Income is strict: every deposit must be explicitly approved per-tx.
    // Vendor overrides are just suggestions/pre-fills — they never mark a tx as approved.
    const userSet = !!txCat;
    const suggestion = vOverride || "excluded";
    v.txs.push({ id: t.id, date: t.date, desc: txDescOv[t.id] || t.desc, amount: t.amount, cat, userSet, suggestion });
  }
  const vendors = Object.values(byVendor).sort((a, b) => b.amount - a.amount);
  vendors.forEach(v => v.txs.sort((a, b) => (b.date || "").localeCompare(a.date || "")));
  const byCategory = { megan: 0, ben: 0, excluded: 0 };
  let total = 0;
  for (const v of vendors) for (const tx of v.txs) {
    byCategory[tx.cat] = (byCategory[tx.cat] || 0) + tx.amount;
    if (tx.cat !== "excluded") total += tx.amount;
  }
  return { vendors, byCategory, total, year: yr };
}

app.get("/api/income", async (req, res) => {
  try { res.json(await _buildIncome(req.query.year ? String(req.query.year) : null)); }
  catch (e) { console.log("income err:", e); res.status(500).json({ error: e.message }); }
});

app.post("/api/income", async (req, res) => {
  try {
    const body = req.body || {};
    let handled = true;
    await _queueIncomeOverrideUpdate(async (obj) => {
      if (body.tx_id && body.desc !== undefined) {
        obj.__tx_desc = obj.__tx_desc || {};
        if (body.desc) obj.__tx_desc[body.tx_id] = body.desc;
        else delete obj.__tx_desc[body.tx_id];
      } else if (body.tx_id && body.category) {
        obj.__tx = obj.__tx || {};
        obj.__tx[body.tx_id] = body.category;
      } else if (body.vendor_key && body.name !== undefined) {
        obj.__names = obj.__names || {};
        if (body.name) obj.__names[body.vendor_key] = body.name;
        else delete obj.__names[body.vendor_key];
      } else if (body.vendor_key && body.category) {
        obj[body.vendor_key] = body.category;
        // Same logic as expense side: clear conflicting per-tx overrides so the
        // new vendor category actually applies to every tx of this vendor.
        if (obj.__tx) {
          const snap = await getSnapshot(false).catch(() => null);
          const plaidTx = (snap && snap._plaidTx) || [];
          const vendorTxIds = new Set();
          for (const t of plaidTx) {
            const raw = String(t.name || "").trim();
            const vKey = normalizeVendor(raw);
            if (vKey === body.vendor_key) {
              const txId = (t.date || "") + "|" + Number(t.amount) + "|" + raw.slice(0, 60);
              vendorTxIds.add(txId);
            }
          }
          for (const id of vendorTxIds) delete obj.__tx[id];
        }
      } else { handled = false; }
    });
    if (!handled) return res.status(400).json({ error: "bad payload" });
    invalidateCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Batch endpoint: apply N income overrides in one round-trip.
// Body: { ops: [{ tx_id, category }, { vendor_key, category }, ...] }
// Same op shapes as POST /api/income but applied atomically in one kv update.
app.post("/api/income/batch", async (req, res) => {
  try {
    const ops = (req.body && req.body.ops) || [];
    if (!Array.isArray(ops) || ops.length === 0) {
      return res.status(400).json({ error: "ops must be a non-empty array" });
    }
    let applied = 0;
    const vendorKeysToClear = [];
    await _queueIncomeOverrideUpdate(async (obj) => {
      for (const op of ops) {
        if (op.tx_id && op.desc !== undefined) {
          obj.__tx_desc = obj.__tx_desc || {};
          if (op.desc) obj.__tx_desc[op.tx_id] = op.desc;
          else delete obj.__tx_desc[op.tx_id];
          applied++;
        } else if (op.tx_id && op.category) {
          obj.__tx = obj.__tx || {};
          obj.__tx[op.tx_id] = op.category;
          applied++;
        } else if (op.vendor_key && op.name !== undefined) {
          obj.__names = obj.__names || {};
          if (op.name) obj.__names[op.vendor_key] = op.name;
          else delete obj.__names[op.vendor_key];
          applied++;
        } else if (op.vendor_key && op.category) {
          obj[op.vendor_key] = op.category;
          vendorKeysToClear.push(op.vendor_key);
          applied++;
        }
      }
      if (vendorKeysToClear.length > 0 && obj.__tx) {
        const snap = await getSnapshot(false).catch(() => null);
        const plaidTx = (snap && snap._plaidTx) || [];
        const wantedVendors = new Set(vendorKeysToClear);
        for (const t of plaidTx) {
          const raw = String(t.name || "").trim();
          const vKey = normalizeVendor(raw);
          if (wantedVendors.has(vKey)) {
            const txId = (t.date || "") + "|" + Number(t.amount) + "|" + raw.slice(0, 60);
            delete obj.__tx[txId];
          }
        }
      }
    });
    invalidateCache();
    res.json({ ok: true, applied });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Batch endpoint: apply N expense overrides in one round-trip (one kv write).
// Body: { ops: [{ tx_id, category }, { vendor_key, category }, ...] } — same op
// shapes as POST /api/actuals. Vendor ops clear stale per-tx overrides for that
// vendor (2026-04-29 rule); tx ops in the SAME batch are applied AFTER the clear,
// so a batch can set a vendor rule plus per-tx exceptions in one call.
app.post("/api/actuals/batch", async (req, res) => {
  try {
    const ops = (req.body && req.body.ops) || [];
    if (!Array.isArray(ops) || ops.length === 0) {
      return res.status(400).json({ error: "ops must be a non-empty array" });
    }
    let applied = 0;
    const vendorKeysToClear = [];
    const txOpsDeferred = [];
    await _queueOverrideUpdate(async (obj) => {
      for (const op of ops) {
        if (op.tx_id && op.desc !== undefined) {
          obj.__tx_desc = obj.__tx_desc || {};
          if (op.desc) obj.__tx_desc[op.tx_id] = op.desc;
          else delete obj.__tx_desc[op.tx_id];
          applied++;
        } else if (op.tx_id && op.category) {
          txOpsDeferred.push(op);
          applied++;
        } else if (op.vendor_key && op.name !== undefined) {
          obj.__names = obj.__names || {};
          if (op.name) obj.__names[op.vendor_key] = op.name;
          else delete obj.__names[op.vendor_key];
          applied++;
        } else if (op.vendor_key && op.category) {
          obj[op.vendor_key] = op.category;
          vendorKeysToClear.push(op.vendor_key);
          applied++;
        }
      }
      if (vendorKeysToClear.length > 0 && obj.__tx) {
        const snap = await getSnapshot(false).catch(() => null);
        const plaidTx = (snap && snap._plaidTx) || [];
        const wantedVendors = new Set(vendorKeysToClear);
        for (const t of plaidTx) {
          const raw = String(t.name || "").trim();
          const vKey = normalizeVendor(raw);
          if (wantedVendors.has(vKey)) {
            const txId = (t.date || "") + "|" + Number(t.amount) + "|" + raw.slice(0, 60);
            delete obj.__tx[txId];
          }
        }
      }
      if (txOpsDeferred.length > 0) {
        obj.__tx = obj.__tx || {};
        for (const op of txOpsDeferred) obj.__tx[op.tx_id] = op.category;
      }
    });
    invalidateCache();
    res.json({ ok: true, applied });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/categories", async (req, res) => {
  try { res.json({ categories: await _readCategories() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Replace the entire categories list. Body: { categories: [...] }.
// Validation: every item needs a key + label. Duplicate keys rejected.
// Parents must reference an existing key.
app.post("/api/categories", async (req, res) => {
  try {
    const list = (req.body && req.body.categories) || [];
    if (!Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ error: "categories must be a non-empty array" });
    }
    const seen = new Set();
    const cleaned = [];
    for (const c of list) {
      if (!c || typeof c.key !== "string" || !c.key.trim()) {
        return res.status(400).json({ error: "each category needs a key" });
      }
      const key = c.key.trim();
      if (seen.has(key)) return res.status(400).json({ error: `duplicate key: ${key}` });
      seen.add(key);
      const label = (c.label && String(c.label).trim()) || key;
      const item = { key, label };
      if (c.parent) item.parent = String(c.parent);
      if (c.isExcluded) item.isExcluded = true;
      cleaned.push(item);
    }
    // Parent integrity check
    for (const c of cleaned) {
      if (c.parent && !seen.has(c.parent)) {
        return res.status(400).json({ error: `parent ${c.parent} not found for ${c.key}` });
      }
    }
    await _writeCategories(cleaned);
    invalidateCache();
    res.json({ ok: true, categories: cleaned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Investments ----
// Simple list of {id, name, value, source, note, updated_at, last_pdf_filename}.
// "source" can be "rockefeller" (PDF-parsed), "manual" (typed value), or future
// integrations. We store the entire blob under one kv key.
const INVESTMENTS_KEY = "family-investments";
async function _readInvestments() {
  const list = await db.kvGet(INVESTMENTS_KEY, []);
  return Array.isArray(list) ? list : [];
}
async function _writeInvestments(list) { await db.kvSet(INVESTMENTS_KEY, list); }

function _newInvestmentId() {
  return "inv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

app.get("/api/investments", async (req, res) => {
  try {
    const list = await _readInvestments();
    const total = list.reduce((s, x) => s + (Number(x.value) || 0), 0);
    res.json({ investments: list, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create or update one row.
// Body: { id?, name, value?, source?, note? }. If id is missing, create.
app.post("/api/investments", async (req, res) => {
  try {
    const body = req.body || {};
    const list = await _readInvestments();
    let row;
    if (body.id) {
      row = list.find(x => x.id === body.id);
      if (!row) return res.status(404).json({ error: "investment not found" });
      if (body.name !== undefined) row.name = String(body.name);
      if (body.value !== undefined) row.value = Number(body.value) || 0;
      if (body.source !== undefined) row.source = String(body.source);
      if (body.note !== undefined) row.note = String(body.note);
      if (body.instructions !== undefined) row.instructions = String(body.instructions);
      row.updated_at = new Date().toISOString();
    } else {
      row = {
        id: _newInvestmentId(),
        name: String(body.name || "Untitled"),
        value: Number(body.value) || 0,
        source: String(body.source || "manual"),
        note: String(body.note || ""),
        instructions: String(body.instructions || ""),
        updated_at: new Date().toISOString(),
      };
      list.push(row);
    }
    await _writeInvestments(list);
    res.json({ ok: true, investment: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/investments/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const list = await _readInvestments();
    const next = list.filter(x => x.id !== id);
    if (next.length === list.length) return res.status(404).json({ error: "not found" });
    await _writeInvestments(next);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parse a Rockefeller (or other brokerage) PDF and extract the total net worth.
// We send the PDF to Claude as a document block and ask for one number.
// Body: multipart/form-data with `pdf` file + form fields { id?, name? }.
//   - If `id` is provided, update that investment row's value.
//   - If `name` is provided (and no id), create a new row.
app.post("/api/investments/parse-pdf", express.raw({ type: "application/pdf", limit: "20mb" }), async (req, res) => {
  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    const id = (req.query.id && String(req.query.id)) || null;
    const name = (req.query.name && String(req.query.name)) || null;
    const filename = (req.query.filename && String(req.query.filename)) || "statement.pdf";

    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: "no pdf body" });
    const b64 = Buffer.from(buf).toString("base64");

    // Ask Claude to extract the total. We accept a JSON object back so we can
    // report a confidence and as_of date too.
    const prompt = `You are reading a brokerage account statement. Find the SINGLE most-encompassing total dollar amount on this statement — the "Total Net Worth", "Total Account Value", "Total Portfolio Value", or equivalent grand total covering ALL accounts. This is the number the household should care about, not any individual sub-account.

Respond with ONLY a JSON object, no prose, no markdown:
{ "total": <number, no commas, no $>, "label": "<exact label as shown on statement>", "as_of": "<YYYY-MM-DD if a statement date is visible, else empty>", "confidence": "high"|"medium"|"low", "notes": "<one short sentence if ambiguous, else empty>" }`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 512,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    const j = await r.json();
    if (j.error) return res.status(500).json({ error: j.error.message || "anthropic error" });
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
    let parsed;
    try {
      // Strip code fences if Claude added them.
      const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: "couldn't parse model response", raw: text });
    }
    if (typeof parsed.total !== "number" || !isFinite(parsed.total)) {
      return res.status(500).json({ error: "no total found", raw: parsed });
    }

    // Save to investment row.
    const list = await _readInvestments();
    let row;
    if (id) {
      row = list.find(x => x.id === id);
      if (!row) return res.status(404).json({ error: "investment not found" });
      row.value = parsed.total;
      row.source = "rockefeller";
      row.last_pdf_filename = filename;
      row.last_pdf_label = parsed.label || "";
      row.last_pdf_as_of = parsed.as_of || "";
      row.last_pdf_confidence = parsed.confidence || "";
      row.updated_at = new Date().toISOString();
    } else {
      row = {
        id: _newInvestmentId(),
        name: name || "Rockefeller",
        value: parsed.total,
        source: "rockefeller",
        last_pdf_filename: filename,
        last_pdf_label: parsed.label || "",
        last_pdf_as_of: parsed.as_of || "",
        last_pdf_confidence: parsed.confidence || "",
        updated_at: new Date().toISOString(),
      };
      list.push(row);
    }
    await _writeInvestments(list);
    res.json({ ok: true, investment: row, parsed });
  } catch (e) { console.log("parse-pdf err:", e); res.status(500).json({ error: e.message }); }
});

app.get("/api/version", (req, res) => {
  res.json({
    commit: process.env.RENDER_GIT_COMMIT || "local",
    branch: process.env.RENDER_GIT_BRANCH || "main",
    booted_at: BOOT_TIME,
  });
});

app.get("/api/debug/find", async (req, res) => {
  try {
    const snap = await getSnapshot(false);
    const tx = snap._plaidTx || [];
    const q = (req.query.q || "").toLowerCase();
    const amt = req.query.amt ? parseFloat(req.query.amt) : null;
    const mask = req.query.mask;
    const hits = [];
    for (const t of tx) {
      const m = t.account_mask;
      if (mask && m !== mask) continue;
      const desc = ((t.name || "") + " " + (t.merchant_name || "") + " " + (t.original_description || "")).toLowerCase();
      if (q && !desc.includes(q)) continue;
      if (amt != null && Math.abs(Math.abs(t.amount) - Math.abs(amt)) > 0.01) continue;
      hits.push({ date: t.date, amount: t.amount, name: t.name, mask: m, source: t.source || "plaid" });
    }
    hits.sort((a, b) => (b.date > a.date ? 1 : -1));
    res.json({ count: hits.length, total_tx: tx.length, hits: hits.slice(0, 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/oauth-return", (req, res) => {
  res.send("<script>window.close();</script>OAuth complete.");
});

// ---- boot ----
const PORT = process.env.PORT || 8787;
(async () => {
  try { await db.init(); }
  catch (e) { console.log("[boot] db init failed:", e.message); }
  try { await csv.prime(); }
  catch (e) { console.log("[boot] csv prime failed:", e.message); }
  try { await plaid.ensureTokenLoaded(); }
  catch (e) { console.log("[boot] plaid token load failed:", e.message); }

  app.listen(PORT, () => {
    console.log(`Meg & Ben Finance backend on http://localhost:${PORT}`);
    getSnapshot(true).then(() => console.log("Snapshot ready.")).catch(e => console.log("Boot snapshot err:", e.message));
  });
})();

// Exported for tools.js — Harold reconciles to the Dashboard by calling
// these same helpers (lazy-required to avoid circular import at load time).
module.exports = {
  _buildActuals,
  _buildIncome,
  getSnapshot,
  normalizeVendor,
  cleanDescription,
};
