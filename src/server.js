import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cypher, listTenants, graphFor, tenantGraphName, describeDbError } from './db.js';
import { seedTenant, resetScenario, TENANTS } from './seed.js';
import { investigate, chat, llmEnabled } from './agents.js';
import { listInvestigations, getInvestigation, resolveInvestigation, decisionTrace } from './memory.js';
import { runTool, TOOLS } from './tools.js';
import { proposeActions, listActions, approveAction, channels } from './actions.js';

const app = express();
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

// PUBLIC_MODE (for a live deployment): every visitor gets a private GRAPH.COPY
// sandbox of the tenant graph, so nobody can wipe or pollute anyone else's
// memory, and each visitor has a small Gemini quota before agents fall back to
// the scripted playbooks.
const PUBLIC = process.env.PUBLIC_MODE === 'true';
const LLM_RUNS_PER_VISITOR = Number(process.env.LLM_RUNS_PER_VISITOR || 3);
const ready = new Set();
const llmRuns = new Map();

const baseOf = (req) => {
  const t = String(req.query.tenant || req.body?.tenant || 'acme');
  if (!TENANTS[t]) throw Object.assign(new Error(`unknown tenant ${t}`), { status: 400 });
  return t;
};
const visitorOf = (req) => String(req.get('x-visitor') || '').replace(/[^a-z0-9]/gi, '').slice(0, 16).toLowerCase();

async function tenantOf(req) {
  const base = baseOf(req);
  if (!PUBLIC) return base;
  const v = visitorOf(req);
  if (!v) throw Object.assign(new Error('missing visitor id'), { status: 400 });
  const t = `${base}_v_${v}`;
  if (!ready.has(t)) {
    const graphs = await listTenants();
    if (!graphs.includes(base)) await seedTenant(base);
    if (!graphs.includes(t)) {
      await (await graphFor(base)).copy(tenantGraphName(t));
      // The base graph may have been seeded hours ago: re-fire the alerts and
      // move the scenario deploys back to "minutes ago" for this visitor.
      await resetScenario(t, base);
    }
    ready.add(t);
  }
  return t;
}

// Returns true when this visitor still has LLM budget.
function takeLlmRun(req) {
  if (!PUBLIC) return true;
  const v = visitorOf(req);
  const n = llmRuns.get(v) || 0;
  if (n >= LLM_RUNS_PER_VISITOR) return false;
  llmRuns.set(v, n + 1);
  return true;
}

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    const dbDown = /ECONNREFUSED|ENOTFOUND|AggregateError|Connection timeout|Socket closed/i.test(`${err?.name} ${err?.message} ${err?.errors?.[0]?.code || ''}`);
    res.status(dbDown ? 503 : err.status || 500).json({ error: dbDown ? describeDbError(err) : String(err.message || err) });
  }
};

// Stream agent events as newline-delimited JSON.
function stream(handler) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const emit = (e) => res.write(`${JSON.stringify({ ...e, t: Date.now() })}\n`);
    try {
      await handler(req, emit);
    } catch (err) {
      emit({ type: 'error', text: String(err.message || err) });
    }
    res.end();
  };
}

app.get('/api/status', async (req, res, next) => {
  // Fail closed: without FalkorDB there is nothing for the agents to reason over.
  try { await listTenants(); } catch (err) {
    return res.status(503).json({ error: `GraphOps ${describeDbError(err)} GraphOps has no fallback store: every tool, memory and decision lives in the graph.` });
  }
  next();
}, wrap(async (req) => {
  const seeded = await listTenants();
  return {
    llm: llmEnabled(),
    public: PUBLIC,
    action_channels: channels(),
    llm_runs_left: PUBLIC ? Math.max(0, LLM_RUNS_PER_VISITOR - (llmRuns.get(visitorOf(req)) || 0)) : null,
    models: process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3-flash-preview',
    tenants: Object.entries(TENANTS).map(([id, s]) => ({ id, label: s.label, seeded: PUBLIC || seeded.includes(id) })),
  };
}));

app.post('/api/seed', wrap(async (req) => seedTenant(await tenantOf(req), { spec: baseOf(req) })));
app.post('/api/reset-scenario', wrap(async (req) => resetScenario(await tenantOf(req), baseOf(req))));

app.get('/api/graph', wrap(async (req) => {
  const t = await tenantOf(req);
  const nodes = await cypher(t, `
    MATCH (n) WHERE NOT n:Turn AND NOT n:User
    RETURN ID(n) AS id, labels(n)[0] AS label, coalesce(n.name, n.id) AS name,
           n.title AS title, n.status AS status, n.kind AS kind, n.tier AS tier, n.agent AS agent`, {}, { readOnly: true });
  const edges = await cypher(t, `
    MATCH (a)-[r]->(b) WHERE NOT a:Turn AND NOT b:Turn AND NOT a:User
    RETURN ID(a) AS from, ID(b) AS to, type(r) AS type`, {}, { readOnly: true });
  return { nodes, edges };
}));

app.get('/api/investigations', wrap(async (req) => listInvestigations(await tenantOf(req))));
app.get('/api/investigations/:id', wrap(async (req) => {
  const t = await tenantOf(req);
  return { ...(await getInvestigation(t, req.params.id)), trace: await decisionTrace(t, req.params.id) };
}));
app.post('/api/investigations/:id/resolve', wrap(async (req) =>
  resolveInvestigation(await tenantOf(req), req.params.id, { resolution: req.body.resolution || 'Mitigated per decision.', resolver: req.body.resolver, outcome: req.body.outcome })));

app.get('/api/investigations/:id/actions', wrap(async (req) => listActions(await tenantOf(req), req.params.id)));
app.post('/api/investigations/:id/actions', wrap(async (req) => proposeActions(await tenantOf(req), req.params.id)));
app.post('/api/actions/:id/approve', wrap(async (req) => approveAction(await tenantOf(req), req.params.id, req.body.user)));

app.post('/api/investigate', stream(async (req, emit) => {
  const tenant = await tenantOf(req);
  const scripted = !takeLlmRun(req);
  if (scripted && llmEnabled()) emit({ type: 'notice', agent: 'orchestrator', text: `AI quota for this visitor is used up (${LLM_RUNS_PER_VISITOR} runs), so the agents run their scripted graph playbooks. Same tools, same proof gate.` });
  await investigate({ tenant, user: req.body.user || 'anonymous', question: req.body.question, emit, scripted });
}));

app.post('/api/chat', stream(async (req, emit) => {
  const tenant = await tenantOf(req);
  await chat({ tenant, scripted: !takeLlmRun(req), user: req.body.user || 'anonymous', investigationId: req.body.investigationId, message: req.body.message, emit });
}));

// Direct tool access, used by the UI's "tool explorer".
app.get('/api/tools', (_req, res) => res.json(Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }))));
app.post('/api/tools/:name', wrap(async (req) => runTool(await tenantOf(req), req.params.name, req.body.args || {}, { agent: 'human' })));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`GraphOps on http://localhost:${port}  (LLM: ${llmEnabled() ? 'gemini' : 'scripted'})`));
