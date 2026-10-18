const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = (s) => esc(s).replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');

const COLORS = {
  Service: '#4fa3ff', Capability: '#3ddc97', Team: '#8892b0', Person: '#e6c07b', Deploy: '#ff8a3d', Alert: '#ff5c6c',
  Incident: '#c678dd', Runbook: '#56b6c2', Decision: '#ffc24b', Document: '#98a7c4', Fact: '#7ee0b5',
  Investigation: '#ff8a3d', Finding: '#b67cff',
  Project: '#f78fb3', Ticket: '#e5c07b', Message: '#7f8ea3', Action: '#3ddc97',
};
const AGENT_COLORS = { triage: '#4fa3ff', historian: '#b67cff', commander: '#ff8a3d', chat: '#3ddc97' };
const LAYERS = {
  'Services': ['Service', 'Capability'],
  'People': ['Team', 'Person'],
  'Changes & alerts': ['Deploy', 'Alert'],
  'Incident memory': ['Incident', 'Runbook'],
  'Knowledge': ['Document', 'Fact', 'Decision:adr'],
  'Projects & chat': ['Project', 'Ticket', 'Message'],
  'Agent state': ['Investigation', 'Finding', 'Decision:agent', 'Action'],
};
const state = {
  tenant: 'acme', layers: new Set(['Services', 'Changes & alerts', 'Agent state']),
  graph: { nodes: [], edges: [] }, byName: new Map(), network: null, nodesDS: null, edgesDS: null,
  investigationId: null, running: false, cypherCount: 0,
};

// A random per-browser id. In public mode the server gives each visitor a
// private GRAPH.COPY sandbox keyed by it.
const VISITOR = (() => {
  // ?v=<id> opens a specific sandbox (used for shareable links and screenshots).
  const fromUrl = new URLSearchParams(location.search).get('v');
  if (fromUrl) return fromUrl.replace(/[^a-z0-9]/gi, '').slice(0, 16);
  try {
    let v = localStorage.getItem('graphops-visitor');
    if (!v) { v = Math.random().toString(36).slice(2, 12); localStorage.setItem('graphops-visitor', v); }
    return v;
  } catch { return Math.random().toString(36).slice(2, 12); }
})();
const HEADERS = { 'Content-Type': 'application/json', 'x-visitor': VISITOR };

async function api(path, opts = {}) {
  const res = await fetch(`${path}${path.includes('?') ? '&' : '?'}tenant=${state.tenant}`, {
    headers: HEADERS, ...opts, body: opts.body ? JSON.stringify({ ...opts.body, tenant: state.tenant }) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

async function streamPost(path, body, onEvent) {
  const res = await fetch(path, { method: 'POST', headers: HEADERS, body: JSON.stringify({ ...body, tenant: state.tenant }) });
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
    id: n.id, label: ['Service', 'Capability'].includes(n.label) || n.label === 'Decision' && n.agent ? nodeLabel(n) : undefined, group: n.label,
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
      physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -80, springLength: 110, avoidOverlap: 0.4 }, stabilization: { iterations: 250, fit: true } },
      interaction: { hover: true, tooltipDelay: 120, hideEdgesOnDrag: true },
      edges: { smooth: false, selectionWidth: 0, hoverWidth: 0.5 },
    });
    settle();
  } else {
    const keep = new Set(nodes.map((n) => n.id));
    const before = state.nodesDS.length;
    state.nodesDS.remove(state.nodesDS.getIds().filter((id) => !keep.has(id)));
    state.nodesDS.update(nodes.map(visNode));
    state.edgesDS.clear();
    state.edgesDS.add(edges);
    if (state.nodesDS.length !== before) settle();
  }
  $('#stats').textContent = `${nodes.length}/${state.graph.nodes.length} nodes shown · ${state.cypherCount} Cypher queries this session`;
}

