// MCP server: exposes the same graph tools to any MCP client (Claude Desktop,
// Claude Code, Cursor...). Usage: node src/mcp.js [tenant]
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TOOLS, runTool } from './tools.js';
import { startInvestigation } from './memory.js';

const tenant = process.argv[2] || process.env.GRAPHOPS_TENANT || 'acme';
const server = new McpServer({ name: 'graphops', version: '1.0.0' });

// Minimal JSON-schema -> zod conversion for our flat tool schemas.
function toZod(schema) {
  const shape = {};
  const required = new Set(schema.required || []);
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    let z0;
    if (prop.type === 'array') z0 = z.array(z.string());
    else if (prop.type === 'integer') z0 = z.number().int();
    else if (prop.type === 'number') z0 = z.number();
    else if (prop.enum) z0 = z.enum(prop.enum);
    else z0 = z.string();
    if (prop.description) z0 = z0.describe(prop.description);
    shape[key] = required.has(key) ? z0 : z0.optional();
  }
  return shape;
}

let investigationId;
for (const [name, tool] of Object.entries(TOOLS)) {
  server.registerTool(name, { description: tool.description, inputSchema: toZod(tool.parameters) }, async (args) => {
    if (['record_finding', 'record_decision', 'read_investigation'].includes(name) && !investigationId) {
      investigationId = await startInvestigation(tenant, 'mcp-client', 'Investigation opened via MCP');
    }
    const result = await runTool(tenant, name, args, { agent: 'mcp', investigationId });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
}

await server.connect(new StdioServerTransport());
