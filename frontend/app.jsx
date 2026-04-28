// Meg & Ben Finance — frontend (React via Babel, no build step)
// Components: App, TopBar, Sidebar, Main, Dashboard, KpiRow, MonthlyCharts, Chart,
//             BudgetView, ApprovalRow, ForecastInput, AccountsView, FloatingChat, ChatPanel.

const { useState, useEffect, useCallback, useRef } = React;
const API = "";  // same origin
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Categories. Subcategories carry a `parent` key — they roll up into the parent's total
// for KPIs, but each owns its own forecast. Parent rows display the rollup actuals + sum-of-children forecast.
const FAMILY_CATS = [
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

  { key: "travel", label: "Travel & Vacation" },
  { key: "travel_general", label: "General (lodging, flights, etc.)", parent: "travel" },
  { key: "travel_dining", label: "Dining", parent: "travel" },
  { key: "travel_activities", label: "Activities", parent: "travel" },
  { key: "travel_childcare", label: "Childcare", parent: "travel" },

  { key: "entertainment", label: "Entertainment & Subscriptions" },
  { key: "gifts_charity", label: "Gifts & Charity" },
  { key: "other", label: "Other" },
  { key: "excluded", label: "Excluded (paid from savings/investments)", isExcluded: true },
];

// Helpers for parent/child rollups.
const isParent = (k) => FAMILY_CATS.some(c => c.parent === k);
const childrenOf = (parentKey) => FAMILY_CATS.filter(c => c.parent === parentKey);
const parentOf = (key) => (FAMILY_CATS.find(c => c.key === key) || {}).parent || null;

const fmt = (n) => {
  if (n == null || isNaN(n)) return "$0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(n));
  return sign + "$" + abs.toLocaleString();
};
const fmtPct = (n) => (n == null || isNaN(n)) ? "0%" : `${n}%`;

function App() {
  const [tab, setTab] = useState(() => localStorage.getItem("mb_tab") || "dashboard");
  const [snap, setSnap] = useState(null);
  const [err, setErr] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [plaidStatus, setPlaidStatus] = useState({ connected: false });

  useEffect(() => { localStorage.setItem("mb_tab", tab); }, [tab]);

  const load = useCallback(async (force = false) => {
    try {
      const [snapRes, plaidRes] = await Promise.all([
        fetch(API + "/api/snapshot" + (force ? "?force=1" : "")).then(r => r.json()),
        fetch(API + "/api/plaid/status").then(r => r.json()).catch(() => ({ connected: false })),
      ]);
      if (snapRes.error) throw new Error(snapRes.error);
      setSnap(snapRes);
      setPlaidStatus(plaidRes);
      setRefreshedAt(new Date());
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    // Listen for navigation actions from chat
    const h = (e) => { if (e.detail) setTab(e.detail); };
    window.addEventListener("app:navigate", h);
    return () => window.removeEventListener("app:navigate", h);
  }, [load]);

  if (err) return <ErrorScreen err={err} onRetry={() => load(true)} />;
  if (!snap) return <div className="boot-loader"><div className="boot-dot"></div><div className="boot-msg">Loading…</div></div>;

  return (
    <div className="app">
      <TopBar
        refreshedAt={refreshedAt}
        onRefresh={() => load(true)}
        plaidStatus={plaidStatus}
        tab={tab}
        onTabChange={setTab}
      />
      <Sidebar snap={snap} plaidStatus={plaidStatus} onPlaidChanged={() => load(true)} />
      <Main snap={snap} tab={tab} />
      <FloatingChat />
    </div>
  );
}

function TopBar({ refreshedAt, onRefresh, plaidStatus, tab, onTabChange }) {
  const tabs = [
    { key: "dashboard", label: "Dashboard" },
    { key: "budget", label: "Budget & Expenses" },
    { key: "accounts", label: "Accounts" },
  ];
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="brand">Meg & Ben Finance<span className="brand-sub">family CFO</span></span>
        <div className="tabs">
          {tabs.map(t => (
            <div key={t.key} className={"tab" + (tab === t.key ? " active" : "")}
                 onClick={() => onTabChange(t.key)}>{t.label}</div>
          ))}
        </div>
      </div>
      <div className="topbar-right">
        <span className="status-text">
          <span className={"status-dot " + (plaidStatus.connected ? "status-on" : "status-off")}></span>
          Plaid {plaidStatus.connected ? "connected" : "not connected"}
        </span>
        <button className="refresh-btn" onClick={onRefresh}>
          {refreshedAt ? "Refreshed " + refreshedAt.toLocaleTimeString() : "Refresh"}
        </button>
      </div>
    </div>
  );
}

