// csv.js — parse uploaded Chase CSVs. CSVs persisted in Postgres via data.js.
//
// Format A (Chase checking):  Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
// Format B (Chase CC):         Transaction Date,Post Date,Description,Category,Type,Amount,Memo
const db = require("./data");

// In-memory cache populated at boot from Postgres so the synchronous
// stitch path in server.js stays fast and side-effect-free.
const cache = new Map(); // mask -> { csv, kind }
let primed = false;

async function prime() {
  if (primed) return;
  try {
    const rows = await db.csvList();
    for (const { mask, kind } of rows) {
      const r = await db.csvGet(mask);
      if (r) cache.set(mask, { csv: r.csv, kind: r.kind || kind || null });
    }
    primed = true;
    console.log(`[csv] primed ${cache.size} CSV file(s) from Postgres`);
  } catch (e) {
    console.log("[csv] prime err:", e.message);
  }
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
      out.push({ date, amount: -amt, name: (p[chkDesc] || "").trim(), mask, source: "csv" });
    }
    return { transactions: out, format: "checking" };
  } else if (isCC) {
    for (let i = 1; i < lines.length; i++) {
      const p = parseLine(lines[i]);
      const date = toISODate(p[ccPostDate >= 0 ? ccPostDate : ccTxDate]);
      const amt = parseFloat(p[ccAmount]);
      if (!date || isNaN(amt)) continue;
      out.push({ date, amount: -amt, name: (p[ccDesc] || "").trim(), mask, source: "csv" });
    }
    return { transactions: out, format: "cc" };
  }

  return { transactions: [], format: null, error: "unknown csv format — headers: " + header.join(",") };
}

async function saveCsv(mask, csvText, kind) {
  await db.csvSave(mask, csvText, kind || null);
  cache.set(mask, { csv: csvText, kind: kind || cache.get(mask)?.kind || null });
}

function getKind(mask) {
  return cache.get(mask)?.kind || null;
}

function loadCsvTx(mask) {
  const row = cache.get(mask);
  if (!row || !row.csv) return { transactions: [], format: null };
  return parseChaseCsv(row.csv, mask);
}

function hasCsv(mask) {
  return cache.has(mask) && !!cache.get(mask)?.csv;
}

function listMasks() {
  return Array.from(cache.keys()).sort();
}

function stitch(csvTx, plaidTx) {
  if (!csvTx.length) return plaidTx;
  const csvMaxDate = csvTx.reduce((m, t) => (!m || t.date > m) ? t.date : m, null);
  const merged = [...csvTx];
  for (const t of plaidTx) {
    if (!csvMaxDate || t.date > csvMaxDate) merged.push(t);
  }
  return merged;
}

module.exports = { prime, parseChaseCsv, saveCsv, loadCsvTx, hasCsv, listMasks, getKind, stitch };
