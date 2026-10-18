const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = (s) => esc(s).replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');

const COLORS = {
  Service: '#4fa3ff', Capability: '#3ddc97', Team: '#8892b0', Person: '#e6c07b', Deploy: '#ff8a3d', Alert: '#ff5c6c',
  Incident: '#c678dd', Runbook: '#56b6c2', Decision: '#ffc24b', Document: '#98a7c4', Fact: '#7ee0b5',
  Investigation: '#ff8a3d', Finding: '#b67cff',
};
const AGENT_COLORS = { triage: '#4fa3ff', historian: '#b67cff', commander: '#ff8a3d', chat: '#3ddc97' };
const LAYERS = {
  'Services': ['Service', 'Capability'],
  'People': ['Team', 'Person'],
  'Changes & alerts': ['Deploy', 'Alert'],
  'Incident memory': ['Incident', 'Runbook'],
  'Knowledge': ['Document', 'Fact', 'Decision:adr'],
  'Agent state': ['Investigation', 'Finding', 'Decision:agent'],
};
const state = {
  tenant: 'acme', layers: new Set(['Services', 'People', 'Changes & alerts', 'Incident memory', 'Agent state']),
  graph: { nodes: [], edges: [] }, byName: new Map(), network: null, nodesDS: null, edgesDS: null,
  investigationId: null, running: false, cypherCount: 0,
};

async function api(path, opts = {}) {
  const res = await fetch(`${path}${path.includes('?') ? '&' : '?'}tenant=${state.tenant}`, {
    headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify({ ...opts.body, tenant: state.tenant }) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

async function streamPost(path, body, onEvent) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, tenant: state.tenant }) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) if (l.trim()) onEvent(JSON.parse(l));
  }
}

// ---------------- Graph ----------------
function layerOf(n) {
  const key = n.label === 'Decision' ? `Decision:${n.agent ? 'agent' : 'adr'}` : n.label;
  return Object.entries(LAYERS).find(([, labels]) => labels.includes(key))?.[0];
}

function nodeLabel(n) {
  if (n.label === 'Finding') return `${n.agent}\nfinding`;
  if (n.label === 'Investigation') return n.name;
  if (['Incident', 'Decision', 'Runbook', 'Deploy', 'Alert', 'Document'].includes(n.label)) return n.name;
  return n.name;
}

function visNode(n) {
  const isSvc = n.label === 'Service';
  const down = n.status === 'down', degraded = n.status === 'degraded';
  const color = COLORS[n.label] || '#888';
  return {
    id: n.id, label: nodeLabel(n), group: n.label,
    title: `${n.label}: ${n.title || n.name}${n.status ? ` (${n.status})` : ''}`,
    shape: isSvc ? 'dot' : n.label === 'Person' ? 'diamond' : n.label === 'Capability' ? 'star' : 'square',
    size: isSvc ? 22 - (n.tier || 2) * 3 : n.label === 'Finding' ? 8 : 10,
    color: { background: color, border: down ? '#ff5c6c' : degraded ? '#ffb547' : color, highlight: { background: '#fff', border: color } },
    borderWidth: down || degraded ? 4 : 1,
    font: { color: '#c8d0e0', size: isSvc ? 13 : 11, face: 'Inter' },
  };
}

function visibleNodes() {
  const g = state.graph;
  // Show only the current investigation's agent state, not all past runs.
  const invNode = g.nodes.find((n) => n.label === 'Investigation' && n.name === state.investigationId);
  const allowed = new Set();
  if (invNode) {
    allowed.add(invNode.id);
    for (const e of g.edges) if (e.from === invNode.id && ['HAS_FINDING', 'CONCLUDED'].includes(e.type)) allowed.add(e.to);
  }
  return g.nodes.filter((n) => {
    const layer = layerOf(n);
    if (!layer || !state.layers.has(layer)) return false;
    if (layer === 'Agent state') return allowed.has(n.id);
    return true;
  });
}

