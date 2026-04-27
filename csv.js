// csv.js — parse uploaded Chase CSVs and normalize to a common tx shape.
// Lifted from reference/chase-csv.js, mask whitelist removed, kind tracking added.
//
// Format A (Chase checking):  Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
// Format B (Chase CC):         Transaction Date,Post Date,Description,Category,Type,Amount,Memo
//
// Output: [{ date: "YYYY-MM-DD", amount: number (Plaid sign convention: + = debit, − = credit), name, mask, source: "csv" }]
const fs = require("fs");
const path = require("path");

const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, "secrets");
const DIR = path.join(DATA_ROOT, "csv");
const KIND_FILE = path.join(DIR, "_kinds.json");

function _ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}
}

function _readKinds() {
  try { return JSON.parse(fs.readFileSync(KIND_FILE, "utf8")); } catch (e) { return {}; }
}
function _writeKinds(o) {
  _ensureDir();
  fs.writeFileSync(KIND_FILE, JSON.stringify(o, null, 2));
}

function parseLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function toISODate(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let [_, mm, dd, yy] = m;
  if (yy.length === 2) yy = "20" + yy;
  return `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// Returns { transactions: [...], format: "checking" | "cc", error? }
function parseChaseCsv(csvText, mask) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { transactions: [], format: null, error: "empty csv" };
  const header = parseLine(lines[0]).map(s => s.trim().toLowerCase());
  const idx = (name) => header.findIndex(h => h === name);

  const chkPosting = idx("posting date");
  const chkAmount = idx("amount");
  const chkDesc = idx("description");

  const ccTxDate = idx("transaction date");
  const ccPostDate = idx("post date");
  const ccAmount = idx("amount");
  const ccDesc = idx("description");

  const isCC = ccTxDate >= 0 && ccAmount >= 0;
  const isChecking = !isCC && chkPosting >= 0 && chkAmount >= 0;

  const out = [];
  if (isChecking) {
    for (let i = 1; i < lines.length; i++) {
      const p = parseLine(lines[i]);
      const date = toISODate(p[chkPosting]);
      const amt = parseFloat(p[chkAmount]);
      if (!date || isNaN(amt)) continue;
      // Chase checking CSV: +deposit, -debit. Plaid: -credit, +debit. Invert.
      out.push({ date, amount: -amt, name: (p[chkDesc] || "").trim(), mask, source: "csv" });
    }
    return { transactions: out, format: "checking" };
  } else if (isCC) {
    for (let i = 1; i < lines.length; i++) {
      const p = parseLine(lines[i]);
      const date = toISODate(p[ccPostDate >= 0 ? ccPostDate : ccTxDate]);
      const amt = parseFloat(p[ccAmount]);
      if (!date || isNaN(amt)) continue;
      // Chase CC CSV: charges are NEGATIVE, refunds POSITIVE. Plaid: +debit, -credit. Invert.
      out.push({ date, amount: -amt, name: (p[ccDesc] || "").trim(), mask, source: "csv" });
    }
    return { transactions: out, format: "cc" };
  }

  return { transactions: [], format: null, error: "unknown csv format — headers: " + header.join(",") };
}

function saveCsv(mask, csvText, kind) {
  _ensureDir();
  fs.writeFileSync(path.join(DIR, `${mask}.csv`), csvText);
  if (kind) {
    const k = _readKinds();
    k[mask] = kind;
    _writeKinds(k);
  }
}

function getKind(mask) {
  return _readKinds()[mask] || null;
}

function loadCsvTx(mask) {
  const p = path.join(DIR, `${mask}.csv`);
  if (!fs.existsSync(p)) return { transactions: [], format: null };
  return parseChaseCsv(fs.readFileSync(p, "utf8"), mask);
}

function hasCsv(mask) {
  return fs.existsSync(path.join(DIR, `${mask}.csv`));
}

function listMasks() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter(f => /^\d{4}\.csv$/.test(f))
    .map(f => f.replace(/\.csv$/, ""));
}

// Stitch CSV + Plaid: CSV covers historical, Plaid covers tail.
function stitch(csvTx, plaidTx) {
  if (!csvTx.length) return plaidTx;
  const csvMaxDate = csvTx.reduce((m, t) => (!m || t.date > m) ? t.date : m, null);
  const merged = [...csvTx];
  for (const t of plaidTx) {
    if (!csvMaxDate || t.date > csvMaxDate) merged.push(t);
  }
  return merged;
}

module.exports = { parseChaseCsv, saveCsv, loadCsvTx, hasCsv, listMasks, getKind, stitch, DIR };
