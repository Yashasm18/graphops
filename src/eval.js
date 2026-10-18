// Keyless benchmark: inject random faults into a GRAPH.COPY sandbox of a
// tenant graph and score the graph tools against hidden ground truth.
// No LLM is involved, so anyone can reproduce the numbers:
//   npm run eval            (100 worlds)
//   npm run eval -- 300     (300 worlds)
import { writeFileSync, mkdirSync } from 'node:fs';
import { cypher } from './db.js';
import { withSandbox, verifyRootCause } from './proof.js';
import { TOOLS } from './tools.js';
import { seedTenant, OTEL } from './seed.js';
import { listTenants } from './db.js';

const N = Number(process.argv[2] || 100);
const TENANT = process.argv[3] || process.env.GRAPHOPS_EVAL_TENANT || 'acme';
const FLAGS = process.argv.includes('--flags');
const MIN = 60 * 1000;

// Deterministic RNG so the run is reproducible.
let seed = 20261018;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const chance = (p) => rand() < p;

async function world(sim, services, people, opts = {}) {
  const now = Date.now();
  await cypher(sim, `MATCH (a:Alert) DETACH DELETE a`);
  await cypher(sim, `MATCH (d:Deploy) DETACH DELETE d`);
  await cypher(sim, `MATCH (s:Service) SET s.status = 'healthy'`);

  // Root: any service that something depends on.
  const roots = services.filter((s) => s.dependents > 0);
  const root = opts.root || pick(roots).name;
  const upstream = (await cypher(sim, `
    MATCH (u:Service)-[:DEPENDS_ON*1..4]->(:Service {name: $root}) RETURN collect(DISTINCT u.name) AS u`, { root }))[0].u;
  const direct = (await cypher(sim, `
    MATCH (u:Service)-[:DEPENDS_ON]->(:Service {name: $root}) RETURN collect(u.name) AS u`, { root }))[0].u;

  const silentRoot = opts.silent ?? chance(0.25);
  const alerting = new Set(silentRoot ? [] : [root]);
  for (const u of upstream) if (chance(0.6)) alerting.add(u);
  // Make sure at least two services alert (bounded: small chains may not have two callers).
  for (const u of upstream) { if (alerting.size >= 2) break; alerting.add(u); }
  if (alerting.size < 2) alerting.add(root);
  const others = services.map((s) => s.name).filter((n) => n !== root && !upstream.includes(n));
  const noise = (opts.noise ?? chance(0.4)) && others.length ? pick(others) : null;
  if (noise) alerting.add(noise);

  const alerts = [...alerting].map((s, i) => ({ id: `EV-ALR-${i}`, service: s, at: now - Math.floor(1 + rand() * 20) * MIN }));
  await cypher(sim, `
    UNWIND $alerts AS a MATCH (s:Service {name: a.service})
    CREATE (:Alert {id: a.id, name: 'synthetic', severity: 'critical', status: 'firing', at: a.at})-[:FIRED_ON]->(s)
    SET s.status = 'down'`, { alerts });

  // The real culprit change sits on the root or on a direct dependent; decoys elsewhere, often newer.
  const deploys = [];
  let culprit = null;
  if (chance(0.7)) {
    culprit = { id: 'EV-DEP-CULPRIT', service: chance(0.5) || !direct.length ? root : pick(direct), at: now - Math.floor(5 + rand() * 55) * MIN };
    deploys.push(culprit);
  }
  for (let i = 0; i < 2; i++) {
    if (others.length) deploys.push({ id: `EV-DEP-DECOY-${i}`, service: pick(others), at: now - Math.floor(rand() * 120) * MIN });
  }
  await cypher(sim, `
    UNWIND $deploys AS d MATCH (s:Service {name: d.service}), (p:Person {name: $author})
    CREATE (dep:Deploy {id: d.id, version: 'eval', summary: 'synthetic change', risk: 'medium', at: d.at})
    CREATE (dep)-[:CHANGED]->(s), (dep)-[:AUTHORED_BY]->(p)`, { deploys, author: pick(people) });

  return { root, culprit, alerting: [...alerting], noise, silentRoot, deploys };
}