// Let the layout settle, then freeze it and fit it to the view (no jiggling).
function settle() {
  const net = state.network;
  if (!net) return;
  net.setOptions({ physics: { enabled: true } });
  net.stabilize(200);
  net.once('stabilizationIterationsDone', () => { net.setOptions({ physics: { enabled: false } }); net.fit({ animation: { duration: 400 } }); });
}

async function loadGraph() {
  state.graph = await api('/api/graph');
  state.byName = new Map(state.graph.nodes.map((n) => [n.name, n]));
  renderGraph();
  fillWhatIf();
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
  if (isMobile()) setView('center');
  if (!state.nodesDS.get(n.id)) {
    state.layers.add(layerOf(n)); renderLayers(); renderGraph();
  }
  state.network.focus(n.id, { scale: 1.2, animation: true });
  state.network.selectNodes([n.id]);
}

function renderLayers() {
  const open = $('#layers details')?.open;
  const sw = (labels) => labels.map((k) => k.split(':')[0]).filter((k, i, a) => a.indexOf(k) === i)
    .map((k) => `<span class="sw"><i style="background:${COLORS[k] || '#888'}"></i>${k}</span>`).join('');
  $('#layers').innerHTML = `<details ${open ? 'open' : ''}><summary>Layers · ${state.layers.size}/${Object.keys(LAYERS).length} ▾</summary>
    <div class="menu">${Object.entries(LAYERS).map(([l, labels]) => `<label><input type="checkbox" data-layer="${l}" ${state.layers.has(l) ? 'checked' : ''}>
      <span><b>${l}</b><span class="sws">${sw(labels)}</span></span></label>`).join('')}
    <button class="ghost fit" data-fit>Fit graph</button></div></details>`;
}
$('#layers').addEventListener('change', (e) => {
  const l = e.target.dataset.layer;
  e.target.checked ? state.layers.add(l) : state.layers.delete(l);
  renderLayers(); renderGraph();
});
$('#layers').addEventListener('click', (e) => { if (e.target.matches('[data-fit]')) state.network?.fit({ animation: true }); });


