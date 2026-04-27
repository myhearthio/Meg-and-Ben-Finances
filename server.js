// Meg & Ben Finance — Express backend.
// Endpoints:
//   GET  /api/snapshot           — cached 60s, full dashboard state
//   POST /api/chat               — Connor proxy (Claude tool-calling)
//   POST /api/plaid/link         — create link token
//   POST /api/plaid/exchange     — exchange public token
//   GET  /api/plaid/status       — { connected: bool }
//   POST /api/upload/csv?mask=&kind=  — Chase CSV upload
//   GET  /api/upload/status
//   GET/POST /api/forecast       — annual forecast amounts per category
//   GET/POST /api/actuals        — vendor + per-tx category overrides + approval state
//   GET  /api/version            — running commit SHA (for deploy verification)
//   GET  /api/connor/md          — Connor's CONNOR.md memory file
//   GET  /api/connor/history     — last 40 chat messages
//   POST /api/connor/history/clear
//   GET  /api/debug/find         — find tx by query/amount/mask
//   GET  /oauth-return           — Plaid OAuth return page

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const plaid = require("./plaid");
const csv = require("./csv");
const { buildSnapshot } = require("./snapshot");
const { chat, readConnorMd, readHistory, writeHistory } = require("./chat");

const app = express();
const BOOT_TIME = new Date().toISOString();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const frontendDir = path.join(__dirname, "frontend");
app.use("/", express.static(frontendDir));

const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, "secrets");

// ---- snapshot cache (60s, invalidated on every write) ----
let cache = { data: null, ts: 0, inflight: null };
const CACHE_MS = 60_000;

// ---- override + forecast file plumbing ----
function _ensureSecrets() { try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch (e) {} }
function _overridesPath() { _ensureSecrets(); return path.join(DATA_ROOT, "family-overrides.json"); }
function _forecastPath()  { _ensureSecrets(); return path.join(DATA_ROOT, "family-forecast.json"); }
function _readOverrides() { try { return JSON.parse(fs.readFileSync(_overridesPath(), "utf8")); } catch (e) { return {}; } }
function _writeOverrides(obj) { fs.writeFileSync(_overridesPath(), JSON.stringify(obj, null, 2)); }
function _readForecast()  { try { return JSON.parse(fs.readFileSync(_forecastPath(), "utf8")); } catch (e) { return {}; } }
function _writeForecast(obj) { fs.writeFileSync(_forecastPath(), JSON.stringify(obj, null, 2)); }

// Single-promise queue serializes override writes (race-condition fix from reference).
let _writeQueue = Promise.resolve();
function _queueOverrideUpdate(mutator) {
  _writeQueue = _writeQueue.then(() => {
    const obj = _readOverrides();
    mutator(obj);
    _writeOverrides(obj);
  }).catch(e => { console.log("override queue err:", e); });
  return _writeQueue;
}