function renderGraph() {
  const nodes = visibleNodes();
  const ids = new Set(nodes.map((n) => n.id));
  const edges = state.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e, i) => ({
    id: `${e.from}-${e.to}-${e.type}-${i}`, from: e.from, to: e.to, title: e.type,
    arrows: { to: { enabled: true, scaleFactor: 0.4 } },
    color: { color: e.type === 'DEPENDS_ON' ? '#33405c' : e.type === 'EVIDENCE' ? '#6b4fa0' : '#252d40', highlight: '#ff8a3d' },
    width: e.type === 'DEPENDS_ON' ? 1.4 : 0.8, dashes: ['EVIDENCE', 'BASED_ON', 'HAS_FINDING'].includes(e.type),
  }));
  if (!state.network) {
    state.nodesDS = new vis.DataSet(nodes.map(visNode));
    state.edgesDS = new vis.DataSet(edges);
    state.network = new vis.Network($('#graph'), { nodes: state.nodesDS, edges: state.edgesDS }, {
      physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -60, springLength: 90 }, stabilization: { iterations: 150 } },
      interaction: { hover: true, tooltipDelay: 120 },
    });
  } else {
    const keep = new Set(nodes.map((n) => n.id));
    state.nodesDS.remove(state.nodesDS.getIds().filter((id) => !keep.has(id)));
    state.nodesDS.update(nodes.map(visNode));
    state.edgesDS.clear();
    state.edgesDS.add(edges);
  }
  $('#stats').textContent = `${state.graph.nodes.length} nodes · ${state.graph.edges.length} edges · ${state.cypherCount} cypher queries this session`;
}

async function loadGraph() {
  state.graph = await api('/api/graph');
  state.byName = new Map(state.graph.nodes.map((n) => [n.name, n]));
  renderGraph();
}

const pulseTimers = new Map();
function pulse(names, agent) {
  const color = AGENT_COLORS[agent] || '#fff';
  const ids = [];
  for (const name of names) {
    const n = state.byName.get(name);
    if (!n || !state.nodesDS.get(n.id)) continue;
    ids.push(n.id);
    state.nodesDS.update({ id: n.id, borderWidth: 6, color: { ...visNode(n).color, border: color }, shadow: { enabled: true, color, size: 22, x: 0, y: 0 } });
    clearTimeout(pulseTimers.get(n.id));
    pulseTimers.set(n.id, setTimeout(() => state.nodesDS.update({ ...visNode(n), shadow: { enabled: false } }), 4000));
  }
  return ids;
}

function namesIn(obj) {
  const s = JSON.stringify(obj);
  return [...state.byName.keys()].filter((name) => name && name.length > 3 && (s.includes(`"${name}"`) || s.includes(`${name} `)));
}

function focus(name) {
  const n = state.byName.get(name);
  if (!n || !state.network) return;
  if (!state.nodesDS.get(n.id)) {
    state.layers.add(layerOf(n)); renderLayers(); renderGraph();
  }
  state.network.focus(n.id, { scale: 1.2, animation: true });
  state.network.selectNodes([n.id]);
}

function renderLayers() {
  $('#layers').innerHTML = Object.keys(LAYERS).map((l) =>
    `<label><input type="checkbox" data-layer="${l}" ${state.layers.has(l) ? 'checked' : ''}> ${l}</label>`).join('');
  $('#legend').innerHTML = Object.entries(COLORS).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('');
}
$('#layers').addEventListener('change', (e) => {
  const l = e.target.dataset.layer;
  e.target.checked ? state.layers.add(l) : state.layers.delete(l);
  renderGraph();
});

// ---------------- Timeline ----------------
const tl = () => $('#timeline');
function add(html, cls = '') {
  const el = document.createElement('div');
  el.className = `ev ${cls}`;
  el.innerHTML = html;
  tl().appendChild(el);
  tl().scrollTop = tl().scrollHeight;
  return el;
}
const chip = (a) => `<span class="chip ${a}">${esc(a)}</span>`;

