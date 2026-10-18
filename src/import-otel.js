// Imports the public OpenTelemetry Demo ("Astronomy Shop") into a GraphOps
// tenant spec: the service topology comes from its real compose files (the
// *_ADDR / *_HOST wiring and depends_on), the faults from its real flagd
// feature flags. Ownership, people and revenue are synthetic.
//   npm run import:otel   -> writes data/otel-demo.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { parse } from 'yaml';

const REPO = 'open-telemetry/opentelemetry-demo';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const FILES = ['compose.yaml', 'compose.full.yaml', 'src/flagd/demo.flagd.json'];

// Observability, tooling and traffic generators are not part of the product path.
const SKIP = new Set(['otel-collector', 'flagd-ui', 'telemetry-docs', 'load-generator', 'jaeger', 'grafana',
  'prometheus', 'opensearch', 'llm', 'agent', 'chatbot', 'firepit', 'opamp-server']);

// Env var prefix -> service name, as wired in the compose files.
const ADDR = {
  AD: 'ad', CART: 'cart', CHECKOUT: 'checkout', CURRENCY: 'currency', EMAIL: 'email', FRONTEND: 'frontend',
  FRONTEND_PROXY: 'frontend-proxy', ENVOY: 'frontend-proxy', IMAGE_PROVIDER: 'image-provider', PAYMENT: 'payment',
  PRODUCT_CATALOG: 'product-catalog', QUOTE: 'quote', RECOMMENDATION: 'recommendation', SHIPPING: 'shipping',
  VALKEY: 'valkey-cart', KAFKA: 'kafka', POSTGRES: 'astronomy-db', FLAGD: 'flagd',
};

// Which service each fault flag breaks (from the flag descriptions).
const FLAG_TARGET = {
  adFailure: 'ad', adHighCpu: 'ad', adManualGc: 'ad', cartFailure: 'cart', failedReadinessProbe: 'cart',
  cartMetricCardinalityOverflow: null, emailMemoryLeak: 'email', imageSlowLoad: 'image-provider',
  intlShippingSlowdown: 'shipping', kafkaConsumerDead: 'fraud-detection', kafkaQueueProblems: 'fraud-detection',
  loadGeneratorFloodHomepage: 'frontend', paymentFailure: 'payment', paymentUnreachable: 'payment',
  productCatalogFailure: 'product-catalog', productCatalogLockContention: 'astronomy-db',
  recommendationCacheFailure: 'recommendation', emitRawPii: null, aiRunawayAgent: null, aiSlowResponse: null,
};

const KIND = { 'valkey-cart': 'cache', kafka: 'queue', 'astronomy-db': 'database', flagd: 'service' };

async function get(path) {
  const res = await fetch(`${RAW}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

const envNames = (env) => (Array.isArray(env) ? env.map((e) => String(e).split('=')[0]) : Object.keys(env || {}));
const depNames = (d) => (Array.isArray(d) ? d : Object.keys(d || {}));

export async function importOtel() {
  const [base, full, flagsRaw] = await Promise.all(FILES.map(get));
  const services = {};
  for (const doc of [parse(base), parse(full)]) {
    for (const [name, svc] of Object.entries(doc.services || {})) {
      const s = (services[name] ||= { env: new Set(), deps: new Set() });
      envNames(svc.environment).forEach((e) => s.env.add(e));
      depNames(svc.depends_on).forEach((d) => s.deps.add(d));
    }
  }
  const nodes = Object.keys(services).filter((n) => !SKIP.has(n));
  const edges = new Set();
  for (const name of nodes) {
    const s = services[name];
    for (const e of s.env) {
      const m = e.match(/^([A-Z_]+?)_(ADDR|HOST)$/);
      const target = m && ADDR[m[1]];
      if (target && target !== name && nodes.includes(target)) edges.add(`${name}>${target}`);
    }
    for (const d of s.deps) if (d !== name && nodes.includes(d)) edges.add(`${name}>${d}`);
  }
  const flags = Object.entries(JSON.parse(flagsRaw).flags).map(([flag, f]) => ({
    flag, description: f.description, target: FLAG_TARGET[flag] ?? null,
  }));
  const out = {
    source: { repo: `https://github.com/${REPO}`, files: FILES, fetched_at: new Date().toISOString() },
    services: nodes.map((n) => ({ name: n, kind: KIND[n] || 'service' })),
    deps: [...edges].map((e) => e.split('>')),
    flags,
  };
  mkdirSync('data', { recursive: true });
  writeFileSync('data/otel-demo.json', JSON.stringify(out, null, 2));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = await importOtel();
  console.log(`imported ${o.services.length} services, ${o.deps.length} dependencies, ${o.flags.length} fault flags`);
  console.log(o.deps.map((d) => d.join(' -> ')).join('\n'));
  console.log('faults with a target:', o.flags.filter((f) => f.target).map((f) => `${f.flag}->${f.target}`).join(', '));
}
