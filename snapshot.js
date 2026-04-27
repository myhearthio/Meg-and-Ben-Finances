// snapshot.js — single source of truth for every dashboard metric.
// Family edition. Formulas locked. Do not change without explicit approval.
//
// Inputs:
//   accounts        — Plaid accounts (with type, subtype, balances)
//   plaidTx         — All YTD tx with account_id; account_mask/type/subtype attached upstream
//   excludedTxIds   — Set<string> of tx ids the user has flagged "Excluded"
//
// Output: plain JSON object the frontend renders directly.
//
// Locked formulas:
//   Cash on Hand    = Σ depository balances − Σ credit card balances owed
//   Income YTD      = Σ depository deposits in current year, minus Excluded
//   Expenses YTD    = Σ depository debits + Σ CC charges in current year, minus:
//                       • tx flagged Excluded
//                       • CC autopay (depository debit ≈ CC payment within ±3 days, ±$0.01)
//                       • Internal transfers (matched ± pair across own depository accounts, same day)
//   Net Saved YTD   = Income − Expenses
//   Savings Rate    = Net Saved / Income * 100  (0% guard when Income ≤ 0)

const CURRENT_YEAR = new Date().getFullYear();

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [_, mm, dd, yy] = m;
    if (yy.length === 2) yy = "20" + yy;
    return { y: +yy, m: +mm, d: +dd };
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  return null;
}
function monthKey(d) { return String(d.m).padStart(2, "0"); }
function round(n) { return Math.round(n * 100) / 100; }
function roundMap(m) { const o = {}; for (const k of Object.keys(m)) o[k] = round(m[k]); return o; }
function daysBetween(a, b) {
  return (new Date(a.y, a.m - 1, a.d) - new Date(b.y, b.m - 1, b.d)) / 86400000;
}

// Plaid account types: "depository" (subtype: checking, savings) and "credit" (credit card)
function classifyAccount(a) {
  const type = (a.type || "").toLowerCase();
  if (type === "depository") return "depository";
  if (type === "credit") return "credit";
  return "other"; // loan, investment, brokerage — skip
}

function buildAccountIndex(accounts) {
  const idx = {};
  for (const a of accounts) {
    idx[a.account_id] = {
      kind: classifyAccount(a),
      mask: a.mask || "",
      name: a.name || "",
      subtype: a.subtype || "",
    };
  }
  return idx;
}

function txKey(t) {
  return `${t.account_id}|${t.date}|${t.amount}|${(t.name || "").slice(0, 40)}`;
}

// Tx ID format MUST match _buildActuals in server.js.
function mkTxId(t) {
  return (t.date || "") + "|" + Number(t.amount) + "|" + String(t.name || "").slice(0, 60);
}

// Internal transfer: two depository tx, same date, opposite-sign matched amounts (±0.01),
// different accounts. Mark BOTH so neither counts toward Income or Expenses.
function detectInternalTransfers(plaidTx, accountIdx) {
  const skip = new Set();
  const byDate = {};
  for (const t of plaidTx) {
    const acct = accountIdx[t.account_id];
    if (!acct || acct.kind !== "depository") continue;
    if (!t.date) continue;
    (byDate[t.date] = byDate[t.date] || []).push(t);
  }
  for (const date of Object.keys(byDate)) {
    const txs = byDate[date];
    for (let i = 0; i < txs.length; i++) {
      for (let j = i + 1; j < txs.length; j++) {
        const a = txs[i], b = txs[j];
        if (a.account_id === b.account_id) continue;
        if (Math.abs(a.amount + b.amount) > 0.01) continue; // opposite signs cancel
        if (Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) > 0.01) continue;
        skip.add(txKey(a));
        skip.add(txKey(b));
      }
    }
  }
  return skip;
}

// CC autopay: depository debit (positive) whose amount + date ≈ a CC payment (negative on credit acct)
// within ±3 days, ±$0.01. Skip the depository debit only — the CC charges are already counted.
function detectCCAutopay(plaidTx, accountIdx) {
  const skip = new Set();
  const depDebits = plaidTx.filter(t => {
    const a = accountIdx[t.account_id];
    return a && a.kind === "depository" && t.amount > 0;
  });
  const ccPayments = plaidTx.filter(t => {
    const a = accountIdx[t.account_id];
    return a && a.kind === "credit" && t.amount < 0;
  });
  for (const dd of depDebits) {
    const dDate = parseDate(dd.date);
    if (!dDate) continue;
    for (const cp of ccPayments) {
      if (Math.abs(Math.abs(cp.amount) - dd.amount) > 0.01) continue;
      const pDate = parseDate(cp.date);
      if (!pDate) continue;
      if (Math.abs(daysBetween(dDate, pDate)) > 3) continue;
      skip.add(txKey(dd));
      break;
    }
  }
  return skip;
}

