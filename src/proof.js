// Proof layer: the model proposes, the graph decides.
// - verifyRootCause: "no path, no claim". A root cause is accepted only if
//   algo.SPpaths finds a causal DEPENDS_ON path from the alerting services to it.
// - whatIf / containmentPlan: simulate failures and fixes on a GRAPH.COPY
//   sandbox, so the real graph is never touched.
// - checkCitations: every id an agent cites must exist in the graph.
import { cypher, graphFor, tenantGraphName, getDb } from './db.js';

const HOUR = 60 * 60 * 1000;

export async function verifyRootCause(tenant, { root_cause, suspect_deploy }) {
  const [root] = await cypher(tenant, `MATCH (s:Service {name: $n}) RETURN s.name AS name, s.status AS status`,
    { n: root_cause }, { readOnly: true });
  if (!root) return { verdict: 'REJECTED', reason: `${root_cause} is not a service in the graph`, paths: [] };

  const alerting = (await cypher(tenant, `
    MATCH (:Alert {status: 'firing'})-[:FIRED_ON]->(s:Service) RETURN collect(DISTINCT s.name) AS s`,
  {}, { readOnly: true }))[0].s.filter((s) => s !== root_cause);

  // One shortest causal path per alerting service, computed by FalkorDB.
  const resolved = await Promise.all(alerting.map(async (name) => {
    const rows = await cypher(tenant, `
      MATCH (a:Service {name: $a}), (r:Service {name: $root})
      CALL algo.SPpaths({sourceNode: a, targetNode: r, relTypes: ['DEPENDS_ON'], pathCount: 1, maxLen: 6})
      YIELD path RETURN [n IN nodes(path) | n.name] AS path`, { a: name, root: root_cause }, { readOnly: true });
    return { name, path: rows[0]?.path || null };
  }));

  const explained = resolved.filter((r) => r.path);
  const unexplained = resolved.filter((r) => !r.path).map((r) => r.name);
  const coverage = alerting.length ? explained.length / alerting.length : (root.status !== 'healthy' ? 1 : 0);

  let deploy = null;
  if (suspect_deploy) {
    const [d] = await cypher(tenant, `
      MATCH (d:Deploy {id: $id})-[:CHANGED]->(x:Service), (r:Service {name: $root})
      OPTIONAL MATCH (x)-[e1:DEPENDS_ON]->(r)
      OPTIONAL MATCH (r)-[e2:DEPENDS_ON]->(x)
      RETURN x.name AS service, d.at AS at, x = r OR e1 IS NOT NULL OR e2 IS NOT NULL AS adjacent`,
    { id: suspect_deploy, root: root_cause }, { readOnly: true });
    deploy = d
      ? { id: suspect_deploy, service: d.service, adjacent: d.adjacent, recent: Date.now() - d.at < 6 * HOUR }
      : { id: suspect_deploy, missing: true };
  }
  const deployOk = !deploy || (!deploy.missing && deploy.adjacent && deploy.recent);

  // Max-flow with unit capacities = edge-disjoint dependency paths from the
  // product entry points to the root cause, i.e. how many links you would have
  // to cut to isolate it (Menger's theorem).
  const [flow] = await cypher(tenant, `
    MATCH (e:Service) WHERE NOT ()-[:DEPENDS_ON]->(e) AND (e)-[:DEPENDS_ON*1..8]->(:Service {name: $root})
    WITH collect(e) AS entries
    MATCH (r:Service {name: $root})
    CALL algo.maxFlow({sourceNodes: entries, targetNodes: [r], relationshipTypes: ['DEPENDS_ON'], capacityProperty: 'capacity'})
    YIELD maxFlow
    RETURN maxFlow, size(entries) AS entry_points`, { root: root_cause }, { readOnly: true }).catch(() => [null]);

  // Direct evidence: how many of the node's immediate callers are failing?
  const [callers] = await cypher(tenant, `
    MATCH (c:Service)-[:DEPENDS_ON]->(:Service {name: $root})
    OPTIONAL MATCH (c)<-[:FIRED_ON]-(a:Alert {status: 'firing'})
    RETURN count(DISTINCT c) AS total, count(DISTINCT CASE WHEN a IS NULL THEN NULL ELSE c END) AS failing`,
  { root: root_cause }, { readOnly: true });
  const rootFailing = root.status !== 'healthy';
  // Explain every alerting service. With 4+ alerts we tolerate one unexplained
  // alert, but only if it looks like noise: none of its own callers are failing.
  let tolerated = unexplained.length === 0;
  if (!tolerated && unexplained.length === 1 && alerting.length >= 4) {
    const [u] = await cypher(tenant, `
      MATCH (c:Service)-[:DEPENDS_ON]->(:Service {name: $u})
      MATCH (c)<-[:FIRED_ON]-(:Alert {status: 'firing'})
      RETURN count(DISTINCT c) AS failingCallers`, { u: unexplained[0] }, { readOnly: true });
    tolerated = u.failingCallers === 0;
  }
  let verdict = 'VERIFIED';
  if (!tolerated || !deployOk) verdict = 'WEAK';
  // A silent node also needs a failing direct caller; otherwise any shared
  // downstream hub (a queue everything writes to) would look like the cause.
  if (!rootFailing && callers.failing === 0) verdict = 'WEAK';
  if (coverage === 0 && alerting.length) verdict = 'REJECTED';
  return {
    verdict,
    root_cause,
    coverage: Math.round(coverage * 100) / 100,
    explained: explained.map((r) => ({ alerting: r.name, path: r.path })),
    unexplained,
    deploy,
    failing_callers: `${callers.failing}/${callers.total}`,
    isolation_min_cut: flow?.maxFlow ?? null,
    entry_points: flow?.entry_points ?? null,
    reason: verdict === 'VERIFIED'
      ? `${explained.length}/${alerting.length} alerting services have a causal DEPENDS_ON path to ${root_cause}`
      : verdict === 'WEAK'
        ? `${explained.length}/${alerting.length} alerting services reach ${root_cause}${!tolerated ? ' (too many unexplained)' : ''}${!rootFailing && callers.failing === 0 ? '; it is healthy and none of its direct callers are failing' : ''}${deployOk ? '' : '; the suspect deploy is not adjacent or not recent'}`
        : `no alerting service has a causal path to ${root_cause}`,
  };
}

