// Connor — family CFO. Tool-calling loop with Claude Sonnet 4.5.
// Hard rule: Connor never emits a number he didn't just retrieve via a tool call.
const fs = require("fs");
const path = require("path");
const tools = require("./tools");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY;
const MODEL = "claude-sonnet-4-5";
const MAX_ITERATIONS = 8;
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, "secrets");
const MEMORY_PATH = path.join(DATA_ROOT, "connor-memory.json");
const CONNOR_MD_PATH = path.join(DATA_ROOT, "CONNOR.md");
const HISTORY_PATH = path.join(DATA_ROOT, "connor-history.json");

const CONNOR_MD_SEED = `# CONNOR.md

Connor's persistent memory for the Lalez family. Sectioned. Append-only on
explicit "remember this" instructions. Newest at the top within each section.

## Facts
(empty — Connor appends here when learning durable facts)

## Preferences
- Plain text answers. No markdown. <br/> between lines only.
- Numbers first. Two or three lines max unless asked for detail.
- Never approximate. Fetch it or say so.

## Decisions
(empty)

## Corrections
(empty)
`;

function ensureConnorMd() {
  try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch (e) {}
  if (!fs.existsSync(CONNOR_MD_PATH)) {
    try { fs.writeFileSync(CONNOR_MD_PATH, CONNOR_MD_SEED); } catch (e) {}
  }
}
function readConnorMd() {
  ensureConnorMd();
  try { return fs.readFileSync(CONNOR_MD_PATH, "utf8"); } catch { return CONNOR_MD_SEED; }
}
function writeConnorMd(content) {
  ensureConnorMd();
  fs.writeFileSync(CONNOR_MD_PATH, content);
}
function appendToConnorMd(section, entry) {
  const md = readConnorMd();
  const today = new Date().toISOString().slice(0, 10);
  const line = `- (${today}) ${entry}`;
  const re = new RegExp(`(## ${section}\\s*\\n)`, "i");
  if (!re.test(md)) {
    const next = md.trimEnd() + `\n\n## ${section}\n${line}\n`;
    writeConnorMd(next);
    return next;
  }
  const sectionStart = md.search(re);
  const afterHeader = sectionStart + md.match(re)[0].length;
  const rest = md.slice(afterHeader);
  const nextHeader = rest.search(/\n## /);
  const sectionBody = nextHeader >= 0 ? rest.slice(0, nextHeader) : rest;
  const tail = nextHeader >= 0 ? rest.slice(nextHeader) : "";
  const cleanedBody = sectionBody.replace(/^\(empty[^\n]*\)\s*\n?/m, "");
  const newBody = line + "\n" + cleanedBody;
  const next = md.slice(0, afterHeader) + newBody + tail;
  writeConnorMd(next);
  return next;
}

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch { return []; }
}
function writeHistory(msgs) {
  try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch (e) {}
  const trimmed = msgs.slice(-40);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2));
}
function readMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8")); } catch { return { facts: [], preferences: [], history: [] }; }
}

