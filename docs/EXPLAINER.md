# GraphOps, explained

A plain-language guide to how GraphOps works: the graph model, the queries, the architecture and the technical decisions.

## 1. The one-sentence version

When something breaks, three AI agents work through a **FalkorDB graph** of the company (services, dependencies, people,
deploys, incidents, runbooks, projects, tickets and chat). They write what they find **back into the graph**, and a
decision is only stored once the graph shows a causal path that supports it.

## 2. What happens when you click "Investigate"

```
browser ──POST /api/investigate──▶ server.js ──▶ agents.js: investigate()
                                                     │
                     1. create (:Investigation) node │ memory.js
                     2. run TRIAGE and HISTORIAN at the same time
                        each agent = Gemini + a list of graph tools (tools.js)
                        every tool call = one or more Cypher queries (db.js logs them)
                        findings are written as (:Finding)-[:EVIDENCE]->(node)
                     3. run COMMANDER: reads the findings FROM THE GRAPH,
                        picks who to page, calls record_decision
                     4. record_decision runs the proof gate (proof.js)
                        -> VERIFIED / WEAK / REJECTED
                     5. propose actions (actions.js): page + GitHub issue,
                        sent only after a human clicks Approve
   ◀── every step is streamed back as one JSON line (NDJSON) ──
```

**Why stream?** So the UI can show each tool call, its Cypher and its result while the agents work.

**Why do the agents not talk to each other?** Triage and Historian only *write* `Finding` nodes, and the Commander only
*reads* them with `read_investigation`. The graph is the shared state, so it is also the audit trail and the memory.
There is nothing extra to keep in sync.

## 3. The graph model (and why each part exists)

| Part of the graph | Why it is there |
| --- | --- |
| `(:Service)-[:DEPENDS_ON]->(:Service)` | The core. Failures travel *up* these edges: if payments-db breaks, everything that depends on it can break. |
| `(:Service)-[:POWERS]->(:Capability {revenue_per_min})` | Turns "which services break" into "how much money per minute is at risk". |
| `(:Service)-[:OWNED_BY]->(:Team)<-[:ON_CALL_FOR]-(:Person)` | Who to page. |
| `(:Deploy)-[:CHANGED]->(:Service)` | What changed recently, next to the failure. |
| `(:Alert)-[:FIRED_ON]->(:Service)` | What is broken right now. |
| `(:Incident)-[:ROOT_CAUSE\|AFFECTED\|RESOLVED_BY\|MITIGATED_WITH]->…` | **Episodic memory**: what happened before, who fixed it, how. |
| `(:Runbook {success_count, failure_count})`, `-[:SUPERSEDES]->` | **Procedural memory**: fixes that work rank higher, and a corrected runbook replaces the old version. |
| `(:Fact)`, `(:Decision)`, `(:Document)` | **Semantic memory**: things people taught it, design decisions (ADRs), docs. |
| `(:Project)`, `(:Ticket)`, `(:Message)` | **Company brain**: why a change was made, who discussed it, which follow-ups are still open. |
| `(:Investigation)-[:HAS_FINDING]->(:Finding)-[:EVIDENCE]->(any)` | **Shared state between agents**, linked to the nodes each claim is based on. |
| `(:Decision)-[:BASED_ON]->(:Finding)` | **The "why" trail**: decision → findings → evidence. |
| `(:Action)<-[:APPROVED]-(:User)` | **Audit**: which real-world action a person approved, and what happened. |

Each tenant (company) is a **separate graph** in the same FalkorDB instance (`graphops_acme`, `graphops_otel`…).
In public mode each website visitor gets their own copy (`GRAPH.COPY`), so nobody can change anyone else's memory.

## 4. The key queries, in plain words

**Root cause ranking** (`probable_root_cause`, `src/tools.js`)
"Start from every alerting service and walk down `DEPENDS_ON` up to 5 hops. For each node reached, count how many alerts
it could explain." The ranking then adds points if the node is alerting itself, if its direct callers are failing, if it
is the deepest failing node, or if a deploy landed on it or next to it. Explaining **more alerts** counts the most
(parsimony: the simplest explanation that covers everything).

**Blast radius** (`blast_radius`)
"Walk *up* `DEPENDS_ON` from the broken service to find everything that depends on it, then follow `POWERS` to business
capabilities and add up their revenue per minute."

**The proof gate** (`verifyRootCause`, `src/proof.js`)
1. For each alerting service, ask FalkorDB's `algo.SPpaths` for a causal path to the claimed root cause.
2. Every alert must be explained. With 4+ alerts one can be ignored, but only if it looks like noise (none of its own callers fail).
3. A healthy, silent node also needs at least one failing direct caller.
4. The suspect deploy must be on the root, or one hop from it, and recent.
5. `algo.maxFlow` with capacity 1 on every edge counts how many links you would need to cut to isolate the node.
The result is `VERIFIED`, `WEAK` (suggest it, but say it is not proven) or `REJECTED` (sent back to the agent).

