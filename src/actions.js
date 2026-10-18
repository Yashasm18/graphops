// Real-world actions, gated by a human. A decision proposes actions as
// (:Action {status: 'proposed'}) nodes; nothing leaves the system until a
// person approves one. Every approval and result is written back to the graph:
//   (:User)-[:APPROVED]->(:Action)-[:FOR_DECISION]->(:Decision)
// Channels:
//   - page:  Discord or Slack incoming webhook (ACTION_WEBHOOK_URL)
//   - issue: GitHub issue (GITHUB_TOKEN + GITHUB_REPO, e.g. "you/graphops-ops")
// Without credentials an action runs as a dry run that shows the exact payload.
import { cypher } from './db.js';
import { getInvestigation, decisionTrace } from './memory.js';

const WEBHOOK = () => process.env.ACTION_WEBHOOK_URL || '';
const GH_TOKEN = () => process.env.GITHUB_TOKEN || '';
const GH_REPO = () => process.env.GITHUB_REPO || '';
const PUBLIC = () => process.env.PUBLIC_MODE === 'true';
// In public mode real sends are capped so visitors cannot spam the channels.
const DAILY_CAP = Number(process.env.ACTIONS_PER_DAY || 20);
let sentToday = { day: new Date().toDateString(), n: 0 };

export function channels() {
  return {
    page: WEBHOOK() ? (/discord/.test(WEBHOOK()) ? 'discord' : 'slack') : 'dry-run',
    issue: GH_TOKEN() && GH_REPO() ? `github:${GH_REPO()}` : 'dry-run',
  };
}

function issueBody(inv, d, trace) {
  const chain = (trace?.[0]?.chain || []).filter((c) => c.finding);
  const byFinding = new Map();
  for (const c of chain) {
    const e = byFinding.get(c.finding) || { agent: c.agent, summary: c.summary, evidence: [] };
    if (c.evidence) e.evidence.push(c.evidence);
    byFinding.set(c.finding, e);
  }
  return `**${d.severity}: ${d.title}**

| | |
| --- | --- |
| Root cause | \`${d.root_cause}\` (${d.verdict || 'unverified'}: ${d.proof || 'n/a'}) |
| Suspect change | ${d.suspect_deploy ? `\`${d.suspect_deploy}\`` : 'none'} |
| Runbook | ${d.runbook ? `\`${d.runbook}\`` : 'none'} |
| Paged | ${d.paged.join(', ')} |

**Action**

${d.action}

**Evidence (from the GraphOps graph)**

${[...byFinding.values()].map((f) => `- **${f.agent}**: ${f.summary}${f.evidence.length ? `\n  evidence: ${f.evidence.map((x) => `\`${x}\``).join(', ')}` : ''}`).join('\n')}