function logCypher(e) {
  const box = $('#tab-cypher');
  if (box.querySelector('.empty')) box.innerHTML = '';
  for (const q of e.cypher) {
    state.cypherCount++;
    box.insertAdjacentHTML('afterbegin', `<div class="cy"><div class="meta">${chip(e.agent)} <span>${esc(e.tool)} · ${q.rows} rows · ${q.ms}ms</span></div><pre>${esc(q.query)}${Object.keys(q.params || {}).length ? `\n\n// params ${esc(JSON.stringify(q.params))}` : ''}</pre></div>`);
  }
}

const pendingTools = new Map();
function onEvent(e) {
  switch (e.type) {
    case 'investigation':
      state.investigationId = e.id;
      add(`<div class="head"><b>${esc(e.id)}</b><span class="ms">${e.mode === 'llm' ? 'Gemini agents' : 'scripted agents'}</span></div><div>${esc(e.question)}</div>`, 'say');
      break;
    case 'handoff':
      add(`${[].concat(e.from).map(chip).join(' ')} → ${[].concat(e.to).map(chip).join(' ')} · ${esc(e.note)}`, 'handoff');
      break;
    case 'agent_start':
      add(`<div class="head">${chip(e.agent)}<span class="ms">started</span></div>`, e.agent);
      break;
    case 'thought':
      add(`<div class="head">${chip(e.agent)}</div><div>${md(e.text)}</div>`, `${e.agent} say`);
      break;
    case 'tool_call': {
      const el = add(`<div class="head"><span class="tool">⚙ ${esc(e.tool)}(${esc(Object.values(e.args || {}).map((v) => Array.isArray(v) ? `[${v.length}]` : String(v).slice(0, 40)).join(', '))})</span><span class="ms">…</span></div>`, e.agent);
      pendingTools.set(`${e.agent}:${e.tool}`, el);
      pulse(namesIn(e.args), e.agent);
      break;
    }
    case 'tool_result': {
      const el = pendingTools.get(`${e.agent}:${e.tool}`);
      if (el) {
        el.querySelector('.ms').textContent = `${e.cypher.length} cypher · ${e.ms}ms`;
        el.insertAdjacentHTML('beforeend', `<details><summary>result & cypher</summary><pre>${esc(JSON.stringify(e.result, null, 1)).slice(0, 3000)}</pre>${e.cypher.map((q) => `<pre>${esc(q.query)}</pre>`).join('')}</details>`);
      }
      logCypher(e);
      if (e.tool !== 'record_finding') pulse(namesIn(e.result).slice(0, 25), e.agent);
      break;
    }
    case 'finding':
      add(`<div class="head">${chip(e.agent)}<span class="kind">${esc(e.kind.replace('_', ' '))}</span></div><div>${md(e.summary)}</div>
        <div>${(e.evidence || []).map((x) => `<span class="pill" data-focus="${esc(x)}">${esc(x)}</span>`).join('')}</div>
        <div class="conf"><i style="width:${Math.round((e.confidence ?? 0.7) * 100)}%"></i></div>`, `${e.agent} finding`);
      break;
    case 'memory':
      add(`<div class="head">${chip(e.agent)}<span class="kind">learned</span></div><div>🧠 Remembered about <b>${esc(e.service)}</b>: ${esc(e.fact)}</div>`, `${e.agent} finding`);
      break;
    case 'decision':
      renderDecision(e);
      break;
    case 'notice':
      add(`⚠ ${chip(e.agent || 'orchestrator')} ${esc(e.text)}`, 'notice');
      break;
    case 'agent_done':
      if (e.text) add(`<div class="head">${chip(e.agent)}<span class="ms">done</span></div><div>${md(e.text)}</div>`, `${e.agent} say`);
      break;
    case 'done':
      if (e.stats) add(`✓ ${e.stats.tools} tool calls · ${e.stats.queries} Cypher queries · ${(e.stats.ms / 1000).toFixed(1)}s`, 'handoff');
      break;
    case 'error':
      add(`✖ ${esc(e.text)}`, 'notice');
      break;
  }
}

function renderDecision(d) {
  const el = document.createElement('div');
  el.className = 'decision';
  el.innerHTML = `<h3><span class="sev">${esc(d.severity)}</span>${esc(d.title)}</h3>
    <dl>
      <dt>Root cause</dt><dd><span class="pill" data-focus="${esc(d.root_cause)}">${esc(d.root_cause)}</span></dd>
      ${d.suspect_deploy ? `<dt>Suspect</dt><dd><span class="pill" data-focus="${esc(d.suspect_deploy)}">${esc(d.suspect_deploy)}</span></dd>` : ''}
      ${d.runbook ? `<dt>Runbook</dt><dd><span class="pill" data-focus="${esc(d.runbook)}">${esc(d.runbook)}</span></dd>` : ''}
      <dt>Page</dt><dd>${(d.page || []).map((p) => `<span class="pill" data-focus="${esc(p)}">${esc(p)}</span>`).join('')}</dd>
      <dt>Action</dt><dd>${md(d.action)}</dd>
    </dl>
    <div class="actions"><button class="primary" data-resolve>Mark resolved & remember</button><button data-why>Why?</button></div>`;
  tl().appendChild(el);
  tl().scrollTop = tl().scrollHeight;
}

document.addEventListener('click', async (e) => {
  const f = e.target.closest('[data-focus]');
  if (f) focus(f.dataset.focus);
  if (e.target.matches('[data-why]')) { switchTab('trace'); await showTrace(state.investigationId); }
  if (e.target.matches('[data-resolve]')) {
    e.target.disabled = true;
    const resolution = prompt('How was it resolved?', 'Rolled back the suspect deploy and followed the runbook. Error rates recovered.');
    if (resolution === null) { e.target.disabled = false; return; }
    const r = await api(`/api/investigations/${state.investigationId}/resolve`, { method: 'POST', body: { resolution } });
    e.target.textContent = `Learned as ${r.incident} ✓`;
    add(`🧠 Stored <b>${esc(r.incident)}</b> in episodic memory (resolved by ${esc(r.resolved_by)}). The runbook's success count went up. The next investigation will recall it.`, 'finding historian');
    await loadGraph(); await loadMemory();
  }
  const m = e.target.closest('[data-inv]');
  if (m) openInvestigation(m.dataset.inv);
});

// ---------------- Right panel ----------------
function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
}
document.querySelector('.tabs').addEventListener('click', (e) => e.target.dataset.tab && switchTab(e.target.dataset.tab));