function ErrorScreen({ err, onRetry }) {
  return (
    <div className="err-screen">
      <div className="err-msg">Error loading data: {err}</div>
      <button className="connect-btn" onClick={onRetry}>Try again</button>
    </div>
  );
}

function Sidebar({ snap, plaidStatus, onPlaidChanged }) {
  const cash = snap.kpis?.cash_on_hand ?? 0;
  const accounts = snap.cash_accounts || [];
  return (
    <div className="sidebar">
      <div className="sidebar-block">
        <div className="cash-card">
          <div className="cash-label">Cash on Hand</div>
          <div className="cash-amount">{fmt(cash)}</div>
        </div>
      </div>

      <div className="sidebar-block">
        <div className="sidebar-label">Accounts</div>
        {accounts.length === 0 && (
          <div style={{ fontSize: 12, color: "#888", padding: "8px 0" }}>
            No accounts yet. Connect Plaid below.
          </div>
        )}
        {accounts.map((a, i) => (
          <div key={i} className="account-row">
            <div>
              <div className="account-name">{a.name}</div>
              <div className="account-name-sub">{a.subtype || a.kind} · {a.mask}</div>
            </div>
            <div className={"account-bal" + (a.balance < 0 ? " negative" : "")}>{fmt(a.balance)}</div>
          </div>
        ))}
      </div>

      <div className="sidebar-block">
        <div className="sidebar-label">Connection</div>
        <PlaidConnectButton connected={plaidStatus.connected} onChanged={onPlaidChanged} />
      </div>
    </div>
  );
}

function PlaidConnectButton({ connected, onChanged }) {
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const { link_token } = await fetch("/api/plaid/link", { method: "POST" }).then(r => r.json());
      const handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (public_token) => {
          await fetch("/api/plaid/exchange", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ public_token }),
          });
          onChanged();
        },
        onExit: () => { setBusy(false); },
      });
      handler.open();
    } catch (e) {
      alert("Plaid link failed: " + e.message);
      setBusy(false);
    }
  };
  return (
    <button className={"connect-btn" + (connected ? " secondary" : "")} onClick={connect} disabled={busy}>
      {busy ? "…" : (connected ? "Relink bank" : "Connect a bank")}
    </button>
  );
}

function Main({ snap, tab }) {
  if (tab === "budget") return <BudgetView snap={snap} />;
  if (tab === "accounts") return <AccountsView snap={snap} />;
  return <Dashboard snap={snap} />;
}

function Dashboard({ snap }) {
  return (
    <div className="main">
      <div className="page-title">Dashboard</div>
      <div className="page-subtitle">As of {snap.as_of_date} · year {snap.year}</div>
      <KpiRow snap={snap} />
      <MonthlyCharts snap={snap} />
    </div>
  );
}

