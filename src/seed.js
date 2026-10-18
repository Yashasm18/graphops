// Seeds a tenant graph with a realistic platform: services and their
// dependencies, business capabilities, teams, people, deploys, alerts,
// past incidents, runbooks, docs and architecture decisions.
import { cypher, graphFor } from './db.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export const TENANTS = {
  acme: {
    label: 'Acme Shop (e-commerce)',
    teams: [
      ['Platform', 'Gateway, auth plumbing, shared infra'],
      ['Payments', 'Payment processing and fraud'],
      ['Commerce', 'Cart, checkout, orders, pricing'],
      ['Discovery', 'Catalog, search, recommendations'],
      ['Identity', 'Users and authentication'],
      ['Fulfillment', 'Inventory and shipping'],
      ['Data', 'Event streaming and analytics'],
    ],
    people: [
      // name, role, team, on call, slack handle
      ['Priya Raman', 'Staff SRE', 'Platform', true, '@priya'],
      ['Marcus Chen', 'Senior Engineer', 'Platform', false, '@marcus'],
      ['Elena Petrova', 'Engineering Manager', 'Payments', false, '@elena'],
      ['Diego Alvarez', 'Senior Engineer', 'Payments', true, '@diego'],
      ['Aisha Bello', 'Engineer', 'Payments', false, '@aisha'],
      ['Tom Becker', 'Senior Engineer', 'Commerce', true, '@tom'],
      ['Sofia Rossi', 'Engineer', 'Commerce', false, '@sofia'],
      ['Kenji Watanabe', 'Staff Engineer', 'Discovery', true, '@kenji'],
      ['Lena Fischer', 'Engineer', 'Discovery', false, '@lena'],
      ['Omar Haddad', 'Senior Engineer', 'Identity', true, '@omar'],
      ['Grace Kim', 'Engineer', 'Fulfillment', true, '@grace'],
      ['Ravi Shah', 'Data Engineer', 'Data', true, '@ravi'],
      ['Nina Volkova', 'DBA', 'Platform', false, '@nina'],
      ['Sam Okafor', 'Principal Engineer', 'Commerce', false, '@sam'],
    ],
    // name, kind, team, tier (1 = most critical)
    services: [
      ['web-frontend', 'service', 'Commerce', 1],
      ['mobile-bff', 'service', 'Commerce', 1],
      ['api-gateway', 'service', 'Platform', 1],
      ['auth-service', 'service', 'Identity', 1],
      ['user-service', 'service', 'Identity', 2],
      ['catalog-service', 'service', 'Discovery', 2],
      ['search-service', 'service', 'Discovery', 2],
      ['recommendations-service', 'service', 'Discovery', 3],
      ['cart-service', 'service', 'Commerce', 1],
      ['pricing-service', 'service', 'Commerce', 2],
      ['checkout-service', 'service', 'Commerce', 1],
      ['payments-service', 'service', 'Payments', 1],
      ['fraud-service', 'service', 'Payments', 2],
      ['orders-service', 'service', 'Commerce', 1],
      ['inventory-service', 'service', 'Fulfillment', 2],
      ['shipping-service', 'service', 'Fulfillment', 2],
      ['notifications-service', 'service', 'Platform', 3],
      ['analytics-pipeline', 'service', 'Data', 3],
      ['payments-db', 'database', 'Payments', 1],
      ['orders-db', 'database', 'Commerce', 1],
      ['users-db', 'database', 'Identity', 1],
      ['redis-cache', 'cache', 'Platform', 1],
      ['kafka-events', 'queue', 'Data', 1],
      ['elasticsearch', 'database', 'Discovery', 2],
      ['stripe-api', 'external', 'Payments', 1],
    ],
    deps: [
      ['web-frontend', 'api-gateway'], ['mobile-bff', 'api-gateway'],
      ['api-gateway', 'auth-service'], ['api-gateway', 'catalog-service'],
      ['api-gateway', 'search-service'], ['api-gateway', 'cart-service'],
      ['api-gateway', 'checkout-service'], ['api-gateway', 'recommendations-service', true, 'Hide recommendation widgets (ADR-031)'],
      ['auth-service', 'user-service'], ['auth-service', 'redis-cache'],
      ['user-service', 'users-db'],
      ['catalog-service', 'elasticsearch'], ['catalog-service', 'redis-cache'],
      ['search-service', 'elasticsearch'],
      ['recommendations-service', 'catalog-service', true, 'Serve the static popular-items list'], ['recommendations-service', 'kafka-events'],
      ['cart-service', 'redis-cache'], ['cart-service', 'pricing-service'], ['cart-service', 'inventory-service', true, 'Optimistic stock check, reconcile on fulfilment'],
      ['pricing-service', 'catalog-service'],
      ['checkout-service', 'cart-service'], ['checkout-service', 'payments-service'],
      ['checkout-service', 'orders-service'], ['checkout-service', 'pricing-service', true, 'Use prices locked when the item was added to the cart'],
      ['payments-service', 'payments-db'], ['payments-service', 'fraud-service', true, 'Fail open: rules-only fraud check for orders under $200'],
      ['payments-service', 'stripe-api'], ['payments-service', 'kafka-events', true, 'Buffer payment events in a local outbox'],
      ['fraud-service', 'payments-db', true, 'Score from cached risk profiles in redis-cache'], ['fraud-service', 'redis-cache'],
      ['orders-service', 'orders-db'], ['orders-service', 'kafka-events', true, 'Write to the outbox table and replay later'], ['orders-service', 'inventory-service'],
      ['inventory-service', 'orders-db'],
      ['shipping-service', 'orders-service'], ['shipping-service', 'kafka-events'],
      ['notifications-service', 'kafka-events'], ['notifications-service', 'user-service', true, 'Send emails from cached profiles'],
      ['analytics-pipeline', 'kafka-events'],
    ],
    // name, revenue per minute (USD), powered by
    capabilities: [
      ['Checkout & Payments', 4200, ['checkout-service', 'payments-service']],
      ['Login', 900, ['auth-service']],
      ['Product Search', 1500, ['search-service']],
      ['Browse Catalog', 1100, ['catalog-service']],
      ['Order Tracking', 300, ['orders-service', 'shipping-service']],
      ['Personalised Recommendations', 600, ['recommendations-service']],
      ['Customer Emails', 50, ['notifications-service']],
    ],
    // id, service, author, minutes ago, version, summary, risk
    deploys: [
      ['DEP-981', 'payments-service', 'Aisha Bello', 23, 'v2.14.0', 'Raise DB retry attempts 3 -> 10 and lower backoff to 50ms for payment capture', 'medium'],
      ['DEP-980', 'catalog-service', 'Lena Fischer', 95, 'v5.2.1', 'Cache TTL tuning for product pages', 'low'],
      ['DEP-979', 'web-frontend', 'Sofia Rossi', 140, 'v9.30.0', 'New promo banner on homepage', 'low'],
      ['DEP-978', 'auth-service', 'Omar Haddad', 60 * 26, 'v3.8.2', 'Rotate JWT signing keys', 'medium'],
      ['DEP-977', 'orders-service', 'Tom Becker', 60 * 50, 'v4.1.0', 'Add order-split for multi-warehouse', 'medium'],
    ],
    // id, service, name, severity, minutes ago
    alerts: [
      ['ALR-5001', 'checkout-service', 'HTTP 5xx rate 18% (threshold 2%)', 'critical', 12],
      ['ALR-5002', 'payments-service', 'p99 latency 9.4s (threshold 1.5s)', 'critical', 15],
      ['ALR-5003', 'payments-db', 'Active connections 498/500', 'critical', 18],
      ['ALR-5004', 'fraud-service', 'Timeouts calling payments-db', 'warning', 14],
      ['ALR-5005', 'mobile-bff', 'Elevated error rate on /orders', 'warning', 9],
    ],
    runbooks: [
      ['RB-PAY-01', 'Payments DB connection exhaustion', 'payments-db',
        '1. Check pg_stat_activity for idle-in-transaction. 2. Roll back any recent payments-service deploy that changed retries/pool size. 3. Temporarily raise pgbouncer pool to 600. 4. Restart payments-service pods one AZ at a time.', 3],
      ['RB-PAY-02', 'Stripe API degradation', 'stripe-api',
        '1. Check status.stripe.com. 2. Enable payment queueing mode (feature flag pay_queue). 3. Notify support.', 2],
      ['RB-CACHE-01', 'Redis cache saturation', 'redis-cache',
        '1. Check evictions and memory. 2. Fail over to replica. 3. Shed recommendations traffic.', 4],
      ['RB-GEN-01', 'Generic bad deploy rollback', 'api-gateway',
        '1. Identify last deploy in blast radius. 2. Roll back via deploy tool. 3. Confirm error rates recover within 10 min.', 6],
      ['RB-ES-01', 'Elasticsearch cluster red', 'elasticsearch',
        '1. Check unassigned shards. 2. Route search to cached results. 3. Page Discovery on-call.', 1],
    ],
    // id, title, severity, days ago, root cause service, affected, resolver, runbook, summary, triggered by (description)
    incidents: [
      ['INC-2041', 'Checkout failures from payments retry storm', 'SEV1', 41, 'payments-db',
        ['checkout-service', 'payments-service', 'fraud-service', 'payments-db'], 'Nina Volkova', 'RB-PAY-01',
        'A payments-service release increased retries without jitter. Retries multiplied connections and exhausted the payments-db pool. Fixed by rolling back and raising the pgbouncer pool.', 'payments-service retry config change'],
      ['INC-1987', 'Login outage after Redis failover', 'SEV1', 88, 'redis-cache',
        ['auth-service', 'cart-service', 'redis-cache'], 'Priya Raman', 'RB-CACHE-01',
        'Redis primary failed and clients did not reconnect, so auth and cart failed.', 'infra failure'],
      ['INC-2010', 'Card declines from Stripe partial outage', 'SEV2', 63, 'stripe-api',
        ['payments-service', 'checkout-service'], 'Diego Alvarez', 'RB-PAY-02',
        'Stripe returned intermittent 503s. Queueing mode was enabled.', 'third-party outage'],
      ['INC-2066', 'Search returning empty results', 'SEV2', 12, 'elasticsearch',
        ['search-service', 'catalog-service', 'elasticsearch'], 'Kenji Watanabe', 'RB-ES-01',
        'A shard rebalance left the index red for 40 minutes.', 'cluster maintenance'],
      ['INC-1950', 'Payments latency from slow fraud checks', 'SEV3', 120, 'fraud-service',
        ['payments-service', 'fraud-service'], 'Diego Alvarez', null,
        'A fraud model upgrade doubled scoring time. Fixed by rolling back the model.', 'fraud model release'],
    ],
    // id, title, made by, days ago, about, rationale
    decisions: [
      ['ADR-014', 'Use pgbouncer in front of payments-db', 'Nina Volkova', 200, ['payments-db', 'payments-service'],
        'Payments pods scale to 80 replicas and direct connections exceeded Postgres limits. A hard pool of 500 protects the primary.'],
      ['ADR-022', 'All DB clients must use exponential backoff with jitter', 'Elena Petrova', 40, ['payments-service', 'fraud-service', 'orders-service'],
        'This follows INC-2041. Linear retries with short backoff amplified a small blip into a full outage.'],
      ['ADR-009', 'Checkout calls payments synchronously', 'Sam Okafor', 400, ['checkout-service', 'payments-service'],
        'Customers need an immediate payment result. This was accepted knowing checkout availability is bound to payments.'],
      ['ADR-031', 'Recommendations may degrade gracefully', 'Kenji Watanabe', 30, ['recommendations-service'],
        'Recommendations are non-critical. The gateway uses a 300ms timeout and shows empty widgets.'],
    ],
    docs: [
      ['DOC-1', 'Payments architecture overview', 'https://wiki.acme.dev/payments/arch', 'Elena Petrova', ['payments-service', 'payments-db', 'fraud-service', 'stripe-api']],
      ['DOC-2', 'INC-2041 postmortem', 'https://wiki.acme.dev/pm/INC-2041', 'Nina Volkova', ['payments-db', 'payments-service']],
      ['DOC-3', 'Checkout flow sequence', 'https://wiki.acme.dev/commerce/checkout', 'Sam Okafor', ['checkout-service', 'cart-service', 'orders-service']],
      ['DOC-4', 'Redis HA setup', 'https://wiki.acme.dev/platform/redis', 'Priya Raman', ['redis-cache']],
    ],
    // people who worked on services beyond their own team (expertise)
    worked_on: [
      ['Nina Volkova', 'payments-db'], ['Nina Volkova', 'orders-db'], ['Nina Volkova', 'users-db'],
      ['Marcus Chen', 'api-gateway'], ['Marcus Chen', 'redis-cache'],
      ['Sam Okafor', 'checkout-service'], ['Sam Okafor', 'payments-service'], ['Sam Okafor', 'orders-service'],
      ['Diego Alvarez', 'payments-service'], ['Diego Alvarez', 'fraud-service'], ['Diego Alvarez', 'payments-db'],
      ['Aisha Bello', 'payments-service'], ['Tom Becker', 'checkout-service'], ['Tom Becker', 'cart-service'],
      ['Ravi Shah', 'kafka-events'], ['Kenji Watanabe', 'elasticsearch'], ['Kenji Watanabe', 'search-service'],
    ],
  },

  globex: {
    label: 'Globex Stream (video streaming)',
    teams: [['Playback', 'Video playback'], ['Edge', 'CDN and edge'], ['Accounts', 'Accounts and billing']],
    people: [
      ['Hana Sato', 'SRE', 'Edge', true, '@hana'],
      ['Leo Martin', 'Engineer', 'Playback', true, '@leo'],
      ['Zara Ali', 'Engineer', 'Accounts', true, '@zara'],
    ],
    services: [
      ['player-web', 'service', 'Playback', 1], ['playback-api', 'service', 'Playback', 1],
      ['drm-service', 'service', 'Playback', 1], ['cdn-edge', 'external', 'Edge', 1],
      ['accounts-api', 'service', 'Accounts', 1], ['billing-service', 'service', 'Accounts', 2],
      ['accounts-db', 'database', 'Accounts', 1],
    ],
    deps: [
      ['player-web', 'playback-api'], ['playback-api', 'drm-service'], ['playback-api', 'cdn-edge'],
      ['playback-api', 'accounts-api', true, 'Allow playback with a cached entitlement token'], ['accounts-api', 'accounts-db'], ['billing-service', 'accounts-db'],
    ],
    capabilities: [['Video Playback', 3000, ['playback-api']], ['Subscriptions', 800, ['billing-service']]],
    deploys: [['DEP-12', 'drm-service', 'Leo Martin', 30, 'v1.9.0', 'Upgrade DRM license server SDK', 'high']],
    alerts: [
      ['ALR-77', 'playback-api', 'Playback start failures 22%', 'critical', 10],
      ['ALR-78', 'drm-service', 'License request errors', 'critical', 12],
    ],
    runbooks: [['RB-DRM-01', 'DRM license failures', 'drm-service', '1. Roll back DRM SDK. 2. Extend cached license TTL.', 1]],
    incidents: [
      ['INC-301', 'Playback failures after DRM cert expiry', 'SEV1', 70, 'drm-service',
        ['playback-api', 'drm-service'], 'Leo Martin', 'RB-DRM-01', 'A DRM certificate expired and license issuance failed.', 'certificate expiry'],
    ],
    decisions: [],
    docs: [],
    worked_on: [['Hana Sato', 'cdn-edge']],
  },
};

