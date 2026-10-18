# ◈ GraphOps: a multi-agent incident commander on FalkorDB

> "Checkout is throwing 500s and customers can't pay." In seconds GraphOps says it's **payments-db**
> connection exhaustion triggered by **DEP-981** (a retry change shipped 23 minutes ago). This is the same failure as **INC-2041**,
> so it recommends rolling back and following **RB-PAY-01**, and it pages **Diego** (on call), **Nina** (who fixed it last time) and
> **Aisha** (who wrote the deploy). Every claim links back to the graph nodes and Cypher queries behind it.

Built for **Graph Hacks: Context for AI Agents** (WeMakeDevs × FalkorDB). It targets all three tracks.

## Why a graph

An incident is a question about how things connect. Which upstream services alert *because of* a broken dependency?
What changed *next to* the failing node? Who has fixed *this* system before? What did we *decide* after the last outage?
Each of these is a multi-hop traversal. GraphOps gives its agents those traversals as tools. The agents also
**write their reasoning back into the same graph**, so the graph serves as their shared state, their long-term memory and their audit trail.

## What it does

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
                                  │  "Mark resolved & remember"
                                  ▼
   (:Incident {source:'graphops'})  ← episodic memory the Historian finds next session
   Runbook.success_count += 1       ← procedural memory gets stronger
