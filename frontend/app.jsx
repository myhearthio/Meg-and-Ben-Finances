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

// Lightweight confirmation toast. Approving/moving a row lands it in a category
// that may be collapsed, which felt like the row "disappeared". This shows WHERE
// it went so the action always has visible feedback.
let _toastTimer = null;
function flashToast(msg) {
  let el = document.getElementById("mb-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "mb-toast";
    el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);background:#1f2937;color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:9999;opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:none;max-width:80vw;text-align:center;";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
  });
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(8px)";
  }, 2200);
}
const catLabel = (key) => (FAMILY_CATS.find(c => c.key === key) || {}).label || key;

function App() {
  const [tab, setTab] = useState(() => {
    const t = localStorage.getItem("mb_tab") || "dashboard";
    return localStorage.getItem("mb_pin_ok") === "1" ? t : "todos";
  });
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

  const [unlocked, setUnlocked] = useState(() => localStorage.getItem("mb_pin_ok") === "1");
  const isTodos = tab === "todos";
  const locked = !unlocked && !isTodos;
  if (!isTodos && !locked) {
    if (err) return <ErrorScreen err={err} onRetry={() => load(true)} />;
    if (!snap) return <div className="boot-loader"><div className="boot-dot"></div><div className="boot-msg">Loading…</div></div>;
  }

  return (
    <div className={"app" + (isTodos || locked ? " app-full" : "")}>
      <TopBar
        refreshedAt={refreshedAt}
        onRefresh={() => load(true)}
        plaidStatus={plaidStatus}
        tab={tab}
        onTabChange={setTab}
        year={year}
        onYearChange={setYear}
      />
      {locked ? (
        <PinGate onUnlock={() => { localStorage.setItem("mb_pin_ok", "1"); setUnlocked(true); }} />
      ) : isTodos ? (
        <TodosView />
      ) : (
        <React.Fragment>
          <Sidebar snap={snap} plaidStatus={plaidStatus} onPlaidChanged={() => load(true)} />
          <Main snap={snap} tab={tab} />
          <FloatingChat />
        </React.Fragment>
      )}
    </div>
  );
}

const FINANCE_TABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "budget", label: "Budget & Expenses" },
  { key: "income", label: "Income" },
  { key: "investments", label: "Investments" },
];
const FINANCE_KEYS = new Set(FINANCE_TABS.map(t => t.key));

function TopBar({ refreshedAt, onRefresh, plaidStatus, tab, onTabChange, year, onYearChange }) {
  const inFinance = FINANCE_KEYS.has(tab);
  const topTabs = [
    { key: "todos", label: "To-Dos", active: tab === "todos" },
    { key: "finance", label: "Finance", active: inFinance },
    { key: "accounts", label: "Accounts", active: tab === "accounts" },
    { key: "settings", label: "Settings", active: tab === "settings" },
  ];
  const goTop = (key) => {
    if (key === "finance") onTabChange(localStorage.getItem("mb_fin_tab") || "dashboard");
    else onTabChange(key);
  };
  const goSub = (key) => { localStorage.setItem("mb_fin_tab", key); onTabChange(key); };
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="brand">Meg & Ben Finance<span className="brand-sub">family CFO</span></span>
        <div className="tabs">
          {topTabs.map(t => (
            <div key={t.key} className={"tab" + (t.active ? " active" : "")}
                 onClick={() => goTop(t.key)}>{t.label}</div>
          ))}
        </div>
        {inFinance && (
          <div className="tabs subtabs">
            {FINANCE_TABS.map(t => (
              <div key={t.key} className={"tab subtab" + (tab === t.key ? " active" : "")}
                   onClick={() => goSub(t.key)}>{t.label}</div>
            ))}
          </div>
        )}
      </div>
      {tab !== "todos" && <div className="topbar-right">
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
      </div>}
    </div>
  );
}

function PinGate({ onUnlock }) {
  const [pin, setPin] = useState("");
  const [shake, setShake] = useState(false);
  const press = (d) => {
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      if (next === "9892") onUnlock();
      else { setShake(true); setTimeout(() => { setPin(""); setShake(false); }, 450); }
    }
  };
  return (
    <div className="pin-screen">
      <div className="pin-brand">Meg & Ben Finance</div>
      <div className="pin-sub">Enter code</div>
      <div className={"pin-dots" + (shake ? " pin-shake" : "")}>
        {[0, 1, 2, 3].map(i => <span key={i} className={"pin-dot" + (pin.length > i ? " filled" : "")}></span>)}
      </div>
      <div className="pin-pad">
        {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((k, i) => (
          k === "" ? <span key={i}></span> :
          <button key={i} className="pin-key" onClick={() => k === "⌫" ? setPin(pin.slice(0, -1)) : press(k)}>{k}</button>
        ))}
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
      <NetWorthHero snap={snap} />
      <KpiRow snap={snap} />
      <MonthlyCharts snap={snap} />
    </div>
  );
}