// `spec` lets a test graph (e.g. "ci_acme") be seeded from a named tenant spec.
export async function seedTenant(tenant, { reset = true, spec: specName } = {}) {
  const spec = TENANTS[specName || tenant];
  if (!spec) throw new Error(`unknown tenant ${specName || tenant}`);
  const now = Date.now();
  if (reset) {
    try { await (await graphFor(tenant)).delete(); } catch { /* graph did not exist */ }
  }

  await cypher(tenant, `UNWIND $teams AS t CREATE (:Team {name: t[0], description: t[1]})`, { teams: spec.teams });
  await cypher(tenant, `
    UNWIND $people AS p
    MATCH (t:Team {name: p[2]})
    CREATE (person:Person {name: p[0], role: p[1], handle: p[4]})-[:MEMBER_OF]->(t)
    FOREACH (_ IN CASE WHEN p[3] THEN [1] ELSE [] END | CREATE (person)-[:ON_CALL_FOR]->(t))`,
  { people: spec.people });
  await cypher(tenant, `
    UNWIND $services AS s
    MATCH (t:Team {name: s[2]})
    CREATE (:Service {name: s[0], kind: s[1], tier: s[3], status: 'healthy'})-[:OWNED_BY]->(t)`,
  { services: spec.services });
  await cypher(tenant, `
    UNWIND $deps AS d
    MATCH (a:Service {name: d[0]}), (b:Service {name: d[1]})
    CREATE (a)-[:DEPENDS_ON {capacity: 1, optional: coalesce(d[2], false), fallback: d[3]}]->(b)`, { deps: spec.deps });
  await cypher(tenant, `
    UNWIND $caps AS c
    CREATE (cap:Capability {name: c[0], revenue_per_min: c[1]})
    WITH cap, c UNWIND c[2] AS svc
    MATCH (s:Service {name: svc}) CREATE (s)-[:POWERS]->(cap)`, { caps: spec.capabilities });
  await cypher(tenant, `
    UNWIND $deploys AS d
    MATCH (s:Service {name: d[1]}), (p:Person {name: d[2]})
    CREATE (dep:Deploy {id: d[0], version: d[4], summary: d[5], risk: d[6], at: $now - d[3] * $min})
    CREATE (dep)-[:CHANGED]->(s), (dep)-[:AUTHORED_BY]->(p)`,
  { deploys: spec.deploys, now, min: MIN });
  await cypher(tenant, `
    UNWIND $alerts AS a
    MATCH (s:Service {name: a[1]})
    CREATE (:Alert {id: a[0], name: a[2], severity: a[3], status: 'firing', at: $now - a[4] * $min})-[:FIRED_ON]->(s)
    SET s.status = CASE WHEN a[3] = 'critical' THEN 'down' ELSE 'degraded' END`,
  { alerts: spec.alerts, now, min: MIN });
  await cypher(tenant, `
    UNWIND $rbs AS r
    MATCH (s:Service {name: r[2]})
    CREATE (:Runbook {id: r[0], title: r[1], steps: r[3], success_count: r[4]})-[:FOR]->(s)`,
  { rbs: spec.runbooks });
  for (const i of spec.incidents) {
    await cypher(tenant, `
      MATCH (root:Service {name: $root}), (resolver:Person {name: $resolver})
      CREATE (inc:Incident {id: $id, title: $title, severity: $sev, status: 'resolved', at: $at,
                            summary: $summary, trigger: $trigger, source: 'history'})
      CREATE (inc)-[:ROOT_CAUSE]->(root), (inc)-[:RESOLVED_BY]->(resolver)
      WITH inc
      UNWIND $affected AS a
      MATCH (s:Service {name: a}) CREATE (inc)-[:AFFECTED]->(s)`,
    { id: i[0], title: i[1], sev: i[2], at: now - i[3] * DAY, root: i[4], affected: i[5], resolver: i[6],
      summary: i[8], trigger: i[9] });
    if (i[7]) {
      await cypher(tenant, `MATCH (inc:Incident {id: $id}), (r:Runbook {id: $rb}) CREATE (inc)-[:MITIGATED_WITH]->(r)`,
        { id: i[0], rb: i[7] });
    }
  }
  for (const d of spec.decisions) {
    await cypher(tenant, `
      MATCH (p:Person {name: $by})
      CREATE (dec:Decision {id: $id, title: $title, rationale: $why, at: $at, source: 'adr'})-[:MADE_BY]->(p)
      WITH dec UNWIND $about AS a MATCH (s:Service {name: a}) CREATE (dec)-[:ABOUT]->(s)`,
    { id: d[0], title: d[1], by: d[2], at: now - d[3] * DAY, about: d[4], why: d[5] });
  }
  await cypher(tenant, `MATCH (d:Decision {id: 'ADR-022'}), (i:Incident {id: 'INC-2041'}) CREATE (d)-[:MOTIVATED_BY]->(i)`);
  for (const d of spec.docs) {
    await cypher(tenant, `
      MATCH (p:Person {name: $author})
      CREATE (doc:Document {id: $id, title: $title, url: $url})-[:WRITTEN_BY]->(p)
      WITH doc UNWIND $about AS a MATCH (s:Service {name: a}) CREATE (doc)-[:DOCUMENTS]->(s)`,
    { id: d[0], title: d[1], url: d[2], author: d[3], about: d[4] });
  }
  await cypher(tenant, `
    UNWIND $w AS w MATCH (p:Person {name: w[0]}), (s:Service {name: w[1]}) MERGE (p)-[:WORKED_ON]->(s)`,
  { w: spec.worked_on });
  // Authors of deploys have worked on what they changed.
  await cypher(tenant, `MATCH (d:Deploy)-[:CHANGED]->(s), (d)-[:AUTHORED_BY]->(p) MERGE (p)-[:WORKED_ON]->(s)`);

  for (const idx of [
    'CREATE INDEX FOR (s:Service) ON (s.name)',
    'CREATE INDEX FOR (p:Person) ON (p.name)',
    'CREATE INDEX FOR (i:Investigation) ON (i.id)',
    // Full-text indexes power search_knowledge across the company brain.
    "CALL db.idx.fulltext.createNodeIndex('Incident', 'title', 'summary')",
    "CALL db.idx.fulltext.createNodeIndex('Runbook', 'title', 'steps')",
    "CALL db.idx.fulltext.createNodeIndex('Decision', 'title', 'rationale')",
    "CALL db.idx.fulltext.createNodeIndex('Document', 'title')",
    "CALL db.idx.fulltext.createNodeIndex('Fact', 'text')",
  ]) {
    try { await cypher(tenant, idx); } catch { /* index exists */ }
  }
  const [counts] = await cypher(tenant, 'MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS edges');
  return counts;
}