function KpiRow({ snap }) {
  const k = snap.kpis || {};
  return (
    <div className="kpi-row">
      <div className="kpi-card">
        <div className="kpi-label">Cash on Hand</div>
        <div className="kpi-value">{fmt(k.cash_on_hand)}</div>
      </div>
      <div className="kpi-card">
        <div className="kpi-label">Income YTD</div>
        <div className="kpi-value green">{fmt(k.income_ytd)}</div>
        <div className="kpi-sub">{snap.counts?.income_deposits || 0} deposits</div>
      </div>
      <div className="kpi-card">
        <div className="kpi-label">Expenses YTD</div>
        <div className="kpi-value red">{fmt(k.expenses_ytd)}</div>
        <div className="kpi-sub">{snap.counts?.expense_charges || 0} charges</div>
      </div>
      <div className="kpi-card">
        <div className="kpi-label">Net Saved YTD</div>
        <div className={"kpi-value " + ((k.net_saved_ytd || 0) >= 0 ? "blue" : "red")}>{fmt(k.net_saved_ytd)}</div>
      </div>
      <div className="kpi-card">
        <div className="kpi-label">Savings Rate</div>
        <div className={"kpi-value " + ((k.savings_rate_pct || 0) >= 0 ? "blue" : "red")}>{fmtPct(k.savings_rate_pct)}</div>
      </div>
    </div>
  );
}

function MonthlyCharts({ snap }) {
  const [forecast, setForecast] = useState({});
  useEffect(() => {
    fetch("/api/forecast").then(r => r.json()).then(j => setForecast(j || {})).catch(() => {});
  }, []);
  const annualExpenseForecast = FAMILY_CATS
    .filter(c => !c.isExcluded && !isParent(c.key))
    .reduce((s, c) => s + (Number(forecast[c.key]) || 0), 0);
  const monthlyExpTarget = annualExpenseForecast > 0 ? Math.round(annualExpenseForecast / 12) : 0;

  const inc = snap.monthly?.income || {};
  const exp = snap.monthly?.expenses || {};
  const net = snap.monthly?.net || {};
  const incData = MONTHS.map((m, i) => ({ month: m, v: inc[String(i+1).padStart(2,"0")] || 0, target: 0 }));
  const expData = MONTHS.map((m, i) => ({ month: m, v: exp[String(i+1).padStart(2,"0")] || 0, target: monthlyExpTarget }));
  const netData = MONTHS.map((m, i) => ({ month: m, v: net[String(i+1).padStart(2,"0")] || 0, target: 0 }));

  return (
    <div className="monthly-charts">
      <Chart title="Income by Month" data={incData} color="#15803d" totalLabel="YTD Income" total={snap.kpis?.income_ytd}/>
      <Chart title="Expenses by Month" data={expData} color="#b91c1c" totalLabel="YTD Expenses" total={snap.kpis?.expenses_ytd} annualTarget={annualExpenseForecast}/>
      <Chart title="Net Saved by Month" data={netData} color="#1e40af" signed={true} totalLabel="YTD Net Saved" total={snap.kpis?.net_saved_ytd}/>
    </div>
  );
}

