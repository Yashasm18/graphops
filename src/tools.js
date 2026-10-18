// Graph tools the agents call. Each tool is a small, named Cypher operation
// so the agent picks *which* traversal to run and every step stays traceable.
import { cypher } from './db.js';

const HOUR = 60 * 60 * 1000;
const hops = (n, def = 4) => Math.max(1, Math.min(6, Number.isInteger(n) ? n : def));
const str = { type: 'string' };

export const TOOLS = {
  // ---------- Triage: acting on connected data ----------
  get_active_alerts: {
    description: 'List all currently firing alerts with the service, owning team and age.',
    parameters: { type: 'object', properties: {} },
    async run(t) {
      const rows = await cypher(t, `
        MATCH (a:Alert {status: 'firing'})-[:FIRED_ON]->(s:Service)-[:OWNED_BY]->(team:Team)
        RETURN a.id AS id, a.name AS alert, a.severity AS severity, s.name AS service,
               s.kind AS kind, team.name AS team, a.at AS at
        ORDER BY a.at ASC`, {}, { readOnly: true });
      return rows.map((r) => ({ ...r, minutes_ago: Math.round((Date.now() - r.at) / 60000), at: undefined }));
    },
  },

  probable_root_cause: {
    description: 'Rank candidate root causes for the current alerts. It walks DEPENDS_ON paths from every alerting service and scores the nodes that explain the most alerts. It boosts candidates that alert themselves, sit deepest in the chain, or had a recent deploy on them or a direct dependent.',
    parameters: { type: 'object', properties: { window_minutes: { type: 'integer', description: 'Deploy look-back window. Default 180.' } } },
    async run(t, { window_minutes = 180 } = {}) {
      const since = Date.now() - window_minutes * 60000;
      const rows = await cypher(t, `
        MATCH (al:Alert {status: 'firing'})-[:FIRED_ON]->(a:Service)
        WITH collect(DISTINCT a) AS alerting
        UNWIND alerting AS a
        MATCH p = (a)-[:DEPENDS_ON*0..5]->(c:Service)
        WITH c, alerting, collect(DISTINCT a.name) AS explains, max(length(p)) AS depth
        OPTIONAL MATCH (c)<-[:FIRED_ON]-(own:Alert {status: 'firing'})
        WITH c, alerting, explains, depth, count(own) AS own_alerts
        OPTIONAL MATCH (c)-[:DEPENDS_ON]->(down:Service)<-[:FIRED_ON]-(:Alert {status: 'firing'})
        WITH c, alerting, explains, depth, own_alerts, count(DISTINCT down) AS alerting_deps
        OPTIONAL MATCH (d:Deploy)-[:CHANGED]->(x:Service)
        WHERE d.at > $since AND (x = c OR (x)-[:DEPENDS_ON]->(c))
        RETURN c.name AS candidate, c.kind AS kind, size(alerting) AS total_alerting,
               explains, depth, own_alerts, alerting_deps,
               collect(DISTINCT {deploy: d.id, service: x.name, summary: d.summary}) AS nearby_deploys`,
      { since }, { readOnly: true });
      const scored = rows.map((r) => {
        const deploys = r.nearby_deploys.filter((d) => d.deploy);
        const coverage = r.explains.length / r.total_alerting;
        const score = coverage * 5 + (r.own_alerts > 0 ? 2 : 0) + (r.own_alerts > 0 && r.alerting_deps === 0 ? 2 : 0)
          + (deploys.length ? 2 : 0) + r.depth * 0.2;
        return {
          candidate: r.candidate, kind: r.kind, score: Math.round(score * 100) / 100,
          explains_alerts_on: r.explains, is_alerting: r.own_alerts > 0,
          deepest_alerting_node: r.own_alerts > 0 && r.alerting_deps === 0, recent_deploys_nearby: deploys,
        };
      }).filter((r) => r.explains_alerts_on.length > 1 || r.is_alerting);
      return scored.sort((a, b) => b.score - a.score).slice(0, 5);
    },
  },

  blast_radius: {
    description: 'Find everything that transitively depends on a service: upstream services, the business capabilities they power, the revenue at risk per minute, and the teams affected.',
    parameters: { type: 'object', properties: { service: str, max_hops: { type: 'integer' } }, required: ['service'] },
    async run(t, { service, max_hops }) {
      const k = hops(max_hops);
      const upstream = await cypher(t, `
        MATCH p = (up:Service)-[:DEPENDS_ON*1..${k}]->(s:Service {name: $service})
        WITH up, min(length(p)) AS hops
        MATCH (up)-[:OWNED_BY]->(team:Team)
        RETURN up.name AS service, up.tier AS tier, hops, team.name AS team ORDER BY hops, tier`,
      { service }, { readOnly: true });
      const caps = await cypher(t, `
        MATCH (s:Service {name: $service})<-[:DEPENDS_ON*0..${k}]-(x:Service)-[:POWERS]->(c:Capability)
        RETURN c.name AS capability, c.revenue_per_min AS revenue_per_min, collect(DISTINCT x.name) AS via
        ORDER BY revenue_per_min DESC`, { service }, { readOnly: true });
      return {
        service,
        upstream_services: upstream,
        capabilities_at_risk: caps,
        revenue_at_risk_per_min: caps.reduce((s, c) => s + c.revenue_per_min, 0),
        teams_affected: [...new Set(upstream.map((u) => u.team))],
      };
    },
  },

  dependencies: {
    description: 'List what a service depends on, transitively, with each dependency\'s current health status.',
    parameters: { type: 'object', properties: { service: str, max_hops: { type: 'integer' } }, required: ['service'] },
    async run(t, { service, max_hops }) {
      return cypher(t, `
        MATCH p = (s:Service {name: $service})-[:DEPENDS_ON*1..${hops(max_hops, 3)}]->(d:Service)
        RETURN d.name AS dependency, d.kind AS kind, d.status AS status, min(length(p)) AS hops
        ORDER BY hops`, { service }, { readOnly: true });
    },
  },

  dependency_path: {
    description: 'Return the shortest DEPENDS_ON path from one service to another. Use it to explain how a failure propagates.',
    parameters: { type: 'object', properties: { from: str, to: str }, required: ['from', 'to'] },
    async run(t, { from, to }) {
      const rows = await cypher(t, `
        MATCH (a:Service {name: $from}), (b:Service {name: $to})
        WITH a, b
        RETURN [n IN nodes(shortestPath((a)-[:DEPENDS_ON*1..10]->(b))) | n.name] AS path`, { from, to }, { readOnly: true });
      return rows[0]?.path?.length ? rows[0] : { path: null, note: `${to} is not reachable from ${from}` };
    },
  },

  recent_changes: {
    description: 'List recent deploys. You can scope them to a service and its direct neighbours, either side of the dependency.',
    parameters: { type: 'object', properties: { service: str, window_minutes: { type: 'integer' } } },
    async run(t, { service, window_minutes = 180 } = {}) {
      const since = Date.now() - window_minutes * 60000;
      const rows = await cypher(t, `
        MATCH (d:Deploy)-[:CHANGED]->(s:Service), (d)-[:AUTHORED_BY]->(p:Person)
        WHERE d.at > $since AND ($service IS NULL OR s.name = $service
              OR (s)-[:DEPENDS_ON]-(:Service {name: $service}))
        RETURN d.id AS deploy, s.name AS service, d.version AS version, d.summary AS summary,
               d.risk AS risk, p.name AS author, d.at AS at
        ORDER BY d.at DESC`, { since, service: service || null }, { readOnly: true });
      return rows.map((r) => ({ ...r, minutes_ago: Math.round((Date.now() - r.at) / 60000), at: undefined }));
    },
  },

  critical_nodes: {
    description: 'Run PageRank and betweenness centrality over the dependency graph to find the most load-bearing services: single points of failure and chokepoints.',
    parameters: { type: 'object', properties: {} },
    async run(t) {
      const pr = await cypher(t, `
        CALL algo.pageRank('Service', 'DEPENDS_ON') YIELD node, score
        RETURN node.name AS service, score ORDER BY score DESC LIMIT 8`, {}, { readOnly: true });
      const bc = await cypher(t, `
        CALL algo.betweenness({nodeLabels: ['Service'], relationshipTypes: ['DEPENDS_ON'], samplingSize: 64, samplingSeed: 7})
        YIELD node, score
        RETURN node.name AS service, score ORDER BY score DESC LIMIT 8`, {}, { readOnly: true });
      const r3 = (x) => Math.round(x * 1000) / 1000;
      return {
        pagerank: pr.map((r) => ({ service: r.service, score: r3(r.score) })),
        betweenness: bc.map((r) => ({ service: r.service, score: r3(r.score) })),
      };
    },
  },

  service_clusters: {
    description: 'Detect communities of tightly coupled services with label propagation. A failure tends to stay inside its cluster.',
    parameters: { type: 'object', properties: {} },
    async run(t) {
      return cypher(t, `
        CALL algo.labelPropagation({nodeLabels: ['Service'], relationshipTypes: ['DEPENDS_ON']})
        YIELD node, communityId
        RETURN communityId AS cluster, collect(node.name) AS services, count(*) AS size
        ORDER BY size DESC`, {}, { readOnly: true });
    },
  },

  // ---------- Historian: episodic / semantic / procedural memory ----------
  similar_incidents: {
    description: 'Search episodic memory for past incidents that touched any of the given services. Returns root cause, the fix, who resolved it and the runbook used. This includes incidents learned in earlier GraphOps sessions.',
    parameters: { type: 'object', properties: { services: { type: 'array', items: str } }, required: ['services'] },
    async run(t, { services }) {
      return cypher(t, `
        MATCH (i:Incident)-[:AFFECTED|ROOT_CAUSE]->(s:Service) WHERE s.name IN $services
        WITH i, collect(DISTINCT s.name) AS overlap
        MATCH (i)-[:ROOT_CAUSE]->(root:Service)
        OPTIONAL MATCH (i)-[:RESOLVED_BY]->(p:Person)
        OPTIONAL MATCH (i)-[:MITIGATED_WITH]->(rb:Runbook)
        RETURN i.id AS incident, i.title AS title, i.severity AS severity, i.summary AS summary,
               i.trigger AS trigger, i.source AS learned_from, root.name AS root_cause,
               overlap, p.name AS resolved_by, rb.id AS runbook,
               size(overlap) + CASE WHEN root.name IN $services THEN 2 ELSE 0 END AS similarity
        ORDER BY similarity DESC, i.at DESC LIMIT 5`, { services }, { readOnly: true });
    },
  },

  runbooks_for: {
    description: 'Procedural memory: runbooks for a service or anything within two hops of it, ranked by how often each one has fixed an incident.',
    parameters: { type: 'object', properties: { service: str }, required: ['service'] },
    async run(t, { service }) {
      return cypher(t, `
        MATCH p = (s:Service {name: $service})-[:DEPENDS_ON*0..2]-(x:Service)<-[:FOR]-(rb:Runbook)
        WITH rb, x, min(length(p)) AS distance
        RETURN rb.id AS runbook, rb.title AS title, x.name AS for_service, distance,
               rb.steps AS steps, rb.success_count AS times_it_worked
        ORDER BY distance, times_it_worked DESC LIMIT 5`, { service }, { readOnly: true });
    },
  },

  decisions_and_docs: {
    description: 'Company knowledge about a service: architecture decisions (with who made them and why, and the incident that motivated them), documents, and facts learned in earlier sessions.',
    parameters: { type: 'object', properties: { service: str }, required: ['service'] },
    async run(t, { service }) {
      const decisions = await cypher(t, `
        MATCH (d:Decision)-[:ABOUT]->(:Service {name: $service})
        OPTIONAL MATCH (d)-[:MADE_BY]->(p:Person)
        OPTIONAL MATCH (d)-[:MOTIVATED_BY]->(i:Incident)
        RETURN d.id AS id, d.title AS title, d.rationale AS rationale, d.source AS source,
               p.name AS made_by, i.id AS motivated_by ORDER BY d.at DESC LIMIT 6`, { service }, { readOnly: true });
      const docs = await cypher(t, `
        MATCH (doc:Document)-[:DOCUMENTS]->(:Service {name: $service})
        OPTIONAL MATCH (doc)-[:WRITTEN_BY]->(p:Person)
        RETURN doc.title AS title, doc.url AS url, p.name AS author`, { service }, { readOnly: true });
      const facts = await cypher(t, `
        MATCH (f:Fact)-[:ABOUT]->(:Service {name: $service})
        RETURN f.text AS fact, f.learned_from AS learned_from ORDER BY f.at DESC LIMIT 10`, { service }, { readOnly: true });
      return { decisions, docs, facts };
    },
  },

  // ---------- Commander / company brain: people ----------
  who_to_page: {
    description: 'Rank people to page for a service. It combines the on-call engineer of the owning team, people who resolved past incidents on it, recent deploy authors, and people who have worked on it. Every person comes with reasons.',
    parameters: { type: 'object', properties: { service: str }, required: ['service'] },
    async run(t, { service }) {
      const since = Date.now() - 6 * HOUR;
      const rows = await cypher(t, `
        MATCH (s:Service {name: $service})
        OPTIONAL MATCH (s)-[:OWNED_BY]->(:Team)<-[:ON_CALL_FOR]-(oc:Person)
        WITH s, collect(DISTINCT {p: oc.name, why: 'on call for owning team', w: 3}) AS a
        OPTIONAL MATCH (s)<-[:ROOT_CAUSE|AFFECTED]-(i:Incident)-[:RESOLVED_BY]->(r:Person)
        WITH s, a, collect(DISTINCT {p: r.name, why: 'resolved ' + i.id, w: 2}) AS b
        OPTIONAL MATCH (s)-[:DEPENDS_ON*0..1]-(x:Service)<-[:CHANGED]-(d:Deploy)-[:AUTHORED_BY]->(au:Person)
        WHERE d.at > $since
        WITH s, a, b, collect(DISTINCT {p: au.name, why: 'authored ' + d.id + ' on ' + x.name, w: 2}) AS c
        OPTIONAL MATCH (e:Person)-[:WORKED_ON]->(s)
        WITH a, b, c, collect(DISTINCT {p: e.name, why: 'has worked on ' + s.name, w: 1}) AS e
        UNWIND a + b + c + e AS row
        WITH row WHERE row.p IS NOT NULL
        MATCH (person:Person {name: row.p})-[:MEMBER_OF]->(team:Team)
        RETURN person.name AS person, person.handle AS handle, person.role AS role, team.name AS team,
               sum(row.w) AS score, collect(row.why) AS reasons
        ORDER BY score DESC LIMIT 5`, { service, since }, { readOnly: true });
      return rows;
    },
  },

  who_knows: {
    description: 'Find the people who know most about a system: those who worked on it, resolved incidents on it, wrote its docs or made decisions about it.',
    parameters: { type: 'object', properties: { system: str }, required: ['system'] },
    async run(t, { system }) {
      return cypher(t, `
        MATCH (s:Service {name: $system})
        MATCH (p:Person)-[r:WORKED_ON|RESOLVED_BY|WRITTEN_BY|MADE_BY]-(x)
        WHERE x = s OR (x)-[:AFFECTED|ROOT_CAUSE|DOCUMENTS|ABOUT]->(s)
        WITH p, collect(DISTINCT type(r)) AS evidence, count(DISTINCT x) AS weight
        MATCH (p)-[:MEMBER_OF]->(team:Team)
        RETURN p.name AS person, p.role AS role, team.name AS team, evidence, weight
        ORDER BY weight DESC LIMIT 6`, { system }, { readOnly: true });
    },
  },

  owner_of: {
    description: 'Return the owning team of a service, its members, and who is on call now.',
    parameters: { type: 'object', properties: { service: str }, required: ['service'] },
    async run(t, { service }) {
      const rows = await cypher(t, `
        MATCH (s:Service {name: $service})-[:OWNED_BY]->(team:Team)
        OPTIONAL MATCH (m:Person)-[:MEMBER_OF]->(team)
        OPTIONAL MATCH (oc:Person)-[:ON_CALL_FOR]->(team)
        RETURN s.name AS service, s.kind AS kind, s.tier AS tier, s.status AS status, team.name AS team,
               collect(DISTINCT m.name) AS members, collect(DISTINCT oc.name) AS on_call`, { service }, { readOnly: true });
      return rows[0] || { error: `no service named ${service}` };
    },
  },

  run_cypher: {
    description: 'Run a read-only Cypher query for questions no other tool answers. Labels: Service, Team, Person, Capability, Deploy, Alert, Incident, Runbook, Decision, Document, Fact, Investigation, Finding, User, Turn. Relationships: DEPENDS_ON, OWNED_BY, MEMBER_OF, ON_CALL_FOR, POWERS, CHANGED, AUTHORED_BY, FIRED_ON, FOR, AFFECTED, ROOT_CAUSE, RESOLVED_BY, MITIGATED_WITH, MADE_BY, ABOUT, MOTIVATED_BY, WRITTEN_BY, DOCUMENTS, WORKED_ON.',
    parameters: { type: 'object', properties: { query: str }, required: ['query'] },
    async run(t, { query }) {
      if (/\b(CREATE|MERGE|DELETE|SET|REMOVE|DROP|CALL\s+db\.)/i.test(query)) {
        return { error: 'only read-only queries are allowed' };
      }
      const q = /\bLIMIT\b/i.test(query) ? query : `${query} LIMIT 50`;
      return cypher(t, q, {}, { readOnly: true });
    },
  },

  // ---------- Shared state between agents ----------
  read_investigation: {
    description: 'Read the shared investigation state: the question, and every finding and decision recorded so far by any agent. Read it before you act on what another agent found.',
    parameters: { type: 'object', properties: {} },
    async run(t, _args, ctx) {
      const [inv] = await cypher(t, `
        MATCH (inv:Investigation {id: $id})
        OPTIONAL MATCH (inv)-[:HAS_FINDING]->(f:Finding)
        WITH inv, f ORDER BY f.at
        RETURN inv.question AS question, inv.status AS status,
               collect(CASE WHEN f IS NULL THEN NULL ELSE {id: f.id, agent: f.agent, kind: f.kind,
                 summary: f.summary, confidence: f.confidence} END) AS findings`,
      { id: ctx.investigationId }, { readOnly: true });
      return inv;
    },
  },

  record_finding: {
    description: 'Write a finding to the shared investigation graph so other agents can build on it. Link it to the graph nodes it is based on (service names, deploy ids, incident ids, runbook ids, person names).',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['root_cause', 'blast_radius', 'suspect_change', 'precedent', 'runbook', 'knowledge', 'people', 'other'] },
        summary: str,
        confidence: { type: 'number', description: 'Between 0 and 1.' },
        evidence: { type: 'array', items: str, description: 'Names or ids of the graph nodes that support this finding.' },
      },
      required: ['kind', 'summary', 'evidence'],
    },
    async run(t, { kind, summary, confidence = 0.7, evidence = [] }, ctx) {
      const id = `F-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const [r] = await cypher(t, `
        MATCH (inv:Investigation {id: $inv})
        CREATE (inv)-[:HAS_FINDING]->(f:Finding {id: $id, agent: $agent, kind: $kind, summary: $summary,
                                                 confidence: $confidence, at: $at})
        WITH f
        OPTIONAL MATCH (n) WHERE (n:Service OR n:Deploy OR n:Incident OR n:Runbook OR n:Person OR n:Capability
                                  OR n:Decision OR n:Document OR n:Alert)
                             AND (n.name IN $evidence OR n.id IN $evidence)
        FOREACH (_ IN CASE WHEN n IS NULL THEN [] ELSE [1] END | CREATE (f)-[:EVIDENCE]->(n))
        RETURN f.id AS id, count(n) AS linked`,
      { inv: ctx.investigationId, id, agent: ctx.agent, kind, summary, confidence, evidence, at: Date.now() });
      ctx.emit?.({ type: 'finding', agent: ctx.agent, id, kind, summary, confidence, evidence });
      return { recorded: r.id, linked_evidence_nodes: r.linked };
    },
  },

  record_decision: {
    description: 'Commander only. Record the incident decision in the graph: suspected root cause, suspect deploy, mitigation, runbook and people to page. The decision is linked to every finding it is based on, so it can be traced later.',
    parameters: {
      type: 'object',
      properties: {
        title: str,
        root_cause: { type: 'string', description: 'Service name.' },
        suspect_deploy: { type: 'string', description: 'Deploy id, or empty.' },
        action: { type: 'string', description: 'Concrete mitigation steps.' },
        rationale: str,
        runbook: { type: 'string', description: 'Runbook id, or empty.' },
        page: { type: 'array', items: str, description: 'Full names of the people to page, as returned by who_to_page (for example "Diego Alvarez").' },
        affected: { type: 'array', items: str, description: 'Affected service names.' },
        severity: { type: 'string', enum: ['SEV1', 'SEV2', 'SEV3'] },
      },
      required: ['title', 'root_cause', 'action', 'rationale', 'page', 'severity'],
    },
    async run(t, a, ctx) {
      const id = `DEC-${Date.now().toString(36).toUpperCase()}`;
      await cypher(t, `
        MATCH (inv:Investigation {id: $inv})
        CREATE (inv)-[:CONCLUDED]->(d:Decision {id: $id, title: $title, action: $action, rationale: $rationale,
                 severity: $severity, at: $at, source: 'agent', agent: $agent})
        WITH inv, d
        OPTIONAL MATCH (inv)-[:HAS_FINDING]->(f:Finding)
        FOREACH (_ IN CASE WHEN f IS NULL THEN [] ELSE [1] END | CREATE (d)-[:BASED_ON]->(f))
        WITH DISTINCT d
        OPTIONAL MATCH (root:Service {name: $root}) FOREACH (_ IN CASE WHEN root IS NULL THEN [] ELSE [1] END | CREATE (d)-[:ROOT_CAUSE]->(root))
        WITH DISTINCT d
        OPTIONAL MATCH (dep:Deploy {id: $deploy}) FOREACH (_ IN CASE WHEN dep IS NULL THEN [] ELSE [1] END | CREATE (d)-[:SUSPECTS]->(dep))
        WITH DISTINCT d
        OPTIONAL MATCH (rb:Runbook {id: $runbook}) FOREACH (_ IN CASE WHEN rb IS NULL THEN [] ELSE [1] END | CREATE (d)-[:USES]->(rb))
        WITH DISTINCT d
        OPTIONAL MATCH (p:Person) WHERE p.name IN $page OR p.handle IN $page OR ('@' + p.handle) IN $page FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | CREATE (d)-[:PAGES]->(p))
        WITH DISTINCT d
        OPTIONAL MATCH (s:Service) WHERE s.name IN $affected FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | CREATE (d)-[:ABOUT]->(s))`,
      { inv: ctx.investigationId, id, title: a.title, action: a.action, rationale: a.rationale, severity: a.severity,
        at: Date.now(), agent: ctx.agent, root: a.root_cause, deploy: a.suspect_deploy || '', runbook: a.runbook || '',
        page: a.page || [], affected: a.affected || [] });
      await cypher(t, `MATCH (inv:Investigation {id: $inv}) SET inv.status = 'decided', inv.decision = $id`,
        { inv: ctx.investigationId, id });
      ctx.emit?.({ type: 'decision', agent: ctx.agent, id, ...a });
      return { recorded: id };
    },
  },

  remember_fact: {
    description: 'Semantic memory: store a durable fact about a service that the user taught you, or that you confirmed, so future sessions know it.',
    parameters: { type: 'object', properties: { service: str, fact: str }, required: ['service', 'fact'] },
    async run(t, { service, fact }, ctx) {
      const rows = await cypher(t, `
        MATCH (s:Service {name: $service})
        MERGE (f:Fact {text: $fact})
        ON CREATE SET f.at = $at, f.learned_from = $inv
        MERGE (f)-[:ABOUT]->(s)
        RETURN f.text AS fact`, { service, fact, at: Date.now(), inv: ctx.investigationId || 'chat' });
      ctx.emit?.({ type: 'memory', agent: ctx.agent, service, fact });
      return rows[0] ? { remembered: fact } : { error: `no service named ${service}` };
    },
  },
};

export const AGENT_TOOLSETS = {
  triage: ['get_active_alerts', 'probable_root_cause', 'blast_radius', 'dependencies', 'dependency_path',
    'recent_changes', 'critical_nodes', 'service_clusters', 'read_investigation', 'record_finding'],
  historian: ['similar_incidents', 'runbooks_for', 'decisions_and_docs', 'who_knows', 'read_investigation', 'record_finding'],
  commander: ['read_investigation', 'who_to_page', 'owner_of', 'runbooks_for', 'blast_radius', 'record_decision'],
  chat: Object.keys(TOOLS).filter((n) => n !== 'record_decision'),
};

export async function runTool(tenant, name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { error: `unknown tool ${name}` };
  try {
    return await tool.run(tenant, args || {}, ctx);
  } catch (err) {
    return { error: String(err.message || err) };
  }
}