// Real faults: every OpenTelemetry Demo flagd flag that targets a service, in
// three variants (root alerting, silent root, root plus a noise alert), then
// the same fault again after the first one was resolved into memory.
async function flagBench() {
  const flags = OTEL.flags.filter((f) => f.target);
  return withSandbox('otel', async (sim) => {
    const services = await cypher(sim, `
      MATCH (s:Service) OPTIONAL MATCH (u:Service)-[:DEPENDS_ON]->(s) RETURN s.name AS name, count(u) AS dependents`);
    const people = (await cypher(sim, `MATCH (p:Person) RETURN collect(p.name) AS p`))[0].p;
    const rows = [];
    for (const f of flags) {
      const callers = services.find((s) => s.name === f.target)?.dependents || 0;
      const variants = [{ silent: false, noise: false }, { silent: true, noise: false }, { silent: false, noise: true }]
        .filter((v) => !v.silent || callers > 0);
      for (const v of variants) {
        const w = await world(sim, services, people, { root: f.target, ...v });
        const ranked = await TOOLS.probable_root_cause.run(sim, {});
        const proof = await verifyRootCause(sim, { root_cause: f.target });
        rows.push({ flag: f.flag, target: f.target, variant: v.silent ? 'silent root' : v.noise ? 'with noise' : 'root alerting',
          top1: ranked[0]?.candidate === f.target, top3: ranked.slice(0, 3).some((r) => r.candidate === f.target),
          verified: proof.verdict === 'VERIFIED', alerts: w.alerting.length });
      }
      // Memory: resolve the fault into an Incident, inject it again, recall it.
      const id = `INC-EV-${f.flag}`;
      await cypher(sim, `
        MATCH (s:Service {name: $t})
        CREATE (i:Incident {id: $id, title: $flag, severity: 'SEV2', status: 'resolved', at: $at, summary: $d, source: 'graphops'})
        CREATE (i)-[:ROOT_CAUSE]->(s), (i)-[:AFFECTED]->(s)`, { t: f.target, id, flag: f.flag, d: f.description, at: Date.now() });
      const w2 = await world(sim, services, people, { root: f.target, silent: false, noise: false });
      const recalled = await TOOLS.similar_incidents.run(sim, { services: w2.alerting });
      rows.push({ flag: f.flag, target: f.target, variant: 'same fault again', recall: recalled[0]?.incident === id });
      await cypher(sim, `MATCH (i:Incident {id: $id}) DETACH DELETE i`, { id });
    }
    return { flags, rows };
  });
}

