// Meg & Ben Finance — frontend (React via Babel, no build step)
// Components: App, TopBar, Sidebar, Main, Dashboard, KpiRow, MonthlyCharts, Chart,
//             BudgetView, ApprovalRow, ForecastInput, AccountsView, FloatingChat, ChatPanel.

const { useState, useEffect, useCallback, useRef } = React;
const API = "";  // same origin
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Categories — loaded from /api/categories on boot. The seed list below is a
// fallback only (used if the server returns nothing). The mutable array
// FAMILY_CATS is replaced in-place after fetch so all references stay live.
// Subcategories carry a `parent` key — they roll up into the parent's total
// for KPIs, but each owns its own forecast.
const FAMILY_CATS = [
  { key: "housing", label: "Housing" },
  { key: "utilities", label: "Utilities" },
  { key: "groceries", label: "Groceries" },
  { key: "dining", label: "Dining & Takeout" },
  { key: "transportation", label: "Transportation" },
  { key: "health", label: "Health" },
  { key: "shopping", label: "Shopping" },
  { key: "kids_activities", label: "Children's Activities" },
  { key: "childcare", label: "Childcare" },
  { key: "education", label: "Education" },
  { key: "travel", label: "Travel & Vacation" },
  { key: "entertainment", label: "Entertainment & Subscriptions" },
  { key: "gifts_charity", label: "Gifts & Charity" },
  { key: "taxes_professional", label: "Taxes & Professional Services" },
  { key: "needs_review", label: "Needs Review" },
  { key: "other", label: "Other" },
  { key: "excluded", label: "Excluded (paid from savings/investments)", isExcluded: true },
];

// Replace FAMILY_CATS contents in place (so all closures over it pick up changes)
// and notify subscribers to re-render.
const _catSubs = new Set();
function setFamilyCats(next) {
  if (!Array.isArray(next) || !next.length) return;
  FAMILY_CATS.length = 0;
  for (const c of next) FAMILY_CATS.push(c);
  for (const fn of _catSubs) { try { fn(); } catch (e) {} }
}
function useFamilyCats() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick(t => t + 1);
    _catSubs.add(fn);
    return () => _catSubs.delete(fn);
  }, []);
  return FAMILY_CATS;
}
async function fetchCategories() {
  try {
    const r = await fetch("/api/categories").then(r => r.json());
    if (r && Array.isArray(r.categories)) setFamilyCats(r.categories);
  } catch (e) { console.warn("[cats] fetch failed", e); }
}
async function saveCategories(list) {
  const r = await fetch("/api/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categories: list }),
  }).then(r => r.json());
  if (r.error) throw new Error(r.error);
  if (Array.isArray(r.categories)) setFamilyCats(r.categories);
}

// Inline-editable text. Click pencil → input; Enter saves, Esc cancels.
function EditableText({ value, onSave, className }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const save = async () => {
    const next = (draft || "").trim();
    if (!next || next === value) { setEditing(false); return; }
    setBusy(true);
    try { await onSave(next); } finally { setBusy(false); setEditing(false); }
  };
  if (editing) {
    return (
      <input
        className={(className || "") + " editable-input"}
        autoFocus
        value={draft}
        disabled={busy}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          else if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
        }}
      />
    );
  }
  return (
    <span className={(className || "") + " editable-wrap"}>
      <span className="editable-text">{value}</span>
      <button className="editable-edit" onClick={() => setEditing(true)} title="Rename">edit</button>
    </span>
  );
}

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

const fmtTxDate = (d) => {
  if (!d) return "";
  const p = String(d).split("-");
  if (p.length !== 3) return d;
  return `${p[1]}/${p[2]}/${p[0].slice(2)}`;
};
const fmtPct = (n) => (n == null || isNaN(n)) ? "0%" : `${n}%`;

function App() {
  const [tab, setTab] = useState(() => localStorage.getItem("mb_tab") || "dashboard");
  const [year, setYear] = useState(() => Number(localStorage.getItem("mb_year")) || new Date().getFullYear());
  const [snap, setSnap] = useState(null);
  const [err, setErr] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [plaidStatus, setPlaidStatus] = useState({ connected: false });

  useEffect(() => { localStorage.setItem("mb_tab", tab); }, [tab]);
  useEffect(() => { localStorage.setItem("mb_year", String(year)); }, [year]);

  const load = useCallback(async (force = false) => {
    try {
      const qs = `?year=${year}` + (force ? "&force=1" : "");
      const [snapRes, plaidRes] = await Promise.all([
        fetch(API + "/api/snapshot" + qs).then(r => r.json()),
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
  }, [year]);

  // Subscribe so a category edit forces a re-render of the whole tree.
  useFamilyCats();
  useEffect(() => {
    fetchCategories();
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
        year={year}
        onYearChange={setYear}
      />
      <Sidebar snap={snap} plaidStatus={plaidStatus} onPlaidChanged={() => load(true)} />
      <Main snap={snap} tab={tab} />
      <FloatingChat />
    </div>
  );
}

function TopBar({ refreshedAt, onRefresh, plaidStatus, tab, onTabChange, year, onYearChange }) {
  const tabs = [
    { key: "dashboard", label: "Dashboard" },
    { key: "budget", label: "Budget & Expenses" },
    { key: "income", label: "Income" },
    { key: "investments", label: "Investments" },
    { key: "accounts", label: "Accounts" },
    { key: "settings", label: "Settings" },
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
        <div className="year-switch">
          {[2025, 2026].map(y => (
            <button
              key={y}
              className={"year-btn" + (year === y ? " active" : "")}
              onClick={() => onYearChange(y)}
            >{y}</button>
          ))}
        </div>
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
        <div className="sidebar-label">Connected banks</div>
        {(plaidStatus.items || []).length === 0 && (
          <div style={{ fontSize: 12, color: "#888", padding: "4px 0 8px" }}>
            No banks linked yet.
          </div>
        )}
        {(plaidStatus.items || []).map((it) => (
          <div key={it.item_id} className="account-row" style={{ alignItems: "center" }}>
            <div>
              <div className="account-name">{it.institution_name}</div>
              <div className="account-name-sub">linked {(it.added_at || "").slice(0,10)}</div>
            </div>
            <button
              className="connect-btn secondary"
              style={{ padding: "4px 8px", fontSize: 11, width: "auto" }}
              onClick={async () => {
                if (!confirm(`Disconnect ${it.institution_name}? Transactions will stop syncing.`)) return;
                await fetch("/api/plaid/remove", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ item_id: it.item_id }),
                });
                onPlaidChanged();
              }}
            >Remove</button>
          </div>
        ))}
        <PlaidConnectButton hasItems={(plaidStatus.items || []).length > 0} onChanged={onPlaidChanged} />
      </div>
    </div>
  );
}

function PlaidConnectButton({ hasItems, onChanged }) {
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
    <button className="connect-btn" style={{ marginTop: 8 }} onClick={connect} disabled={busy}>
      {busy ? "…" : (hasItems ? "+ Connect another bank" : "Connect a bank")}
    </button>
  );
}