async function showTrace(id) {
  if (!id) return;
  const inv = await api(`/api/investigations/${id}`);
  const box = $('#tab-trace');
  if (!inv.decision) { box.innerHTML = '<div class="empty">No decision yet.</div>'; return; }
  const d = inv.decision;
  const pills = (xs) => xs.filter(Boolean).map((x) => `<span class="pill" data-focus="${esc(x)}">${esc(x)}</span>`).join('');
  box.innerHTML = `
    <h4>Decision</h4>
    <div class="tr-node"><div class="lbl">${esc(d.id)} · ${esc(d.severity)}</div><b>${esc(d.title)}</b>
      <div>${pills([d.root_cause, d.suspect_deploy, d.runbook, ...d.paged])}</div></div>
    <div class="tr-children">
      <h4>based on ${inv.findings.length} findings</h4>
      ${inv.findings.map((f) => `<div class="tr-node"><div class="lbl">${chip(f.agent)} ${esc(f.kind)} · conf ${Math.round((f.confidence ?? 0) * 100)}%</div>
        ${md(f.summary)}<div class="tr-children">${pills(f.evidence)}</div></div>`).join('')}
    </div>
    <h4>Cypher behind this trace</h4>
    <pre style="white-space:pre-wrap;font:11px var(--mono)">MATCH (:Investigation {id:'${esc(id)}'})-[:CONCLUDED]->(d:Decision)
      -[:BASED_ON]->(f:Finding)-[:EVIDENCE]->(e)
RETURN d, f, e</pre>`;
  // Highlight the whole evidence subgraph.
  state.layers.add('Agent state'); renderLayers(); renderGraph();
  const names = [d.id, d.root_cause, d.suspect_deploy, d.runbook, ...d.paged, ...inv.findings.flatMap((f) => [f.id, ...f.evidence])];
  const ids = names.map((n) => state.byName.get(n)?.id).filter((x) => x !== undefined && state.nodesDS?.get(x));
  state.network?.selectNodes(ids);
  state.network?.fit({ nodes: ids, animation: true });
}

async function loadMemory() {
  const invs = await api('/api/investigations');
  $('#tab-memory').innerHTML = `<h4>Investigations across sessions (${invs.length})</h4>` + (invs.length ? invs.map((i) => `
    <div class="mem" data-inv="${esc(i.id)}"><div class="q">${esc(i.question)}</div>
    <div class="m"><span class="status ${esc(i.status)}">${esc(i.status)}</span> ${esc(i.id)} · ${esc(i.user)} · ${new Date(i.at).toLocaleString()}
    ${i.decision ? `<br>→ ${esc(i.decision)}` : ''}${i.incident ? ` · learned as <b>${esc(i.incident)}</b>` : ''}</div></div>`).join('')
    : '<div class="empty">No investigations yet. Memory is stored in the graph, so it survives restarts.</div>');
}

