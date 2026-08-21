// To-Dos vertical — household ops for Ben / Megan / Marcy. Lives OUTSIDE the finance PIN gate.
(() => {
const { useState, useEffect, useCallback, useRef } = React;

const TD_OWNERS = ["Ben", "Megan", "Marcy"];
const TD_PRI = { 3: "3 · High", 2: "2 · Med", 1: "1 · Low" };
function tdToday() { return new Date().toISOString().slice(0, 10); }
function tdFmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function tdShort(iso) { return iso ? iso.slice(5, 7) + "/" + iso.slice(8, 10) : ""; }
function tdIsHot(due) {
  if (!due) return false;
  const diff = (new Date(due) - new Date(tdToday())) / 86400000;
  return diff <= 7;
}

function TodosView({ list = "home", owners = TD_OWNERS, kicker = "Household Operations", heading = "To-Dos" }) {
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState(null);
  const [ownerFilter, setOwnerFilter] = useState("All");
  const [sortMode, setSortMode] = useState("pri");
  const [showAllDone, setShowAllDone] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetch("/api/todos?list=" + list).then(r => r.json());
      if (d.error) throw new Error(d.error);
      setDoc(d); setErr(null);
    } catch (e) { setErr(e.message); }
  }, [list]);
  useEffect(() => { load(); }, [load]);

  const post = useCallback(async (ops) => {
    try {
      const d = await fetch("/api/todos?list=" + list, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops }),
      }).then(r => r.json());
      if (d.error) throw new Error(d.error);
      setDoc(d);
    } catch (e) { setErr(e.message); }
  }, [list]);

  if (err) return <div className="todos"><div className="td-wrap"><div style={{ padding: 40 }}>Error: {err} <button className="td-btn" onClick={load}>Retry</button></div></div></div>;
  if (!doc) return <div className="todos"><div className="td-wrap"><div className="td-mono" style={{ padding: 40 }}>Loading…</div></div></div>;

  const tasks = doc.tasks || [];
  const projects = doc.projects || [];
  const matchOwner = (t) => ownerFilter === "All" || t.owner === ownerFilter;
  const openTasks = tasks.filter(t => t.type === "task" && !t.done && matchOwner(t));
  const followups = tasks.filter(t => t.type === "followup" && !t.done && matchOwner(t));
  const doneTasks = tasks.filter(t => t.done && matchOwner(t)).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const counts = {
    open: tasks.filter(t => !t.done).length,
    high: tasks.filter(t => !t.done && t.priority === 3).length,
    waiting: tasks.filter(t => t.type === "followup" && !t.done).length,
    doneWeek: tasks.filter(t => t.done && t.doneAt >= weekAgo).length,
  };
  const sorted = [...openTasks].sort((a, b) => {
    if (sortMode === "new") return b.id.localeCompare(a.id, undefined, { numeric: true });
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1; if (b.due) return 1;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
  const doneShown = showAllDone ? doneTasks : doneTasks.slice(0, 5);

  return (
    <div className="todos">
      <div className="td-wrap">
        <header className="td-head">
          <div>
            <div className="td-mono td-teal" style={{ marginBottom: 6 }}>{kicker}</div>
            <h1 className="td-h1">{heading}</h1>
          </div>
          <div className="td-mono td-muted">{owners.join(" · ")}</div>
        </header>
        <div className="td-bar">
          <div className="td-f"><div className="td-n"><em>{counts.open}</em></div><div className="td-mono td-muted">Open</div></div>
          <div className="td-f"><div className="td-n">{counts.high}</div><div className="td-mono td-muted">High priority</div></div>
          <div className="td-f"><div className="td-n">{counts.waiting}</div><div className="td-mono td-muted">Waiting on reply</div></div>
          <div className="td-f"><div className="td-n">{counts.doneWeek}</div><div className="td-mono td-muted">Done this week</div></div>
        </div>
        <div className="td-controls td-mono">
          {["All", ...owners].map(o => (
            <button key={o} className={"td-chip" + (ownerFilter === o ? " on" : "")} onClick={() => setOwnerFilter(o)}>{o}</button>
          ))}
          <span className="td-vr"></span>
          <button className={"td-chip" + (sortMode === "pri" ? " on" : "")} onClick={() => setSortMode("pri")}>High first</button>
          <button className={"td-chip" + (sortMode === "new" ? " on" : "")} onClick={() => setSortMode("new")}>Newest</button>
          <button className="td-add" onClick={() => setAdding(a => !a)}>{adding ? "Close" : "+ New task"}</button>
        </div>
        {adding && <NewTaskForm post={post} owners={owners} onDone={() => setAdding(false)} />}
        <section>
          <div className="td-sec-h"><span className="td-mono">Master To-Do</span><span className="td-mono td-muted">{sorted.length} open</span></div>
          <div className="td-legend td-mono td-muted"><span className="td-c-tick"></span><span className="td-c-task">Task / latest update</span><span className="td-c-pri">Priority</span><span className="td-c-own">Owner</span><span className="td-c-due">Due</span><span className="td-c-x"></span></div>
          {sorted.map(t => <TaskRow key={t.id} t={t} post={post} owners={owners} />)}
          {sorted.length === 0 && <div className="td-empty td-mono td-muted">Nothing open{ownerFilter !== "All" ? " for " + ownerFilter : ""}.</div>}
          {doneShown.map(t => <TaskRow key={t.id} t={t} post={post} owners={owners} />)}
          {doneTasks.length > 5 && (
            <div style={{ padding: "12px 0" }}><a className="td-mono td-link" onClick={() => setShowAllDone(s => !s)}>{showAllDone ? "Show fewer done" : `View all ${doneTasks.length} done →`}</a></div>
          )}
        </section>
        <section>
          <div className="td-sec-h"><span className="td-mono">Follow-ups</span><span className="td-mono td-muted">Waiting on someone else</span></div>
          {followups.map(t => <TaskRow key={t.id} t={t} post={post} owners={owners} followup />)}
          {followups.length === 0 && <div className="td-empty td-mono td-muted">No open follow-ups.</div>}
        </section>
        <ProjectsSection projects={projects} post={post} />
      </div>
    </div>
  );
}

function TaskRow({ t, post, owners = TD_OWNERS, followup }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const latest = (t.updates || [])[t.updates ? t.updates.length - 1 : 0];
  const saveNote = () => {
    const txt = note.trim();
    if (txt) post([{ op: "add_update", id: t.id, text: txt }]);
    setNote(""); setNoting(false);
  };
  return (
    <div className={"td-row" + (t.done ? " done" : "")}>
      <span className="td-tick" title={t.done ? "Reopen" : "Mark done"}
        onClick={() => post([{ op: "update_task", id: t.id, patch: { done: !t.done } }])}></span>
      <div className="td-c-task">
        <div className="td-task">{t.title}{followup && t.with ? <span className="td-with"> — with {t.with}</span> : null}</div>
        {latest && <div className="td-note"><span className="td-d">{tdShort(latest.date)}</span>{latest.text}</div>}
        {noting ? (
          <div className="td-note-form">
            <input autoFocus className="td-input" placeholder="Add an update…" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveNote(); if (e.key === "Escape") setNoting(false); }} />
            <button className="td-btn" onClick={saveNote}>Save</button>
          </div>
        ) : (
          !t.done && <a className="td-mono td-link td-note-add" onClick={() => setNoting(true)}>+ Update</a>
        )}
      </div>
      <span className="td-c-pri">
        <select className={"td-sel td-mono td-p" + t.priority} value={t.priority} disabled={t.done}
          onChange={e => post([{ op: "update_task", id: t.id, patch: { priority: Number(e.target.value) } }])}>
          {[3, 2, 1].map(p => <option key={p} value={p}>{TD_PRI[p]}</option>)}
        </select>
      </span>
      <span className="td-c-own">
        <select className="td-sel td-own" value={t.owner || ""} disabled={t.done}
          onChange={e => post([{ op: "update_task", id: t.id, patch: { owner: e.target.value } }])}>
          <option value="">—</option>
          {owners.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </span>
      <span className="td-c-due">
        {t.done ? <span className="td-mono td-muted">Done {tdShort(t.doneAt)}</span> : (
          <input type="date" className={"td-date" + (tdIsHot(t.due) ? " hot" : "")} value={t.due || ""}
            onChange={e => post([{ op: "update_task", id: t.id, patch: { due: e.target.value || null } }])} />
        )}
      </span>
      <span className="td-c-x">
        <button className="td-x" title="Delete" onClick={() => {
          if (confirm("Delete \"" + t.title + "\"? This can't be undone.")) post([{ op: "delete_task", id: t.id }]);
        }}>×</button>
      </span>
    </div>
  );
}