function NetWorthHero({ snap }) {
  const k = snap.kpis || {};
  const cash = k.cash_on_hand || 0;
  const inv = k.investments_total || 0;
  const nw = k.net_worth ?? (cash + inv);
  return (
    <div className="nw-hero">
      <div className="nw-hero-main">
        <div className="nw-hero-label">Net Worth</div>
        <div className="nw-hero-value">{fmt(nw)}</div>
      </div>
      <div className="nw-hero-breakdown">
        <div className="nw-hero-part">
          <div className="nw-hero-part-label">Investments</div>
          <div className="nw-hero-part-value">{fmt(inv)}</div>
        </div>
        <div className="nw-hero-plus">+</div>
        <div className="nw-hero-part">
          <div className="nw-hero-part-label">Cash − Credit</div>
          <div className={"nw-hero-part-value " + (cash >= 0 ? "" : "red")}>{fmt(cash)}</div>
        </div>
      </div>
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
  // Optimistic approvals: txId -> category. Applied on top of server data so the
  // queue row vanishes instantly when the user hits Approve, even while the
  // network request is still in flight.
  const [optimisticTx, setOptimisticTx] = useState({});
  const toggle = (k) => setExpanded(e => ({ ...e, [k]: !e[k] }));
  const toggleVendor = (vk) => setExpandedVendors(e => ({ ...e, [vk]: !e[vk] }));

  // Merge optimistic approvals over server vendors: stamp userSet + override cat.
  const mergedVendors = (actuals?.vendors || []).map(v => ({
    ...v,
    txs: (v.txs || []).map(tx => {
      const ov = optimisticTx[tx.id];
      if (!ov) return tx;
      return { ...tx, cat: ov, userSet: true };
    }),
  }));
  const mergedActuals = { ...(actuals || {}), vendors: mergedVendors };

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

  // Recompute byCategory from merged vendors so optimistic approvals flow into
  // every category total instantly. MUST be declared before rawActual/actualGrand
  // use it — otherwise it's a temporal-dead-zone ReferenceError that blanks the page.
  const mergedByCategory = (() => {
    const out = {};
    for (const v of mergedVendors) for (const tx of (v.txs || [])) {
      out[tx.cat] = (out[tx.cat] || 0) + tx.amount;
    }
    return out;
  })();

  const rawActual = (k) => Number((mergedByCategory || {})[k] || 0);
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
  for (const v of mergedVendors) {
    for (const tx of (v.txs || [])) {
      if (!tx.userSet) pendingTxs.push({ ...tx, vendorKey: v.key, vendorName: v.name });
    }
  }
  pendingTxs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const vendorsByCat = {};
  for (const v of mergedVendors) {
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
    // Drop optimistic entries the server has now confirmed (userSet=true).
    setOptimisticTx(prev => {
      const serverApproved = new Set();
      for (const v of (fresh?.vendors || [])) for (const t of (v.txs || [])) {
        if (t.userSet) serverApproved.add(t.id);
      }
      const next = {};
      for (const [id, cat] of Object.entries(prev)) {
        if (!serverApproved.has(id)) next[id] = cat;
      }
      return next;
    });
  };

  // Optimistic approve from the queue: stamp locally, fire request in background.
  // Per-tx ONLY — approving one transaction must never write a vendor rule
  // (a vendor rule auto-approves every other pending tx from that vendor,
  // which made the whole queue vanish in one click). Vendor-wide approval
  // is a separate, explicit action (approveVendorOptimistic).
  const approveTxOptimistic = (txId, newCat) => {
    setOptimisticTx(prev => ({ ...prev, [txId]: newCat }));
    // Open the destination category so the row is visible where it landed.
    setExpanded(e => ({ ...e, [newCat]: true }));
    flashToast("Moved to " + catLabel(newCat));
    (async () => {
      try {
        await fetch("/api/actuals", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tx_id: txId, category: newCat }),
        });
        await refreshActuals();
      } catch (e) { /* leave optimistic stamp in place; next refresh reconciles */ }
    })();
  };

  // Explicit vendor-wide approve: user clicked "All N from this vendor".
  const approveVendorOptimistic = (vendorKey, newCat) => {
    const stamped = {};
    for (const v of mergedVendors) {
      if (v.key !== vendorKey) continue;
      for (const tx of (v.txs || [])) if (!tx.userSet) stamped[tx.id] = newCat;
    }
    const n = Object.keys(stamped).length;
    setOptimisticTx(prev => ({ ...prev, ...stamped }));
    setExpanded(e => ({ ...e, [newCat]: true }));
    flashToast(n + " moved to " + catLabel(newCat));
    (async () => {
      try {
        await fetch("/api/actuals", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vendor_key: vendorKey, category: newCat }),
        });
        await refreshActuals();
      } catch (e) { /* reconcile on next refresh */ }
    })();
  };

  const moveVendor = async (vendorKey, newCat) => {
    setExpanded(e => ({ ...e, [newCat]: true }));
    flashToast("Moved to " + catLabel(newCat));
    await fetch("/api/actuals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor_key: vendorKey, category: newCat }),
    });
    await refreshActuals();
  };

  // Per-tx only — moving one tx must not rewrite the vendor rule.
  const moveTx = async (txId, newCat) => {
    setExpanded(e => ({ ...e, [newCat]: true }));
    flashToast("Moved to " + catLabel(newCat));
    await fetch("/api/actuals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_id: txId, category: newCat }),
    });
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
          onApprove={(txId, cat) => { approveTxOptimistic(txId, cat); }}
          onApproveVendor={(vendorKey, cat) => { approveVendorOptimistic(vendorKey, cat); }}
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