function buildSystemPrompt(snapshot) {
  const today = new Date().toISOString().slice(0, 10);
  const k = snapshot.kpis || {};
  const mem = readMemory();
  const connorMd = readConnorMd();

  return `You are Connor, the Lalez family CFO. You report to Ben and Meg.

Today: ${today}

== HARD RULES ==
1. NEVER quote a number you didn't just fetch via a tool call this turn. No memory-quoting, no guessing, no "approximately". The 5 KPIs below are the ONLY exception.
2. For ANY ranking question ("biggest / top / most expensive / what did we spend on") → call get_top_expenses. NEVER rank from find_transactions or memory.
3. For "how much on <vendor>" → get_vendor_total. For "how much on <category>" → get_category_breakdown.
4. If a tool returns nothing, say so. Do not invent.

== WHAT COUNTS AS AN EXPENSE ==
EXCLUDED from expenses (and never appear in rankings):
- CC autopayments (transfers from a depository account paying off a credit card)
- Internal transfers between Ben & Meg's own depository accounts (e.g. checking → savings)
- Anything Ben or Meg flagged "Excluded" in the approval queue (investments, savings transfers, etc.)
get_top_expenses applies these exclusions; find_transactions does NOT — never rank from find_transactions.

== ANSWER STYLE ==
- Answer EXACTLY what was asked. If asked "#2", give #2 — not a top 6 list.
- Numbers first. Two or three lines max unless asked for detail.
- NO markdown. No **bold**, no asterisks, no bullets, no headers. Plain text with <br/> between lines only.
- Wrap key dollar amounts in <span class="num-chip">$X,XXX</span>.
- No preambles ("Let me look…", "Great question"). Just answer.
- Never narrate tool calls.

== KPIs (quotable without a tool call) ==
Cash on Hand: $${(k.cash_on_hand || 0).toLocaleString()}
Income YTD: $${(k.income_ytd || 0).toLocaleString()}  ·  Expenses YTD: $${(k.expenses_ytd || 0).toLocaleString()}
Net Saved YTD: $${(k.net_saved_ytd || 0).toLocaleString()}  ·  Savings Rate: ${k.savings_rate_pct || 0}%

== TOOLS ==
- get_top_expenses(month?, date_from?, date_to?, limit?, group_by?) — ranked vendors/txs with exclusions applied. USE FOR ANY RANKING.
- get_vendor_total(vendor) — YTD total for one vendor.
- get_category_breakdown(category, by_month?) — actual vs forecast for a family category.
- get_forecast_vs_actual() — all categories at once.
- find_transactions(query?, amount?, date_from?, date_to?, mask?) — raw search, NO exclusions, never rank from this.
- navigate(label, tab, scroll_to?) — produces a click-chip for the user.
- save_memory / read_memory.
- write_to_connor_md — only when the user explicitly says so.

== MEMORY ==
${mem.facts.length ? mem.facts.map(f => "- " + (f.content || f)).join("\n") : "(none saved)"}
${mem.preferences.length ? "\nPreferences:\n" + mem.preferences.map(p => "- " + (p.content || p)).join("\n") : ""}

== CONNOR.md (long-term memory — consult before answering) ==
${connorMd}

== WRITING TO CONNOR.md ==
Only when Ben or Meg explicitly says "write to connor.md" / "remember this" do you call write_to_connor_md. Never on your own initiative. Sections: Facts, Preferences, Decisions, Corrections. One factual line, no markdown.`;
}

async function anthropicCall(body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j;
}

async function chat(userMessages, snapshot) {
  const system = buildSystemPrompt(snapshot);
  const toolDefs = tools.getToolDefinitions();
  const toolCalls = [];

  let messages = userMessages.map(m => ({ role: m.role, content: m.content }));
  let actions = [];
  let finalText = "";

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const resp = await anthropicCall({
      model: MODEL,
      max_tokens: 2048,
      system,
      tools: toolDefs,
      messages,
    });

    const content = resp.content || [];
    const textBlocks = content.filter(b => b.type === "text");
    const toolUses = content.filter(b => b.type === "tool_use");

    messages.push({ role: "assistant", content });

    if (toolUses.length === 0) {
      finalText = textBlocks.map(b => b.text).join("\n").trim();
      break;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      let result;
      try { result = await tools.runTool(tu.name, tu.input || {}, snapshot); }
      catch (e) { result = { error: e.message }; }
      toolCalls.push({ name: tu.name, input: tu.input, result });
      if (result && result.__action) actions.push(result.__action);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result).slice(0, 100000),
      });
    }
    messages.push({ role: "user", content: toolResults });
    if (resp.stop_reason === "end_turn") break;
  }

  return { text: finalText || "(no response)", actions, toolCalls };
}

module.exports = { chat, readConnorMd, writeConnorMd, appendToConnorMd, readHistory, writeHistory };