async function main() {
  if (FLAGS) return mainFlags();
  if (!(await listTenants()).includes(TENANT)) await seedTenant(TENANT);
  const started = Date.now();
  const res = await withSandbox(TENANT, async (sim) => {
    const services = await cypher(sim, `
      MATCH (s:Service) OPTIONAL MATCH (u:Service)-[:DEPENDS_ON]->(s)
      RETURN s.name AS name, count(u) AS dependents`);
    const people = (await cypher(sim, `MATCH (p:Person) RETURN collect(p.name) AS p`))[0].p;
    const score = {
      worlds: 0, silent_root: 0, with_noise: 0, with_culprit: 0,
      graph_top1: 0, graph_top3: 0, base_recent_deploy: 0, base_random_alert: 0,
      deploy_graph: 0, deploy_most_recent: 0,
      gate_true_verified: 0, gate_true_rejected: 0, gate_wrong_verified: 0, gate_wrong_checked: 0,
      gate_chain_verified: 0, gate_chain_checked: 0,
    };
    for (let i = 0; i < N; i++) {
      const w = await world(sim, services, people);
      score.worlds++;
      if (w.silentRoot) score.silent_root++;
      if (w.noise) score.with_noise++;

      const ranked = await TOOLS.probable_root_cause.run(sim, {});
      const names = ranked.map((r) => r.candidate);
      if (names[0] === w.root) score.graph_top1++;
      else if (process.env.EVAL_DEBUG) console.log('\nMISS', JSON.stringify({ root: w.root, silent: w.silentRoot, alerting: w.alerting, noise: w.noise, culprit: w.culprit?.service, top: ranked.slice(0, 3).map((r) => [r.candidate, r.score, r.alerting_callers, r.explains_alerts_on.length]) }));
      if (names.slice(0, 3).includes(w.root)) score.graph_top3++;

      const newest = [...w.deploys].sort((a, b) => b.at - a.at)[0];
      if (newest?.service === w.root) score.base_recent_deploy++;
      if (pick(w.alerting) === w.root) score.base_random_alert++;

      if (w.culprit) {
        score.with_culprit++;
        const top = ranked[0];
        if (top?.recent_deploys_nearby?.[0]?.deploy === w.culprit.id) score.deploy_graph++;
        if (newest?.id === w.culprit.id) score.deploy_most_recent++;
      }

      // Proof gate: the true root should pass; a wrong claim should not be VERIFIED.
      const truth = await verifyRootCause(sim, { root_cause: w.root });
      if (truth.verdict === 'VERIFIED') score.gate_true_verified++;
      if (truth.verdict === 'REJECTED') score.gate_true_rejected++;
      const wrongPool = services.map((s) => s.name).filter((n) => n !== w.root);
      const wrong = w.noise && chance(0.5) ? w.noise : pick(wrongPool);
      const claim = await verifyRootCause(sim, { root_cause: wrong });
      // Is the wrong node on the same causal chain as the true root (between the
      // alerts and the root, or below the root)? Then the graph genuinely cannot
      // tell them apart without telemetry, so we report it separately.
      const [chain] = await cypher(sim, `
        MATCH (w:Service {name: $w}), (r:Service {name: $r})
        OPTIONAL MATCH p1 = (w)-[:DEPENDS_ON*1..6]->(r)
        OPTIONAL MATCH p2 = (r)-[:DEPENDS_ON*1..6]->(w)
        RETURN count(p1) + count(p2) > 0 AS onChain`, { w: wrong, r: w.root });
      if (chain.onChain) {
        score.gate_chain_checked++;
        if (claim.verdict === 'VERIFIED') score.gate_chain_verified++;
      } else {
        score.gate_wrong_checked++;
        if (claim.verdict === 'VERIFIED') score.gate_wrong_verified++;
        if (process.env.EVAL_DEBUG && claim.verdict === 'VERIFIED') console.log('\nGATE-FP', JSON.stringify({ root: w.root, silent: w.silentRoot, alerting: w.alerting, noise: w.noise, wrong, reason: claim.reason, callers: claim.failing_callers }));
      }
      if (process.stdout.isTTY) process.stdout.write(`\r  world ${i + 1}/${N}`);
    }
    return score;
  });
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : 'n/a');
  const ms = Date.now() - started;
  const table = [
    ['Root cause, top-1 (GraphOps graph ranking)', pct(res.graph_top1, res.worlds)],
    ['Root cause, top-3 (GraphOps graph ranking)', pct(res.graph_top3, res.worlds)],
    ['Baseline: blame the most recent deploy', pct(res.base_recent_deploy, res.worlds)],
    ['Baseline: pick a random alerting service', pct(res.base_random_alert, res.worlds)],
    ['Culprit deploy found (GraphOps, worlds with a culprit)', pct(res.deploy_graph, res.with_culprit)],
    ['Culprit deploy found (baseline: most recent deploy)', pct(res.deploy_most_recent, res.with_culprit)],
    ['Proof gate: true root VERIFIED', pct(res.gate_true_verified, res.worlds)],
    ['Proof gate: true root REJECTED', pct(res.gate_true_rejected, res.worlds)],
    [`Proof gate: unrelated wrong claim wrongly VERIFIED (n=${res.gate_wrong_checked})`, pct(res.gate_wrong_verified, res.gate_wrong_checked)],
    [`Proof gate: wrong claim on the same causal chain VERIFIED (n=${res.gate_chain_checked})`, pct(res.gate_chain_verified, res.gate_chain_checked)],
  ];
  const md = `# GraphOps benchmark

Generated by \`npm run eval -- ${N}\` on ${new Date().toISOString().slice(0, 10)} against FalkorDB, with no LLM involved.
${res.worlds} random fault worlds were injected into a \`GRAPH.COPY\` sandbox of the \`${TENANT}\` graph. ${res.silent_root} had a **silent root cause**
(the broken node raised no alert), ${res.with_noise} had an **unrelated noise alert**, and every world had **two decoy deploys** on unrelated
services, often newer than the real culprit. ${res.with_culprit} worlds had a real culprit deploy on the root or on a direct dependent.

| Metric | Result |
| --- | --- |
${table.map(([a, b]) => `| ${a} | **${b}** |`).join('\n')}

Run time: ${(ms / 1000).toFixed(1)}s. Reproduce with \`npm run eval\` (a fixed RNG seed gives the same worlds every run).

**How a world is built:** pick a random service that something depends on as the root. Alert it (75% of the time), alert each service
up to 4 hops upstream with probability 0.6, maybe alert one unrelated service, add the culprit deploy next to the root (70%) and two decoys.
**Proof gate check:** for each world we also claim a wrong root cause (often the noise service) and count how often the gate wrongly returns VERIFIED.
Wrong claims are split in two. *Unrelated* ones share no dependency chain with the true root, and the gate should never verify them.
*Same-chain* ones sit between the alerts and the root, or below the root. Topology alone cannot always separate those from the truth,
which is why the ranking also weighs alerts on the node itself, depth and nearby deploys.
`;
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/EVAL.md', md);
  console.log(`\n${md}`);
  process.exit(0);
}