function ApprovalCard({ pendingTxs, onApprove, onApproveVendor, onRenameVendor, onRenameTx }) {
  // How many pending txs each vendor has — powers the "All N from this vendor" button.
  const vendorPendingCount = {};
  for (const t of pendingTxs) vendorPendingCount[t.vendorKey] = (vendorPendingCount[t.vendorKey] || 0) + 1;
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
      await onApprove(tx.id, rowCats[tx.id]);
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
                vendorPending={vendorPendingCount[tx.vendorKey] || 0}
                onCatChange={(c) => setCat(tx.id, c)}
                onApprove={async () => onApprove(tx.id, rowCats[tx.id] || tx.suggestion)}
                onApproveVendor={async () => onApproveVendor(tx.vendorKey, rowCats[tx.id] || tx.suggestion)}
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

function ApprovalRow({ tx, cat, vendorPending, onCatChange, onApprove, onApproveVendor, onRenameVendor, onRenameTx }) {
  useFamilyCats();
  const [busy, setBusy] = useState(false);
  const fmtDate = (d) => { if (!d) return ""; const p = d.split("-"); return p.length === 3 ? p[1]+"/"+p[2] : d; };
  const go = async () => {
    if (!cat || busy) return;
    setBusy(true);
    await onApprove();
  };
  const goVendor = async () => {
    if (!cat || busy) return;
    setBusy(true);
    await onApproveVendor();
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
      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "stretch" }}>
        <button className={"approval-row-btn" + ((!cat || busy) ? " disabled" : "")} disabled={!cat || busy} onClick={go}>
          {busy ? "…" : "Approve"}
        </button>
        {vendorPending > 1 && (
          <button
            disabled={!cat || busy}
            onClick={goVendor}
            title={"Categorize all " + vendorPending + " pending transactions from this vendor and remember it for the future"}
            style={{ padding: "3px 6px", border: "1px solid #d4d4d0", background: "#fafaf8", borderRadius: 5, fontSize: 10.5, color: "#666", cursor: (!cat || busy) ? "default" : "pointer", opacity: (!cat || busy) ? 0.5 : 1, whiteSpace: "nowrap" }}
          >All {vendorPending} from vendor</button>
        )}
      </div>
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

function DraggablePill({ onOpen }) {
  // Position is stored as {x, y} in px from the left/top of the viewport.
  // We migrate from the old fixed bottom-right anchor on first run.
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("mb_chat_pos") || "null");
      if (saved && typeof saved.x === "number" && typeof saved.y === "number") return saved;
    } catch {}
    // Default: bottom-right, accounting for pill size (~140x44).
    return { x: window.innerWidth - 160, y: window.innerHeight - 64 };
  });
  const dragState = useRef({
    dragging: false, startX: 0, startY: 0, origX: 0, origY: 0, moved: false,
  });
  const elRef = useRef(null);

  // Reclamp on viewport resize so the pill never lives off-screen.
  useEffect(() => {
    const clamp = () => setPos(p => clampPos(p, elRef.current));
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const clampPos = (p, el) => {
    const w = (el && el.offsetWidth) || 140;
    const h = (el && el.offsetHeight) || 44;
    return {
      x: Math.max(8, Math.min(window.innerWidth - w - 8, p.x)),
      y: Math.max(8, Math.min(window.innerHeight - h - 8, p.y)),
    };
  };

  const onPointerDown = (e) => {
    dragState.current = {
      dragging: true,
      startX: e.clientX, startY: e.clientY,
      origX: pos.x, origY: pos.y,
      moved: false,
    };
    e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const s = dragState.current;
    if (!s.dragging) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.moved && Math.hypot(dx, dy) > 4) s.moved = true;
    if (s.moved) {
      const next = clampPos({ x: s.origX + dx, y: s.origY + dy }, elRef.current);
      setPos(next);
    }
  };

  const onPointerUp = (e) => {
    const s = dragState.current;
    if (!s.dragging) return;
    s.dragging = false;
    if (s.moved) {
      // Persist new position; suppress the click so we don't open chat.
      const final = clampPos(pos, elRef.current);
      setPos(final);
      localStorage.setItem("mb_chat_pos", JSON.stringify(final));
    } else {
      // It was a real click → open chat.
      onOpen();
    }
  };

  return (
    <button
      ref={elRef}
      className="fchat-pill fchat-pill-draggable"
      style={{ left: pos.x + "px", top: pos.y + "px", right: "auto", bottom: "auto", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >💼 Harold</button>
  );
}

function FloatingChat() {
  const [open, setOpen] = useState(() => localStorage.getItem("mb_chat") === "open");
  useEffect(() => { localStorage.setItem("mb_chat", open ? "open" : "closed"); }, [open]);
  if (!open) {
    return <DraggablePill onOpen={() => setOpen(true)} />;
  }
  return (
    <div className="fchat-panel">
      <div className="fchat-head">
        <div className="fchat-title">Harold</div>
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
  const [pendingFiles, setPendingFiles] = useState([]); // [{filename, mediaType, base64, size}]
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetch("/api/harold/history").then(r => r.json()).then(j => {
      if (j.messages) setMessages(j.messages);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const onPickFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // reset so same file can be re-picked
    const max = 3 - pendingFiles.length;
    const additions = [];
    for (const f of files.slice(0, max)) {
      if (f.size > 25 * 1024 * 1024) {
        alert(`${f.name}: file too large (max 25 MB).`);
        continue;
      }
      try {
        const base64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => {
            const s = String(r.result || "");
            const i = s.indexOf(",");
            res(i >= 0 ? s.slice(i + 1) : s);
          };
          r.onerror = rej;
          r.readAsDataURL(f);
        });
        additions.push({
          filename: f.name,
          mediaType: f.type || "application/octet-stream",
          base64,
          size: f.size,
        });
      } catch (err) {
        alert(`Failed to read ${f.name}: ${err.message}`);
      }
    }
    if (additions.length) setPendingFiles(p => [...p, ...additions]);
  };

  const removePendingFile = (idx) => {
    setPendingFiles(p => p.filter((_, i) => i !== idx));
  };

  const send = async (text) => {
    const t = text != null ? text : input;
    if ((!t.trim() && pendingFiles.length === 0) || busy) return;

    // Build user content: string if no attachments, object if attachments.
    const userContent = pendingFiles.length
      ? { text: t, attachments: pendingFiles.map(p => ({ filename: p.filename, mediaType: p.mediaType, base64: p.base64 })) }
      : t;
    const newMsgs = [...messages, { role: "user", content: userContent }];
    setMessages(newMsgs);
    setInput("");
    setPendingFiles([]);
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

  // Render a message bubble. Content is either a string (legacy/assistant)
  // or {text, attachments}. We render the text via dangerouslySetInnerHTML
  // (Harold uses inline HTML chips) but plain-text for user messages.
  const renderBubble = (m) => {
    const c = m.content;
    if (typeof c === "string") {
      if (m.role === "assistant") {
        return <div className="msg-bubble" dangerouslySetInnerHTML={{ __html: c }} />;
      }
      return <div className="msg-bubble">{c}</div>;
    }
    if (c && typeof c === "object") {
      const text = c.text || "";
      const atts = Array.isArray(c.attachments) ? c.attachments : [];
      return (
        <div className="msg-bubble">
          {atts.length > 0 && (
            <div className="msg-attachments">
              {atts.map((a, i) => (
                <span key={i} className="att-chip">
                  <span className="att-icon">{attIcon(a.mediaType)}</span>
                  <span className="att-name">{a.filename}</span>
                </span>
              ))}
            </div>
          )}
          {text && <div>{text}</div>}
        </div>
      );
    }
    return <div className="msg-bubble">(empty)</div>;
  };

  return (
    <div className="chat">
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div style={{ color: "#888", fontSize: 12, textAlign: "center", padding: 24 }}>
            Hello. Harold here — your family CFO.<br/>
            Bessemer Trust, then a small family office. Now you.<br/>
            Ask me anything. Spending, the portfolio, REPS, when you can retire.<br/>
            <span style={{ opacity: 0.6 }}>Attach PDFs, images, or CSVs with the 📎 button.</span>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"msg " + m.role}>
            {renderBubble(m)}
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
      {pendingFiles.length > 0 && (
        <div className="chat-pending">
          {pendingFiles.map((f, i) => (
            <span key={i} className="att-chip pending">
              <span className="att-icon">{attIcon(f.mediaType)}</span>
              <span className="att-name">{f.filename}</span>
              <button className="att-x" onClick={() => removePendingFile(i)} aria-label="Remove">✕</button>
            </span>
          ))}
        </div>
      )}
      <form className="chat-input" onSubmit={e => { e.preventDefault(); send(); }}>
        <button type="button" className="chat-paperclip" onClick={() => fileInputRef.current?.click()} title="Attach files (PDF, image, CSV)">📎</button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.csv,.txt,.json,image/*"
          style={{ display: "none" }}
          onChange={onPickFiles}
        />
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask Harold…" />
        <button type="submit" disabled={busy}>Send</button>
      </form>
    </div>
  );
}

function attIcon(mediaType) {
  const mt = (mediaType || "").toLowerCase();
  if (mt === "application/pdf") return "📄";
  if (mt.startsWith("image/")) return "🖼";
  if (mt.includes("csv") || mt.includes("text") || mt.includes("json")) return "📊";
  return "📎";
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
  const [forecast, setForecast] = useState({});
  const [loading, setLoading] = useState(true);
  const [firstLoaded, setFirstLoaded] = useState(false);
  // Optimistic state: tx IDs the user has just approved locally (before server confirms).
  // Maps txId -> category. Merged into the vendor/tx tree so the UI updates instantly.
  const [optimisticTx, setOptimisticTx] = useState({});
  const [expandedVendors, setExpandedVendors] = useState({});
  const [collapsedSections, setCollapsedSections] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mb_income_collapsed") || "{\"excluded\":true}"); }
    catch { return { excluded: true }; }
  });
  useEffect(() => { localStorage.setItem("mb_income_collapsed", JSON.stringify(collapsedSections)); }, [collapsedSections]);
  const toggleSection = (k) => setCollapsedSections(s => ({ ...s, [k]: !s[k] }));

  useEffect(() => { localStorage.setItem("mb_year", year); }, [year]);

  const reload = useCallback(async ({ background = false } = {}) => {
    if (!background) setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        fetch("/api/income?year=" + year),
        fetch("/api/income-forecast?year=" + year),
      ]);
      const j = await r1.json();
      const f = await r2.json();
      setData(j || { vendors: [], byCategory: {}, total: 0 });
      setForecast(f || {});
      setFirstLoaded(true);
      // Clear optimistic state once real data has caught up — anything still
      // pending in optimisticTx whose tx hasn't yet shown userSet=true on the
      // server gets reapplied on next render via the merged view.
      setOptimisticTx(prev => {
        const next = {};
        const serverApproved = new Set();
        for (const v of (j?.vendors || [])) for (const t of (v.txs || [])) {
          if (t.userSet) serverApproved.add(t.id);
        }
        for (const [id, cat] of Object.entries(prev)) {
          if (!serverApproved.has(id)) next[id] = cat; // server hasn't caught up yet
        }
        return next;
      });
    } finally { if (!background) setLoading(false); }
  }, [year]);

  useEffect(() => { reload(); }, [reload]);

  const saveForecast = async (person, amount) => {
    setForecast(f => ({ ...f, [person]: amount }));
    await fetch("/api/income-forecast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person, amount, year }),
    });
  };

  // Single-op write: fire request, then revalidate in background (no loading flash).
  const post = async (body) => {
    await fetch("/api/income", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await reload({ background: true });
  };

  // Batch write: send N ops in one round-trip, then one background revalidate.
  const postBatch = async (ops) => {
    if (!ops || ops.length === 0) return;
    await fetch("/api/income/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops }),
    });
    await reload({ background: true });
  };

  // Optimistic approve: stamp tx as userSet locally immediately, fire request in
  // background. Used by the queue so it never flashes "Loading…".
  const approveTxOptimistic = (txId, category) => {
    setOptimisticTx(prev => ({ ...prev, [txId]: category }));
    // Open the destination section (Excluded starts collapsed) so the row shows.
    setCollapsedSections(s => ({ ...s, [category]: false }));
    flashToast("Tagged as " + ((INCOME_CATS.find(c => c.key === category) || {}).label || category));
    // Fire the network call but don't await UI on it.
    fetch("/api/income", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_id: txId, category }),
    }).then(() => reload({ background: true })).catch(() => {});
  };

  // Optimistic batch approve: same idea for "Approve N on this page".
  const approveBatchOptimistic = (rows) => {
    if (!rows || rows.length === 0) return;
    setOptimisticTx(prev => {
      const next = { ...prev };
      for (const r of rows) next[r.tx_id] = r.category;
      return next;
    });
    setCollapsedSections(s => {
      const next = { ...s };
      for (const r of rows) next[r.category] = false;
      return next;
    });
    flashToast(rows.length + " deposit" + (rows.length === 1 ? "" : "s") + " tagged");
    const ops = rows.map(r => ({ tx_id: r.tx_id, category: r.category }));
    fetch("/api/income/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops }),
    }).then(() => reload({ background: true })).catch(() => {});
  };

  const setVendorCat = (vendor_key, category) => {
    setCollapsedSections(s => ({ ...s, [category]: false }));
    flashToast("Moved to " + ((INCOME_CATS.find(c => c.key === category) || {}).label || category));
    return post({ vendor_key, category });
  };
  const setTxCat = (tx_id, category) => {
    setCollapsedSections(s => ({ ...s, [category]: false }));
    flashToast("Moved to " + ((INCOME_CATS.find(c => c.key === category) || {}).label || category));
    return post({ tx_id, category });
  };
  const renameVendor = (vendor_key, name) => post({ vendor_key, name });
  const renameTx = (tx_id, desc) => post({ tx_id, desc });

  const toggleVendor = (vk) => setExpandedVendors(e => ({ ...e, [vk]: !e[vk] }));

  const nextYear = Number(snap.year) + 1;
  const years = [String(snap.year - 2), String(snap.year - 1), String(snap.year), String(nextYear)];

  // Apply optimistic tx-level approvals on top of server data so the UI reflects
  // pending changes instantly. Each optimistic entry stamps `userSet=true` and
  // overrides the tx's category, which in turn fixes the queue, KPIs, and
  // vendor sections all at once.
  const mergedVendors = (data.vendors || []).map(v => ({
    ...v,
    txs: (v.txs || []).map(tx => {
      const ov = optimisticTx[tx.id];
      if (!ov) return tx;
      return { ...tx, cat: ov, userSet: true };
    }),
  }));

  // Pending = vendors that haven't been categorized yet (default = excluded but not vendorSaved).
  const pendingTxs = [];
  for (const v of mergedVendors) {
    for (const tx of (v.txs || [])) {
      if (!tx.userSet) pendingTxs.push({ ...tx, vendorKey: v.key, vendorName: v.name });
    }
  }
  pendingTxs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  // Recompute KPIs from merged tx so optimistic changes flow into the top numbers.
  const byCat = { megan: 0, ben: 0, excluded: 0 };
  for (const v of mergedVendors) for (const tx of (v.txs || [])) {
    byCat[tx.cat] = (byCat[tx.cat] || 0) + tx.amount;
  }
  const meganTotal = byCat.megan || 0;
  const benTotal = byCat.ben || 0;
  const excludedTotal = byCat.excluded || 0;
  const incomeTotal = meganTotal + benTotal;

  // Group vendors by their resolved category (uses tx-level cats since user can split a vendor).
  const vendorsByCat = { megan: [], ben: [], excluded: [] };
  for (const v of mergedVendors) {
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

      {!firstLoaded && <div style={{ padding: 24, color: "#888" }}>Loading…</div>}

      {firstLoaded && (
        <>
          <div className="kpi-row" style={{ marginTop: 16 }}>
            <div className="kpi"><div className="kpi-label">Total Income</div><div className="kpi-value">{fmt(incomeTotal)}</div><div className="kpi-sub">Megan + Ben</div></div>
            <div className="kpi"><div className="kpi-label">Megan</div><div className="kpi-value">{fmt(meganTotal)}</div></div>
            <div className="kpi"><div className="kpi-label">Ben</div><div className="kpi-value">{fmt(benTotal)}</div></div>
            <div className="kpi"><div className="kpi-label">Excluded</div><div className="kpi-value" style={{ color: "#888" }}>{fmt(excludedTotal)}</div><div className="kpi-sub">transfers / refunds</div></div>
          </div>

          <IncomeForecastCard
            year={year}
            meganActual={meganTotal}
            benActual={benTotal}
            forecast={forecast}
            onSave={saveForecast}
          />

          {pendingTxs.length > 0 && (
            <IncomeApprovalCard pendingTxs={pendingTxs}
              onApprove={(txId, cat) => {
                // Optimistic: stamp locally + fire request, no UI flash.
                approveTxOptimistic(txId, cat);
              }}
              onApproveBatch={(rows) => {
                // One request for the whole page.
                approveBatchOptimistic(rows);
              }}
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

function IncomeForecastCard({ year, meganActual, benActual, forecast, onSave }) {
  const meganF = Number(forecast.megan || 0);
  const benF = Number(forecast.ben || 0);
  const totalF = meganF + benF;
  const totalA = meganActual + benActual;

  const Row = ({ label, actual, forecastVal, person }) => {
    const [editing, setEditing] = useState(false);
    const [val, setVal] = useState(String(forecastVal || ""));
    useEffect(() => { setVal(String(forecastVal || "")); }, [forecastVal]);
    const pct = forecastVal > 0 ? Math.min(100, (actual / forecastVal) * 100) : 0;
    const remaining = forecastVal - actual;
    const commit = () => {
      const n = Number(String(val).replace(/[^0-9.]/g, "")) || 0;
      onSave(person, n);
      setEditing(false);
    };
    return (
      <div style={{ padding: "12px 0", borderBottom: "1px solid #eee" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600 }}>{label}</div>
          <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
            <div><span style={{ color: "#888", fontSize: 12 }}>Actual: </span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(actual)}</span></div>
            <div>
              <span style={{ color: "#888", fontSize: 12 }}>Forecast: </span>
              {editing ? (
                <>
                  <input
                    type="text"
                    value={val}
                    autoFocus
                    onChange={e => setVal(e.target.value)}
                    onBlur={commit}
                    onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
                    style={{ width: 110, padding: "4px 6px", fontSize: 14, border: "1px solid #c7d2fe", borderRadius: 4, fontVariantNumeric: "tabular-nums" }}
                  />
                </>
              ) : (
                <span
                  onClick={() => setEditing(true)}
                  style={{ fontVariantNumeric: "tabular-nums", cursor: "pointer", borderBottom: "1px dashed #999", paddingBottom: 1 }}
                  title="Click to edit"
                >{forecastVal > 0 ? fmt(forecastVal) : "Set…"}</span>
              )}
            </div>
            {forecastVal > 0 && (
              <div style={{ color: remaining >= 0 ? "#15803d" : "#b91c1c", fontVariantNumeric: "tabular-nums" }}>
                {remaining >= 0 ? `${fmt(remaining)} to go` : `${fmt(Math.abs(remaining))} over`}
              </div>
            )}
          </div>
        </div>
        {forecastVal > 0 && (
          <div style={{ marginTop: 8, height: 6, background: "#eef2ff", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: actual > forecastVal ? "#b91c1c" : "#15803d", transition: "width .3s" }}/>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Income Forecast — {year}</h3>
        {totalF > 0 && (
          <div style={{ fontSize: 13, color: "#666" }}>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(totalA)}</span>
            <span> of </span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(totalF)}</span>
            <span> ({totalF > 0 ? Math.round((totalA / totalF) * 100) : 0}%)</span>
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>Set what you expect each person to earn this year. Compare to actual income tagged to them.</div>
      <Row label="Megan" actual={meganActual} forecastVal={meganF} person="megan"/>
      <Row label="Ben" actual={benActual} forecastVal={benF} person="ben"/>
    </div>
  );
}

function IncomeApprovalCard({ pendingTxs, onApprove, onApproveBatch, onRenameVendor, onRenameTx }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("mb_income_approval_collapsed") === "1");
  const [page, setPage] = useState(0);
  const [rowCats, setRowCats] = useState({});
  useEffect(() => { localStorage.setItem("mb_income_approval_collapsed", collapsed ? "1" : "0"); }, [collapsed]);

  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(pendingTxs.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageTxs = pendingTxs.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Pre-fill from suggestion (vendor cat) when a tx first appears on the page.
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

  const pageReady = pageTxs.filter(tx => rowCats[tx.id]);
  const setCat = (id, cat) => setRowCats(rc => ({ ...rc, [id]: cat }));

  const approveAllShown = () => {
    // Optimistic batch: fire one batch request, UI updates instantly.
    const rows = pageReady.map(tx => ({ tx_id: tx.id, category: rowCats[tx.id] }));
    onApproveBatch(rows);
    setRowCats({});
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
            className="approval-bulk-btn"
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

// Sensible default "where do I get this number" guidance, matched by name keywords.
// Used when an investment row has no explicit `instructions` saved yet.
function defaultInstructions(name) {
  const n = (name || "").toLowerCase();
  if (/rockefeller|rockafeller/.test(n)) return "Log into rockefellerdigital.com → Total Net Worth. Or drag the statement PDF onto the row and it auto-reads.";
  if (/401|netbenefits|fidelity/.test(n)) return "Log into Fidelity NetBenefits (Lilly 401k) → current total balance.";
  if (/\blly\b|lilly|eli lilly/.test(n)) return "Shares × current LLY share price. Google 'LLY stock' for the live price, multiply by your share count.";
  if (/compass|\bcomp\b/.test(n)) return "Shares × current COMP (Compass) share price. Google 'Compass stock'.";
  if (/529/.test(n)) return "Log into BrightDirections (or your 529 provider) → total balance across the kids' accounts.";
  if (/treasury|t-bill|tbill|bond/.test(n)) return "Log into TreasuryDirect → current value (includes accrued interest).";
  if (/genesis|minivan|\bcar\b|vehicle|truck|suv/.test(n)) return "KBB.com or Edmunds → 'trade-in' value for your make/model/mileage.";
  if (/equity|blvd|\bn\.|\bw\.|\bst\b|ave|street|property|home|house|duplex|rental/.test(n)) return "Current market value (Zillow 'Zestimate' is fine) minus your remaining mortgage balance = equity.";
  return "Update from your latest statement or account portal.";
}

// Days since an ISO timestamp. Returns null if no date.
function daysSince(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

// A row is "stale" if it hasn't been updated in 45+ days.
const STALE_DAYS = 45;

function InvestmentsView() {
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [walkthrough, setWalkthrough] = useState(null); // null | "stale" | "all"

  const load = async () => {
    try {
      const r = await fetch("/api/investments");
      const j = await r.json();
      setList(j.investments || []);
      setTotal(j.total || 0);
    } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const staleCount = list.filter(r => {
    const d = daysSince(r.updated_at);
    return d == null || d >= STALE_DAYS;
  }).length;

  return (
    <div>
      <div className="inv-header">
        <div>
          <div className="page-title">Investments</div>
          <div className="page-subtitle">Drag a Rockefeller statement PDF onto its row to refresh. Type a value for everything else.</div>
        </div>
        {!loading && list.length > 0 && (
          <button className="inv-review-btn" onClick={() => setWalkthrough(staleCount > 0 ? "stale" : "all")}>
            Review &amp; Update
            {staleCount > 0 && <span className="inv-review-badge">{staleCount}</span>}
          </button>
        )}
      </div>

      <div className="inv-total-card">
        <div className="inv-total-label">Total invested</div>
        <div className="inv-total-value">{fmt(total)}</div>
        {!loading && staleCount > 0 && (
          <div className="inv-total-stale">{staleCount} item{staleCount === 1 ? "" : "s"} need{staleCount === 1 ? "s" : ""} a refresh (45+ days old)</div>
        )}
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

      {walkthrough && (
        <UpdateWalkthrough
          items={walkthrough === "stale"
            ? list.filter(r => { const d = daysSince(r.updated_at); return d == null || d >= STALE_DAYS; })
            : list}
          allCount={list.length}
          mode={walkthrough}
          onSwitchToAll={() => setWalkthrough("all")}
          onClose={() => { setWalkthrough(null); load(); }}
        />
      )}
    </div>
  );
}

// Step-through modal that walks the user item-by-item to refresh values.
function UpdateWalkthrough({ items, allCount, mode, onSwitchToAll, onClose }) {
  const [idx, setIdx] = useState(0);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(0);

  const item = items[idx];
  useEffect(() => { if (item) setVal(String(item.value || 0)); }, [idx, item]);

  if (!item) {
    // Empty (nothing stale) or finished.
    return (
      <div className="inv-modal-overlay" onClick={onClose}>
        <div className="inv-modal" onClick={e => e.stopPropagation()}>
          <div className="inv-modal-title">All caught up</div>
          <div className="inv-modal-body">
            {changed > 0
              ? `Updated ${changed} item${changed === 1 ? "" : "s"}. Net worth refreshed.`
              : (mode === "stale"
                  ? "Nothing's gone stale. Everything's been updated in the last 45 days."
                  : "No changes made.")}
          </div>
          <div className="inv-modal-actions">
            {mode === "stale" && allCount > items.length && (
              <button className="inv-btn-secondary" onClick={() => { setIdx(0); setChanged(0); onSwitchToAll(); }}>Review all {allCount} anyway</button>
            )}
            <button className="inv-btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  const instr = item.instructions || defaultInstructions(item.name);
  const d = daysSince(item.updated_at);
  const ageLabel = d == null ? "never updated" : d === 0 ? "updated today" : `updated ${d} day${d === 1 ? "" : "s"} ago`;

  const saveAndNext = async (skip) => {
    if (!skip) {
      const newVal = Number(String(val).replace(/[^0-9.\-]/g, "")) || 0;
      if (newVal !== item.value) {
        setBusy(true);
        try {
          await fetch("/api/investments", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: item.id, value: newVal, source: "manual" }),
          });
          setChanged(c => c + 1);
        } finally { setBusy(false); }
      }
    }
    setIdx(i => i + 1);
  };

  return (
    <div className="inv-modal-overlay" onClick={onClose}>
      <div className="inv-modal" onClick={e => e.stopPropagation()}>
        <div className="inv-modal-progress">{idx + 1} of {items.length}{mode === "stale" ? " stale" : ""}</div>
        <div className="inv-modal-title">{item.name}</div>
        <div className={"inv-modal-age" + ((d == null || d >= STALE_DAYS) ? " stale" : "")}>{ageLabel}</div>

        <div className="inv-modal-instr">
          <div className="inv-modal-instr-label">Where to get the number</div>
          <div>{instr}</div>
        </div>

        <div className="inv-modal-field">
          <label>Current value</label>
          <input
            value={val}
            autoFocus
            onChange={e => setVal(e.target.value.replace(/[^0-9.\-]/g, ""))}
            onKeyDown={e => { if (e.key === "Enter") saveAndNext(false); }}
            placeholder="0"
          />
          <div className="inv-modal-was">was {fmt(item.value)}</div>
        </div>

        <div className="inv-modal-actions">
          <button className="inv-btn-ghost" onClick={onClose}>Close</button>
          <button className="inv-btn-secondary" onClick={() => saveAndNext(true)} disabled={busy}>No change →</button>
          <button className="inv-btn-primary" onClick={() => saveAndNext(false)} disabled={busy}>{busy ? "Saving…" : "Save & next →"}</button>
        </div>
      </div>
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
        {(() => {
          const d = daysSince(row.updated_at);
          if (d == null) return <span className="inv-stale-badge">never updated</span>;
          if (d >= STALE_DAYS) return <span className="inv-stale-badge">{d}d old — refresh</span>;
          return <span>Updated {new Date(row.updated_at).toLocaleDateString()}</span>;
        })()}
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
