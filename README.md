# ◈ GraphOps: a multi-agent incident commander on FalkorDB

[![CI](https://github.com/Yashasm18/graphops/actions/workflows/ci.yml/badge.svg)](https://github.com/Yashasm18/graphops/actions/workflows/ci.yml)

**▶ Live: https://graphops-gr4u.onrender.com** (free tier, so the first load after idling can take ~50 s. Every visitor gets a private sandbox.)

> "Checkout is throwing 500s and customers can't pay." In seconds GraphOps says it's **payments-db**
> connection exhaustion triggered by **DEP-981** (a retry change shipped 23 minutes ago). This is the same failure as **INC-2041**,
> so it recommends rolling back and following **RB-PAY-01**, and it pages **Diego** (on call), **Nina** (who fixed it last time) and
> **Aisha** (who wrote the deploy). It also finds that Diego had warned against that change in `#payments-eng`. Every claim is
> checked against the graph before it is stored, and links back to the nodes and Cypher queries behind it.

Built for **Graph Hacks: Context for AI Agents** (WeMakeDevs × FalkorDB). It targets all three tracks.

![GraphOps: decision brief, live graph and the Why? trace](docs/screenshot.png)

*A real Gemini run. Left: the brief (decision, proof gate VERIFIED, actions waiting for approval), then one collapsible section per
agent. Center: the FalkorDB graph, with the evidence nodes marked. Right: the Why? trace, from the Decision to its Findings to the evidence nodes.*

## Submission at a glance

| | |
| --- | --- |
| **Tracks entered** | **Track 1: Agents That Act on Connected Data** (primary), Track 2: Agent Memory and Coordination, Track 3: Company Brain |
| **FalkorDB's role** | The agents' only context layer. Every tool is a Cypher query or FalkorDB algorithm, and agent findings, decisions, conversation turns and learned incidents are written back into the graph. There is no other database: with FalkorDB unreachable the API fails closed (`/api/status` returns 503) and no agent can run. |
| **Data** | See [data/README.md](data/README.md). **Real public topology:** the `otel` tenant is imported from the open-source [OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo) (its real compose wiring and its 20 real fault flags) by `npm run import:otel`. **Synthetic:** the Acme and Globex companies, and all people, ownership and revenue. No private or restricted data. |
| **Live deployment** | https://graphops-gr4u.onrender.com (Render + FalkorDB Cloud; a private `GRAPH.COPY` sandbox per visitor) |
| **Run it** | `docker compose up --build`, or see [Run it](#run-it) |
| **AI assistance** | Built with Claude Code (AI coding assistant). See [AI assistance disclosure](#ai-assistance-disclosure) |
| **How it works** | [docs/EXPLAINER.md](docs/EXPLAINER.md): architecture, graph model, queries and design decisions in plain language |

## Why a graph

An incident is a question about how things connect. Which upstream services alert *because of* a broken dependency?
What changed *next to* the failing node? Who has fixed *this* system before? What did we *decide* after the last outage?
Each of these is a multi-hop traversal. GraphOps gives its agents those traversals as tools. The agents also
**write their reasoning back into the same graph**, so the graph serves as their shared state, their long-term memory and their audit trail.

## What it does

<p align="center"><img src="docs/architecture.svg" alt="GraphOps architecture (animated)" width="100%"></p>

<details><summary>Text version of the diagram</summary>

```
            ┌────────────── orchestrator ──────────────┐
            │                                          │
   ┌────────▼────────┐  (parallel)  ┌─────────────────▼┐
   │  TRIAGE agent   │              │  HISTORIAN agent │
   │ root cause, blast│             │ episodic/semantic│
   │ radius, deploys, │             │ /procedural      │
   │ PageRank, BC     │             │ memory, ADRs     │
   └────────┬────────┘              └─────────┬────────┘
            │ record_finding                  │ record_finding
            ▼                                 ▼
      ┌──────────────── FalkorDB tenant graph ────────────────┐
      │ (:Investigation)-[:HAS_FINDING]->(:Finding)-[:EVIDENCE]->(any node)
      └───────────────────────────┬───────────────────────────┘
                                  │ read_investigation
                        ┌─────────▼─────────┐
                        │ COMMANDER agent   │  who_to_page → record_decision
                        └─────────┬─────────┘
                                  ▼
   (:Decision)-[:BASED_ON]->(:Finding)  -[:ROOT_CAUSE]->(:Service)  -[:SUSPECTS]->(:Deploy)
              -[:USES]->(:Runbook)       -[:PAGES]->(:Person)
            proof gate (SPpaths + maxFlow) │ VERIFIED / WEAK / REJECTED
                                  ├──▶ (:Action) page + GitHub issue, sent only after a human approves
                                  │  "Fix worked: remember"
                                  ▼
   (:Incident {source:'graphops'})  ← episodic memory the Historian finds next session
   Runbook.success_count += 1       ← procedural memory gets stronger
```

</details>

* **Triage** (Track 1) calls `probable_root_cause`. It walks `DEPENDS_ON*0..5` from every alerting service and ranks the
  nodes that explain the most alerts first (parsimony), then breaks ties by own alerts, the share of failing direct callers,
  being the deepest failing node, and a recent deploy on it or next to it. It then calls
  `recent_changes`, `blast_radius` (upstream services, business capabilities and **revenue at risk per minute**) and
  `dependency_path` (`shortestPath`) to show how the failure propagates. `critical_nodes` runs **PageRank** and
  **betweenness centrality**, and `service_clusters` runs **label propagation**.
* **Historian** (Track 2) runs *at the same time* as Triage and writes to the same investigation. It recalls
  **episodic** memory (`similar_incidents`, including incidents GraphOps itself learned), **procedural** memory (`runbooks_for`,
  ranked by graph distance and how often each runbook worked or failed) and **semantic** memory (`decisions_and_docs`, which covers ADRs,
  documents and `Fact` nodes taught by users, plus full-text `search_knowledge`). For the company brain it calls `trace_change`
  on the suspect deploy (deploy → ticket → project → chat, including warnings that were ignored) and `project_context`.
* **Commander** (Track 3) never receives the other agents' output directly. It **reads the shared investigation subgraph**,
  runs `containment_plan`, ranks who to page (on-call + past resolvers + deploy authors + people who worked on the system,
  each with reasons) and calls `record_decision`. That runs the proof gate, links the `Decision` to every finding, and
  proposes the real-world actions.
* **Chat** answers follow-ups with every tool plus guarded read-only text-to-Cypher. It loads the conversation
  history *from the graph* (`(:Investigation)-[:HAS_TURN]->(:Turn)-[:NEXT]->(:Turn)`), and `remember_fact` lets it learn from users.

### How GraphOps checks its own answers

Gemini can suggest a root cause, but **nothing is stored until FalkorDB backs it up with a causal path.**

* **Causal-path gate.** `record_decision` runs a proof gate before anything is stored. `algo.SPpaths` must return a causal
  `DEPENDS_ON` path from the alerting services to the claimed root cause, the suspect deploy must be adjacent and recent, and a
  silent (healthy) node also needs failing direct callers. `algo.maxFlow` reports how many links you would have to cut to isolate it.
  The verdict is `VERIFIED`, `WEAK` or `REJECTED`. A rejected claim is sent back to the Commander to fix.
* **Citations are checked.** Every id an agent mentions (`INC-2041`, `DEP-981`, `` `payments-db` ``…) is looked up in the graph,
  and the UI shows `✓ 6/6 cited nodes exist in the graph`, or flags the unknown ones.
* **Fixes are tried on a copy first.** `what_if` and `containment_plan` copy the tenant graph with `GRAPH.COPY` and run on the copy.
  Containment tries every combination of up to three fallback modes and picks the smallest set that protects the most revenue,
  then **replays it** on the sandbox (real `DELETE`s, recomputed impact) to prove it. Example: in a Kafka outage, turning on two
  outbox fallbacks *together* keeps **Checkout & Payments ($4,200/min)** up. Neither one does it alone.
* **It learns from failure, too.** *Didn't work* lowers the runbook's rank, and a human correction creates `RB-PAY-01-v2 -[:SUPERSEDES]-> RB-PAY-01`.
  Every later session uses the new version.

### Measured: keyless benchmark

`npm run eval` injects random faults into a `GRAPH.COPY` sandbox (silent root causes, unrelated noise alerts, decoy deploys that
are often newer than the real culprit) and scores the graph tools against hidden ground truth, with no LLM involved.
Full method and numbers: [docs/EVAL.md](docs/EVAL.md).

| 200 random fault worlds, no LLM | Result |
| --- | --- |
| Root cause found, top-1 (graph ranking) | **71.5%** (baselines: most recent deploy 17.5%, random alerting service 17.5%) |
| Root cause in top-3 | **89%** |
| Culprit deploy found (worlds with one) | **85%** (baseline: most recent deploy 53.5%) |
| Proof gate verifies the true root | **71.5%**, otherwise WEAK, never REJECTED (0%) |
| Proof gate verifies an *unrelated* wrong claim | **2.2%** of 138 |

The cost of the gate is recall. When the topology can't separate the culprit from a neighbour on the same causal chain, the gate says
`WEAK` instead of guessing, and the Commander has to say so. The benchmark reports that case separately (see EVAL.md).

### Real-world actions, approved by a human

After every decision GraphOps proposes **actions** as `(:Action {status: 'proposed'})` nodes: page the people it chose in the incident
channel (**Discord or Slack webhook**), and open an **incident issue on GitHub** whose body is the full evidence trail
(proof verdict, findings, evidence nodes). Nothing is sent until a person clicks **Approve**. The approval and the result
(issue URL, or the failure) are written back to the graph as `(:User)-[:APPROVED]->(:Action)-[:FOR_DECISION]->(:Decision)`.
Without credentials, approval runs as a **dry run** that shows the exact payload. In public mode, real sends have a daily cap.

### Real data: the OpenTelemetry Demo

`npm run import:otel` downloads the public [OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo) (`compose.yaml`,
`compose.full.yaml`, `src/flagd/demo.flagd.json`) and builds the **`otel`** tenant: 19 real services and 35 real dependencies, taken
from the `*_ADDR`/`*_HOST` wiring and `depends_on`, plus its fault flags. `npm run eval:otel` replays **every flag that breaks a service**
on a `GRAPH.COPY` sandbox, in three variants, and then the same fault again after it was learned. See [docs/EVAL-OTEL.md](docs/EVAL-OTEL.md).

| OpenTelemetry Demo, 16 real fault flags × 3 variants (46 worlds) | Root cause top-1 | Top-3 | Proof gate VERIFIED |
| --- | --- | --- | --- |
| Broken service alerts | **100%** | 100% | 100% |
| Broken service is silent (only callers alert) | 14.3% | **78.6%** | 100% |
| Plus an unrelated noise alert | **75%** | 100% | 0% (WEAK: it abstains) |
| **Same fault again, after learning it** | Historian recalls the learned incident first in **16/16** faults | | |

A silent root is the hardest case. In this topology most services have a single caller, so "the caller broke" and "its silent dependency
broke" look the same in the graph. GraphOps keeps the true cause in its top 3 (79%) and still verifies it, instead of pretending to know.

### Mapping to the tracks

| Track | What GraphOps does |
| --- | --- |
| **1 · Act on connected data** | Multi-hop root-cause scoring (tested on the **real OpenTelemetry Demo topology and fault flags**), blast radius with revenue impact, **human-approved real actions** (Discord/Slack page, GitHub incident issue), shortest-path propagation, PageRank, betweenness and CDLP as agent tools, a **causal-path proof gate** (`algo.SPpaths` + `algo.maxFlow`), **what-if and containment simulation on `GRAPH.COPY` sandboxes**, an **MCP server** exposing all 26 tools, and a keyless benchmark |
| **2 · Memory & coordination** | Episodic (Incidents), semantic (Facts/ADRs) and procedural (runbook success/failure counts and `SUPERSEDES` versions) memory. Persistent conversation turns, per-user history (`(:User)-[:STARTED]->(:Investigation)`), parallel agents sharing state only through the graph with concurrent writes, **one isolated graph per tenant** (`graphops_acme`, `graphops_globex`, `graphops_otel`) and, live, **one `GRAPH.COPY` sandbox per visitor**. Recall of a repeated fault: **16/16** on the OpenTelemetry Demo |
| **3 · Company brain** | People, teams, **projects, tickets, Slack messages**, services, capabilities, deploys, docs, ADRs and incidents in one graph. `trace_change` follows a deploy to its ticket, project and chat thread and surfaces **warnings that were raised and ignored**. Who owns what, who knows what (`who_knows`), decisions traced to their motivating incident (`ADR-022 -[:MOTIVATED_BY]-> INC-2041`), and answers with sources |

### Explainability you can click

* **The brief** at the top shows the decision, the proof-gate verdict with its causal paths, and the proposed actions with their exact payloads.
* **One section per agent** lists its findings and every tool call. Expand a call to see the **exact Cypher** and its result.
* The **Why? trace** tab renders `Decision → BASED_ON → Finding → EVIDENCE → node` and marks those nodes on the graph.
* The **Cypher log** tab lists every query the agents ran, with row counts and timings. **What-if** runs simulations on a `GRAPH.COPY`.
* The graph lights up each node in the acting agent's colour as tools touch it. The **Layers** menu switches node types on and off.

## Run it

```bash
git clone https://github.com/Yashasm18/graphops.git && cd graphops
```

**Fastest (Docker):** starts FalkorDB and GraphOps together.

```bash
docker compose up --build                          # no API key needed: agents run their scripted graph playbooks
GEMINI_API_KEY=your-key docker compose up --build  # with Gemini agents
# open http://localhost:3000 (the graph seeds itself on first load)
```

**Local Node 20+ and any FalkorDB:**

```bash
docker run -d -p 6379:6379 falkordb/falkordb:latest   # or use FalkorDB Cloud (see below)
npm install
cp .env.example .env      # works as is for a local FalkorDB; GEMINI_API_KEY is optional
npm run seed              # optional: the app also seeds itself on first load
npm start                 # http://localhost:3000
```

FalkorDB options:
* **Docker:** `docker run -p 6379:6379 -p 3001:3000 falkordb/falkordb:latest` (or use `docker compose` above)
* **FalkorDB Cloud:** set `FALKORDB_HOST`, `FALKORDB_PORT`, `FALKORDB_USERNAME`, `FALKORDB_PASSWORD` (and `FALKORDB_TLS=true` if your instance uses TLS).

**No LLM key or rate-limited?** Without `GEMINI_API_KEY` the agents run scripted playbooks automatically (follow-up chat needs the key).
Set `GRAPHOPS_SCRIPTED=true` to force this, or let it fall back by itself on rate limits. Each agent then runs a deterministic
playbook over the *same* graph tools and writes the *same* findings and decisions, so it keeps working. With Gemini,
the agents choose their own tools. Each Gemini model has its own free-tier quota, so on a 429 the model is put on cooldown and the
call moves to the next one in `GEMINI_MODELS` (default `gemini-3.8-flash`, then `gemini-3.5-flash-lite`, `gemini-3.7-flash`…). If an
agent finishes without recording findings, its playbook records grounded ones, so the shared state is never empty.

### Deploy it (Render, free)

[`render.yaml`](render.yaml) is a Render Blueprint: **New → Blueprint → this repo**, then paste the FalkorDB and Gemini secrets.
It runs with `PUBLIC_MODE=true`, so **every visitor gets a private `GRAPH.COPY` sandbox** of the company graph (their investigations,
lessons and runbook edits never touch anyone else's memory) and a small AI budget, after which the agents use their scripted playbooks.

### Tests and benchmark

```bash
npm test          # 14 integration tests against FalkorDB (they use their own graphs: graphops_ci_acme, graphops_ci_otel)
npm run eval      # keyless fault-injection benchmark, writes docs/EVAL.md
npm run import:otel && npm run eval:otel   # real OpenTelemetry Demo topology + its fault flags
```
`npm test` and `npm run eval` run in GitHub Actions against a `falkordb/falkordb` service container on every push.

### Use the graph tools from Claude, Cursor or any MCP client

```json
{
  "mcpServers": {
    "graphops": {
      "command": "node",
      "args": ["/absolute/path/to/graphops/src/mcp.js", "acme"],
      "env": { "FALKORDB_HOST": "localhost", "FALKORDB_PORT": "6379" }
    }
  }
}
```


## Graph model

```
(:Service {name, kind, tier, status})-[:DEPENDS_ON]->(:Service)
(:Service)-[:OWNED_BY]->(:Team)<-[:MEMBER_OF|ON_CALL_FOR]-(:Person)
(:Service)-[:POWERS]->(:Capability {revenue_per_min})
(:Deploy)-[:CHANGED]->(:Service), (:Deploy)-[:AUTHORED_BY]->(:Person)
(:Alert)-[:FIRED_ON]->(:Service)
(:Incident)-[:ROOT_CAUSE|AFFECTED]->(:Service), -[:RESOLVED_BY]->(:Person), -[:MITIGATED_WITH]->(:Runbook), -[:TRIGGERED_BY]->(:Deploy)
(:Runbook {success_count, failure_count, version})-[:FOR]->(:Service), (:Runbook)-[:SUPERSEDES]->(:Runbook)
(:Decision)-[:ABOUT]->(:Service), -[:MADE_BY]->(:Person), -[:MOTIVATED_BY]->(:Incident)
(:Document)-[:DOCUMENTS]->(:Service), (:Fact)-[:ABOUT]->(:Service), (:Person)-[:WORKED_ON]->(:Service)
(:Project)-[:OWNED_BY]->(:Team), (:Project)-[:TOUCHES]->(:Service), (:Person)-[:WORKS_ON]->(:Project)
(:Ticket)-[:PART_OF]->(:Project), (:Ticket)-[:ABOUT]->(:Service), (:Ticket)-[:ASSIGNED_TO]->(:Person), (:Ticket)-[:FOLLOWS_UP]->(:Decision)
(:Deploy)-[:IMPLEMENTS]->(:Ticket), (:Message {channel})-[:POSTED_BY]->(:Person), (:Message)-[:MENTIONS]->(:Ticket|:Incident|:Decision|:Service)
-- agent state & memory --
(:User)-[:STARTED]->(:Investigation)-[:HAS_FINDING]->(:Finding {agent, kind, confidence})-[:EVIDENCE]->(*)
(:Investigation)-[:CONCLUDED]->(:Decision {source:'agent'})-[:BASED_ON]->(:Finding)
(:Investigation)-[:HAS_TURN]->(:Turn)-[:NEXT]->(:Turn)
(:Incident {source:'graphops'})-[:FROM_INVESTIGATION]->(:Investigation)
(:Decision {verdict, coverage})-[:ROOT_CAUSE|SUSPECTS|USES|PAGES|ABOUT]->(…)
(:Action {kind, status, payload})-[:FOR_DECISION]->(:Decision), (:User)-[:APPROVED]->(:Action), (:Action)-[:NOTIFIES]->(:Person)
```

## Cypher queries and algorithms the product depends on

All of these live in [`src/tools.js`](src/tools.js). Each agent tool is one of them.

**1. Root-cause ranking** (`probable_root_cause`). Multi-hop from every alerting service. Explaining the most alerts counts most; own alerts, failing direct callers, depth and a nearby recent deploy break ties. Excerpt:
```cypher
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
RETURN c.name AS candidate, explains, depth, own_alerts, alerting_deps,
       collect(DISTINCT {deploy: d.id, service: x.name}) AS nearby_deploys
```

**2. Blast radius and revenue at risk** (`blast_radius`). Reverse traversal to everything upstream and the business capabilities it powers.
```cypher
MATCH p = (up:Service)-[:DEPENDS_ON*1..4]->(s:Service {name: $service})
WITH up, min(length(p)) AS hops
MATCH (up)-[:OWNED_BY]->(team:Team)
RETURN up.name, up.tier, hops, team.name ORDER BY hops;

MATCH (s:Service {name: $service})<-[:DEPENDS_ON*0..4]-(x:Service)-[:POWERS]->(c:Capability)
RETURN c.name, c.revenue_per_min, collect(DISTINCT x.name) AS via
```

**3. Failure propagation path** (`dependency_path`). FalkorDB `shortestPath`.
```cypher
MATCH (a:Service {name: $from}), (b:Service {name: $to})
WITH a, b
RETURN [n IN nodes(shortestPath((a)-[:DEPENDS_ON*1..10]->(b))) | n.name] AS path
```

**4. Graph algorithms as agent tools** (`critical_nodes`, `service_clusters`).
```cypher
CALL algo.pageRank('Service', 'DEPENDS_ON') YIELD node, score RETURN node.name, score ORDER BY score DESC LIMIT 8;
CALL algo.betweenness({nodeLabels: ['Service'], relationshipTypes: ['DEPENDS_ON'], samplingSize: 64, samplingSeed: 7})
  YIELD node, score RETURN node.name, score ORDER BY score DESC LIMIT 8;
CALL algo.labelPropagation({nodeLabels: ['Service'], relationshipTypes: ['DEPENDS_ON']})
  YIELD node, communityId RETURN communityId, collect(node.name) AS services
```

**5. Episodic memory recall** (`similar_incidents`). Past incidents ranked by service overlap, with a bonus when the root cause matches.
```cypher
MATCH (i:Incident)-[:AFFECTED|ROOT_CAUSE]->(s:Service) WHERE s.name IN $services
WITH i, collect(DISTINCT s.name) AS overlap
MATCH (i)-[:ROOT_CAUSE]->(root:Service)
OPTIONAL MATCH (i)-[:RESOLVED_BY]->(p:Person)
OPTIONAL MATCH (i)-[:MITIGATED_WITH]->(rb:Runbook)
RETURN i.id, i.title, root.name, overlap, p.name AS resolved_by, rb.id AS runbook,
       size(overlap) + CASE WHEN root.name IN $services THEN 2 ELSE 0 END AS similarity
ORDER BY similarity DESC
```

**6. Procedural memory** (`runbooks_for`). Current runbook versions, ranked by graph distance, then by times worked minus times failed.
```cypher
MATCH p = (s:Service {name: $service})-[:DEPENDS_ON*0..2]-(x:Service)<-[:FOR]-(rb:Runbook)
WHERE NOT ()-[:SUPERSEDES]->(rb)          // only the current version of each runbook
WITH rb, x, min(length(p)) AS distance
RETURN rb.id, rb.title, x.name, distance, rb.success_count, coalesce(rb.failure_count, 0) AS failed
ORDER BY distance, rb.success_count - failed DESC
```

**7. Who to page** (`who_to_page`). Combines four relationship types into a ranked list with reasons. See `src/tools.js`.
On-call `(:Person)-[:ON_CALL_FOR]->(:Team)<-[:OWNED_BY]-(s)`, past resolvers `(s)<-[:ROOT_CAUSE|AFFECTED]-(:Incident)-[:RESOLVED_BY]->(:Person)`,
recent deploy authors `(s)-[:DEPENDS_ON*0..1]-(:Service)<-[:CHANGED]-(:Deploy)-[:AUTHORED_BY]->(:Person)` and `(:Person)-[:WORKED_ON]->(s)`.

**8. Shared state and the decision trace** (`record_finding`, `record_decision`, `decisionTrace`).
```cypher
// a finding linked to its evidence nodes
MATCH (inv:Investigation {id: $inv})
CREATE (inv)-[:HAS_FINDING]->(f:Finding {agent: $agent, kind: $kind, summary: $summary, confidence: $confidence})
WITH f
OPTIONAL MATCH (n) WHERE n.name IN $evidence OR n.id IN $evidence
FOREACH (_ IN CASE WHEN n IS NULL THEN [] ELSE [1] END | CREATE (f)-[:EVIDENCE]->(n));

// "why?": decision -> findings -> evidence
MATCH (:Investigation {id: $id})-[:CONCLUDED]->(d:Decision)-[:BASED_ON]->(f:Finding)-[:EVIDENCE]->(e)
RETURN d, f, e
```

**9. Learning from a resolved incident** (`resolveInvestigation` in [`src/memory.js`](src/memory.js)). The decision becomes an `Incident` with
`ROOT_CAUSE`, `AFFECTED`, `RESOLVED_BY`, `MITIGATED_WITH` and `TRIGGERED_BY` edges, and `SET rb.success_count = rb.success_count + 1`.

**10. Proof gate** (`verifyRootCause` in [`src/proof.js`](src/proof.js)).
```cypher
MATCH (a:Service {name: $alerting}), (r:Service {name: $root})
CALL algo.SPpaths({sourceNode: a, targetNode: r, relTypes: ['DEPENDS_ON'], pathCount: 1, maxLen: 6})
YIELD path RETURN [n IN nodes(path) | n.name] AS path;

MATCH (e:Service) WHERE NOT ()-[:DEPENDS_ON]->(e) AND (e)-[:DEPENDS_ON*1..8]->(:Service {name: $root})
WITH collect(e) AS entries MATCH (r:Service {name: $root})
CALL algo.maxFlow({sourceNodes: entries, targetNodes: [r], relationshipTypes: ['DEPENDS_ON'], capacityProperty: 'capacity'})
YIELD maxFlow RETURN maxFlow   // = minimum links to cut to isolate the root (Menger)
```

**11. What-if and containment on a sandbox** (`whatIf`, `containmentPlan`). `GRAPH.COPY graphops_acme graphops_acme_sim_x`, then:
```cypher
MATCH (cap:Capability)<-[:POWERS]-(s:Service)
OPTIONAL MATCH p = (s)-[:DEPENDS_ON*0..8]->(d:Service) WHERE d.name IN $down
  AND none(r IN relationships(p) WHERE (startNode(r).name + '->' + endNode(r).name) IN $cut)
WITH cap, count(p) AS hits
RETURN cap.name, cap.revenue_per_min, hits > 0 AS impacted
```

**12. Full-text knowledge search** (`search_knowledge`).
```cypher
CALL db.idx.fulltext.createNodeIndex('Incident', 'title', 'summary');
CALL db.idx.fulltext.queryNodes('Incident', $q) YIELD node, score RETURN node.id, node.title, score
```

**13. Why was this change made?** (`trace_change`). Deploy → ticket → project → chat, plus open follow-ups that were skipped.
```cypher
MATCH (d:Deploy {id: $id})-[:CHANGED]->(s:Service), (d)-[:AUTHORED_BY]->(a:Person)
OPTIONAL MATCH (d)-[:IMPLEMENTS]->(tk:Ticket)-[:PART_OF]->(pr:Project)-[:OWNED_BY]->(team:Team)
RETURN d.id, s.name, a.name, tk.id, pr.name, team.name;

MATCH (m:Message)-[:MENTIONS]->(x) WHERE x.id IN [$deploy, $ticket]
MATCH (m)-[:POSTED_BY]->(p) OPTIONAL MATCH (m)-[:MENTIONS]->(other)
RETURN m.text, p.name, collect(coalesce(other.id, other.name)) AS mentions ORDER BY m.at;
// a message that cites an INC-/ADR- id in that thread is a warning that was raised

MATCH (tk:Ticket)-[:ABOUT]->(:Service {name: $svc}) WHERE tk.status <> 'done'
OPTIONAL MATCH (tk)-[:FOLLOWS_UP]->(dec:Decision) RETURN tk.id, tk.title, dec.id
```

## Code map

| File | Purpose |
| --- | --- |
| `src/tools.js` | 26 graph tools (Cypher + FalkorDB algorithms) shared by the agents, the HTTP API and MCP |
| `src/proof.js` | Proof gate (SPpaths, maxFlow), GRAPH.COPY sandboxes, what-if, containment search, citation checks |
| `src/eval.js` | Keyless fault-injection benchmark (`npm run eval`, `npm run eval:otel`) |
| `src/import-otel.js` | Imports the public OpenTelemetry Demo topology and fault flags (`data/otel-demo.json`) |
| `src/actions.js` | Human-approved actions: Discord/Slack page and GitHub incident issue, audited in the graph |
| `test/` | Integration tests against a real FalkorDB (`npm test`), run in GitHub Actions |
| `src/agents.js` | Gemini function-calling loop, triage/historian/commander/chat agents, parallel orchestration, scripted fallback |
| `src/memory.js` | Investigations, turns, per-user history, decision trace, and resolve → episodic memory |
| `src/seed.js` | Multi-tenant seed data (Acme e-commerce, Globex streaming, and the OpenTelemetry Demo topology) |
| `src/db.js` | FalkorDB connection, per-tenant graphs, Cypher tracing via AsyncLocalStorage |
| `src/server.js` | Express API, NDJSON event streaming, public mode (per-visitor sandboxes, AI quota) |
| `src/mcp.js` | MCP stdio server |
| `public/` | Ops console UI (vis-network). `?tenant=acme&inv=INV-…` deep-links to an investigation from memory (`&v=<id>` picks a sandbox) |
| `Dockerfile`, `docker-compose.yml` | One-command FalkorDB + GraphOps |

## AI assistance disclosure

As the rules require: GraphOps was built with **Claude Code** (Anthropic), an AI coding assistant, and the agents use
**Google Gemini** at runtime.

* **Claude Code** proposed the idea, and wrote most of the code, seed data, tests, benchmarks and documentation. It also ran
  the tests and benchmarks and fixed the issues they found.
* **The author (Yashas M)** directed the work and made the calls. That includes going for an entry that covers all three tracks,
  choosing Gemini and FalkorDB Cloud, and asking for the competitor comparison, the real-world actions, the public OpenTelemetry
  data and the README changes. The author set up and connected every external service (FalkorDB Cloud, the Gemini API, GitHub,
  Render, the Discord webhook and the GitHub issues token), and verified the live deployment, including a real approved page and GitHub issue.
* [docs/EXPLAINER.md](docs/EXPLAINER.md) documents the architecture, graph model, queries and design decisions in plain language.

## License

MIT
