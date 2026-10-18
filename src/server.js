import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cypher, listTenants } from './db.js';
import { seedTenant, resetScenario, TENANTS } from './seed.js';
import { investigate, chat, llmEnabled } from './agents.js';
import { listInvestigations, getInvestigation, resolveInvestigation, decisionTrace } from './memory.js';
import { runTool, TOOLS } from './tools.js';

const app = express();
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

const tenantOf = (req) => {
  const t = String(req.query.tenant || req.body?.tenant || 'acme');
  if (!TENANTS[t]) throw Object.assign(new Error(`unknown tenant ${t}`), { status: 400 });
  return t;
};

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
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

app.get('/api/status', wrap(async () => {
  const seeded = await listTenants();
  return {
    llm: llmEnabled(),
    models: process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3-flash-preview',
    tenants: Object.entries(TENANTS).map(([id, s]) => ({ id, label: s.label, seeded: seeded.includes(id) })),
  };
}));

app.post('/api/seed', wrap(async (req) => seedTenant(tenantOf(req))));
app.post('/api/reset-scenario', wrap(async (req) => resetScenario(tenantOf(req))));

app.get('/api/graph', wrap(async (req) => {
  const t = tenantOf(req);
  const nodes = await cypher(t, `
    MATCH (n) WHERE NOT n:Turn AND NOT n:User
    RETURN ID(n) AS id, labels(n)[0] AS label, coalesce(n.name, n.id) AS name,
           n.title AS title, n.status AS status, n.kind AS kind, n.tier AS tier, n.agent AS agent`, {}, { readOnly: true });
  const edges = await cypher(t, `
    MATCH (a)-[r]->(b) WHERE NOT a:Turn AND NOT b:Turn AND NOT a:User
    RETURN ID(a) AS from, ID(b) AS to, type(r) AS type`, {}, { readOnly: true });
  return { nodes, edges };
}));

app.get('/api/investigations', wrap(async (req) => listInvestigations(tenantOf(req))));
app.get('/api/investigations/:id', wrap(async (req) => {
  const t = tenantOf(req);
  return { ...(await getInvestigation(t, req.params.id)), trace: await decisionTrace(t, req.params.id) };
}));
app.post('/api/investigations/:id/resolve', wrap(async (req) =>
  resolveInvestigation(tenantOf(req), req.params.id, { resolution: req.body.resolution || 'Mitigated per decision.', resolver: req.body.resolver, outcome: req.body.outcome })));

app.post('/api/investigate', stream(async (req, emit) => {
  await investigate({ tenant: tenantOf(req), user: req.body.user || 'anonymous', question: req.body.question, emit });
}));

app.post('/api/chat', stream(async (req, emit) => {
  await chat({ tenant: tenantOf(req), user: req.body.user || 'anonymous', investigationId: req.body.investigationId, message: req.body.message, emit });
}));

// Direct tool access, used by the UI's "tool explorer".
app.get('/api/tools', (_req, res) => res.json(Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }))));
app.post('/api/tools/:name', wrap(async (req) => runTool(tenantOf(req), req.params.name, req.body.args || {}, { agent: 'human' })));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`GraphOps on http://localhost:${port}  (LLM: ${llmEnabled() ? 'gemini' : 'scripted'})`));
