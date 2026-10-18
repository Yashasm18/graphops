// Integration tests against a real FalkorDB. They use their own graph
// (graphops_ci_acme), so they never touch a tenant's data.
//   docker run -p 6379:6379 falkordb/falkordb:latest && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedTenant } from '../src/seed.js';
import { runTool } from '../src/tools.js';
import { verifyRootCause, checkCitations } from '../src/proof.js';
import { startInvestigation, getInvestigation, resolveInvestigation } from '../src/memory.js';
import { investigate } from '../src/agents.js';
import { getDb, graphFor } from '../src/db.js';

const T = 'ci_acme';
const ctx = { agent: 'test' };

before(async () => { await seedTenant(T, { spec: 'acme' }); });
after(async () => { await (await graphFor(T)).delete().catch(() => {}); (await getDb()).close(); });

test('ranks payments-db as the root cause and finds the culprit deploy', async () => {
  const [top] = await runTool(T, 'probable_root_cause', {}, ctx);
  assert.equal(top.candidate, 'payments-db');
  assert.equal(top.recent_deploys_nearby[0].deploy, 'DEP-981');
});

test('blast radius reaches web and mobile and prices the outage', async () => {
  const r = await runTool(T, 'blast_radius', { service: 'payments-db' }, ctx);
  const names = r.upstream_services.map((s) => s.service);
  assert.ok(names.includes('web-frontend') && names.includes('mobile-bff'));
  assert.equal(r.revenue_at_risk_per_min, 4200);
});

test('shortest causal path uses FalkorDB shortestPath', async () => {
  const r = await runTool(T, 'dependency_path', { from: 'mobile-bff', to: 'payments-db' }, ctx);
  assert.deepEqual(r.path, ['mobile-bff', 'api-gateway', 'checkout-service', 'payments-service', 'payments-db']);
});

test('graph algorithms run as tools', async () => {
  const r = await runTool(T, 'critical_nodes', {}, ctx);
  assert.ok(r.pagerank.length > 0 && r.betweenness.length > 0);
  assert.equal(r.betweenness[0].service, 'checkout-service');
});

test('proof gate: true root VERIFIED, symptom WEAK, unrelated REJECTED or WEAK', async () => {
  assert.equal((await verifyRootCause(T, { root_cause: 'payments-db', suspect_deploy: 'DEP-981' })).verdict, 'VERIFIED');
  assert.equal((await verifyRootCause(T, { root_cause: 'payments-service' })).verdict, 'WEAK');
  assert.notEqual((await verifyRootCause(T, { root_cause: 'elasticsearch' })).verdict, 'VERIFIED');
});

test('what-if runs on a GRAPH.COPY sandbox and leaves the graph untouched', async () => {
  const before = (await (await getDb()).list()).length;
  const r = await runTool(T, 'what_if', { down: ['redis-cache'] }, ctx);
  assert.ok(r.before.impacted_capabilities.includes('Login'));
  assert.equal((await (await getDb()).list()).length, before);
});

test('containment plan finds the two outbox fallbacks for a Kafka outage', async () => {
  const r = await runTool(T, 'containment_plan', { root_cause: 'kafka-events' }, ctx);
  assert.equal(r.revenue_protected_per_min, 4200);
  assert.equal(r.plan.length, 2);
  assert.ok(r.verified_by_replay);
});

test('full-text knowledge search finds the retry-storm incident', async () => {
  const r = await runTool(T, 'search_knowledge', { text: 'retry' }, ctx);
  assert.equal(r[0].id, 'INC-2041');
});

test('citation check flags ids that are not in the graph', async () => {
  const r = await checkCitations(T, 'See INC-2041 and INC-9999 on `payments-db`.');
  assert.equal(r.checked, 3);
  assert.deepEqual(r.unknown, ['INC-9999']);
});

test('runbook revision supersedes the old version', async () => {
  const r = await runTool(T, 'revise_runbook', { runbook: 'RB-PAY-02', steps: 'new steps', reason: 'test' }, ctx);
  assert.equal(r.created, 'RB-PAY-02-v2');
  const rbs = await runTool(T, 'runbooks_for', { service: 'stripe-api' }, ctx);
  assert.ok(!rbs.some((x) => x.runbook === 'RB-PAY-02'));
});

test('multi-agent run (scripted) records a verified decision; resolving teaches memory', async () => {
  process.env.GRAPHOPS_SCRIPTED = 'true';
  const events = [];
  const { investigationId } = await investigate({ tenant: T, user: 'ci', question: 'checkout 500s', emit: (e) => events.push(e) });
  const inv = await getInvestigation(T, investigationId);
  assert.equal(inv.decision.root_cause, 'payments-db');
  assert.equal(inv.decision.verdict, 'VERIFIED');
  assert.ok(inv.findings.length >= 5);
  assert.ok(events.some((e) => e.type === 'verification'));
  const { incident } = await resolveInvestigation(T, investigationId, { resolution: 'rolled back' });
  const recalled = await runTool(T, 'similar_incidents', { services: ['payments-db'] }, ctx);
  assert.equal(recalled[0].incident, incident);
});