```

* **Triage** (Track 1) calls `probable_root_cause`. It walks `DEPENDS_ON*0..5` from every alerting service and scores the
  nodes that explain the most alerts, boosting the deepest alerting node and nodes next to a recent deploy. It then calls
  `recent_changes`, `blast_radius` (upstream services, business capabilities and **revenue at risk per minute**) and
  `dependency_path` (`shortestPath`) to show how the failure propagates. `critical_nodes` runs **PageRank** and
  **betweenness centrality**, and `service_clusters` runs **label propagation**.
* **Historian** (Track 2) runs *at the same time* as Triage and writes to the same investigation. It recalls
  **episodic** memory (`similar_incidents`, including incidents GraphOps itself learned), **procedural** memory (`runbooks_for`,
  ranked by graph distance and how often each runbook worked) and **semantic** memory (`decisions_and_docs`, which covers ADRs,
  documents and `Fact` nodes taught by users).
* **Commander** (Track 3) never receives the other agents' output directly. It **reads the shared investigation subgraph**,
  ranks who to page (on-call + past resolvers + deploy authors + people who worked on the system, each with reasons)
  and records a `Decision` linked to every finding, which in turn links to its evidence nodes.
* **Chat** answers follow-ups with every tool plus guarded read-only text-to-Cypher. It loads the conversation
  history *from the graph* (`(:Investigation)-[:HAS_TURN]->(:Turn)-[:NEXT]->(:Turn)`), and `remember_fact` lets it learn from users.

### Mapping to the tracks

| Track | What GraphOps does |
| --- | --- |
| **1 · Act on connected data** | Multi-hop root-cause scoring, blast radius with revenue impact, shortest-path propagation, PageRank, betweenness and CDLP as agent tools, an **MCP server** exposing all 19 tools, and decisions you can explain from evidence |
| **2 · Memory & coordination** | Episodic (Incidents), semantic (Facts/ADRs) and procedural (Runbook success counts) memory. Persistent conversation turns, per-user history (`(:User)-[:STARTED]->(:Investigation)`), parallel agents sharing state only through the graph with concurrent writes, and **one isolated graph per tenant** (`graphops_acme`, `graphops_globex`) |
| **3 · Company brain** | People, teams, services, capabilities, deploys, docs, ADRs and incidents in one graph. Who owns what, who knows what (`who_knows`), decisions traced to their motivating incident (`ADR-022 -[:MOTIVATED_BY]-> INC-2041`), and answers with sources |

### Explainability you can click

* Each agent step in the timeline shows the tool, its arguments, its result and the **exact Cypher with parameters**.
* The **Why? trace** tab renders `Decision → BASED_ON → Finding → EVIDENCE → node` and highlights that subgraph on the canvas.
* The **Cypher log** tab lists every query the agents ran, with row counts and timings.
* The live graph pulses each node in the acting agent's colour as tools touch it.

## Run it

```bash
cd graphops
npm install
cp .env.example .env      # add GEMINI_API_KEY and FalkorDB connection
npm run seed              # seeds tenants acme + globex
npm start                 # http://localhost:3000
```

FalkorDB options:
* **Docker:** `docker run -p 6379:6379 -p 3001:3000 falkordb/falkordb:latest`
* **FalkorDB Cloud:** set `FALKORDB_HOST`, `FALKORDB_PORT`, `FALKORDB_USERNAME`, `FALKORDB_PASSWORD` (and `FALKORDB_TLS=true` if your instance uses TLS).

**No LLM key or rate-limited?** Set `GRAPHOPS_SCRIPTED=true`, or let it fall back by itself. Each agent then runs a deterministic
playbook over the *same* graph tools and writes the *same* findings and decisions, so the demo never breaks. With Gemini,
the agents choose their own tools. On a 429 they back off and step down from `gemini-3.8-flash` to `gemini-3.5-flash-lite`.

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

## Demo script (3 minutes)

1. Show the graph: 25 services, 7 teams, 14 people, deploys, alerts, incidents, runbooks and ADRs. Toggle the layers.
2. Click **Investigate**. Triage and Historian run in parallel, and nodes pulse in each agent's colour.
3. Open a tool card and show the Cypher. Open the **Cypher log**.
4. The Commander's decision card appears. Click **Why?** to walk Decision → Findings → evidence nodes.
5. Ask a follow-up: *"who else knows payments-db, and why did we add pgbouncer?"* The answer cites ADR-014 and Nina.
6. Teach a fact: *"remember that payments-db max_connections was raised to 800 last week"*. It becomes a `Fact` node.
7. Click **Mark resolved & remember**. The investigation becomes `INC-xxxx`, and RB-PAY-01's success count goes up.
8. Click **Re-fire alerts**, then **Investigate** again. The Historian now recalls the incident it learned a minute ago,
   and the fact you taught it. That is memory across sessions.
9. Switch tenant to **Globex**. It's a different, isolated graph in the same FalkorDB instance, with different answers.

## Graph model

```
(:Service {name, kind, tier, status})-[:DEPENDS_ON]->(:Service)
(:Service)-[:OWNED_BY]->(:Team)<-[:MEMBER_OF|ON_CALL_FOR]-(:Person)
(:Service)-[:POWERS]->(:Capability {revenue_per_min})
(:Deploy)-[:CHANGED]->(:Service), (:Deploy)-[:AUTHORED_BY]->(:Person)
(:Alert)-[:FIRED_ON]->(:Service)
(:Incident)-[:ROOT_CAUSE|AFFECTED]->(:Service), -[:RESOLVED_BY]->(:Person), -[:MITIGATED_WITH]->(:Runbook), -[:TRIGGERED_BY]->(:Deploy)
(:Runbook {success_count})-[:FOR]->(:Service)
(:Decision)-[:ABOUT]->(:Service), -[:MADE_BY]->(:Person), -[:MOTIVATED_BY]->(:Incident)
(:Document)-[:DOCUMENTS]->(:Service), (:Fact)-[:ABOUT]->(:Service), (:Person)-[:WORKED_ON]->(:Service)
-- agent state & memory --
(:User)-[:STARTED]->(:Investigation)-[:HAS_FINDING]->(:Finding {agent, kind, confidence})-[:EVIDENCE]->(*)
(:Investigation)-[:CONCLUDED]->(:Decision {source:'agent'})-[:BASED_ON]->(:Finding)
(:Investigation)-[:HAS_TURN]->(:Turn)-[:NEXT]->(:Turn)
(:Incident {source:'graphops'})-[:FROM_INVESTIGATION]->(:Investigation)
```

## Code map

| File | Purpose |
| --- | --- |
| `src/tools.js` | 19 graph tools (Cypher + FalkorDB algorithms) shared by the agents, the HTTP API and MCP |
| `src/agents.js` | Gemini function-calling loop, triage/historian/commander/chat agents, parallel orchestration, scripted fallback |
| `src/memory.js` | Investigations, turns, per-user history, decision trace, and resolve → episodic memory |
| `src/seed.js` | Multi-tenant seed data (Acme e-commerce, Globex streaming) |
| `src/db.js` | FalkorDB connection, per-tenant graphs, Cypher tracing via AsyncLocalStorage |
| `src/server.js` | Express API and NDJSON event streaming |
| `src/mcp.js` | MCP stdio server |
| `public/` | Ops console UI (vis-network) |