function Main({ snap, tab }) {
  if (tab === "budget") return <BudgetView snap={snap} />;
  if (tab === "income") return <IncomeView snap={snap} />;
  if (tab === "investments") return <InvestmentsView />;
  if (tab === "accounts") return <AccountsView snap={snap} />;
  if (tab === "settings") return <SettingsView />;
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
  useFamilyCats();
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
  useFamilyCats();
  const [year, setYear] = useState(() => localStorage.getItem("mb_year") || String(snap.year));
  const [forecast, setForecast] = useState({});
  const [actuals, setActuals] = useState({ vendors: [], byCategory: {}, total: 0 });

  useEffect(() => { localStorage.setItem("mb_year", year); }, [year]);

  useEffect(() => {
    fetch("/api/forecast?year=" + year).then(r => r.json()).then(j => setForecast(j || {})).catch(() => {});
  }, [year]);

  useEffect(() => {
    fetch("/api/actuals?year=" + year).then(r => r.json()).then(j => setActuals(j || { vendors: [], byCategory: {}, total: 0 })).catch(() => {});
  }, [year]);

  // 2026+ are editable (we set budget targets for the future).
  // Years before snap.year are historical (read-only forecast).
  const nextYear = Number(snap.year) + 1;
  const yNum = Number(year);
  const isEditable = yNum >= Number(snap.year);
  const years = [String(snap.year - 2), String(snap.year - 1), String(snap.year), String(nextYear)];

  return (
    <div className="main">
      <div className="page-title">Budget & Expenses</div>
      <div className="page-subtitle">
        Forecast vs actual for {year}.
        {!isEditable && " (Historical year — actuals only.)"}
        {yNum > Number(snap.year) && " (Future year — set targets here; actuals will populate as data arrives.)"}
      </div>
      <div className="year-pills">
        {years.map(y => (
          <div key={y} className={"year-pill" + (y === year ? " active" : "")} onClick={() => setYear(y)}>{y}</div>
        ))}
      </div>
      <BudgetCurrentYear
        forecast={forecast}
        setForecast={setForecast}
        actuals={actuals}
        setActuals={setActuals}
        year={year}
        readOnly={!isEditable}
      />
    </div>
  );
}

function BudgetHistorical_unused() { return null;
  // Snapshot only knows current year; historical view is a stub for now (CSV upload feature lights this up later).
  return (
    <div className="accounts-section">
      <h3>Historical year {year}</h3>
      <p>Upload Chase CSVs for {year} via the Accounts tab to populate this view. The approval queue and per-vendor learning will work the same way once history is loaded.</p>
    </div>
  );
}