function Chart({ title, data, color, signed, totalLabel, total, annualTarget }) {
  const w = 640, h = 220, padL = 32, padR = 16, padT = 24, padB = 28;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const slot = innerW / 12;
  const barW = slot * 0.62;

  const allVals = data.flatMap(d => [d.v, d.target || 0]);
  const maxAbs = Math.max(1, ...allVals.map(Math.abs));
  const minVal = signed ? Math.min(0, ...allVals) : 0;
  const maxVal = Math.max(1, ...allVals);
  const range = maxVal - minVal;
  const yFor = (v) => padT + (innerH * (1 - (v - minVal) / range));
  const yZero = yFor(0);

  const lightTint = (color === "#15803d") ? "#86efac" : (color === "#b91c1c") ? "#fca5a5" : "#93c5fd";

  return (
    <div className="chart-card">
      <div className="chart-title">
        <div>
          <div className="chart-name">{title}</div>
          {annualTarget != null && annualTarget > 0 && (
            <div className="chart-target">Annual target: {fmt(annualTarget)} · {fmt(annualTarget/12)}/mo</div>
          )}
        </div>
        <div className="chart-total">
          <span className="chart-total-label">{totalLabel}</span>
          <span className="chart-total-value">{fmt(total)}</span>
        </div>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
        {/* baseline */}
        <line x1={padL} y1={yZero} x2={w - padR} y2={yZero} stroke="#e6e4df" strokeWidth="1" />
        {data.map((d, i) => {
          const cx = padL + slot * (i + 0.5);
          const x = cx - barW / 2;
          const targetH = d.target ? Math.abs(yFor(d.target) - yZero) : 0;
          const targetY = d.target > 0 ? yFor(d.target) : yZero;
          const valH = Math.abs(yFor(d.v) - yZero);
          const valY = d.v >= 0 ? yFor(d.v) : yZero;
          const barColor = signed && d.v < 0 ? "#b91c1c" : color;
          return (
            <g key={i}>
              {d.target > 0 && (
                <rect x={x} y={targetY} width={barW} height={Math.max(1, targetH)} fill={color} opacity="0.85" rx="2"/>
              )}
              <rect x={x} y={valY} width={barW} height={Math.max(1, valH)} fill={d.target > 0 ? lightTint : barColor} rx="2"
                    opacity={d.target > 0 ? 1 : 0.85}/>
              {d.target > 0 && (
                <text x={cx} y={Math.min(targetY, valY) - 14} textAnchor="middle" fontSize="9" fill="#888">
                  {fmt(d.target)}
                </text>
              )}
              {d.v !== 0 && (
                <text x={cx} y={Math.min(targetY || valY, valY) - 4} textAnchor="middle" fontSize="10" fontWeight="600" fill={barColor}>
                  {fmt(d.v)}
                </text>
              )}
              <text x={cx} y={h - 8} textAnchor="middle" fontSize="11" fill="#888">{d.month}</text>
            </g>
          );
        })}
      </svg>
      {annualTarget != null && annualTarget > 0 && (
        <div className="chart-legend">
          <span><span className="legend-swatch" style={{background: color}}></span>Target</span>
          <span><span className="legend-swatch" style={{background: lightTint}}></span>Actual</span>
        </div>
      )}
    </div>
  );
}

function BudgetView({ snap }) {
  const [year, setYear] = useState(() => localStorage.getItem("mb_year") || String(snap.year));
  const [forecast, setForecast] = useState({});
  const [actuals, setActuals] = useState({ vendors: [], byCategory: {}, total: 0 });

  useEffect(() => { localStorage.setItem("mb_year", year); }, [year]);

  useEffect(() => {
    fetch("/api/forecast").then(r => r.json()).then(j => setForecast(j || {})).catch(() => {});
    fetch("/api/actuals").then(r => r.json()).then(j => setActuals(j || { vendors: [], byCategory: {}, total: 0 })).catch(() => {});
  }, []);

  const isCurrentYear = String(year) === String(snap.year);
  const years = [String(snap.year - 2), String(snap.year - 1), String(snap.year)];

  return (
    <div className="main">
      <div className="page-title">Budget & Expenses</div>
      <div className="page-subtitle">
        Forecast vs actual for {year}.
        {!isCurrentYear && " (Historical year — actuals only, no forecast.)"}
      </div>
      <div className="year-pills">
        {years.map(y => (
          <div key={y} className={"year-pill" + (y === year ? " active" : "")} onClick={() => setYear(y)}>{y}</div>
        ))}
      </div>
      {isCurrentYear ? (
        <BudgetCurrentYear forecast={forecast} setForecast={setForecast} actuals={actuals} setActuals={setActuals} />
      ) : (
        <BudgetHistorical year={year} actuals={actuals} />
      )}
    </div>
  );
}

function BudgetHistorical({ year, actuals }) {
  // Snapshot only knows current year; historical view is a stub for now (CSV upload feature lights this up later).
  return (
    <div className="accounts-section">
      <h3>Historical year {year}</h3>
      <p>Upload Chase CSVs for {year} via the Accounts tab to populate this view. The approval queue and per-vendor learning will work the same way once history is loaded.</p>
    </div>
  );
}

