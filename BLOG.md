# Your incident agent doesn't need a bigger context window. It needs a graph.

*How I built GraphOps, a multi-agent incident commander that reasons over FalkorDB, remembers every outage and shows its work.*

---

It's 2 a.m. and checkout is throwing 500s. Five alerts are firing across four services. The on-call engineer opens
Grafana, then the deploy log, then the service catalog, then Slack search ("didn't this happen before?"), then the wiki.
Half an hour later they've rebuilt in their head a picture that already existed, scattered across ten tools.

That reconstruction is the actual work of incident response, and it is graph work:

* *Which alerting services are symptoms, and which one is the cause?* → follow `DEPENDS_ON` until the alerts stop.
* *What changed near the failure?* → deploys one hop from the root cause.
* *What breaks next?* → reverse traversal to every upstream service and the business capability it powers.
* *Have we seen this before? Who fixed it?* → incidents that share the root cause → `RESOLVED_BY` → person.
* *Why is the system built like this?* → `(:Decision)-[:ABOUT]->(:Service)`, `-[:MOTIVATED_BY]->(:Incident)`.

A vector store returns chunks that look similar. A graph returns the relationships, and it can show the path.
So for the FalkorDB Graph Hacks hackathon I built **GraphOps**.

## The shape of it

GraphOps stores a company's operational knowledge in one FalkorDB graph per tenant: services and their dependencies, teams and on-call,
people and what they've worked on, deploys, alerts, past incidents, runbooks, architecture decisions and docs.

Three agents work an incident:

1. **Triage** finds the root cause and blast radius.
2. **Historian** recalls precedents, runbooks and decisions.
3. **Commander** decides what to do and who to page.

The design choice I'm proudest of is that **the agents never talk to each other directly**. Triage and Historian
run in parallel and write `Finding` nodes into a shared `Investigation` subgraph. Each finding is linked by `EVIDENCE` edges
to the services, deploys, incidents and people it's based on. The Commander starts by *reading that subgraph*. It then
writes a `Decision` with `BASED_ON` edges to every finding.

That one choice gives you three things:

* **Shared state** between agents with no message bus.
* **An audit trail.** "Why did you page Nina?" is a two-hop query:
  `(:Decision)-[:BASED_ON]->(:Finding)-[:EVIDENCE]->(nina)`.
* **Memory.** When you mark the incident resolved, GraphOps turns the investigation into an `Incident` node with
  `ROOT_CAUSE`, `AFFECTED`, `RESOLVED_BY`, `MITIGATED_WITH` and `TRIGGERED_BY` edges, and bumps the runbook's `success_count`.
  Next time, the Historian finds it like any other incident in the history.

## Tools, not a text-to-Cypher free-for-all

I gave the LLM (Gemini 3.8 Flash) **19 small named graph tools** instead of asking it to write Cypher from scratch.
Each tool is one well-tested traversal or algorithm:

```cypher
// probable_root_cause: which node explains the most alerts?
MATCH (al:Alert {status:'firing'})-[:FIRED_ON]->(a:Service)
WITH collect(DISTINCT a) AS alerting
UNWIND alerting AS a
MATCH p = (a)-[:DEPENDS_ON*0..5]->(c:Service)
WITH c, alerting, collect(DISTINCT a.name) AS explains, max(length(p)) AS depth
...
```

That candidate is then boosted if it is alerting itself, if none of its own dependencies alert (it's the *deepest* failure),
and if a deploy landed on it or on a direct dependent in the last three hours. In the Acme scenario it picks `payments-db`,
which explains alerts on five services, and flags `DEP-981`, a retry change on `payments-service` shipped 23 minutes earlier.

FalkorDB's built-in algorithms are tools too: `algo.pageRank` and `algo.betweenness` find load-bearing services
(checkout and payments are the chokepoints), and `algo.labelPropagation` clusters tightly coupled services.
There's still a guarded `run_cypher` tool for questions nothing else answers. It's read-only (`GRAPH.RO_QUERY`) and keyword-filtered.

The tools sit in one module shared by three front doors: the agents, the HTTP API and an **MCP server**. Any MCP client,
such as Claude Desktop or Cursor, can call `who_to_page` or `blast_radius` against the same graph.

## Making every answer traceable

Every Cypher query runs through a wrapper that records it into an `AsyncLocalStorage` trace scoped to the current tool call.
The UI streams those as they happen. You see `⚙ blast_radius(payments-db)`, expand it, and read the exact query and
parameters. Nodes on the canvas pulse in the colour of the agent touching them. The **Why?** tab draws the decision's
evidence chain and highlights it in the graph.

## Three kinds of memory, all in the graph

* **Episodic:** `Incident` nodes, including those GraphOps learned itself (`source: 'graphops'`).
* **Semantic:** `Fact` nodes taught by users in chat ("remember payments-db max_connections is now 800"), plus ADRs and docs.
* **Procedural:** `Runbook.success_count`, which goes up every time a runbook resolves an incident and drives its ranking.

Conversation turns are a linked list (`(:Turn)-[:NEXT]->(:Turn)`) under each investigation, so a follow-up question
the next day picks up the context. Users have their own history (`(:User)-[:STARTED]->(:Investigation)`). Tenants
get **separate graphs in one FalkorDB instance** (`graphops_acme`, `graphops_globex`), so there's no row-level filtering to get wrong.

## Surviving the free tier

Free-tier LLM quotas are tight. GraphOps retries 429s using the server's `retryDelay`, then steps down
to a lighter model. If the LLM is still unavailable, each agent switches to a **scripted playbook** that calls the *same*
graph tools and writes the *same* findings and decisions. The graph does the reasoning, and the LLM picks tools and
writes the summary. The scripted mode reaching the same answer is a decent sign the context layer is doing the heavy lifting.

## What I learned

* **Make the graph the protocol between agents.** Shared state, observability and memory came out of the same design.
* **Small named tools beat raw text-to-Cypher** for reliability, and they're easier to explain to judges and on-call engineers.
* **Model what actually happened, not just the documents about it.** "Nina resolved INC-2041" is an edge. It's what makes
  "who should I page?" answerable.
* FalkorDB quirk: `shortestPath` must sit in `WITH`/`RETURN`, not `MATCH`:
  `RETURN [n IN nodes(shortestPath((a)-[:DEPENDS_ON*1..10]->(b))) | n.name]`.

GraphOps is open source. Run `npm run seed && npm start`, click **Investigate**, then resolve the incident, re-fire the alerts and
watch the Historian remember.