async function mainFlags() {
  if (!OTEL) throw new Error('run npm run import:otel first');
  await seedTenant('otel');
  const started = Date.now();
  const { flags, rows } = await flagBench();
  const scored = rows.filter((r) => r.variant !== 'same fault again');
  const again = rows.filter((r) => r.variant === 'same fault again');
  const pct = (a, b) => `${Math.round((a / b) * 1000) / 10}%`;
  const by = (v) => scored.filter((r) => r.variant === v);
  const line = (label, xs) => `| ${label} | ${xs.length} | **${pct(xs.filter((r) => r.top1).length, xs.length)}** | ${pct(xs.filter((r) => r.top3).length, xs.length)} | ${pct(xs.filter((r) => r.verified).length, xs.length)} |`;
  const md = `# GraphOps on the real OpenTelemetry Demo

Generated by \`npm run eval:otel\` on ${new Date().toISOString().slice(0, 10)}, with no LLM involved.
The service topology (${OTEL.services.length} services, ${OTEL.deps.length} dependencies) and the ${flags.length} fault flags were imported from
[open-telemetry/opentelemetry-demo](${OTEL.source.repo}) (\`${OTEL.source.files.join('`, `')}\`) by \`npm run import:otel\`.
Each flag that breaks a service is replayed on a \`GRAPH.COPY\` sandbox in three variants: the broken service alerts, the broken service is
silent (only its callers alert), and an unrelated noise alert is added. Every world also gets two decoy deploys.

| Variant | Worlds | Root cause top-1 | Top-3 | Proof gate VERIFIED |
| --- | --- | --- | --- | --- |
${line('All', scored)}
${line('Root alerting', by('root alerting'))}
${line('Silent root', by('silent root'))}
${line('With noise alert', by('with noise'))}

**Memory:** after each fault was resolved into an \`Incident\`, the same fault was injected again. The Historian's \`similar_incidents\`
recalled the learned incident first in **${again.filter((r) => r.recall).length}/${again.length}** faults.

| Flag | Breaks | Root alerting | Silent root | With noise | Same fault again |
| --- | --- | --- | --- | --- | --- |
${flags.map((f) => {
    const cell = (v) => { const r = rows.find((x) => x.flag === f.flag && x.variant === v); return !r ? 'n/a' : (r.top1 ? '✅ top-1' : r.top3 ? '🟡 top-3' : '❌'); };
    const a = rows.find((x) => x.flag === f.flag && x.variant === 'same fault again');
    return `| \`${f.flag}\` | ${f.target} | ${cell('root alerting')} | ${cell('silent root')} | ${cell('with noise')} | ${a?.recall ? '✅ recalled' : '❌'} |`;
  }).join('\n')}

Run time: ${((Date.now() - started) / 1000).toFixed(1)}s.
`;
  writeFileSync('docs/EVAL-OTEL.md', md);
  console.log(md);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
