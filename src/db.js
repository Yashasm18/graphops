import 'dotenv/config';
import { FalkorDB } from 'falkordb';
import { AsyncLocalStorage } from 'node:async_hooks';

// Every Cypher query run inside a traced scope is recorded, so each agent
// answer can show the exact graph operations behind it.
export const traceStore = new AsyncLocalStorage();

// The client forwards socket errors (timeouts, resets) as 'error' events on the
// FalkorDB instance, sometimes before we hold it to add a listener. An 'error'
// event with no listener crashes Node, so log those instead: the next query
// reconnects (see getDb) and the API reports a clear 503 meanwhile.
const emit = FalkorDB.prototype.emit;
FalkorDB.prototype.emit = function guardedEmit(event, ...args) {
  if (event === 'error' && this.listenerCount('error') === 0) {
    console.error(`[falkordb] ${args[0]?.message || args[0]}`);
    return false;
  }
  return emit.call(this, event, ...args);
};

let dbPromise;

let connected = false;

export function getDb() {
  if (!dbPromise) {
    connected = false;
    const tls = process.env.FALKORDB_TLS === 'true';
    dbPromise = FalkorDB.connect({
      username: process.env.FALKORDB_USERNAME || undefined,
      password: process.env.FALKORDB_PASSWORD || undefined,
      socket: {
        host: process.env.FALKORDB_HOST || 'localhost',
        port: Number(process.env.FALKORDB_PORT || 6379),
        tls,
        connectTimeout: 5000,
        // Reconnect after drops, but give up eventually so a dead endpoint
        // does not keep retrying in the background forever.
        reconnectStrategy: (retries) => ((!connected && retries >= 2) || retries > 20
          ? new Error('FalkorDB unreachable') : Math.min(200 * (retries + 1), 3000)),
      },
    }).then((db) => {
      connected = true;
      db.on('error', (err) => console.error(`[falkordb] ${err?.message || err}`));
      return db;
    }).catch((err) => {
      dbPromise = null; // retry on the next call instead of caching the failure
      throw err;
    });
  }
  return dbPromise;
}

// Human-readable connection errors (node-redis often throws an AggregateError
// with an empty message when every address is refused).
export function describeDbError(err) {
  const inner = err?.errors?.[0] || err;
  const msg = inner?.message || inner?.code || String(err);
  const where = `${process.env.FALKORDB_HOST || 'localhost'}:${process.env.FALKORDB_PORT || 6379}`;
  return `cannot reach FalkorDB at ${where} (${msg}). Start one with "docker run -p 6379:6379 falkordb/falkordb:latest", or set FALKORDB_HOST / FALKORDB_PORT in .env.`;
}

export function tenantGraphName(tenant) {
  if (!/^[a-z0-9_-]{1,40}$/i.test(tenant)) throw new Error(`invalid tenant: ${tenant}`);
  return `graphops_${tenant}`;
}

export async function graphFor(tenant) {
  const db = await getDb();
  return db.selectGraph(tenantGraphName(tenant));
}

export async function listTenants() {
  const db = await getDb();
  const graphs = await db.list();
  return graphs.filter((g) => g.startsWith('graphops_')).map((g) => g.slice('graphops_'.length));
}

// Run a query against a tenant graph, recording it in the active trace.
export async function cypher(tenant, query, params = {}, { readOnly = false } = {}) {
  const graph = await graphFor(tenant);
  const started = Date.now();
  const res = readOnly
    ? await graph.roQuery(query, { params })
    : await graph.query(query, { params });
  const rows = res.data || [];
  const trace = traceStore.getStore();
  if (trace) {
    trace.push({
      query: query.replace(/\s+/g, ' ').trim(),
      params,
      rows: rows.length,
      ms: Date.now() - started,
    });
  }
  return rows;
}