function NewTaskForm({ post, owners = TD_OWNERS, onDone }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("task");
  const [priority, setPriority] = useState(2);
  const [owner, setOwner] = useState(owners[0]);
  const [due, setDue] = useState("");
  const [withWho, setWithWho] = useState("");
  const save = () => {
    const tt = title.trim();
    if (!tt) return;
    post([{ op: "add_task", task: { title: tt, type, priority, owner, due: due || null, with: withWho.trim() } }]);
    onDone();
  };
  return (
    <div className="td-newform">
      <div className="td-mono td-teal" style={{ marginBottom: 10 }}>New {type === "followup" ? "follow-up" : "task"}</div>
      <div className="td-newgrid">
        <input autoFocus className="td-input" style={{ gridColumn: "1 / -1" }} placeholder={type === "followup" ? "Follow up about…" : "What needs doing?"}
          value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); }} />
        <select className="td-sel-box" value={type} onChange={e => setType(e.target.value)}>
          <option value="task">Task</option><option value="followup">Follow-up</option>
        </select>
        {type === "followup" && <input className="td-input" placeholder="With whom?" value={withWho} onChange={e => setWithWho(e.target.value)} />}
        <select className="td-sel-box" value={priority} onChange={e => setPriority(Number(e.target.value))}>
          {[3, 2, 1].map(p => <option key={p} value={p}>{TD_PRI[p]}</option>)}
        </select>
        <select className="td-sel-box" value={owner} onChange={e => setOwner(e.target.value)}>
          {owners.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <input type="date" className="td-sel-box" value={due} onChange={e => setDue(e.target.value)} />
        <button className="td-add" onClick={save}>Add</button>
      </div>
    </div>
  );
}