async function openInvestigation(id) {
  const inv = await api(`/api/investigations/${id}`);
  state.investigationId = id;
  tl().innerHTML = '';
  add(`<div class="head"><b>${esc(id)}</b><span class="ms">from memory · ${esc(inv.status)}</span></div><div>${esc(inv.question)}</div>`, 'say');
  for (const f of inv.findings) onEvent({ type: 'finding', ...f });
  for (const t of inv.turns.slice(1)) add(`<div class="head">${chip(t.agent || t.role)}</div><div>${md(t.text)}</div>`, `${t.agent || ''} say`);
  if (inv.decision) renderDecision({ ...inv.decision, page: inv.decision.paged });
  if (inv.status === 'resolved') tl().querySelector('[data-resolve]:last-of-type')?.replaceWith(Object.assign(document.createElement('span'), { className: 'status resolved', textContent: 'resolved · in memory' }));
  $('#chatform').classList.remove('hidden');
  await showTrace(id); switchTab('trace');
}

// ---------------- Actions ----------------
async function run(path, body) {
  if (state.running) return;
  state.running = true; $('#go').disabled = true;
  try {
    await streamPost(path, body, onEvent);
  } finally {
    state.running = false; $('#go').disabled = false;
    await loadGraph(); await loadMemory();
  }
}

$('#go').addEventListener('click', async () => {
  tl().innerHTML = '';
  $('#tab-cypher').innerHTML = '';
  await run('/api/investigate', { question: $('#question').value, user: $('#user').value });
  $('#chatform').classList.remove('hidden');
  await showTrace(state.investigationId);
});

$('#chatform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('#chatmsg').value.trim();
  if (!message) return;
  $('#chatmsg').value = '';
  add(`<div class="head"><span class="chip human">${esc($('#user').value)}</span></div><div>${esc(message)}</div>`, 'say');
  await run('/api/chat', { message, user: $('#user').value, investigationId: state.investigationId });
});

$('#seed').addEventListener('click', async () => {
  if (!confirm(`Wipe and re-seed tenant "${state.tenant}"? This erases its learned memory.`)) return;
  await api('/api/seed', { method: 'POST', body: {} });
  state.investigationId = null; await loadGraph(); await loadMemory();
});
$('#refire').addEventListener('click', async () => {
  await api('/api/reset-scenario', { method: 'POST', body: {} });
  await loadGraph();
  add('🔔 Alerts re-fired. Learned memory was kept.', 'notice');
});
$('#tenant').addEventListener('change', async (e) => {
  state.tenant = e.target.value; state.investigationId = null;
  state.network?.destroy(); state.network = null;
  await init(false);
});

async function init(first = true) {
  const s = await api('/api/status');
  if (first) $('#tenant').innerHTML = s.tenants.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('');
  $('#mode').textContent = s.llm ? `Gemini · ${s.models.split(',')[0]}` : 'scripted mode (no LLM key)';
  $('#mode').className = `badge ${s.llm ? 'llm' : 'scripted'}`;
  const current = s.tenants.find((t) => t.id === state.tenant);
  if (!current.seeded) await api('/api/seed', { method: 'POST', body: {} });
  if (state.tenant === 'globex') $('#question').value = 'Users report videos won\'t start playing.';
  else $('#question').value = 'Checkout is throwing 500s and customers can\'t pay. What\'s going on?';
  renderLayers();
  await loadGraph();
  await loadMemory();
}
// Deep links: ?tenant=acme&inv=INV-123 reopens an investigation from memory.
const params = new URLSearchParams(location.search);
if (params.get('tenant')) state.tenant = params.get('tenant');
init()
  .then(async () => {
    $('#tenant').value = state.tenant;
    if (params.get('inv')) await openInvestigation(params.get('inv'));
  })
  .catch((e) => add(`✖ ${esc(e.message)}. Is FalkorDB reachable? Check .env.`, 'notice'));
