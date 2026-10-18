import 'dotenv/config';
import { FalkorDB } from 'falkordb';
import { AsyncLocalStorage } from 'node:async_hooks';

// Every Cypher query run inside a traced scope is recorded, so each agent
// answer can show the exact graph operations behind it.
export const traceStore = new AsyncLocalStorage();

let dbPromise;

export function getDb() {
  if (!dbPromise) {
    const tls = process.env.FALKORDB_TLS === 'true';
    dbPromise = FalkorDB.connect({
      username: process.env.FALKORDB_USERNAME || undefined,
      password: process.env.FALKORDB_PASSWORD || undefined,
      socket: {
        host: process.env.FALKORDB_HOST || 'localhost',
        port: Number(process.env.FALKORDB_PORT || 6379),
        tls,
        connectTimeout: 10000,
      },
    }).catch((err) => {
      dbPromise = null; // retry on the next call instead of caching the failure
      throw err;
    });
  }
  return dbPromise;
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