function ProjectsSection({ projects, post }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [steps, setSteps] = useState(4);
  const save = () => {
    const n = name.trim(); if (!n) return;
    post([{ op: "add_project", project: { name: n, stepsTotal: steps, status: "active" } }]);
    setName(""); setAdding(false);
  };
  return (
    <section>
      <div className="td-sec-h">
        <span className="td-mono">Projects</span>
        <a className="td-mono td-link" onClick={() => setAdding(a => !a)}>{adding ? "Close" : "+ New project"}</a>
      </div>
      {adding && (
        <div className="td-newform">
          <div className="td-newgrid">
            <input autoFocus className="td-input" style={{ gridColumn: "1 / -1" }} placeholder="Project name" value={name}
              onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); }} />
            <label className="td-mono td-muted" style={{ alignSelf: "center" }}>Steps
              <input type="number" min="1" max="20" className="td-sel-box" style={{ width: 64, marginLeft: 8 }} value={steps} onChange={e => setSteps(Number(e.target.value) || 1)} />
            </label>
            <button className="td-add" onClick={save}>Add</button>
          </div>
        </div>
      )}
      <div className="td-proj-grid">
        {projects.map(p => <ProjectCard key={p.id} p={p} post={post} />)}
        {projects.length === 0 && !adding && <div className="td-empty td-mono td-muted">No projects yet.</div>}
      </div>
    </section>
  );
}

function ProjectCard({ p, post }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const latest = (p.updates || [])[p.updates ? p.updates.length - 1 : 0];
  const statusLabel = p.status === "done" ? "Done" : p.status === "not_started" ? "Not started" : `Active · ${p.stepsDone} of ${p.stepsTotal} steps`;
  const saveNote = () => {
    const txt = note.trim();
    if (txt) post([{ op: "add_project_update", id: p.id, text: txt }]);
    setNote(""); setNoting(false);
  };
  return (
    <div className="td-proj">
      <div className="td-proj-top">
        <select className={"td-sel td-mono " + (p.status === "not_started" ? "td-muted" : "td-teal")} value={p.status}
          onChange={e => post([{ op: "update_project", id: p.id, patch: { status: e.target.value } }])}>
          <option value="active">Active</option><option value="not_started">Not started</option><option value="done">Done</option>
        </select>
        <button className="td-x" title="Delete project" onClick={() => {
          if (confirm("Delete project \"" + p.name + "\"?")) post([{ op: "delete_project", id: p.id }]);
        }}>×</button>
      </div>
      <div className="td-proj-name">{p.name}</div>
      {p.status === "active" && <div className="td-mono td-muted" style={{ margin: "2px 0 8px" }}>{p.stepsDone} of {p.stepsTotal} steps</div>}
      {latest && <div className="td-note"><span className="td-d">{tdShort(latest.date)}</span>{latest.text}</div>}
      {noting ? (
        <div className="td-note-form">
          <input autoFocus className="td-input" placeholder="Add an update…" value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") saveNote(); if (e.key === "Escape") setNoting(false); }} />
          <button className="td-btn" onClick={saveNote}>Save</button>
        </div>
      ) : (
        <a className="td-mono td-link td-note-add" onClick={() => setNoting(true)}>+ Update</a>
      )}
      <div className="td-meter" title="Click a segment to set progress">
        {Array.from({ length: p.stepsTotal }, (_, i) => (
          <span key={i} className={i < p.stepsDone ? "f" : ""}
            onClick={() => post([{ op: "update_project", id: p.id, patch: { stepsDone: i + 1 === p.stepsDone ? i : i + 1 } }])}></span>
        ))}
        <button className="td-step-btn" title="Fewer steps" onClick={() => post([{ op: "update_project", id: p.id, patch: { stepsTotal: Math.max(1, p.stepsTotal - 1) } }])}>−</button>
        <button className="td-step-btn" title="More steps" onClick={() => post([{ op: "update_project", id: p.id, patch: { stepsTotal: p.stepsTotal + 1 } }])}>+</button>
      </div>
    </div>
  );
}

Object.assign(window, { TodosView });
})();
