#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Le Parrain MCP — entrée HTTP (serveur REMOTE, URL à coller).
//
// Expose le serveur MCP en "Streamable HTTP" pour que ChatGPT / Claude
// s'y connectent via une simple URL (ex: https://leparrain.com/mcp).
//
// Mode STATELESS (un serveur + transport par requête) + réponses JSON
// (enableJsonResponse) → passe proprement derrière Cloudflare/nginx,
// sans complications de buffering SSE.
//
// POC : pas d'auth → appelant anonyme → lien plateforme par défaut.
// L'auth par compte (clé API / OAuth) viendra en couche 2.
// ─────────────────────────────────────────────────────────────

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./build-server.js";

const PORT = Number(process.env.PORT || process.env.MCP_HTTP_PORT || 3005);
const MCP_PATH = process.env.MCP_PATH || "/mcp";
const PLATFORM_OWNER = process.env.LP_PLATFORM_OWNER || "antoine";

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy(); // garde-fou taille
    });
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(Symbol.for("invalid-json"));
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Petit endpoint de santé pour vérifier le déploiement.
  if (url.pathname === "/health" || url.pathname === `${MCP_PATH}/health`) {
    return send(res, 200, { ok: true, service: "leparrain-mcp", transport: "http" });
  }

  if (url.pathname !== MCP_PATH) {
    return send(res, 404, { error: "not_found", hint: `Le endpoint MCP est ${MCP_PATH}` });
  }

  // En stateless, seul POST porte du JSON-RPC. GET/DELETE ne sont pas utilisés.
  if (req.method === "GET") {
    return send(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: utilisez POST (mode stateless)." },
      id: null,
    });
  }
  if (req.method !== "POST") {
    return send(res, 405, { error: "method_not_allowed" });
  }

  const body = await readJsonBody(req);
  if (body === Symbol.for("invalid-json")) {
    return send(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
  }

  // POC : appelant anonyme (pas d'auth) → lien plateforme par défaut.
  const caller = { user: null, platformOwner: PLATFORM_OWNER };
  const mcp = buildServer({ caller });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true, // réponses JSON (CF-friendly)
  });

  res.on("close", () => {
    transport.close();
    mcp.close();
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[leparrain-mcp] erreur requête :", err);
    if (!res.headersSent) {
      send(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(
    `[leparrain-mcp] HTTP prêt sur http://127.0.0.1:${PORT}${MCP_PATH} — C'est du sssolide !`
  );
});
