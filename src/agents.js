// Multi-agent incident response. Triage and Historian work in parallel and
// share state only through the investigation subgraph; Commander reads that
// subgraph and records a decision linked to the evidence.
import { GoogleGenAI } from '@google/genai';
import { traceStore, cypher } from './db.js';
import { TOOLS, AGENT_TOOLSETS, runTool } from './tools.js';
import { startInvestigation, addTurn, getTurns, userHistory } from './memory.js';
import { checkCitations } from './proof.js';
import { proposeActions } from './actions.js';

const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3-flash-preview').split(',').map((m) => m.trim());
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
export const llmEnabled = () => Boolean(ai) && process.env.GRAPHOPS_SCRIPTED !== 'true';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHARED_RULES = `
You are part of GraphOps, a team of incident-response agents. Your only source of truth is the
company's FalkorDB graph, which you query through tools. Never invent service, person, deploy, incident or runbook
names. Use only names returned by tools. Prefer fewer, well-chosen tool calls. You can call several tools at once.
Record what you learn with record_finding, linking the evidence node names and ids, so other agents can use it.
Keep your final message under 120 words. Use plain Markdown (bold, bullets, backticks), never LaTeX; write arrows as ->.`;

const PROMPTS = {
  triage: `You are the TRIAGE agent. Work out what is broken, the most likely root cause, and the blast radius.
Use probable_root_cause first, then recent_changes and blast_radius on the root cause, and dependency_path to show how it propagates.
Record findings of kind root_cause, suspect_change and blast_radius.`,
  historian: `You are the HISTORIAN agent, responsible for the team's memory. For the services involved, find precedent incidents,
the runbooks that worked before, architecture decisions and facts learned in earlier sessions, and the people who know the system.
Also find recent deploys near the alerting services and call trace_change on the most suspicious one, to learn why it was
made (ticket, project, chat) and whether anyone warned against it. Record findings of kind precedent, runbook and knowledge.`,
  commander: `You are the INCIDENT COMMANDER agent. Read the shared investigation first: it holds the findings from Triage and Historian.
Rules:
- root_cause is the service named in Triage's root_cause finding, i.e. the failing component, not the service whose deploy triggered it.
  Put the triggering deploy in suspect_deploy.
- Call containment_plan on the root cause. If it finds fallback modes that protect revenue, put "switch on <fallback>" steps first in the action.
- Call who_to_page on that root_cause service. Page the top 2 or 3 people it returns, so the on-call engineer is joined by whoever has fixed this before.
- Call record_decision exactly once. It runs a graph proof gate. If it returns GATE REJECTED, fix the root cause and call it again. Include severity, root cause, suspect deploy, runbook, concrete action steps and the people to page.
Then give a short incident brief for humans that names each paged person and says why they were paged.`,
  chat: `You are the GraphOps assistant. Answer questions about this company's systems, people, incidents and decisions
by querying the graph. Cite the nodes you used, such as INC-2041 or ADR-022. If the user teaches you a durable fact about a service,
store it with remember_fact.`,
};

function declarations(names) {
  return names.map((name) => ({
    name,
    description: TOOLS[name].description,
    parametersJsonSchema: TOOLS[name].parameters,
  }));
}