// ---------------- Phone / tablet view switcher ----------------
const mobileQ = window.matchMedia('(max-width: 1023px)');
const isMobile = () => mobileQ.matches;
function setView(v) {
  document.querySelector('main').dataset.view = v;
  document.querySelectorAll('.mnav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelector(`.mnav button[data-view="${v}"]`)?.classList.remove('dot');
  if (v === 'center' && state.network) {
    // The canvas was sized while hidden: resize, then frame the evidence (or everything).
    setTimeout(() => {
      state.network.setSize('100%', '100%');
      state.network.redraw();
      const ids = (state.traceIds || []).filter((id) => state.nodesDS.get(id));
      state.network.fit(ids.length ? { nodes: ids, animation: false } : { animation: false });
    }, 60);
  }
}
function hint(v) { if (isMobile() && document.querySelector('main').dataset.view !== v) document.querySelector(`.mnav button[data-view="${v}"]`)?.classList.add('dot'); }
document.querySelector('.mnav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
function sizeHeader() { document.documentElement.style.setProperty('--hdr', `${document.querySelector('header').offsetHeight}px`); }
window.addEventListener('resize', () => { sizeHeader(); if (state.network) { state.network.redraw(); } });
mobileQ.addEventListener?.('change', () => { sizeHeader(); setView(document.querySelector('main').dataset.view || 'left'); });
sizeHeader();

// ---------------- Timeline ----------------
// Layout: a brief card pinned on top (decision, proof, actions), then one
// collapsible section per agent with its steps and findings.
const tl = () => $('#timeline');
const chip = (a) => `<span class="chip ${a}">${esc(a)}</span>`;
function el(html, cls = '') { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; }
function add(html, cls = '', parent = null) {
  const node = el(html, `ev ${cls}`);
  (parent || flow()).appendChild(node);
  return node;
}
function ensureLayout() { if (!$('#brief') || !$('#flow')) resetTimeline(); }
function flow() { ensureLayout(); return $('#flow'); }
function resetTimeline() {
  tl().innerHTML = '';
  const b = el('', 'brief'); b.id = 'brief'; tl().appendChild(b);
  const f = el('', 'flow'); f.id = 'flow'; tl().appendChild(f);
  state.sections = {};
}
function slot(name) {
  ensureLayout();
  let s = $(`#brief [data-slot="${name}"]`);
  if (!s) {
    const order = ['head', 'decision', 'proof', 'actions', 'note'];
    s = el('', `slot-${name}`); s.dataset.slot = name;
    const b = $('#brief');
    const after = [...b.children].find((c) => order.indexOf(c.dataset.slot) > order.indexOf(name));
    after ? b.insertBefore(s, after) : b.appendChild(s);
  }
  return s;
}
function section(agent) {
  ensureLayout();
  state.sections ||= {};
  if (state.sections[agent]) return state.sections[agent];
  const sec = el(`<div class="sec-head" data-toggle>${chip(agent)}<span class="st">working…</span><span class="cnt"></span><span class="caret">▾</span></div>
    <div class="sec-text"></div><div class="sec-body"></div>`, `sec ${agent}`);
  flow().appendChild(sec);
  return (state.sections[agent] = { sec, tools: 0, queries: 0, findings: 0, body: sec.querySelector('.sec-body') });
}
function bump(agent, k, n = 1) {
  const s = section(agent); s[k] += n;
  s.sec.querySelector('.cnt').textContent = `${s.findings} findings · ${s.tools} tools · ${s.queries} queries`;
}

function logCypher(e) {
  const box = $('#tab-cypher');
  if (box.querySelector('.empty')) box.innerHTML = '';
  for (const q of e.cypher) {
    state.cypherCount++;
    box.insertAdjacentHTML('afterbegin', `<div class="cy"><div class="meta">${chip(e.agent)} <span>${esc(e.tool)} · ${q.rows} rows · ${q.ms}ms</span></div><pre>${esc(q.query)}${Object.keys(q.params || {}).length ? `\n\n// params ${esc(JSON.stringify(q.params))}` : ''}</pre></div>`);
  }
}

const pendingTools = new Map();
function findingHtml(e) {
  return `<div class="head"><span class="kind">${esc(e.kind.replace('_', ' '))}</span><span class="conf-n">${Math.round((e.confidence ?? 0.7) * 100)}%</span></div>
    <div>${md(e.summary)}</div>
    <div class="pills">${(e.evidence || []).map((x) => `<span class="pill" data-focus="${esc(x)}">${esc(x)}</span>`).join('')}</div>`;
}
function onEvent(e) {
  switch (e.type) {
    case 'investigation':
      state.investigationId = e.id;
      slot('head').innerHTML = `<div class="brief-head"><span><b>${esc(e.id)}</b> · ${e.mode === 'llm' ? 'Gemini agents' : 'scripted agents'}</span><span class="ms" id="brief-stats">working…</span></div>
        <div class="q">${esc(e.question)}</div>`;
      break;
    case 'handoff':
      add(`${[].concat(e.from).map(chip).join(' ')} → ${[].concat(e.to).map(chip).join(' ')} <span class="ms">${esc(e.note)}</span>`, 'handoff');
      if ([].concat(e.to).includes('commander')) for (const a of ['triage', 'historian']) state.sections?.[a]?.sec.classList.add('collapsed');
      break;
    case 'agent_start':
      section(e.agent);
      break;
    case 'thought':
      break;
    case 'tool_call': {
      if (e.tool === 'record_finding' || e.tool === 'record_decision') { pulse(namesIn(e.args), e.agent); break; }
      const s = section(e.agent);
      const row = add(`<details><summary><span class="tool">${esc(e.tool)}</span><span class="args">${esc(Object.values(e.args || {}).map((v) => Array.isArray(v) ? `[${v.length}]` : String(v).slice(0, 32)).join(', '))}</span><span class="ms">…</span></summary></details>`, 'trow', s.body);
      pendingTools.set(`${e.agent}:${e.tool}`, row);
      bump(e.agent, 'tools');
      pulse(namesIn(e.args), e.agent);
      break;
    }
    case 'tool_result': {
      const row = pendingTools.get(`${e.agent}:${e.tool}`);
      if (row && e.tool !== 'record_finding' && e.tool !== 'record_decision') {
        row.querySelector('.ms').textContent = `${e.cypher.length}q · ${e.ms}ms`;
        row.querySelector('details').insertAdjacentHTML('beforeend', `${e.cypher.map((q) => `<pre>${esc(q.query)}</pre>`).join('')}<pre class="res">${esc(JSON.stringify(e.result, null, 1)).slice(0, 2500)}</pre>`);
      }
      bump(e.agent, 'queries', e.cypher.length);
      logCypher(e);
      if (e.tool !== 'record_finding') pulse(namesIn(e.result).slice(0, 25), e.agent);
      break;
    }
    case 'finding':
      add(findingHtml(e), `finding ${e.agent}`, section(e.agent).body);
      bump(e.agent, 'findings');
      break;
    case 'memory':
      add(`🧠 Remembered: <b>${esc(e.service)}</b>: ${esc(e.fact)}`, `finding ${e.agent}`, section(e.agent).body);
      break;
    case 'decision':
      renderDecision(e);
      hint('center'); hint('right');
      break;
    case 'verification':
      slot('proof').innerHTML = `<details class="proof ${esc(e.verdict)}"><summary>${proofSummary(e)}</summary>${proofHtml(e)}</details>`;
      pulse([e.root_cause, ...(e.explained || []).flatMap((x) => x.path)], 'commander');
      break;
    case 'citations': {
      const s = section(e.agent);
      s.sec.querySelector('.sec-text').insertAdjacentHTML('beforeend', `<div class="cites ${e.unknown.length ? 'bad' : ''}">${e.unknown.length ? '⚠' : '✓'} ${e.verified}/${e.checked} cited nodes exist in the graph${e.unknown.length ? ` · unknown: ${esc(e.unknown.join(', '))}` : ''}</div>`);
      break;
    }
    case 'actions':
      renderActions(e.actions);
      break;
    case 'notice':
      add(`⚠ ${esc(e.text)}`, 'notice', e.agent && state.sections?.[e.agent] ? state.sections[e.agent].body : null);
      break;
    case 'agent_done': {
      const s = section(e.agent);
      s.sec.querySelector('.st').textContent = 'done';
      s.sec.classList.add('done');
      if (e.text) s.sec.querySelector('.sec-text').insertAdjacentHTML('afterbegin', `<div class="say">${md(e.text)}</div>`);
      if (e.agent === 'commander' || e.agent === 'chat') s.sec.classList.add('collapsed');
      break;
    }
    case 'done':
      if (e.stats && $('#brief-stats')) $('#brief-stats').textContent = `✓ ${e.stats.tools} tools · ${e.stats.queries} queries · ${(e.stats.ms / 1000).toFixed(1)}s`;
      tl().scrollTo({ top: 0, behavior: 'smooth' });
      break;
    case 'error':
      add(`✖ ${esc(e.text)}`, 'notice');
      break;
  }
}

function proofSummary(p) {
  return `<span class="verdict ${esc(p.verdict)}">${esc(p.verdict)}</span> <b>Proof gate</b> <span class="ms">${esc(p.reason || '')}</span>`;
}
function proofHtml(p) {
  return `<div class="ms">Causal path required · algo.SPpaths · algo.maxFlow${p.isolation_min_cut != null ? ` · isolating it takes ≥ ${p.isolation_min_cut} link cut(s)` : ''}</div>
    ${(p.explained || []).map((x) => `<div class="path">${esc(x.path.join(' → '))}</div>`).join('')}
    ${p.unexplained?.length ? `<div class="path bad">no causal path: ${esc(p.unexplained.join(', '))}</div>` : ''}
    ${p.deploy ? `<div class="path">${esc(p.deploy.id)} on ${esc(p.deploy.service || '?')}: ${p.deploy.adjacent ? 'adjacent' : 'NOT adjacent'}, ${p.deploy.recent ? 'recent' : 'NOT recent'}</div>` : ''}`;
}

function renderActions(actions) {
  const box = document.createElement('div');
  box.className = 'actions-card';
  box.innerHTML = `<div class="ac-head"><b>⚡ Proposed actions</b><span class="ms">nothing is sent until you approve</span></div>
    ${actions.map((a) => `<div class="act" data-act="${esc(a.id)}">
      <div class="head"><span>${a.kind === 'page' ? '📟' : '🐙'} ${esc(a.summary)}</span>
        <span class="chan ${a.channel === 'dry-run' ? 'dry' : 'live'}">${esc(a.channel)}</span></div>
      <details><summary>exact payload</summary><pre>${esc(a.kind === 'page' ? a.payload.text : `${a.payload.title}\n\n${a.payload.body}`)}</pre></details>
      <div class="row">${a.status === 'proposed'
        ? `<button class="primary" data-approve="${esc(a.id)}">Approve & ${a.channel === 'dry-run' ? 'dry-run' : 'send'}</button>`
        : `<span class="status ${esc(a.status)}">${esc(a.status)}</span> ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a>` : esc(a.result || '')}`}</div>
    </div>`).join('')}`;
  const s = slot('actions'); s.innerHTML = ''; s.appendChild(box);
}

function renderDecision(d) {
  const card = document.createElement('div');
  card.className = 'decision';
  card.innerHTML = `<h3><span class="sev">${esc(d.severity)}</span>${esc(d.title)} ${d.verdict ? `<span class="verdict ${esc(d.verdict)}">${esc(d.verdict)}</span>` : ''}</h3>
    <dl>
      <dt>Root cause</dt><dd><span class="pill" data-focus="${esc(d.root_cause)}">${esc(d.root_cause)}</span></dd>
      ${d.suspect_deploy ? `<dt>Suspect</dt><dd><span class="pill" data-focus="${esc(d.suspect_deploy)}">${esc(d.suspect_deploy)}</span></dd>` : ''}
      ${d.runbook ? `<dt>Runbook</dt><dd><span class="pill" data-focus="${esc(d.runbook)}">${esc(d.runbook)}</span></dd>` : ''}
      <dt>Page</dt><dd>${(d.page || []).map((p) => `<span class="pill" data-focus="${esc(p)}">${esc(p)}</span>`).join('')}</dd>
      <dt>Action</dt><dd>${md(d.action)}</dd>
    </dl>
    <div class="actions"><button class="primary" data-resolve>Fix worked: remember</button><button data-failed>Didn't work</button><button data-why>Why?</button></div>`;
  const s = slot('decision'); s.innerHTML = ''; s.appendChild(card);
}

document.addEventListener('click', async (e) => {
  const tg = e.target.closest('[data-toggle]');
  if (tg) tg.parentElement.classList.toggle('collapsed');
  const f = e.target.closest('[data-focus]');
  if (f) focus(f.dataset.focus);
  if (e.target.matches('[data-why]')) { switchTab('trace'); if (isMobile()) setView('right'); await showTrace(state.investigationId); }
  if (e.target.matches('[data-resolve]')) {
    e.target.disabled = true;
    const resolution = prompt('How was it resolved?', 'Rolled back the suspect deploy and followed the runbook. Error rates recovered.');
    if (resolution === null) { e.target.disabled = false; return; }
    const r = await api(`/api/investigations/${state.investigationId}/resolve`, { method: 'POST', body: { resolution } });
    e.target.textContent = `Learned as ${r.incident} ✓`;
    slot('note').innerHTML = `<div class="note">🧠 Stored <b>${esc(r.incident)}</b> in episodic memory (resolved by ${esc(r.resolved_by)}). The runbook's success count went up, and the next investigation will recall it.</div>`;
    await loadGraph(); await loadMemory();
  }
  if (e.target.matches('[data-failed]')) {
    const resolution = prompt('What happened?', 'Rolled back but connections stayed saturated.');
    if (resolution === null) return;
    const r = await api(`/api/investigations/${state.investigationId}/resolve`, { method: 'POST', body: { resolution, outcome: 'failed' } });
    e.target.disabled = true; e.target.textContent = 'Recorded as failed';
    slot('note').innerHTML = `<div class="note">🧠 Recorded the failure.${r.runbook_penalised ? ` ${esc(r.runbook_penalised)} lost rank in procedural memory.` : ''} Investigate again and the agents will prefer the next-best option.</div>`;
    await loadGraph(); await loadMemory();
  }
  if (e.target.matches('[data-approve]')) {
    const id = e.target.dataset.approve;
    e.target.disabled = true; e.target.textContent = 'Sending…';
    const r = await api(`/api/actions/${id}/approve`, { method: 'POST', body: { user: $('#user').value } });
    const row = e.target.closest('.row');
    row.innerHTML = `<span class="status ${esc(r.status)}">${esc(r.status)}</span> ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>` : esc(r.result || '')}`;
    await loadGraph();
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
  for (const id of ids) {
    const n = state.graph.nodes.find((x) => x.id === id);
    if (n) state.nodesDS.update({ ...visNode(n), label: nodeLabel(n), borderWidth: 4, color: { ...visNode(n).color, border: '#ffc24b' } });
  }
  state.traceIds = ids;
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
  resetTimeline();
  slot('head').innerHTML = `<div class="brief-head"><span><b>${esc(id)}</b> · from memory</span><span class="status ${esc(inv.status)}">${esc(inv.status)}</span></div><div class="q">${esc(inv.question)}</div>`;
  if (inv.decision) renderDecision({ ...inv.decision, page: inv.decision.paged });
  if (inv.decision?.verdict) slot('proof').innerHTML = `<details class="proof ${esc(inv.decision.verdict)}"><summary>${proofSummary({ verdict: inv.decision.verdict, reason: inv.decision.proof })}</summary></details>`;
  if (inv.decision) api(`/api/investigations/${id}/actions`).then((acts) => acts.length && renderActions(acts)).catch(() => {});
  if (inv.status === 'resolved') $('#brief .decision .actions')?.replaceWith(Object.assign(document.createElement('span'), { className: 'status resolved', textContent: 'resolved · in memory' }));
  for (const f of inv.findings) { add(findingHtml(f), `finding ${f.agent}`, section(f.agent).body); bump(f.agent, 'findings'); }
  for (const t of inv.turns.slice(1)) {
    const who = t.agent || t.role;
    const s = section(who);
    s.sec.querySelector('.sec-text').insertAdjacentHTML('beforeend', `<div class="say">${md(t.text)}</div>`);
    s.sec.querySelector('.st').textContent = 'done';
    s.sec.classList.add('done', 'collapsed');
  }
  $('#chatform').classList.remove('hidden');
  await showTrace(id); switchTab('trace');
}

// ---------------- What-if simulator ----------------
function fillWhatIf() {
  const svcs = state.graph.nodes.filter((n) => n.label === 'Service').map((n) => n.name).sort();
  const sel = $('#wi-service'); const cur = sel.value;
  sel.innerHTML = svcs.map((n) => `<option ${n === (cur || 'kafka-events') ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
const money = (n) => `$${Number(n).toLocaleString()}/min`;
$('#wi-break').addEventListener('click', async () => {
  const svc = $('#wi-service').value; $('#wi-out').innerHTML = '<div class="empty">Copying graph and simulating…</div>';
  const r = await api('/api/tools/what_if', { method: 'POST', body: { args: { down: [svc] } } });
  if (r.error) { $('#wi-out').innerHTML = `<div class="wi-card bad">${esc(r.error)}</div>`; return; }
  $('#wi-out').innerHTML = `<div class="wi-card"><div>If <b>${esc(svc)}</b> goes down:</div>
    <div class="big bad">${money(r.before.revenue_at_risk_per_min)} at risk</div>
    <div>Capabilities: <ul>${r.before.impacted_capabilities.map((c) => `<li>${esc(c)}</li>`).join('') || '<li>none</li>'}</ul></div>
    <div>${r.before.impacted_services.length} services affected</div>
    <div>${r.before.impacted_services.map((x) => `<span class="pill" data-focus="${esc(x)}">${esc(x)}</span>`).join('')}</div>
    <div class="path">${esc(r.sandbox)}</div></div>`;
  pulse(r.before.impacted_services, 'commander');
});
$('#wi-contain').addEventListener('click', async () => {
  const svc = $('#wi-service').value; $('#wi-out').innerHTML = '<div class="empty">Searching fallback combinations on a sandbox…</div>';
  const r = await api('/api/tools/containment_plan', { method: 'POST', body: { args: { root_cause: svc } } });
  if (r.error) { $('#wi-out').innerHTML = `<div class="wi-card bad">${esc(r.error)}</div>`; return; }
  $('#wi-out').innerHTML = `<div class="wi-card"><div>While <b>${esc(svc)}</b> is down (${money(r.baseline.revenue_at_risk_per_min)} at risk):</div>
    <div class="big ${r.revenue_protected_per_min ? 'good' : 'bad'}">${r.revenue_protected_per_min ? `protect ${money(r.revenue_protected_per_min)}` : 'no fallback helps'}</div>
    ${r.plan.length ? `<div>Switch on:<ul>${r.plan.map((p) => `<li>${esc(p.switch_on)} <span class="path">${esc(p.link)}</span></li>`).join('')}</ul></div>` : ''}
    ${r.protects.length ? `<div class="good">Keeps up: ${esc(r.protects.join(', '))}</div>` : ''}
    <div class="${r.still_down.length ? 'bad' : 'good'}">Still down: ${esc(r.still_down.join(', ') || 'nothing')}</div>
    <div class="path">${r.combinations_simulated} fallback combinations simulated · plan replayed on the copy: ${r.verified_by_replay ? 'confirmed' : 'mismatch'}</div>
    <div class="path">${esc(r.note)}</div></div>`;
});

// ---------------- Actions ----------------
async function run(path, body) {
  if (state.running) return;
  state.running = true; $('#go').disabled = true;
  try {
    await streamPost(path, body, onEvent);
  } finally {
    state.running = false; $('#go').disabled = false;
    await loadGraph(); await loadMemory();
    api('/api/status').then((st) => { if (st.public && st.llm) $('#mode').textContent = `Gemini · ${st.models.split(',')[0]} · ${st.llm_runs_left} AI runs left`; }).catch(() => {});
  }
}

$('#go').addEventListener('click', async () => {
  state.traceIds = [];
  if (isMobile()) setView('left');
  resetTimeline();
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
  if (!confirm(`Re-seed "${state.tenant}"? This erases the learned memory in this graph.`)) return;
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
  $('#mode').textContent = s.llm ? `Gemini · ${s.models.split(',')[0]}${s.public ? ` · ${s.llm_runs_left} AI runs left` : ''}` : 'scripted mode (no LLM key)';
  if (s.public) {
    $('#seed').textContent = 'Reset my sandbox';
    $('#seed').title = 'Your own GRAPH.COPY of the company graph. Nobody else sees your changes.';
  }
  $('#mode').className = `badge ${s.llm ? 'llm' : 'scripted'}`;
  const current = s.tenants.find((t) => t.id === state.tenant);
  if (!current.seeded) await api('/api/seed', { method: 'POST', body: {} });
  if (state.tenant === 'globex') $('#question').value = 'Users report videos won\'t start playing.';
  else if (state.tenant === 'otel') $('#question').value = 'Astronomy Shop checkout is failing. Orders return errors.';
  if (!['globex', 'otel'].includes(state.tenant)) $('#question').value = 'Checkout is throwing 500s and customers can\'t pay. What\'s going on?';
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