function BudgetCurrentYear({ forecast, setForecast, actuals, setActuals }) {
  const [expanded, setExpanded] = useState({});
  const toggle = (k) => setExpanded(e => ({ ...e, [k]: !e[k] }));

  const rawForecast = (k) => Number(forecast[k] || 0);
  // Effective forecast for a row: parents = sum of children + own (if any); leafs = own.
  const getVal = (k) => {
    const kids = childrenOf(k);
    if (kids.length > 0) return kids.reduce((s, c) => s + rawForecast(c.key), 0) + rawForecast(k);
    return rawForecast(k);
  };
  // Grand total: skip parent rows (their forecast is already in the children) + excluded.
  const grand = FAMILY_CATS
    .filter(c => !c.isExcluded && !isParent(c.key))
    .reduce((s, c) => s + rawForecast(c.key), 0);

  const rawActual = (k) => Number((actuals?.byCategory || {})[k] || 0);
  const actualByCat = (() => {
    // Parent actuals = own + children's actuals (transactions can be on either).
    const out = { ...(actuals?.byCategory || {}) };
    for (const c of FAMILY_CATS) {
      const kids = childrenOf(c.key);
      if (kids.length > 0) {
        out[c.key] = (Number(out[c.key]) || 0) + kids.reduce((s, k) => s + rawActual(k.key), 0);
      }
    }
    return out;
  })();
  const actualGrand = FAMILY_CATS
    .filter(c => !c.isExcluded && !isParent(c.key))
    .reduce((s, c) => s + rawActual(c.key), 0);

  const pendingTxs = [];
  for (const v of (actuals?.vendors || [])) {
    for (const tx of (v.txs || [])) {
      if (!tx.userSet) pendingTxs.push({ ...tx, vendorKey: v.key, vendorName: v.name });
    }
  }
  pendingTxs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const vendorsByCat = {};
  for (const v of (actuals?.vendors || [])) {
    const sumByCat = {};
    for (const tx of (v.txs || [])) sumByCat[tx.cat] = (sumByCat[tx.cat] || 0) + tx.amount;
    for (const [cat, amt] of Object.entries(sumByCat)) {
      (vendorsByCat[cat] = vendorsByCat[cat] || []).push({ ...v, amount: amt });
    }
  }

  const saveVal = async (key, amount) => {
    setForecast(f => ({ ...f, [key]: amount }));
    await fetch("/api/forecast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: key, amount }),
    });
  };

  const refreshActuals = async () => {
    const fresh = await fetch("/api/actuals").then(r => r.json());
    setActuals(fresh);
  };

  const moveVendor = async (vendorKey, newCat) => {
    await fetch("/api/actuals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor_key: vendorKey, category: newCat }),
    });
    await refreshActuals();
  };

  const moveTx = async (txId, newCat, vendorKey) => {
    await fetch("/api/actuals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_id: txId, category: newCat }),
    });
    if (vendorKey) {
      await fetch("/api/actuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_key: vendorKey, category: newCat }),
      });
    }
    await refreshActuals();
  };

  return (
    <>
      {pendingTxs.length > 0 && (
        <ApprovalCard pendingTxs={pendingTxs} onApprove={async (txId, cat, vendorKey) => {
          await moveTx(txId, cat, vendorKey);
        }} />
      )}

      <div className="pnl-catlist">
        {FAMILY_CATS.map(c => {
          const target = getVal(c.key);
          const actual = actualByCat[c.key] || 0;
          const isOpen = !!expanded[c.key];
          const vendors = (vendorsByCat[c.key] || []).sort((a, b) => b.amount - a.amount);
          const canExpand = vendors.length > 0;
          const pct = target > 0 ? Math.min(100, (actual / target) * 100) : 0;
          const isOver = target > 0 && actual > target;
          const isSub = !!c.parent;
          const isParentRow = isParent(c.key);

          return (
            <div key={c.key} className={"pnl-cat " + (isOpen ? "pnl-cat-open " : "") + (c.isExcluded ? "pnl-cat-excluded" : "") + (isSub ? " pnl-cat-sub" : "") + (isParentRow ? " pnl-cat-parent" : "")} style={isSub ? { paddingLeft: 28 } : null}>
              <div className="pnl-cat-row">
                {canExpand ? (
                  <button className="pnl-cat-caret-btn" onClick={() => toggle(c.key)}>{isOpen ? "▾" : "▸"}</button>
                ) : (
                  <span className="pnl-cat-caret">·</span>
                )}
                <span className="pnl-cat-name" style={isParentRow ? { fontWeight: 600 } : (isSub ? { color: "#555" } : null)}>{c.label}</span>
                {c.isExcluded ? (
                  <span style={{ color: "#888", fontSize: 11 }}>not counted</span>
                ) : (
                  <div className="pnl-progress-wrap">
                    <div className={"pnl-progress-bar" + (isOver ? " over" : "")} style={{ width: `${pct}%` }}></div>
                    {target > 0 && <span className="pnl-progress-meta mono">{Math.round(pct)}%</span>}
                  </div>
                )}
                <span className="pnl-cat-actual mono">{fmt(actual)}</span>
                {c.isExcluded ? (
                  <span className="pnl-cat-total mono pnl-readonly">—</span>
                ) : isParentRow ? (
                  <span className="pnl-cat-total mono pnl-readonly" title="Sum of subcategories">{fmt(target)}</span>
                ) : (
                  <ForecastInput value={rawForecast(c.key)} onSave={v => saveVal(c.key, v)} />
                )}
              </div>
              {isOpen && (
                <div className="pnl-vendors">
                  {vendors.length === 0 && <div className="pnl-vendor-empty">No vendors in this category yet.</div>}
                  {vendors.map((v, i) => (
                    <div key={v.key + ":" + i} className="pnl-vendor-row">
                      <div>
                        <div style={{ fontWeight: 500 }}>{v.name}</div>
                        <div style={{ color: "#888", fontSize: 11 }}>{v.count} charge{v.count===1?"":"s"}</div>
                      </div>
                      <div className="pnl-vendor-amount">{fmt(v.amount)}</div>
                      <select value={c.key} onChange={e => moveVendor(v.key, e.target.value)} style={{padding: "4px 6px", fontSize: 11}}>
                        {FAMILY_CATS.map(o => <option key={o.key} value={o.key}>{o.parent ? "\u00A0\u00A0\u2014 " + o.label : o.label}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="pnl-cat" style={{ background: "#fafaf8", fontWeight: 600 }}>
          <div className="pnl-cat-row">
            <span className="pnl-cat-caret">·</span>
            <span className="pnl-cat-name">Total</span>
            <span></span>
            <span className="pnl-cat-actual mono">{fmt(actualGrand)}</span>
            <span className="pnl-cat-total mono">{fmt(grand)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

function ApprovalCard({ pendingTxs, onApprove }) {
  const [bulkBusy, setBulkBusy] = useState(false);
  const withGuesses = pendingTxs.filter(t => t.suggestion);
  const approveAll = async () => {
    if (bulkBusy || withGuesses.length === 0) return;
    setBulkBusy(true);
    // Run sequentially to keep server happy + cache invalidation correct.
    for (const tx of withGuesses) {
      await onApprove(tx.id, tx.suggestion, tx.vendorKey);
    }
    setBulkBusy(false);
  };
  return (
    <div className="approval-card">
      <div className="approval-head">
        <div className="approval-title">Approval Queue</div>
        <div className="approval-sub">{pendingTxs.length} uncategorized transaction{pendingTxs.length === 1 ? "" : "s"}</div>
        {withGuesses.length > 0 && (
          <button
            className={"approval-bulk-btn" + (bulkBusy ? " disabled" : "")}
            disabled={bulkBusy}
            onClick={approveAll}
            style={{ marginLeft: "auto", padding: "8px 14px", border: "1px solid #d4d4d0", background: "#fafaf8", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: bulkBusy ? "wait" : "pointer" }}
          >
            {bulkBusy ? `Approving… (${withGuesses.length} left)` : `Approve all ${withGuesses.length} with guesses`}
          </button>
        )}
      </div>
      <div className="approval-list">
        {pendingTxs.slice(0, 25).map(tx => (
          <ApprovalRow key={tx.id} tx={tx} onApprove={async (cat) => onApprove(tx.id, cat, tx.vendorKey)} />
        ))}
      </div>
      {pendingTxs.length > 25 && (
        <div className="approval-more">+ {pendingTxs.length - 25} more will appear after these are approved</div>
      )}
    </div>
  );
}

function ApprovalRow({ tx, onApprove }) {
  const [cat, setCat] = useState(tx.suggestion || "");
  const [busy, setBusy] = useState(false);
  const fmtDate = (d) => { if (!d) return ""; const p = d.split("-"); return p.length === 3 ? p[1]+"/"+p[2] : d; };
  const go = async () => {
    if (!cat || busy) return;
    setBusy(true);
    await onApprove(cat);
  };
  return (
    <div className="approval-row">
      <div className="approval-row-date">{fmtDate(tx.date)}</div>
      <div className="approval-row-vendor">
        <div className="approval-row-name">{tx.vendorName}</div>
        <div className="approval-row-desc">{tx.desc}</div>
      </div>
      <div className="approval-row-amount">{fmt(tx.amount)}</div>
      <select className="approval-row-select" value={cat} onChange={e => setCat(e.target.value)}>
        <option value="">Choose category…</option>
        {FAMILY_CATS.map(c => <option key={c.key} value={c.key}>{c.parent ? "\u00A0\u00A0\u2014 " + c.label : c.label}</option>)}
      </select>
      <button className={"approval-row-btn" + ((!cat || busy) ? " disabled" : "")} disabled={!cat || busy} onClick={go}>
        {busy ? "…" : "Approve"}
      </button>
    </div>
  );
}

function ForecastInput({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value || ""));
  const inputRef = useRef(null);

  useEffect(() => { if (!editing) setDraft(String(value || "")); }, [value, editing]);

  const start = () => {
    setDraft(String(value || ""));
    setEditing(true);
    setTimeout(() => { if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, 10);
  };
  const commit = () => {
    const n = Number(String(draft).replace(/[$,]/g, ""));
    if (Number.isFinite(n) && n >= 0 && n !== Number(value)) onSave(Math.round(n));
    setEditing(false);
  };
  const cancel = () => { setDraft(String(value || "")); setEditing(false); };

  if (editing) {
    return (
      <input ref={inputRef} className="forecast-input" value={draft}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }} />
    );
  }
  return <span className="forecast-display" onClick={start}>{fmt(value)}</span>;
}

function AccountsView({ snap }) {
  const [uploadStatus, setUploadStatus] = useState({});
  useEffect(() => {
    fetch("/api/upload/status").then(r => r.json()).then(setUploadStatus).catch(() => {});
  }, []);
  return (
    <div className="main">
      <div className="page-title">Accounts</div>
      <div className="page-subtitle">Bank connections and CSV history</div>

      <div className="accounts-section">
        <h3>Connected accounts (Plaid)</h3>
        {(snap.cash_accounts || []).length === 0 ? (
          <p>No accounts yet. Use the "Connect a bank" button in the sidebar.</p>
        ) : (
          (snap.cash_accounts || []).map((a, i) => (
            <div key={i} className="account-row">
              <div>
                <div className="account-name">{a.name}</div>
                <div className="account-name-sub">{a.subtype || a.kind} · {a.mask}</div>
              </div>
              <div className={"account-bal" + (a.balance < 0 ? " negative" : "")}>{fmt(a.balance)}</div>
            </div>
          ))
        )}
      </div>

      <div className="accounts-section">
        <h3>Upload Chase CSV history</h3>
        <p>Plaid only goes back ~30 days. To get 2024 + 2025 history, download Chase CSVs from chase.com (Statements & Activity → Download) and upload them with curl:</p>
        <div className="code-block">curl -X POST "https://YOUR-RENDER-URL/api/upload/csv?mask=XXXX&kind=depository" \<br/>
&nbsp;&nbsp;-H "Content-Type: text/plain" \<br/>
&nbsp;&nbsp;--data-binary @"/path/to/Chase_XXXX_Activity.CSV"</div>
        <p style={{ fontSize: 12, color: "#888" }}>kind = "depository" for checking/savings, "credit" for credit cards. Mask = last 4 digits of the account.</p>
        <h4 style={{ marginTop: 16 }}>Uploaded CSVs</h4>
        {Object.keys(uploadStatus).length === 0 ? (
          <p style={{ fontSize: 13, color: "#888" }}>None uploaded yet.</p>
        ) : (
          Object.entries(uploadStatus).map(([mask, info]) => (
            <div key={mask} className="account-row">
              <div>
                <div className="account-name">Account {mask}</div>
                <div className="account-name-sub">{info.kind} · {info.format} format · {info.count} tx · through {info.max_date}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function FloatingChat() {
  const [open, setOpen] = useState(() => localStorage.getItem("mb_chat") === "open");
  useEffect(() => { localStorage.setItem("mb_chat", open ? "open" : "closed"); }, [open]);
  if (!open) {
    return <button className="fchat-pill" onClick={() => setOpen(true)}>💬 Connor</button>;
  }
  return (
    <div className="fchat-panel">
      <div className="fchat-head">
        <div className="fchat-title">Connor</div>
        <div className="fchat-actions">
          <button className="fchat-btn" onClick={() => setOpen(false)}>—</button>
        </div>
      </div>
      <ChatPanel />
    </div>
  );
}

function ChatPanel() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    fetch("/api/connor/history").then(r => r.json()).then(j => {
      if (j.messages) setMessages(j.messages);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const send = async (text) => {
    const t = text != null ? text : input;
    if (!t.trim() || busy) return;
    const newMsgs = [...messages, { role: "user", content: t }];
    setMessages(newMsgs);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMsgs }),
      }).then(r => r.json());
      setMessages(m => [...m, { role: "assistant", content: r.text || "(no response)", actions: r.actions || [] }]);
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", content: "Error: " + e.message }]);
    } finally {
      setBusy(false);
    }
  };

  const handleAction = (a) => {
    if (a.kind === "navigate" && a.tab) {
      window.dispatchEvent(new CustomEvent("app:navigate", { detail: a.tab }));
    }
  };

  return (
    <div className="chat">
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div style={{ color: "#888", fontSize: 12, textAlign: "center", padding: 24 }}>
            Hi. I'm Connor — your family CFO.<br/>
            Ask me anything about cash, spending, vendors, or budgets.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"msg " + m.role}>
            <div className="msg-bubble" dangerouslySetInnerHTML={{ __html: m.content }} />
            {m.actions && m.actions.length > 0 && (
              <div className="action-chips">
                {m.actions.map((a, j) => (
                  <button key={j} className="action-chip" onClick={() => handleAction(a)}>{a.label}</button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant"><div className="msg-bubble">…</div></div>}
      </div>
      <form className="chat-input" onSubmit={e => { e.preventDefault(); send(); }}>
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask Connor anything…" />
        <button type="submit" disabled={busy}>Send</button>
      </form>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