function BudgetCurrentYear({ forecast, setForecast, actuals, setActuals, year, readOnly }) {
  const [expanded, setExpanded] = useState({});
  const [expandedVendors, setExpandedVendors] = useState({});
  const toggle = (k) => setExpanded(e => ({ ...e, [k]: !e[k] }));
  const toggleVendor = (vk) => setExpandedVendors(e => ({ ...e, [vk]: !e[vk] }));

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
  // Grand actuals = sum of every non-excluded category (parents AND leaves).
  // Transactions can land directly on a parent (e.g. "shopping" w/o a person tag)
  // OR on a leaf (e.g. "shopping_megan"). Skipping parents would silently drop
  // every untagged transaction. The parent display row already adds children
  // INTO it via actualByCat, so we sum rawActual(c.key) here (raw, not rolled-up)
  // to count each dollar exactly once.
  const actualGrand = FAMILY_CATS
    .filter(c => !c.isExcluded)
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
      body: JSON.stringify({ category: key, amount, year }),
    });
  };

  const refreshActuals = async () => {
    const fresh = await fetch("/api/actuals?year=" + (year || "")).then(r => r.json());
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

  const renameVendor = async (vendorKey, newName) => {
    await fetch("/api/actuals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor_key: vendorKey, name: newName }),
    });
    await refreshActuals();
  };

  const renameTx = async (txId, newDesc) => {
    await fetch("/api/actuals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_id: txId, desc: newDesc }),
    });
    await refreshActuals();
  };

  return (
    <>
      {pendingTxs.length > 0 && (
        <ApprovalCard pendingTxs={pendingTxs}
          onApprove={async (txId, cat, vendorKey) => { await moveTx(txId, cat, vendorKey); }}
          onRenameVendor={renameVendor}
          onRenameTx={renameTx}
        />
      )}

      <div className="pnl-catlist">
        {FAMILY_CATS.map(c => {
          const target = getVal(c.key);
          const actual = actualByCat[c.key] || 0;
          const isOpen = !!expanded[c.key];
          const vendors = (vendorsByCat[c.key] || []).sort((a, b) => b.amount - a.amount);
          const isSub = !!c.parent;
          const isParentRow = isParent(c.key);
          // Hide subcategory rows when their parent is collapsed.
          if (isSub && !expanded[c.parent]) return null;
          // Parent rows are expandable (to show children) even with no direct vendors.
          const canExpand = vendors.length > 0 || isParentRow;
          const pct = target > 0 ? Math.min(100, (actual / target) * 100) : 0;
          const isOver = target > 0 && actual > target;

          return (
            <div key={c.key} className={"pnl-cat " + (isOpen ? "pnl-cat-open " : "") + (c.isExcluded ? "pnl-cat-excluded" : "") + (isSub ? " pnl-cat-sub" : "") + (isParentRow ? " pnl-cat-parent" : "")} style={isSub ? { paddingLeft: 28 } : null}>
              <div className="pnl-cat-row">
                {canExpand ? (
                  <button className="pnl-cat-caret-btn" onClick={() => toggle(c.key)} aria-label={isOpen ? "Collapse" : "Expand"}>{isOpen ? "▾" : "▸"}</button>
                ) : (
                  <span className="pnl-cat-caret">·</span>
                )}
                <span className={"pnl-cat-name" + (isParentRow ? " is-parent" : "") + (isSub ? " is-sub" : "")}>{c.label}</span>
                {c.isExcluded ? (
                  <span className="pnl-cat-not-counted">not counted</span>
                ) : (
                  <div className="pnl-progress-wrap">
                    <div className={"pnl-progress-bar" + (isOver ? " over" : "")} style={{ width: `${pct}%` }}></div>
                    {target > 0 && (
                      <span className="pnl-progress-text mono">
                        {Math.round(pct)}% — {fmt(Math.max(0, target - actual))} left
                      </span>
                    )}
                  </div>
                )}
                <span className="pnl-cat-actual mono">{fmt(actual)}</span>
                {readOnly ? (
                  <span className="pnl-cat-total mono pnl-readonly">—</span>
                ) : c.isExcluded ? (
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
                  {vendors.map((v, i) => {
                    const vTxs = (v.txs || []).filter(t => t.cat === c.key);
                    const dates = vTxs.map(t => t.date).filter(Boolean).sort();
                    const first = dates[0], last = dates[dates.length - 1];
                    const dateRange = first && last
                      ? (first === last ? fmtTxDate(first) : `${fmtTxDate(first)} – ${fmtTxDate(last)}`)
                      : "";
                    const vKey = v.key + ":" + c.key;
                    const vOpen = !!expandedVendors[vKey];
                    return (
                      <div key={vKey} className={"pnl-vendor" + (vOpen ? " pnl-vendor-open" : "")}>
                        <div className="pnl-vendor-row">
                          {vTxs.length > 0 ? (
                            <button className="pnl-vendor-caret-btn" onClick={() => toggleVendor(vKey)} aria-label={vOpen ? "Collapse charges" : "Expand charges"}>{vOpen ? "▾" : "▸"}</button>
                          ) : (
                            <span className="pnl-vendor-caret">·</span>
                          )}
                          <div className="pnl-vendor-mid">
                            <EditableText value={v.name} onSave={n => renameVendor(v.key, n)} className="pnl-vendor-name" />
                            <span className="pnl-vendor-meta">{vTxs.length} charge{vTxs.length===1?"":"s"}{dateRange ? ` · ${dateRange}` : ""}</span>
                          </div>
                          <select className="pnl-vendor-select" value={c.key} onChange={e => moveVendor(v.key, e.target.value)}>
                            {FAMILY_CATS.map(o => <option key={o.key} value={o.key}>{o.parent ? "\u00A0\u00A0\u2014 " + o.label : o.label}</option>)}
                          </select>
                          <div className="pnl-vendor-amount mono">{fmt(v.amount)}</div>
                        </div>
                        {vOpen && (
                          <div className="pnl-tx-list">
                            {vTxs.map(tx => (
                              <div key={tx.id} className="pnl-tx-row">
                                <div className="pnl-tx-date mono">{fmtTxDate(tx.date)}</div>
                                <EditableText value={tx.desc} onSave={n => renameTx(tx.id, n)} className="pnl-tx-desc" />
                                <select className="pnl-tx-select" value={tx.cat} onChange={e => moveTx(tx.id, e.target.value, null)}>
                                  {FAMILY_CATS.map(o => <option key={o.key} value={o.key}>{o.parent ? "\u00A0\u00A0\u2014 " + o.label : o.label}</option>)}
                                </select>
                                <div className="pnl-tx-amount mono">{fmt(tx.amount)}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
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
            <span className="pnl-cat-total mono">{readOnly ? "—" : fmt(grand)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

function ApprovalCard({ pendingTxs, onApprove, onRenameVendor, onRenameTx }) {
  const [bulkBusy, setBulkBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("mb_approval_collapsed") === "1");
  const [page, setPage] = useState(0);
  const [rowCats, setRowCats] = useState({});
  useEffect(() => { localStorage.setItem("mb_approval_collapsed", collapsed ? "1" : "0"); }, [collapsed]);

  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(pendingTxs.length / PAGE_SIZE));
  useEffect(() => { if (page >= totalPages) setPage(Math.max(0, totalPages - 1)); }, [page, totalPages]);
  const pageStart = page * PAGE_SIZE;
  const pageTxs = pendingTxs.slice(pageStart, pageStart + PAGE_SIZE);

  // Initialize row category from suggestion when a tx first appears
  const pageIdsKey = pageTxs.map(t => t.id).join("|");
  useEffect(() => {
    setRowCats(prev => {
      const next = { ...prev };
      let changed = false;
      for (const t of pageTxs) {
        if (!(t.id in next)) { next[t.id] = t.suggestion || ""; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [pageIdsKey]);

  const setCat = (id, c) => setRowCats(prev => ({ ...prev, [id]: c }));
  const pageReady = pageTxs.filter(t => rowCats[t.id]);
  const approveAllShown = async () => {
    if (bulkBusy || pageReady.length === 0) return;
    setBulkBusy(true);
    for (const tx of pageReady) {
      await onApprove(tx.id, rowCats[tx.id], tx.vendorKey);
    }
    setBulkBusy(false);
  };

  return (
    <div className={"approval-card" + (collapsed ? " approval-collapsed" : "")}>
      <div className="approval-head">
        <button
          className="approval-collapse-btn"
          onClick={() => setCollapsed(c => !c)}
          aria-label={collapsed ? "Expand" : "Collapse"}
          title={collapsed ? "Expand" : "Collapse"}
        >{collapsed ? "▸" : "▾"}</button>
        <div className="approval-title">Approval Queue</div>
        <div className="approval-sub">
          {pendingTxs.length} uncategorized transaction{pendingTxs.length === 1 ? "" : "s"}
          {totalPages > 1 && !collapsed && <> · page {page+1} of {totalPages}</>}
        </div>
        {pageReady.length > 0 && !collapsed && (
          <button
            className={"approval-bulk-btn" + (bulkBusy ? " disabled" : "")}
            disabled={bulkBusy}
            onClick={approveAllShown}
            style={{ marginLeft: "auto", padding: "8px 14px", border: "1px solid #d4d4d0", background: "#fafaf8", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: bulkBusy ? "wait" : "pointer" }}
          >
            {bulkBusy ? `Approving… (${pageReady.length} left)` : `Approve all ${pageReady.length} shown`}
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="approval-list">
            {pageTxs.map(tx => (
              <ApprovalRow key={tx.id} tx={tx}
                cat={rowCats[tx.id] || ""}
                onCatChange={(c) => setCat(tx.id, c)}
                onApprove={async () => onApprove(tx.id, rowCats[tx.id] || tx.suggestion, tx.vendorKey)}
                onRenameVendor={async (n) => onRenameVendor(tx.vendorKey, n)}
                onRenameTx={async (n) => onRenameTx(tx.id, n)}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderTop: "1px solid #eee" }}>
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{ padding: "6px 12px", border: "1px solid #d4d4d0", background: page === 0 ? "#f5f5f3" : "#fafaf8", borderRadius: 6, fontSize: 12, cursor: page === 0 ? "default" : "pointer", opacity: page === 0 ? 0.5 : 1 }}
              >← Previous</button>
              <span style={{ fontSize: 12, color: "#888" }}>
                Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, pendingTxs.length)} of {pendingTxs.length}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                style={{ padding: "6px 12px", border: "1px solid #d4d4d0", background: page >= totalPages - 1 ? "#f5f5f3" : "#fafaf8", borderRadius: 6, fontSize: 12, cursor: page >= totalPages - 1 ? "default" : "pointer", opacity: page >= totalPages - 1 ? 0.5 : 1 }}
              >Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ApprovalRow({ tx, cat, onCatChange, onApprove, onRenameVendor, onRenameTx }) {
  useFamilyCats();
  const [busy, setBusy] = useState(false);
  const fmtDate = (d) => { if (!d) return ""; const p = d.split("-"); return p.length === 3 ? p[1]+"/"+p[2] : d; };
  const go = async () => {
    if (!cat || busy) return;
    setBusy(true);
    await onApprove();
  };
  return (
    <div className="approval-row">
      <div className="approval-row-date">{fmtDate(tx.date)}</div>
      <div className="approval-row-vendor">
        <EditableText value={tx.vendorName} onSave={onRenameVendor} className="approval-row-name" />
        <EditableText value={tx.desc} onSave={onRenameTx} className="approval-row-desc" />
      </div>
      <div className="approval-row-amount">{fmt(tx.amount)}</div>
      <select className="approval-row-select" value={cat} onChange={e => onCatChange(e.target.value)}>
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

// ---- Income ----
// Mirrors the budget vendor/tx model but with a fixed three-bucket category
// system: Megan / Ben / Excluded. New deposits default to Excluded so unknowns
// don't inflate income totals — user explicitly tags as Megan or Ben.
const INCOME_CATS = [
  { key: "megan", label: "Megan" },
  { key: "ben", label: "Ben" },
  { key: "excluded", label: "Excluded" },
];

function IncomeView({ snap }) {
  const [year, setYear] = useState(() => localStorage.getItem("mb_year") || String(snap.year));
  const [data, setData] = useState({ vendors: [], byCategory: {}, total: 0 });
  const [loading, setLoading] = useState(true);
  const [expandedVendors, setExpandedVendors] = useState({});
  const [collapsedSections, setCollapsedSections] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mb_income_collapsed") || "{\"excluded\":true}"); }
    catch { return { excluded: true }; }
  });
  useEffect(() => { localStorage.setItem("mb_income_collapsed", JSON.stringify(collapsedSections)); }, [collapsedSections]);
  const toggleSection = (k) => setCollapsedSections(s => ({ ...s, [k]: !s[k] }));

  useEffect(() => { localStorage.setItem("mb_year", year); }, [year]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/income?year=" + year);
      const j = await r.json();
      setData(j || { vendors: [], byCategory: {}, total: 0 });
    } finally { setLoading(false); }
  }, [year]);

  useEffect(() => { reload(); }, [reload]);

  const post = async (body) => {
    await fetch("/api/income", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await reload();
  };

  const setVendorCat = (vendor_key, category) => post({ vendor_key, category });
  const setTxCat = (tx_id, category) => post({ tx_id, category });
  const renameVendor = (vendor_key, name) => post({ vendor_key, name });
  const renameTx = (tx_id, desc) => post({ tx_id, desc });

  const toggleVendor = (vk) => setExpandedVendors(e => ({ ...e, [vk]: !e[vk] }));

  const nextYear = Number(snap.year) + 1;
  const years = [String(snap.year - 2), String(snap.year - 1), String(snap.year), String(nextYear)];

  // Pending = vendors that haven't been categorized yet (default = excluded but not vendorSaved).
  const pendingTxs = [];
  for (const v of (data.vendors || [])) {
    for (const tx of (v.txs || [])) {
      if (!tx.userSet) pendingTxs.push({ ...tx, vendorKey: v.key, vendorName: v.name });
    }
  }
  pendingTxs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const byCat = data.byCategory || {};
  const meganTotal = byCat.megan || 0;
  const benTotal = byCat.ben || 0;
  const excludedTotal = byCat.excluded || 0;
  const incomeTotal = meganTotal + benTotal;

  // Group vendors by their resolved category (uses tx-level cats since user can split a vendor).
  const vendorsByCat = { megan: [], ben: [], excluded: [] };
  for (const v of (data.vendors || [])) {
    const sumByCat = {};
    for (const tx of (v.txs || [])) sumByCat[tx.cat] = (sumByCat[tx.cat] || 0) + tx.amount;
    for (const [cat, amt] of Object.entries(sumByCat)) {
      (vendorsByCat[cat] = vendorsByCat[cat] || []).push({ ...v, amount: amt });
    }
  }
  for (const cat of Object.keys(vendorsByCat)) {
    vendorsByCat[cat].sort((a, b) => b.amount - a.amount);
  }

  return (
    <div className="main">
      <div className="page-title">Income</div>
      <div className="page-subtitle">All deposits for {year}. Tag each as Megan, Ben, or Excluded (transfers, refunds, etc.).</div>
      <div className="year-pills">
        {years.map(y => (
          <div key={y} className={"year-pill" + (y === year ? " active" : "")} onClick={() => setYear(y)}>{y}</div>
        ))}
      </div>

      {loading && <div style={{ padding: 24, color: "#888" }}>Loading…</div>}

      {!loading && (
        <>
          <div className="kpi-row" style={{ marginTop: 16 }}>
            <div className="kpi"><div className="kpi-label">Total Income</div><div className="kpi-value">{fmt(incomeTotal)}</div><div className="kpi-sub">Megan + Ben</div></div>
            <div className="kpi"><div className="kpi-label">Megan</div><div className="kpi-value">{fmt(meganTotal)}</div></div>
            <div className="kpi"><div className="kpi-label">Ben</div><div className="kpi-value">{fmt(benTotal)}</div></div>
            <div className="kpi"><div className="kpi-label">Excluded</div><div className="kpi-value" style={{ color: "#888" }}>{fmt(excludedTotal)}</div><div className="kpi-sub">transfers / refunds</div></div>
          </div>

          {pendingTxs.length > 0 && (
            <IncomeApprovalCard pendingTxs={pendingTxs}
              onApprove={async (txId, cat, vendorKey) => {
                // "Approve" = save the vendor cat (so future deposits auto-fill).
                await post({ vendor_key: vendorKey, category: cat });
              }}
              onApproveTx={async (txId, cat) => { await setTxCat(txId, cat); }}
              onRenameVendor={renameVendor}
              onRenameTx={renameTx}
            />
          )}

          {INCOME_CATS.map(cat => {
            const vendors = vendorsByCat[cat.key] || [];
            if (vendors.length === 0) return null;
            const catTotal = vendors.reduce((s, v) => s + v.amount, 0);
            const collapsed = !!collapsedSections[cat.key];
            return (
              <div key={cat.key} className="income-section">
                <div className="income-section-head" onClick={() => toggleSection(cat.key)} style={{ cursor: "pointer" }}>
                  <span className="income-section-caret">{collapsed ? "▸" : "▾"}</span>
                  <span className="income-section-name">{cat.label}</span>
                  <span className="income-section-count">{vendors.length} vendor{vendors.length===1?"":"s"}</span>
                  <span className={"income-section-amount mono" + (cat.key === "excluded" ? " muted" : " positive")}>{fmt(catTotal)}</span>
                </div>
                {!collapsed && (
                <div className="pnl-vendors">
                  {vendors.map(v => {
                    const exp = !!expandedVendors[v.key + ":" + cat.key];
                    const vTxs = (v.txs || []).filter(tx => tx.cat === cat.key);
                    return (
                      <div key={v.key + ":" + cat.key} className="pnl-vendor">
                        <div className="pnl-vendor-row">
                          {vTxs.length > 0 ? (
                            <button className="pnl-vendor-caret-btn" onClick={() => toggleVendor(v.key + ":" + cat.key)} aria-label={exp ? "Collapse" : "Expand"}>{exp ? "▾" : "▸"}</button>
                          ) : (
                            <span className="pnl-vendor-caret">·</span>
                          )}
                          <div className="pnl-vendor-mid">
                            <EditableText value={v.name} onSave={n => renameVendor(v.key, n)} className="pnl-vendor-name" />
                            <span className="pnl-vendor-meta">{vTxs.length} deposit{vTxs.length===1?"":"s"}</span>
                          </div>
                          <select
                            className="pnl-vendor-select"
                            value={cat.key}
                            onClick={e => e.stopPropagation()}
                            onChange={e => setVendorCat(v.key, e.target.value)}
                          >
                            {INCOME_CATS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                          </select>
                          <div className="pnl-vendor-amount mono">{fmt(v.amount)}</div>
                        </div>
                        {exp && (
                          <div className="pnl-tx-list">
                            {vTxs.map(tx => (
                              <div key={tx.id} className="pnl-tx-row">
                                <div className="pnl-tx-date mono">{fmtTxDate(tx.date)}</div>
                                <EditableText value={tx.desc} onSave={n => renameTx(tx.id, n)} className="pnl-tx-desc" />
                                <select className="pnl-tx-select" value={tx.cat} onChange={e => setTxCat(tx.id, e.target.value)}>
                                  {INCOME_CATS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                                </select>
                                <div className="pnl-tx-amount mono">{fmt(tx.amount)}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                )}
              </div>
            );
          })}

          {(data.vendors || []).length === 0 && (
            <div className="accounts-section" style={{ marginTop: 18 }}>
              <p style={{ color: "#888" }}>No deposits found for {year}. Make sure your accounts are connected via the Accounts tab.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function IncomeApprovalCard({ pendingTxs, onApprove, onApproveTx, onRenameVendor, onRenameTx }) {
  const [bulkBusy, setBulkBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("mb_income_approval_collapsed") === "1");
  const [page, setPage] = useState(0);
  const [rowCats, setRowCats] = useState({});
  useEffect(() => { localStorage.setItem("mb_income_approval_collapsed", collapsed ? "1" : "0"); }, [collapsed]);

  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(pendingTxs.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageTxs = pendingTxs.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const pageReady = pageTxs.filter(tx => rowCats[tx.id]);
  const setCat = (id, cat) => setRowCats(rc => ({ ...rc, [id]: cat }));

  const approveAllShown = async () => {
    setBulkBusy(true);
    try {
      // Group by vendor to minimize writes.
      const byVendor = {};
      for (const tx of pageReady) {
        const cat = rowCats[tx.id];
        if (!byVendor[tx.vendorKey]) byVendor[tx.vendorKey] = { cat, count: 0 };
        byVendor[tx.vendorKey].count++;
      }
      for (const [vk, { cat }] of Object.entries(byVendor)) {
        await onApprove(null, cat, vk);
      }
      setRowCats({});
    } finally { setBulkBusy(false); }
  };

  return (
    <div className={"approval-card" + (collapsed ? " approval-collapsed" : "")} style={{ marginTop: 16 }}>
      <div className="approval-head">
        <button className="approval-collapse-btn" onClick={() => setCollapsed(c => !c)}>{collapsed ? "▸" : "▾"}</button>
        <div className="approval-title">Income Approval Queue</div>
        <div className="approval-sub">
          {pendingTxs.length} unconfirmed deposit{pendingTxs.length === 1 ? "" : "s"}
          {totalPages > 1 && !collapsed && <> · page {safePage+1} of {totalPages}</>}
        </div>
        {pageReady.length > 0 && !collapsed && (
          <button
            className={"approval-bulk-btn" + (bulkBusy ? " disabled" : "")}
            disabled={bulkBusy}
            onClick={approveAllShown}
          >Approve {pageReady.length} on this page</button>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="approval-list">
            {pageTxs.map(tx => (
              <IncomeApprovalRow key={tx.id} tx={tx}
                cat={rowCats[tx.id] || ""}
                onCatChange={(c) => setCat(tx.id, c)}
                onApprove={async () => {
                  const c = rowCats[tx.id];
                  if (!c) return;
                  await onApprove(tx.id, c, tx.vendorKey);
                }}
                onRenameVendor={(n) => onRenameVendor(tx.vendorKey, n)}
                onRenameTx={(n) => onRenameTx(tx.id, n)}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="approval-pager">
              <button disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p-1))}>‹ Prev</button>
              <span>{safePage+1} / {totalPages}</span>
              <button disabled={safePage >= totalPages - 1} onClick={() => setPage(p => p+1)}>Next ›</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function IncomeApprovalRow({ tx, cat, onCatChange, onApprove, onRenameVendor, onRenameTx }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!cat || busy) return;
    setBusy(true);
    try { await onApprove(); } finally { setBusy(false); }
  };
  return (
    <div className="approval-row">
      <div className="approval-row-date">{fmtTxDate(tx.date)}</div>
      <div className="approval-row-vendor">
        <EditableText value={tx.vendorName} onSave={onRenameVendor} className="approval-row-name" />
        <EditableText value={tx.desc} onSave={onRenameTx} className="approval-row-desc" />
      </div>
      <div className="approval-row-amount" style={{ color: "#1a7f37" }}>{fmt(tx.amount)}</div>
      <select className="approval-row-select" value={cat} onChange={e => onCatChange(e.target.value)}>
        <option value="">Choose…</option>
        {INCOME_CATS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      <button className={"approval-row-btn" + ((!cat || busy) ? " disabled" : "")} disabled={!cat || busy} onClick={go}>
        {busy ? "…" : "Approve"}
      </button>
    </div>
  );
}

// ---- Investments ----
// One row per investment source. Drag a PDF onto a row to update its value.
// "Manual" rows are typed numbers (real estate, etc).
function InvestmentsView() {
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const load = async () => {
    try {
      const r = await fetch("/api/investments");
      const j = await r.json();
      setList(j.investments || []);
      setTotal(j.total || 0);
    } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="page-title">Investments</div>
      <div className="page-subtitle">Drag a Rockefeller statement PDF onto its row to refresh. Type a value for everything else.</div>

      <div className="inv-total-card">
        <div className="inv-total-label">Total invested</div>
        <div className="inv-total-value">{fmt(total)}</div>
      </div>

      <div className="inv-list">
        {loading ? (
          <div className="inv-empty">Loading…</div>
        ) : list.length === 0 ? (
          <div className="inv-empty">No investments yet. Add your first one below.</div>
        ) : list.map(row => (
          <InvestmentRow key={row.id} row={row} onChange={load} total={total} />
        ))}
      </div>

      {showAdd ? (
        <AddInvestmentForm onCancel={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />
      ) : (
        <button className="inv-add-btn" onClick={() => setShowAdd(true)}>+ Add investment</button>
      )}
    </div>
  );
}

function InvestmentRow({ row, onChange, total }) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(row.name);
  const [draftValue, setDraftValue] = useState(String(row.value || 0));
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [parseStatus, setParseStatus] = useState(null); // null | "uploading" | "ok" | { error }

  const pct = total > 0 ? Math.round((row.value / total) * 100) : 0;

  const save = async () => {
    setBusy(true);
    try {
      await fetch("/api/investments", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id, name: draftName, value: Number(draftValue) || 0, source: "manual" }),
      });
      setEditing(false);
      onChange();
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm(`Delete "${row.name}"?`)) return;
    await fetch(`/api/investments/${row.id}`, { method: "DELETE" });
    onChange();
  };

  const uploadPdf = async (file) => {
    if (!file) return;
    setParseStatus("uploading");
    try {
      const r = await fetch(`/api/investments/parse-pdf?id=${encodeURIComponent(row.id)}&filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: file,
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        setParseStatus({ error: j.error || "upload failed" });
      } else {
        setParseStatus("ok");
        onChange();
        setTimeout(() => setParseStatus(null), 3000);
      }
    } catch (e) {
      setParseStatus({ error: e.message });
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type === "application/pdf") uploadPdf(f);
    else setParseStatus({ error: "drop a PDF file" });
  };

  return (
    <div
      className={"inv-row" + (drag ? " inv-row-drag" : "")}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      <div className="inv-row-main">
        {editing ? (
          <>
            <input className="inv-row-name-input" value={draftName} onChange={e => setDraftName(e.target.value)} />
            <input className="inv-row-value-input" value={draftValue}
                   onChange={e => setDraftValue(e.target.value.replace(/[^0-9.\-]/g, ""))}
                   placeholder="0" />
            <div className="inv-row-actions">
              <button className="inv-btn-primary" onClick={save} disabled={busy}>Save</button>
              <button className="inv-btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <div className="inv-row-name">{row.name}</div>
            <div className="inv-row-pct">{pct}%</div>
            <div className="inv-row-value">{fmt(row.value)}</div>
            <div className="inv-row-actions">
              <label className="inv-btn-secondary">
                Upload PDF
                <input type="file" accept="application/pdf" style={{ display: "none" }}
                       onChange={e => uploadPdf(e.target.files[0])} />
              </label>
              <button className="inv-btn-secondary" onClick={() => { setDraftName(row.name); setDraftValue(String(row.value)); setEditing(true); }}>Edit</button>
              <button className="inv-btn-ghost" onClick={remove}>Delete</button>
            </div>
          </>
        )}
      </div>
      <div className="inv-row-meta">
        {row.updated_at && <span>Updated {new Date(row.updated_at).toLocaleDateString()}</span>}
        {row.last_pdf_as_of && <span>· Statement as of {row.last_pdf_as_of}</span>}
        {row.last_pdf_label && <span>· {row.last_pdf_label}</span>}
        {row.source === "rockefeller" && <span>· From PDF</span>}
        {row.source === "manual" && <span>· Manual entry</span>}
      </div>
      {parseStatus === "uploading" && <div className="inv-row-status">Reading PDF…</div>}
      {parseStatus === "ok" && <div className="inv-row-status inv-row-status-ok">Updated.</div>}
      {parseStatus && parseStatus.error && <div className="inv-row-status inv-row-status-err">{parseStatus.error}</div>}
      {drag && <div className="inv-row-drop-hint">Drop the PDF</div>}
    </div>
  );
}

function AddInvestmentForm({ onCancel, onSaved }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/investments", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), value: Number(value) || 0, source: "manual" }),
      });
      onSaved();
    } finally { setBusy(false); }
  };

  return (
    <div className="inv-add-form">
      <input placeholder="Name (e.g. Rockefeller, Wealthfront, Brooklyn duplex)" value={name} onChange={e => setName(e.target.value)} />
      <input placeholder="Value (or leave blank, fill in later)" value={value}
             onChange={e => setValue(e.target.value.replace(/[^0-9.\-]/g, ""))} />
      <button className="inv-btn-primary" onClick={save} disabled={busy || !name.trim()}>Add</button>
      <button className="inv-btn-secondary" onClick={onCancel}>Cancel</button>
    </div>
  );
}

// ---- Settings ----
// Lightweight category manager: rename labels, add new top-level categories,
// add subcategories under an existing parent. Deleting/reassigning is
// intentionally not exposed yet — too easy to strand existing tx overrides.
function SettingsView() {
  const cats = useFamilyCats();
  const [draft, setDraft] = useState(() => cats.map(c => ({ ...c })));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newParent, setNewParent] = useState("");

  // Re-sync local draft when server state changes (e.g. after save)
  useEffect(() => { setDraft(cats.map(c => ({ ...c }))); }, [cats]);

  const renameLocal = (idx, label) => {
    setDraft(d => d.map((c, i) => i === idx ? { ...c, label } : c));
  };

  const addCategory = () => {
    const label = newLabel.trim();
    if (!label) return;
    // Auto-generate a key from the label.
    const baseKey = (newParent ? newParent + "_" : "") + label.toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    let key = baseKey || ("cat_" + Date.now());
    let n = 2;
    const taken = new Set(draft.map(c => c.key));
    while (taken.has(key)) { key = baseKey + "_" + n++; }
    const item = { key, label };
    if (newParent) item.parent = newParent;
    setDraft(d => [...d, item]);
    setNewLabel("");
    setNewParent("");
    setShowAdd(false);
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await saveCategories(draft);
      setMsg("Saved.");
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setMsg("Error: " + e.message);
    } finally { setBusy(false); }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(cats);
  // Top-level categories make valid parents for new subcategories.
  const topLevel = draft.filter(c => !c.parent && !c.isExcluded);

  return (
    <div className="main">
      <div className="page-title">Settings</div>
      <div className="page-subtitle">Manage your spending categories</div>

      <div className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <div className="panel-title">Categories</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="connect-btn secondary" onClick={() => setShowAdd(s => !s)}>
              {showAdd ? "Cancel" : "+ Add category"}
            </button>
            <button
              className="connect-btn"
              onClick={save}
              disabled={!dirty || busy}
              style={{ opacity: (!dirty || busy) ? 0.5 : 1 }}
            >{busy ? "Saving…" : "Save changes"}</button>
          </div>
        </div>

        {showAdd && (
          <div style={{ display: "flex", gap: 8, padding: "12px 16px", borderBottom: "1px solid #eee", alignItems: "center", flexWrap: "wrap" }}>
            <input
              autoFocus
              placeholder="Category name (e.g. Pets)"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") addCategory(); }}
              style={{ flex: "1 1 240px", minWidth: 0, padding: "6px 10px", fontSize: 14, border: "1px solid #ddd", borderRadius: 4 }}
            />
            <select
              value={newParent}
              onChange={e => setNewParent(e.target.value)}
              style={{ padding: "6px 10px", fontSize: 14, border: "1px solid #ddd", borderRadius: 4 }}
            >
              <option value="">Top-level category</option>
              {topLevel.map(c => <option key={c.key} value={c.key}>Subcategory of: {c.label}</option>)}
            </select>
            <button className="connect-btn" onClick={addCategory} disabled={!newLabel.trim()}>Add</button>
          </div>
        )}

        {msg && (
          <div style={{ padding: "8px 16px", color: msg.startsWith("Error") ? "#c33" : "#0a7", fontSize: 13 }}>{msg}</div>
        )}

        <div style={{ padding: "8px 0" }}>
          {draft.map((c, idx) => (
            <div key={c.key} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "8px 16px",
              borderTop: idx === 0 ? "none" : "1px solid #f3f3f3",
              paddingLeft: c.parent ? 40 : 16,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  value={c.label}
                  onChange={e => renameLocal(idx, e.target.value)}
                  style={{
                    width: "100%", padding: "4px 8px", fontSize: 14,
                    border: "1px solid transparent", borderRadius: 4,
                    background: "transparent",
                  }}
                  onFocus={e => e.target.style.border = "1px solid #ddd"}
                  onBlur={e => e.target.style.border = "1px solid transparent"}
                />
              </div>
              <div style={{ fontSize: 11, color: "#999", fontFamily: "monospace" }}>
                {c.key}{c.parent ? ` · child of ${c.parent}` : ""}{c.isExcluded ? " · excluded" : ""}
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: "12px 16px", borderTop: "1px solid #eee", fontSize: 12, color: "#888", lineHeight: 1.6 }}>
          <strong>Notes:</strong> You can rename labels and add new categories. Renaming a label only changes how it's displayed — existing transactions stay where they are. New categories start empty; assign transactions to them via the Approval Queue or Budget tab. Deleting categories isn't supported yet (it could orphan transactions).
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