**What-if and containment** (`whatIf`, `containmentPlan`)
"Copy the whole graph with `GRAPH.COPY`, take a service down on the copy, and see which capabilities lose a path."
Containment tries every combination of up to 3 fallback links (edges marked `optional`, like "send events to an outbox
instead of Kafka"), keeps the smallest set that protects the most revenue, then really deletes those edges on the copy
and recomputes, to prove the plan works. The copy is deleted afterwards.

**Why was this change made?** (`trace_change`)
"Deploy → `IMPLEMENTS` → ticket → `PART_OF` → project → team; then the chat messages that `MENTION` the deploy or the
ticket." A message in that thread that cites an incident or a decision counts as a warning.

**Memory recall** (`similar_incidents`)
"Find past incidents whose `AFFECTED` or `ROOT_CAUSE` services overlap with the ones alerting now, with a bonus when the
root cause matches." Incidents GraphOps learned itself are included.

**Graph algorithms used:** `algo.SPpaths`, `algo.maxFlow`, `algo.pageRank`, `algo.betweenness`, `algo.labelPropagation`,
`shortestPath`, full-text indexes (`db.idx.fulltext.*`) and `GRAPH.COPY`.

## 5. Technical decisions and trade-offs

| Decision | Why | Trade-off |
| --- | --- | --- |
| **Small named graph tools** instead of letting the model write Cypher | Reliable, testable, explainable; the model only picks *which* traversal to run | Less flexible, so a read-only `run_cypher` tool covers the long tail |
| **Graph as the only shared state** between agents | One source of truth that is also the memory and the audit trail | Every handoff costs a graph read (milliseconds) |
| **Proof gate before storing a decision** | Stops confident wrong answers | Lower recall: sometimes it says WEAK when it was actually right |
| **Scripted playbooks as a fallback** | Free-tier Gemini quotas are tiny (about 20 requests per model per day); the demo must not break | Less natural language when the fallback is used |
| **Model pool with cooldowns** | Each Gemini model has its own quota | Answers can come from different models |
| **`GRAPH.COPY` for simulation and per-visitor sandboxes** | Never mutate the real graph for a what-if; isolate visitors | Extra graphs to clean up |
| **Human approval for real actions** | An agent should not page people or open issues on its own | One extra click |
| **Node.js + Express, plain HTML UI** | Fast to build and to run anywhere | No framework niceties |

## 6. Honest limitations

* A **silent root cause** (the broken node raises no alert) whose only caller is also failing looks the same as "the
  caller broke". The benchmark shows this (14% top-1 but 79% top-3 on the OpenTelemetry Demo), and the gate says WEAK.
* The Acme and Globex companies are synthetic. The OpenTelemetry Demo topology and its fault flags are real, but its
  teams and revenue are synthetic.
* Real-world actions are a Discord or Slack webhook and a GitHub issue. There is no automatic rollback.

## 7. Questions a judge might ask

1. **What happens if you remove FalkorDB?** Nothing works. `/api/status` returns 503, and every tool, memory and decision lives in the graph.
2. **How do the agents share state?** Through `(:Investigation)-[:HAS_FINDING]->(:Finding)` nodes. The Commander reads them with `read_investigation`. There is no message passing in code.
3. **How does it remember across sessions?** Resolving an investigation creates an `Incident` and bumps the runbook's `success_count`. Facts and runbook revisions are nodes. Chat turns are a `(:Turn)-[:NEXT]->(:Turn)` chain. All of it survives restarts because it is in FalkorDB.
4. **How do you know the answer is right?** The proof gate (SPpaths + maxFlow), citation checks (every id mentioned must exist), and a benchmark: `npm run eval` and `npm run eval:otel`.
5. **Why max-flow?** With capacity 1 per edge, max-flow equals the number of independent dependency paths into a node (Menger's theorem), i.e. how many links you must cut to isolate it.
6. **What is GRAPH.COPY used for?** What-if simulation, containment planning and per-visitor sandboxes. The real graph is never modified by a simulation.
7. **What does the LLM actually do?** It chooses which graph tools to call and writes the summary. The graph does the reasoning, which is why the scripted fallback reaches the same answer.
8. **How is it multi-tenant?** One FalkorDB graph per tenant, plus one per visitor in public mode.
9. **What real data does it use?** The OpenTelemetry Demo's compose files and flagd fault flags, imported by `npm run import:otel`.
10. **What stops it from spamming people?** Actions are only *proposed*. A person must approve each one, approvals are recorded, and public mode has a daily cap.
11. **Why is Triage and Historian parallel but Commander sequential?** Diagnosis and recall are independent. The decision needs both.
12. **What is the hardest case and how do you handle it?** A silent root cause. Ranking uses the share of failing direct callers, and the gate requires a failing caller before verifying a silent node.

## 8. Check it yourself (10 minutes)

```bash
npm test              # 14 integration tests against FalkorDB
npm run eval -- 50    # quick benchmark run
npm run eval:otel     # the real OpenTelemetry Demo faults
```
Then in the UI: click **Investigate** and read the brief at the top (decision, proof gate, actions). Expand an agent's section
and a tool row to read its Cypher, open the **Cypher log**, click **Why?**, try **What-if → Containment plan** on `kafka-events`,
and switch the tenant to **Astronomy Shop** (the real OpenTelemetry Demo topology).