// Run fn against a throwaway copy of the tenant graph.
export async function withSandbox(tenant, fn) {
  const sandbox = `${tenant}_sim_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const graph = await graphFor(tenant);
  await graph.copy(tenantGraphName(sandbox));
  try {
    return await fn(sandbox);
  } finally {
    const db = await getDb();
    await db.selectGraph(tenantGraphName(sandbox)).delete().catch(() => {});
  }
}

// Failure propagates up DEPENDS_ON. A cut link (a fallback mode switched on)
// stops propagation through that edge.
async function impact(t, down, cut = []) {
  const cutKeys = cut.map(([a, b]) => `${a}->${b}`);
  const reach = `
    OPTIONAL MATCH p = (s)-[:DEPENDS_ON*0..8]->(d:Service) WHERE d.name IN $down
      AND none(r IN relationships(p) WHERE (startNode(r).name + '->' + endNode(r).name) IN $cut)`;
  const caps = await cypher(t, `
    MATCH (cap:Capability)<-[:POWERS]-(s:Service) ${reach}
    WITH cap, count(p) AS hits
    RETURN cap.name AS capability, cap.revenue_per_min AS revenue_per_min, hits > 0 AS impacted
    ORDER BY revenue_per_min DESC`, { down, cut: cutKeys }, { readOnly: true });
  const services = await cypher(t, `
    MATCH (s:Service) ${reach}
    WITH s, count(p) AS hits WHERE hits > 0
    RETURN collect(s.name) AS impacted`, { down, cut: cutKeys }, { readOnly: true });
  const hit = caps.filter((c) => c.impacted);
  return {
    impacted_services: services[0]?.impacted || [],
    impacted_capabilities: hit.map((c) => c.capability),
    revenue_at_risk_per_min: hit.reduce((s, c) => s + c.revenue_per_min, 0),
  };
}

// "What breaks if X goes down?", optionally after cutting dependency links
// (circuit breakers / fallback modes). Runs on a GRAPH.COPY sandbox.
export async function whatIf(tenant, { down = [], cut = [] }) {
  return withSandbox(tenant, async (sim) => {
    const before = await impact(sim, down);
    for (const [from, to] of cut) {
      await cypher(sim, `MATCH (:Service {name: $from})-[r:DEPENDS_ON]->(:Service {name: $to}) DELETE r`, { from, to });
    }
    const after = cut.length ? await impact(sim, down) : before;
    return {
      sandbox: 'GRAPH.COPY (deleted after the run)',
      down, cut,
      before, after,
      revenue_protected_per_min: before.revenue_at_risk_per_min - after.revenue_at_risk_per_min,
    };
  });
}

function* subsets(items, maxSize) {
  for (let k = 1; k <= Math.min(maxSize, items.length); k++) {
    const idx = [...Array(k).keys()];
    for (;;) {
      yield idx.map((i) => items[i]);
      let i = k - 1;
      while (i >= 0 && idx[i] === items.length - k + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
  }
}

// While the root cause is down, find the smallest set of fallback modes
// (optional dependency links) that protects the most revenue. Candidate sets are
// scored inside a GRAPH.COPY sandbox, then the winner is replayed for real in the
// sandbox (edges deleted, impact recomputed) to prove it.
export async function containmentPlan(tenant, { root_cause }) {
  return withSandbox(tenant, async (sim) => {
    const optional = await cypher(sim, `
      MATCH (a:Service)-[r:DEPENDS_ON {optional: true}]->(b:Service)
      WHERE (b)-[:DEPENDS_ON*0..6]->(:Service {name: $root})
      RETURN a.name AS from, b.name AS to, r.fallback AS fallback`, { root: root_cause }, { readOnly: true });
    const baseline = await impact(sim, [root_cause]);
    let best = { cut: [], protected: 0, after: baseline };
    let tried = 0;
    for (const set of subsets(optional, 3)) {
      tried++;
      const after = await impact(sim, [root_cause], set.map((o) => [o.from, o.to]));
      const protectedRev = baseline.revenue_at_risk_per_min - after.revenue_at_risk_per_min;
      if (protectedRev > best.protected) best = { cut: set, protected: protectedRev, after };
    }
    // Replay the winning plan for real inside the sandbox.
    for (const o of best.cut) {
      await cypher(sim, `MATCH (:Service {name: $a})-[r:DEPENDS_ON]->(:Service {name: $b}) DELETE r`, { a: o.from, b: o.to });
    }
    const replay = best.cut.length ? await impact(sim, [root_cause]) : baseline;
    const saved = baseline.impacted_capabilities.filter((c) => !replay.impacted_capabilities.includes(c));
    return {
      root_cause,
      sandbox: 'GRAPH.COPY (deleted after the run)',
      fallback_links_considered: optional.map((o) => `${o.from}->${o.to}`),
      combinations_simulated: tried,
      baseline: { capabilities: baseline.impacted_capabilities, revenue_at_risk_per_min: baseline.revenue_at_risk_per_min },
      plan: best.cut.map((o) => ({ switch_on: o.fallback, link: `${o.from}->${o.to}` })),
      protects: saved,
      revenue_protected_per_min: baseline.revenue_at_risk_per_min - replay.revenue_at_risk_per_min,
      still_down: replay.impacted_capabilities,
      verified_by_replay: replay.revenue_at_risk_per_min === baseline.revenue_at_risk_per_min - best.protected,
      note: replay.impacted_capabilities.length
        ? `${replay.impacted_capabilities.join(', ')} have no fallback path around ${root_cause}; only fixing the root cause restores them.`
        : `all capabilities can be kept up while ${root_cause} is fixed.`,
    };
  });
}

// Every id or service an answer cites must exist in the graph.
const ID_RE = /\b(?:INC|DEP|RB|ADR|ALR|DEC|DOC)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
export async function checkCitations(tenant, text) {
  const ids = [...new Set(String(text || '').match(ID_RE) || [])];
  const ticks = [...new Set([...String(text || '').matchAll(/`([a-z][a-z0-9-]{2,})`/g)].map((m) => m[1]))];
  const names = ticks.filter((t) => t.includes('-'));
  if (!ids.length && !names.length) return { checked: 0, verified: 0, unknown: [] };
  const [row] = await cypher(tenant, `
    OPTIONAL MATCH (n) WHERE n.id IN $ids OR n.name IN $names
    RETURN collect(DISTINCT coalesce(n.id, n.name)) AS found`, { ids, names }, { readOnly: true });
  const found = new Set(row.found);
  const all = [...ids, ...names];
  const unknown = all.filter((x) => !found.has(x));
  return { checked: all.length, verified: all.length - unknown.length, unknown };
}