function computeIncome(plaidTx, accountIdx, isExcluded, transfers) {
  let total = 0, count = 0, excluded = 0;
  const byMonth = {};
  for (const t of plaidTx) {
    const acct = accountIdx[t.account_id];
    if (!acct || acct.kind !== "depository") continue;
    if (t.amount >= 0) continue; // deposits are negative in Plaid convention
    const d = parseDate(t.date);
    if (!d || d.y !== CURRENT_YEAR) continue;
    if (transfers.has(txKey(t))) continue; // internal transfer credit — not income
    const amt = -t.amount;
    if (isExcluded(t)) { excluded += amt; continue; }
    total += amt;
    count++;
    byMonth[monthKey(d)] = (byMonth[monthKey(d)] || 0) + amt;
  }
  return { total: round(total), count, byMonth: roundMap(byMonth), excluded: round(excluded) };
}

function computeExpenses(plaidTx, accountIdx, isExcluded, transfers, autopay) {
  let total = 0, count = 0, excluded = 0;
  const byMonth = {};
  for (const t of plaidTx) {
    const acct = accountIdx[t.account_id];
    if (!acct) continue;
    if (acct.kind !== "depository" && acct.kind !== "credit") continue;
    const d = parseDate(t.date);
    if (!d || d.y !== CURRENT_YEAR) continue;

    if (acct.kind === "depository") {
      if (t.amount <= 0) continue; // credits handled in computeIncome
      const k = txKey(t);
      if (transfers.has(k)) continue;
      if (autopay.has(k)) continue;
      if (isExcluded(t)) { excluded += t.amount; continue; }
      total += t.amount;
      count++;
      byMonth[monthKey(d)] = (byMonth[monthKey(d)] || 0) + t.amount;
    } else if (acct.kind === "credit") {
      if (t.amount <= 0) continue; // CC payments and refunds — skip
      if (isExcluded(t)) { excluded += t.amount; continue; }
      total += t.amount;
      count++;
      byMonth[monthKey(d)] = (byMonth[monthKey(d)] || 0) + t.amount;
    }
  }
  return { total: round(total), count, byMonth: roundMap(byMonth), excluded: round(excluded) };
}

function computeCashOnHand(accounts) {
  let total = 0;
  const parts = [];
  for (const a of accounts) {
    const kind = classifyAccount(a);
    if (kind === "depository") {
      const bal = a.balances?.available ?? a.balances?.current ?? 0;
      total += bal;
      parts.push({
        name: a.name || `Account ${a.mask}`,
        mask: a.mask, kind, subtype: a.subtype,
        balance: round(bal),
      });
    } else if (kind === "credit") {
      const owed = a.balances?.current ?? 0;
      total -= owed;
      parts.push({
        name: a.name || `Card ${a.mask}`,
        mask: a.mask, kind, subtype: a.subtype,
        balance: round(-owed), owed: round(owed),
      });
    }
  }
  return { total: round(total), parts };
}

async function buildSnapshot({ accounts, plaidTx, excludedTxIds }) {
  const accountIdx = buildAccountIndex(accounts);
  const transfers = detectInternalTransfers(plaidTx, accountIdx);
  const autopay = detectCCAutopay(plaidTx, accountIdx);
  const exSet = excludedTxIds instanceof Set ? excludedTxIds : new Set(excludedTxIds || []);
  const isExcluded = (t) => exSet.has(mkTxId(t));

  const income = computeIncome(plaidTx, accountIdx, isExcluded, transfers);
  const expenses = computeExpenses(plaidTx, accountIdx, isExcluded, transfers, autopay);
  const cash = computeCashOnHand(accounts);

  const netSaved = round(income.total - expenses.total);
  const savingsRate = income.total > 0 ? round((netSaved / income.total) * 100) : 0;

  const months = new Set([...Object.keys(income.byMonth), ...Object.keys(expenses.byMonth)]);
  const netByMonth = {};
  for (const m of months) {
    netByMonth[m] = round((income.byMonth[m] || 0) - (expenses.byMonth[m] || 0));
  }

  return {
    generated_at: new Date().toISOString(),
    as_of_date: new Date().toISOString().slice(0, 10),
    year: CURRENT_YEAR,
    kpis: {
      cash_on_hand: cash.total,
      income_ytd: income.total,
      expenses_ytd: expenses.total,
      net_saved_ytd: netSaved,
      savings_rate_pct: savingsRate,
      excluded_ytd: round(income.excluded + expenses.excluded),
    },
    cash_accounts: cash.parts,
    monthly: {
      income: income.byMonth,
      expenses: expenses.byMonth,
      net: netByMonth,
    },
    counts: {
      income_deposits: income.count,
      expense_charges: expenses.count,
      transfers_skipped: transfers.size / 2,
      autopay_skipped: autopay.size,
    },
    source_status: {
      plaid: accounts.length > 0,
    },
  };
}

module.exports = { buildSnapshot };
