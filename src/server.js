#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Le Parrain MCP — entrée STDIO (install locale).
// L'assistant lance ce process en local. Pour la version remote
// (URL à coller), voir src/http.js.
// ─────────────────────────────────────────────────────────────

import "./env.js"; // DOIT rester en premier (charge .env avant les autres imports)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./build-server.js";
import { callerFromEnv } from "./core.js";

async function main() {
  const server = buildServer({ caller: callerFromEnv() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[leparrain-mcp] prêt — Ssssplendide ! (transport stdio)");
}

main().catch((err) => {
  console.error("[leparrain-mcp] erreur fatale :", err);
  process.exit(1);
});