_Investigation ${inv.id}, decision ${d.id}. Opened by GraphOps after human approval._`;
}

// Turn a recorded decision into proposed actions. Idempotent per decision.
export async function proposeActions(tenant, investigationId) {
  const inv = await getInvestigation(tenant, investigationId);
  const d = inv?.decision;
  if (!d) throw new Error('no decision yet');
  const [have] = await cypher(tenant, `MATCH (:Decision {id: $id})<-[:FOR_DECISION]-(a:Action) RETURN count(a) AS n`, { id: d.id });
  if (have.n > 0) return listActions(tenant, investigationId);
  const people = await cypher(tenant, `
    MATCH (p:Person) WHERE p.name IN $names RETURN p.name AS name, p.handle AS handle`, { names: d.paged });
  const trace = await decisionTrace(tenant, investigationId);
  const page = {
    text: `🚨 ${d.severity} ${d.title}\nRoot cause: ${d.root_cause} (${d.verdict || 'unverified'})${d.suspect_deploy ? `\nSuspect change: ${d.suspect_deploy}` : ''}\n`
      + `Paging: ${people.map((p) => `${p.name} ${p.handle}`).join(', ')}\nAction: ${d.action}`,
  };
  const issue = { title: `[${d.severity}] ${d.title}`, body: issueBody(inv, d, trace), labels: ['incident', d.severity.toLowerCase()] };
  const actions = [
    { kind: 'page', summary: `Page ${d.paged.join(', ')} in the incident channel`, payload: page },
    { kind: 'issue', summary: `Open an incident issue with the evidence trail`, payload: issue },
  ];
  for (const [i, a] of actions.entries()) {
    await cypher(tenant, `
      MATCH (d:Decision {id: $did})
      CREATE (a:Action {id: $id, kind: $kind, summary: $summary, payload: $payload, status: 'proposed', at: $at})-[:FOR_DECISION]->(d)
      WITH a UNWIND $people AS name MATCH (p:Person {name: name}) WHERE $kind = 'page' CREATE (a)-[:NOTIFIES]->(p)`,
    { did: d.id, id: `ACT-${Date.now().toString(36).toUpperCase()}-${i}`, kind: a.kind, summary: a.summary,
      payload: JSON.stringify(a.payload), at: Date.now(), people: d.paged });
  }
  return listActions(tenant, investigationId);
}

export async function listActions(tenant, investigationId) {
  const rows = await cypher(tenant, `
    MATCH (:Investigation {id: $inv})-[:CONCLUDED]->(:Decision)<-[:FOR_DECISION]-(a:Action)
    OPTIONAL MATCH (u:User)-[:APPROVED]->(a)
    RETURN a.id AS id, a.kind AS kind, a.summary AS summary, a.status AS status, a.payload AS payload,
           a.result_url AS url, a.result AS result, u.name AS approved_by ORDER BY a.id`, { inv: investigationId }, { readOnly: true });
  const ch = channels();
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload), channel: ch[r.kind] }));
}

async function sendPage(payload) {
  const url = WEBHOOK();
  const body = /discord/.test(url) ? { content: payload.text.slice(0, 1900) } : { text: payload.text };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  return { result: 'posted to the incident channel', url: null };
}

async function sendIssue(payload) {
  const res = await fetch(`https://api.github.com/repos/${GH_REPO()}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GH_TOKEN()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'graphops' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${json.message || ''}`);
  return { result: `opened issue #${json.number}`, url: json.html_url };
}

// A person approves one action; it is executed (or dry-run) and the outcome recorded.
export async function approveAction(tenant, actionId, user) {
  const [a] = await cypher(tenant, `MATCH (a:Action {id: $id}) RETURN a.kind AS kind, a.status AS status, a.payload AS payload`, { id: actionId });
  if (!a) throw new Error(`no action ${actionId}`);
  if (a.status !== 'proposed') return { id: actionId, status: a.status, note: 'already handled' };
  const payload = JSON.parse(a.payload);
  const live = channels()[a.kind] !== 'dry-run';
  let outcome;
  if (!live) {
    outcome = { status: 'dry_run', result: 'no credentials configured: this is exactly what would be sent', url: null };
  } else {
    const today = new Date().toDateString();
    if (sentToday.day !== today) sentToday = { day: today, n: 0 };
    if (PUBLIC() && sentToday.n >= DAILY_CAP) {
      outcome = { status: 'dry_run', result: `daily cap of ${DAILY_CAP} real actions reached: shown as a dry run`, url: null };
    } else {
      try {
        const r = a.kind === 'page' ? await sendPage(payload) : await sendIssue(payload);
        sentToday.n++;
        outcome = { status: 'sent', ...r };
      } catch (err) {
        outcome = { status: 'failed', result: String(err.message || err), url: null };
      }
    }
  }
  await cypher(tenant, `
    MATCH (a:Action {id: $id})
    SET a.status = $status, a.result = $result, a.result_url = $url, a.done_at = $at
    MERGE (u:User {name: $user})
    MERGE (u)-[:APPROVED {at: $at}]->(a)`,
  { id: actionId, status: outcome.status, result: outcome.result, url: outcome.url, at: Date.now(), user: user || 'anonymous' });
  return { id: actionId, kind: a.kind, ...outcome, payload };
}
