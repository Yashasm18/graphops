// Investigation lifecycle and conversation memory, all stored in the tenant
// graph so it survives restarts and is shared by every agent.
import { cypher } from './db.js';

export async function startInvestigation(tenant, user, question) {
  const id = `INV-${Date.now().toString(36).toUpperCase()}`;
  await cypher(tenant, `
    MERGE (u:User {name: $user})
    CREATE (u)-[:STARTED]->(inv:Investigation {id: $id, question: $question, status: 'open', at: $at, user: $user})`,
  { user, id, question, at: Date.now() });
  await addTurn(tenant, id, 'user', question);
  return id;
}

export async function addTurn(tenant, investigationId, role, text, agent = null) {
  await cypher(tenant, `
    MATCH (inv:Investigation {id: $id})
    OPTIONAL MATCH (inv)-[:HAS_TURN]->(prev:Turn) WHERE NOT (prev)-[:NEXT]->()
    CREATE (inv)-[:HAS_TURN]->(t:Turn {role: $role, text: $text, agent: $agent, at: $at})
    FOREACH (_ IN CASE WHEN prev IS NULL THEN [] ELSE [1] END | CREATE (prev)-[:NEXT]->(t))`,
  { id: investigationId, role, text, agent, at: Date.now() });
}

export async function getTurns(tenant, investigationId, limit = 20) {
  const rows = await cypher(tenant, `
    MATCH (:Investigation {id: $id})-[:HAS_TURN]->(t:Turn)
    RETURN t.role AS role, t.text AS text, t.agent AS agent, t.at AS at ORDER BY t.at DESC LIMIT ${limit}`,
  { id: investigationId }, { readOnly: true });
  return rows.reverse();
}

// What this user did in earlier sessions: per-user memory.
export async function userHistory(tenant, user, limit = 5) {
  return cypher(tenant, `
    MATCH (:User {name: $user})-[:STARTED]->(inv:Investigation)
    OPTIONAL MATCH (inv)-[:CONCLUDED]->(d:Decision)
    RETURN inv.id AS id, inv.question AS question, inv.status AS status, d.title AS decision, inv.at AS at
    ORDER BY inv.at DESC LIMIT ${limit}`, { user }, { readOnly: true });
}

export async function listInvestigations(tenant) {
  return cypher(tenant, `
    MATCH (u:User)-[:STARTED]->(inv:Investigation)
    OPTIONAL MATCH (inv)-[:CONCLUDED]->(d:Decision)
    OPTIONAL MATCH (inv)<-[:FROM_INVESTIGATION]-(inc:Incident)
    RETURN inv.id AS id, inv.question AS question, inv.status AS status, u.name AS user, inv.at AS at,
           d.title AS decision, d.severity AS severity, inc.id AS incident
    ORDER BY inv.at DESC LIMIT 30`, {}, { readOnly: true });
}

export async function getInvestigation(tenant, id) {
  const [inv] = await cypher(tenant, `
    MATCH (u:User)-[:STARTED]->(inv:Investigation {id: $id})
    RETURN inv.id AS id, inv.question AS question, inv.status AS status, inv.at AS at, u.name AS user`,
  { id }, { readOnly: true });
  if (!inv) return null;
  inv.findings = await cypher(tenant, `
    MATCH (:Investigation {id: $id})-[:HAS_FINDING]->(f:Finding)
    OPTIONAL MATCH (f)-[:EVIDENCE]->(e)
    RETURN f.id AS id, f.agent AS agent, f.kind AS kind, f.summary AS summary, f.confidence AS confidence,
           collect(coalesce(e.name, e.id)) AS evidence, f.at AS at ORDER BY at`, { id }, { readOnly: true });
  [inv.decision] = await cypher(tenant, `
    MATCH (:Investigation {id: $id})-[:CONCLUDED]->(d:Decision)
    OPTIONAL MATCH (d)-[:ROOT_CAUSE]->(root)
    OPTIONAL MATCH (d)-[:SUSPECTS]->(dep)
    OPTIONAL MATCH (d)-[:USES]->(rb)
    OPTIONAL MATCH (d)-[:PAGES]->(p)
    OPTIONAL MATCH (d)-[:BASED_ON]->(f)
    RETURN d.id AS id, d.title AS title, d.action AS action, d.rationale AS rationale, d.severity AS severity,
           d.verdict AS verdict, d.coverage AS coverage, d.proof AS proof, d.outcome AS outcome,
           root.name AS root_cause, dep.id AS suspect_deploy, rb.id AS runbook,
           collect(DISTINCT p.name) AS paged, collect(DISTINCT f.id) AS based_on`, { id }, { readOnly: true });
  inv.turns = await getTurns(tenant, id, 50);
  return inv;
}