// Re-fire the scenario alerts and shift deploy times so the scenario is "live"
// again, without touching anything the agents have learned (memory survives).
export async function resetScenario(tenant, specName) {
  const spec = TENANTS[specName || tenant];
  const now = Date.now();
  await cypher(tenant, `MATCH (a:Alert) DELETE a`);
  await cypher(tenant, `MATCH (s:Service) SET s.status = 'healthy'`);
  await cypher(tenant, `
    UNWIND $deploys AS d MATCH (dep:Deploy {id: d[0]}) SET dep.at = $now - d[3] * $min, dep.rolled_back = false`,
  { deploys: spec.deploys, now, min: MIN });
  await cypher(tenant, `
    UNWIND $alerts AS a
    MATCH (s:Service {name: a[1]})
    CREATE (:Alert {id: a[0], name: a[2], severity: a[3], status: 'firing', at: $now - a[4] * $min})-[:FIRED_ON]->(s)
    SET s.status = CASE WHEN a[3] = 'critical' THEN 'down' ELSE 'degraded' END`,
  { alerts: spec.alerts, now, min: MIN });
  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tenants = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TENANTS);
  for (const t of tenants) {
    const c = await seedTenant(t);
    console.log(`seeded ${t}: ${c.nodes} nodes, ${c.edges} edges`);
  }
  process.exit(0);
}