// Daily free-tier quotas report retry delays of many hours; respect them so an
// exhausted model is skipped for the rest of the day instead of re-tried.
function retryDelayMs(err) {
  const m = String(err?.message || '').match(/retry(?:Delay)?["\s:in]*([\d.]+)s/i);
  return m ? Math.ceil(Number(m[1]) * 1000) + 500 : 8000;
}

// Free-tier quotas are per model, so a rate-limited model is put on cooldown
// and the call moves straight to the next model instead of waiting.
const cooldownUntil = new Map();
// Spread load: the historian prefers the lighter model.
const PREFERRED = { historian: MODELS[1] };

function modelOrder(agent) {
  const first = PREFERRED[agent];
  const order = first ? [first, ...MODELS.filter((m) => m !== first)] : MODELS;
  return order.filter(Boolean);
}

async function generate(request, emit, agent) {
  let lastErr;
  for (let round = 0; round < 3; round++) {
    const now = Date.now();
    const order = modelOrder(agent);
    const ready = order.filter((m) => (cooldownUntil.get(m) || 0) <= now);
    if (!ready.length) {
      const wait = Math.min(...order.map((m) => cooldownUntil.get(m))) - now;
      if (wait > 60000) throw lastErr || new Error('all Gemini models are out of quota');
      emit({ type: 'notice', agent, text: `all models rate-limited, waiting ${Math.ceil(wait / 1000)}s` });
      await sleep(Math.max(500, wait));
      continue;
    }
    for (const model of ready) {
      try {
        const res = await ai.models.generateContent({ ...request, model });
        res.modelUsed = model;
        return res;
      } catch (err) {
        lastErr = err;
        const status = err?.status || err?.code;
        const retriable = status === 429 || status === 503 || status === 500 || /RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded/i.test(String(err?.message));
        if (!retriable) throw err;
        cooldownUntil.set(model, Date.now() + retryDelayMs(err));
        emit({ type: 'notice', agent, text: `${model} is rate-limited, switching model` });
      }
    }
  }
  throw lastErr;
}

const clip = (v, n = 6000) => {
  const s = JSON.stringify(v);
  return s.length > n ? JSON.parse(JSON.stringify({ truncated: true, preview: s.slice(0, n) })) : v;
};

// Run one tool call with Cypher tracing and stream it to the UI.
async function callTool(ctx, name, args) {
  const trace = [];
  const started = Date.now();
  ctx.emit({ type: 'tool_call', agent: ctx.agent, tool: name, args });
  const result = await traceStore.run(trace, () => runTool(ctx.tenant, name, args, ctx));
  ctx.emit({ type: 'tool_result', agent: ctx.agent, tool: name, ms: Date.now() - started, cypher: trace, result: clip(result, 2500) });
  ctx.stats.queries += trace.length;
  ctx.stats.tools += 1;
  return result;
}

async function llmAgent(ctx, userPrompt, { maxSteps = 6, history = [] } = {}) {
  const tools = [{ functionDeclarations: declarations(AGENT_TOOLSETS[ctx.agent]) }];
  const contents = [...history, { role: 'user', parts: [{ text: userPrompt }] }];
  const config = { systemInstruction: `${PROMPTS[ctx.agent]}\n${SHARED_RULES}`, tools,
    thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING || 'low' } };
  for (let step = 0; step < maxSteps; step++) {
    const res = await generate({ contents, config }, ctx.emit, ctx.agent);
    const calls = res.functionCalls || [];
    if (!calls.length) return res.text || '';
    contents.push(res.candidates[0].content);
    const thought = res.candidates[0].content.parts?.filter((p) => p.text && !p.thought).map((p) => p.text).join(' ');
    if (thought) ctx.emit({ type: 'thought', agent: ctx.agent, text: thought });
    const parts = [];
    for (const call of calls) {
      const result = await callTool(ctx, call.name, call.args || {});
      parts.push({ functionResponse: { id: call.id, name: call.name, response: { result: clip(result) } } });
    }
    contents.push({ role: 'user', parts });
  }
  const res = await generate({ contents: [...contents, { role: 'user', parts: [{ text: 'Stop calling tools and give your final answer now.' }] }], config: { ...config, tools: undefined } }, ctx.emit, ctx.agent);
  return res.text || '';
}

// ---------- Scripted fallbacks: same tools, same graph writes, no LLM ----------
const SCRIPTED = {
  async triage(ctx) {
    const ranked = await callTool(ctx, 'probable_root_cause', {});
    const top = ranked[0];
    if (!top) return 'No firing alerts, so there is nothing to triage.';
    const changes = await callTool(ctx, 'recent_changes', { service: top.candidate });
    const blast = await callTool(ctx, 'blast_radius', { service: top.candidate });
    const entry = top.explains_alerts_on.find((s) => s !== top.candidate) || top.candidate;
    const path = await callTool(ctx, 'dependency_path', { from: entry, to: top.candidate });
    await callTool(ctx, 'record_finding', {
      kind: 'root_cause', confidence: Math.min(0.95, top.score / 10),
      summary: `${top.candidate} is the most likely root cause. It explains alerts on ${top.explains_alerts_on.join(', ')}${top.deepest_alerting_node ? ' and is the deepest alerting node' : ''}. Propagation: ${(path.path || []).join(' -> ')}.`,
      evidence: [top.candidate, ...top.explains_alerts_on],
    });
    const suspect = changes.find((c) => c.service !== top.candidate) || changes[0];
    if (suspect) {
      await callTool(ctx, 'record_finding', {
        kind: 'suspect_change', confidence: 0.8,
        summary: `${suspect.deploy} (${suspect.summary}) on ${suspect.service} by ${suspect.author} shipped ${suspect.minutes_ago} minutes ago, directly next to ${top.candidate}.`,
        evidence: [suspect.deploy, suspect.service, suspect.author],
      });
    }
    await callTool(ctx, 'record_finding', {
      kind: 'blast_radius', confidence: 0.9,
      summary: `${blast.upstream_services.length} upstream services are at risk. Capabilities affected: ${blast.capabilities_at_risk.map((c) => c.capability).join(', ')}. About $${blast.revenue_at_risk_per_min}/min of revenue is at risk.`,
      evidence: [top.candidate, ...blast.capabilities_at_risk.map((c) => c.capability)],
    });
    return `The root cause is most likely **${top.candidate}**${suspect ? `, probably triggered by ${suspect.deploy} on ${suspect.service}` : ''}. Blast radius: ${blast.upstream_services.length} services and $${blast.revenue_at_risk_per_min}/min.`;
  },
  async historian(ctx, { services }) {
    const incidents = await callTool(ctx, 'similar_incidents', { services });
    const best = incidents[0];
    if (best) {
      await callTool(ctx, 'record_finding', {
        kind: 'precedent', confidence: Math.min(0.9, 0.4 + best.similarity / 10),
        summary: `${best.incident} "${best.title}" had root cause ${best.root_cause}. ${best.summary} It was resolved by ${best.resolved_by}${best.runbook ? ` using ${best.runbook}` : ''}.`,
        evidence: [best.incident, best.root_cause, best.resolved_by, best.runbook].filter(Boolean),
      });
    }
    const focus = best?.root_cause || services[services.length - 1];
    const rbs = await callTool(ctx, 'runbooks_for', { service: focus });
    if (rbs[0]) {
      await callTool(ctx, 'record_finding', {
        kind: 'runbook', confidence: 0.8,
        summary: `${rbs[0].runbook} "${rbs[0].title}" has resolved ${rbs[0].times_it_worked} past incidents. Steps: ${rbs[0].steps}`,
        evidence: [rbs[0].runbook, rbs[0].for_service],
      });
    }
    const know = await callTool(ctx, 'decisions_and_docs', { service: focus });
    const adr = know.decisions[0];
    if (adr || know.facts.length) {
      await callTool(ctx, 'record_finding', {
        kind: 'knowledge', confidence: 0.7,
        summary: [adr && `${adr.id} "${adr.title}" (${adr.made_by}): ${adr.rationale}`,
          ...know.facts.map((f) => `Learned fact: ${f.fact}`)].filter(Boolean).join(' '),
        evidence: [adr?.id, focus, ...know.docs.map((d) => d.title)].filter(Boolean),
      });
    }
    // Why was the nearby change made? Follow it to ticket, project and chat.
    const changes = await callTool(ctx, 'recent_changes', { service: focus });
    let why = '';
    if (changes[0]) {
      const tr = await callTool(ctx, 'trace_change', { deploy: changes[0].deploy });
      if (!tr.error) {
        const warn = tr.warnings_raised[0];
        const open = tr.open_follow_ups[0];
        await callTool(ctx, 'record_finding', {
          kind: 'knowledge', confidence: 0.85,
          summary: `${tr.deploy} implemented ${tr.ticket || 'no ticket'}${tr.project ? ` for project "${tr.project}" (${tr.team})` : ''}.`
            + (warn ? ` ${warn.by} warned in ${warn.message}: "${warn.text}"` : '')
            + (open ? ` Follow-up ${open.ticket} "${open.title}" is still ${open.status}.` : ''),
          evidence: [tr.deploy, tr.ticket, warn?.message, open?.ticket, open?.follows_up].filter(Boolean),
        });
        why = warn ? ` ${warn.by} had warned about this in ${warn.message}.` : '';
      }
    }
    return best ? `This looks like **${best.incident}** (${best.title}). The best runbook is ${rbs[0]?.runbook || 'none'}.${why}` : `There are no close precedents in memory.${why}`;
  },
  async commander(ctx) {
    const inv = await callTool(ctx, 'read_investigation', {});
    const rootF = inv.findings.find((f) => f.kind === 'root_cause');
    const root = rootF?.summary.split(' ')[0];
    const pagees = root ? await callTool(ctx, 'who_to_page', { service: root }) : [];
    const blast = root ? await callTool(ctx, 'blast_radius', { service: root }) : { upstream_services: [] };
    const suspect = inv.findings.find((f) => f.kind === 'suspect_change')?.summary.split(' ')[0];
    const rb = inv.findings.find((f) => f.kind === 'runbook')?.summary.split(' ')[0];
    const page = pagees.slice(0, 3).map((p) => p.person);
    const contain = root ? await callTool(ctx, 'containment_plan', { root_cause: root }) : { plan: [] };
    const fallbackSteps = (contain.plan || []).map((p) => `Switch on fallback: ${p.switch_on} (${p.link}). `).join('');
    const severity = blast.revenue_at_risk_per_min > 2000 ? 'SEV1' : 'SEV2';
    await callTool(ctx, 'record_decision', {
      title: `${root} outage${suspect ? ` after ${suspect}` : ''}`,
      root_cause: root, suspect_deploy: suspect || '', runbook: rb || '', severity, page,
      affected: [root, ...blast.upstream_services.map((s) => s.service)],
      action: `${fallbackSteps}${suspect ? `Roll back ${suspect}. ` : ''}${rb ? `Follow ${rb}. ` : ''}Watch error rates on ${blast.upstream_services.slice(0, 3).map((s) => s.service).join(', ')}.`,
      rationale: inv.findings.map((f) => f.summary).join(' | ').slice(0, 900),
    });
    return `**${severity}**: ${root}${suspect ? ` (suspect ${suspect})` : ''}. Paging ${page.join(', ')}.${rb ? ` Runbook ${rb}.` : ''}`;
  },
};

async function runAgent(ctx, prompt, scriptedArgs) {
  const useLlm = llmEnabled() && !ctx.scripted;
  ctx.emit({ type: 'agent_start', agent: ctx.agent, mode: useLlm ? 'llm' : 'scripted' });
  let text;
  if (useLlm) {
    try {
      text = await llmAgent(ctx, prompt);
      // Shared state must never be empty: if the model answered without
      // recording findings, the graph playbook records grounded ones.
      if (['triage', 'historian'].includes(ctx.agent) && !ctx.findings) {
        ctx.emit({ type: 'notice', agent: ctx.agent, text: 'The model recorded no findings, so the graph playbook is recording them in the shared state.' });
        await SCRIPTED[ctx.agent](ctx, scriptedArgs);
      }
    } catch (err) {
      ctx.emit({ type: 'notice', agent: ctx.agent, text: `LLM unavailable (${String(err.message).slice(0, 120)}). Switching to the scripted graph playbook.` });
      text = await SCRIPTED[ctx.agent](ctx, scriptedArgs);
    }
  } else {
    text = await SCRIPTED[ctx.agent](ctx, scriptedArgs);
  }
  ctx.emit({ type: 'agent_done', agent: ctx.agent, text });
  // Grounding check: every id the agent cites must exist in the graph.
  const cites = await checkCitations(ctx.tenant, text).catch(() => null);
  if (cites?.checked) ctx.emit({ type: 'citations', agent: ctx.agent, ...cites });
  await addTurn(ctx.tenant, ctx.investigationId, 'assistant', text, ctx.agent);
  return text;
}

export async function investigate({ tenant, user, question, emit, scripted = false }) {
  const investigationId = await startInvestigation(tenant, user, question);
  const stats = { queries: 0, tools: 0, started: Date.now() };
  emit({ type: 'investigation', id: investigationId, question, mode: llmEnabled() && !scripted ? 'llm' : 'scripted' });
  const base = { tenant, investigationId, emit, stats, scripted };

  const past = await userHistory(tenant, user, 3);
  const memoryNote = past.length > 1
    ? `\nThis user's earlier investigations: ${past.slice(1).map((p) => `${p.id} "${p.question}" -> ${p.decision || p.status}`).join('; ')}.`
    : '';
  const alerting = (await cypher(tenant, `MATCH (:Alert {status: 'firing'})-[:FIRED_ON]->(s:Service) RETURN collect(DISTINCT s.name) AS s`, {}, { readOnly: true }))[0].s;

  // Two agents in parallel, writing to the same investigation subgraph.
  emit({ type: 'handoff', from: 'orchestrator', to: ['triage', 'historian'], note: 'parallel: diagnose + recall' });
  await Promise.all([
    runAgent({ ...base, agent: 'triage' }, `Incident report: "${question}".${memoryNote}`),
    runAgent({ ...base, agent: 'historian' },
      `Incident report: "${question}". The services currently alerting are ${alerting.join(', ')}. Recall what memory knows about them.${memoryNote}`,
      { services: alerting }),
  ]);
  emit({ type: 'handoff', from: ['triage', 'historian'], to: 'commander', note: 'findings shared via graph' });
  // Ground the commander in the graph's own ranking so a weaker fallback model
  // cannot confuse the failing component with the service whose deploy triggered it.
  const [ranked] = await runTool(tenant, 'probable_root_cause', {}, {});
  const anchor = ranked ? ` The graph ranks ${ranked.candidate} as the most likely failing component (score ${ranked.score}). Use it as root_cause unless the findings clearly contradict it.` : '';
  const brief = await runAgent({ ...base, agent: 'commander' }, `Incident report: "${question}".${anchor} Read the investigation, decide, and brief the humans.`);

  // Propose real-world actions; a human must approve each one before it is sent.
  const actions = await proposeActions(tenant, investigationId).catch(() => []);
  if (actions.length) emit({ type: 'actions', id: investigationId, actions });
  stats.ms = Date.now() - stats.started;
  emit({ type: 'done', id: investigationId, brief, stats });
  return { investigationId, brief, stats };
}

// Follow-up chat with persistent history loaded from the graph.
export async function chat({ tenant, user, investigationId, message, emit, scripted = false }) {
  const stats = { queries: 0, tools: 0, started: Date.now() };
  const ctx = { tenant, investigationId, emit, stats, agent: 'chat' };
  let history = [];
  if (investigationId) {
    const turns = await getTurns(tenant, investigationId, 12);
    history = turns.map((t) => ({ role: t.role === 'user' ? 'user' : 'model', parts: [{ text: t.agent ? `[${t.agent}] ${t.text}` : t.text }] }));
    await addTurn(tenant, investigationId, 'user', message);
  }
  const past = await userHistory(tenant, user, 5);
  const prompt = `${past.length ? `(Memory: this user's recent investigations: ${past.map((p) => `${p.id} "${p.question}"`).join('; ')}.)\n` : ''}${message}`;
  emit({ type: 'agent_start', agent: 'chat', mode: llmEnabled() && !scripted ? 'llm' : 'scripted' });
  let text;
  if (!llmEnabled() || scripted) {
    text = scripted ? 'The AI quota for this visitor is used up. Chat needs the LLM, but the incident playbook, What-if and proof tools still work.' : 'Chat needs GEMINI_API_KEY. The scripted mode only covers the incident playbook.';
  } else {
    try {
      text = await llmAgent(ctx, prompt, { maxSteps: 6, history });
    } catch (err) {
      text = `LLM unavailable: ${String(err.message).slice(0, 200)}`;
    }
  }
  if (investigationId) await addTurn(tenant, investigationId, 'assistant', text, 'chat');
  emit({ type: 'agent_done', agent: 'chat', text });
  const cites = await checkCitations(tenant, text).catch(() => null);
  if (cites?.checked) emit({ type: 'citations', agent: 'chat', ...cites });
  emit({ type: 'done', stats: { ...stats, ms: Date.now() - stats.started } });
  return text;
}