// The "why" trail: from the decision through findings to the evidence nodes,
// returned as a subgraph for the UI to draw.
export async function decisionTrace(tenant, id) {
  return cypher(tenant, `
    MATCH (inv:Investigation {id: $id})-[:CONCLUDED]->(d:Decision)
    OPTIONAL MATCH (d)-[:BASED_ON]->(f:Finding)
    OPTIONAL MATCH (f)-[:EVIDENCE]->(e)
    OPTIONAL MATCH (d)-[r]->(x) WHERE type(r) IN ['ROOT_CAUSE', 'SUSPECTS', 'USES', 'PAGES']
    RETURN d.id AS decision, collect(DISTINCT {finding: f.id, agent: f.agent, summary: f.summary,
           evidence: coalesce(e.name, e.id)}) AS chain,
           collect(DISTINCT {rel: type(r), target: coalesce(x.name, x.id)}) AS links`, { id }, { readOnly: true });
}

// Closing the loop: a resolved investigation becomes an Incident in episodic
// memory, and the runbook that worked gains procedural weight.
export async function resolveInvestigation(tenant, id, { resolution, resolver, outcome = 'worked' }) {
  const inv = await getInvestigation(tenant, id);
  if (!inv?.decision) throw new Error('investigation has no decision yet');
  if (outcome === 'failed') {
    // Procedural memory learns from failure too: the runbook loses rank and the
    // investigation reopens so the agents try the next-best option.
    await cypher(tenant, `
      MATCH (inv:Investigation {id: $id})-[:CONCLUDED]->(d:Decision)
      SET d.outcome = 'failed', inv.status = 'reopened'
      WITH d OPTIONAL MATCH (d)-[:USES]->(rb:Runbook)
      FOREACH (_ IN CASE WHEN rb IS NULL THEN [] ELSE [1] END | SET rb.failure_count = coalesce(rb.failure_count, 0) + 1)`, { id });
    await addTurn(tenant, id, 'system', `Fix did not work: ${resolution}`);
    return { outcome: 'failed', runbook_penalised: inv.decision.runbook || null };
  }
  const d = inv.decision;
  const incId = `INC-${3000 + Math.floor(Math.random() * 6000)}`;
  const resolvedBy = resolver || d.paged[0];
  await cypher(tenant, `
    MATCH (inv:Investigation {id: $inv})-[:CONCLUDED]->(d:Decision)
    CREATE (inc:Incident {id: $incId, title: d.title, severity: d.severity, status: 'resolved', at: $at,
                          summary: $resolution, trigger: coalesce($deploy, 'unknown'), source: 'graphops'})
    CREATE (inc)-[:FROM_INVESTIGATION]->(inv)
    SET inv.status = 'resolved', d.outcome = 'worked'
    WITH inc, d
    OPTIONAL MATCH (d)-[:ROOT_CAUSE]->(root:Service)
    FOREACH (_ IN CASE WHEN root IS NULL THEN [] ELSE [1] END | CREATE (inc)-[:ROOT_CAUSE]->(root))
    WITH DISTINCT inc, d
    OPTIONAL MATCH (d)-[:ABOUT]->(s:Service)
    FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | CREATE (inc)-[:AFFECTED]->(s))
    WITH DISTINCT inc, d
    OPTIONAL MATCH (d)-[:USES]->(rb:Runbook)
    FOREACH (_ IN CASE WHEN rb IS NULL THEN [] ELSE [1] END |
      CREATE (inc)-[:MITIGATED_WITH]->(rb) SET rb.success_count = rb.success_count + 1)
    WITH DISTINCT inc, d
    OPTIONAL MATCH (p:Person {name: $resolver})
    FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | CREATE (inc)-[:RESOLVED_BY]->(p))
    WITH DISTINCT inc, d
    OPTIONAL MATCH (d)-[:SUSPECTS]->(dep:Deploy)
    FOREACH (_ IN CASE WHEN dep IS NULL THEN [] ELSE [1] END | SET dep.rolled_back = true CREATE (inc)-[:TRIGGERED_BY]->(dep))`,
  { inv: id, incId, at: Date.now(), resolution, deploy: d.suspect_deploy, resolver: resolvedBy || '' });
  // Clear the alerts the incident covered.
  await cypher(tenant, `
    MATCH (a:Alert {status: 'firing'})-[:FIRED_ON]->(s:Service)
    SET a.status = 'resolved', s.status = 'healthy'`);
  await addTurn(tenant, id, 'system', `Resolved as ${incId}: ${resolution}`);
  return { incident: incId, resolved_by: resolvedBy };
}