// Vendor normalization — institution-agnostic. Strips ORIG CO NAME, ZELLE prefix,
// trailing random digits, *suffixes, phone numbers, state codes, etc.
function normalizeVendor(raw) {
  if (!raw) return "UNKNOWN";
  let s = String(raw).toUpperCase().trim();
  let m = s.match(/ORIG CO NAME:\s*([A-Z0-9&.\- ]+?)(?:\s+ORIG ID|\s+DESC DATE|$)/);
  if (m) return m[1].replace(/\s+/g, " ").trim();
  m = s.match(/ZELLE PAYMENT TO\s+([A-Z][A-Z\s.'-]+?)(?:\s+JPM[A-Z0-9]+)?$/);
  if (m) return "ZELLE: " + m[1].replace(/\s+/g, " ").trim();
  m = s.match(/ONLINE ACH PAYMENT TO\s+([A-Z0-9 ]+?)\s*\(/);
  if (m) return m[1].replace(/\s+/g, " ").trim();
  if (/ONLINE TRANSFER TO CHK/.test(s)) return "ONLINE TRANSFER TO CHK";
  if (/^CHECK\b/.test(s)) return "CHECK";
  if (/^ATM WITHDRAWAL/.test(s)) return "ATM WITHDRAWAL";
  if (/VENMO/.test(s)) return "VENMO";
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

// ---- snapshot builder ----
async function gatherSnapshot() {
  let accounts = [], plaidTx = [];
  try { accounts = await plaid.getAccounts(); } catch (e) { console.log("plaid accounts err:", e.message); }
  try { plaidTx = await plaid.getYTDTransactions(); } catch (e) { console.log("plaid tx err:", e.message); }

  // Attach mask / type / subtype from Plaid accounts onto each Plaid tx
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

  // Stitch CSV uploads. CSV covers historical, Plaid covers tail.
  const finalTx = [...plaidTx];
  const accountsWithCsv = [...accounts];
  const masks = csv.listMasks();
  for (const mask of masks) {
    const csvRes = csv.loadCsvTx(mask);
    const plaidForMask = plaidTx.filter(t => t.account_mask === mask);
    const plaidMinDate = plaidForMask.reduce((m, t) => (!m || t.date < m) ? t.date : m, null);
    const realAcct = accounts.find(a => a.mask === mask);
    const acctId = realAcct ? realAcct.account_id : `csv-${mask}`;
    const kind = csv.getKind(mask) || (realAcct ? realAcct.type : "depository");
    for (const t of csvRes.transactions) {
      if (plaidMinDate && t.date >= plaidMinDate) continue; // Plaid covers this date — skip CSV row
      finalTx.push({
        account_id: acctId,
        amount: t.amount,
        name: t.name,
        date: t.date,
        account_mask: mask,
        account_type: kind,
        source: "csv",
      });
    }
    if (!realAcct) {
      accountsWithCsv.push({
        account_id: `csv-${mask}`,
        mask,
        name: `Account ${mask} (CSV)`,
        type: kind,
        subtype: kind === "credit" ? "credit card" : "checking",
        balances: { current: 0 },
      });
    }
  }

  // Compute excluded tx ids (mirror snapshot.js's mkTxId format)
  const overrides = _readOverrides();
  const excludedTxIds = new Set();
  {
    const txOv = overrides.__tx || {};
    const vendorExcluded = new Set();
    for (const [k, cat] of Object.entries(overrides)) {
      if (k.startsWith("__")) continue;
      if (cat === "excluded") vendorExcluded.add(k);
    }
    for (const t of finalTx) {
      const raw = String(t.name || "").trim();
      const txId = (t.date || "") + "|" + Number(t.amount) + "|" + raw.slice(0, 60);
      const perTx = txOv[txId];
      if (perTx === "excluded") { excludedTxIds.add(txId); continue; }
      if (perTx) continue;
      const vKey = normalizeVendor(raw);
      if (vendorExcluded.has(vKey)) excludedTxIds.add(txId);
    }
  }

  const snap = await buildSnapshot({ accounts: accountsWithCsv, plaidTx: finalTx, excludedTxIds });
  snap._plaidTx = finalTx;
  return snap;
}

async function getSnapshot(force = false) {
  const now = Date.now();
  if (!force && cache.data && (now - cache.ts) < CACHE_MS) return cache.data;
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    try {
      const snap = await gatherSnapshot();
      cache.data = snap;
      cache.ts = Date.now();
      return snap;
    } finally {
      cache.inflight = null;
    }
  })();
  return cache.inflight;
}

// ---- endpoints ----

app.get("/api/snapshot", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const snap = await getSnapshot(force);
    const { _plaidTx, ...safe } = snap;
    res.json(safe);
  } catch (e) {
    console.log("snapshot err:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const snap = await getSnapshot(false);
    const incoming = req.body.messages || [];
    const result = await chat(incoming, snap);
    const assistantMsg = { role: "assistant", content: result.text, actions: result.actions || [], ts: Date.now() };
    const fullHistory = [...incoming.map(m => ({ role: m.role, content: m.content })), assistantMsg];
    try { writeHistory(fullHistory); } catch (e) { console.log("history write err:", e.message); }
    res.json({
      text: result.text,
      actions: result.actions || [],
      tool_calls: (result.toolCalls || []).map(tc => ({ name: tc.name, input: tc.input })),
    });
  } catch (e) {
    console.log("chat err:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/connor/md", (req, res) => {
  try { res.type("text/plain").send(readConnorMd()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/connor/history", (req, res) => {
  try { res.json({ messages: readHistory() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/connor/history/clear", (req, res) => {
  try { writeHistory([]); res.json({ ok: true }); }
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
    cache = { data: null, ts: 0, inflight: null };
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/plaid/status", (req, res) => {
  res.json({ connected: !!plaid.getToken() });
});

// CSV upload (any 4-digit mask, kind = depository|credit)
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
    csv.saveCsv(mask, csvText, kind);
    cache = { data: null, ts: 0, inflight: null };
    res.json({
      ok: true, mask, kind, format: parsed.format, count: parsed.transactions.length,
      date_range: {
        min: parsed.transactions.reduce((m, t) => !m || t.date < m ? t.date : m, null),
        max: parsed.transactions.reduce((m, t) => !m || t.date > m ? t.date : m, null),
      },
    });
  } catch (e) {
    console.log("csv upload err:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/upload/status", (req, res) => {
  const out = {};
  for (const m of csv.listMasks()) {
    const r = csv.loadCsvTx(m);
    out[m] = {
      has_csv: csv.hasCsv(m),
      kind: csv.getKind(m),
      format: r.format,
      count: r.transactions.length,
      max_date: r.transactions.reduce((mx, t) => !mx || t.date > mx ? t.date : mx, null),
    };
  }
  res.json(out);
});

// ---- Forecast (manual annual amounts per category) ----
app.get("/api/forecast", (req, res) => res.json(_readForecast()));
app.post("/api/forecast", (req, res) => {
  try {
    const { category, amount } = req.body || {};
    if (!category) return res.status(400).json({ error: "category required" });
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "amount must be a non-negative number" });
    const cur = _readForecast();
    cur[category] = Math.round(n);
    _writeForecast(cur);
    cache.data = null; cache.ts = 0;
    res.json({ ok: true, forecast: cur });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Actuals (vendor-level + per-tx categorized expenses; approval queue source) ----
async function _buildActuals() {
  const snap = await getSnapshot(false);
  const tx = snap._plaidTx || [];
  const overrides = _readOverrides();
  const txOv = overrides.__tx || {};
  const nameOv = overrides.__names || {};
  const txDescOv = overrides.__tx_desc || {};

  const yr = String(Number(process.env.SNAPSHOT_YEAR) || new Date().getFullYear());
  // CHECK has no payee — render per-tx (no rollup).
  const unrolledPrefixes = [/^CHECK\b/i];

  const txList = [];
  let txIdx = 0;
  for (const t of tx) {
    if (!t.date || !t.date.startsWith(yr)) continue;
    // Only include EXPENSES (depository debits + CC charges). Skip income, CC payments, refunds.
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

    txList.push({
      id: txId,
      date: (t.date || "").slice(0, 10),
      desc: rawDesc,
      amount: Number(t.amount),
      vendorKey, vendorNorm: normName,
      mask: t.account_mask || "",
    });
    txIdx++;
  }

  const byVendor = {};
  for (const t of txList) {
    const txCat = txOv[t.id] || null;
    const vOverride = overrides[t.vendorKey] || null;
    const cat = txCat || vOverride || "other";
    let v = byVendor[t.vendorKey];
    if (!v) {
      v = byVendor[t.vendorKey] = {
        key: t.vendorKey,
        name: nameOv[t.vendorKey] || t.vendorNorm,
        rawSample: t.desc,
        amount: 0, count: 0,
        cat: vOverride || "other",
        vendorSaved: !!vOverride,
        txs: [],
      };
    }
    v.amount += t.amount;
    v.count += 1;
    const userSet = !!(txCat || vOverride);
    const suggestion = vOverride || "";
    v.txs.push({
      id: t.id, date: t.date, desc: txDescOv[t.id] || t.desc,
      amount: t.amount, cat, userSet, suggestion,
    });
  }

  const vendors = Object.values(byVendor).sort((a, b) => b.amount - a.amount);
  vendors.forEach(v => v.txs.sort((a, b) => (b.date || "").localeCompare(a.date || "")));

  const byCategory = {};
  let total = 0;
  for (const v of vendors) {
    for (const tx of v.txs) {
      byCategory[tx.cat] = (byCategory[tx.cat] || 0) + tx.amount;
      total += tx.amount;
    }
  }

  return { vendors, byCategory, total };
}

app.get("/api/actuals", async (req, res) => {
  try { res.json(await _buildActuals()); }
  catch (e) { console.log("actuals err:", e); res.status(500).json({ error: e.message }); }
});

app.post("/api/actuals", async (req, res) => {
  try {
    const body = req.body || {};
    let handled = true;
    await _queueOverrideUpdate(obj => {
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
      } else if (body.vendor && body.category) {
        // backwards compat
        obj[body.vendor] = body.category;
      } else {
        handled = false;
      }
    });
    if (!handled) return res.status(400).json({ error: "bad payload" });
    cache.data = null; cache.ts = 0;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- diagnostics ----
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
app.listen(PORT, () => {
  console.log(`Meg & Ben Finance backend on http://localhost:${PORT}`);
  getSnapshot(true).then(() => console.log("Snapshot ready.")).catch(e => console.log("Boot snapshot err:", e.message));
});
