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

import "./env.js"; // DOIT rester en premier (charge .env avant les autres imports)
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./build-server.js";
import { readLedger } from "./ledger.js";
import { validateToken } from "./backend.js";

const PORT = Number(process.env.PORT || process.env.MCP_HTTP_PORT || 3005);
const MCP_PATH = process.env.MCP_PATH || "/mcp";
const PLATFORM_OWNER = process.env.LP_PLATFORM_OWNER || "antoine";
// Base publique pour le défi OAuth (resource_metadata du 401).
const PUBLIC_BASE = (process.env.LP_PUBLIC_BASE || "https://leparrain.com").replace(/\/+$/, "");

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

  // Journal PUBLIC des placements boostés — preuve d'équité (« pas du pipo »).
  // Lecture seule. Rejouez le code open-source sur ces entrées pour vérifier.
  if (url.pathname === "/mcp/ledger" || url.pathname === "/ledger") {
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10)));
    return send(res, 200, {
      service: "leparrain-mcp",
      doc: "Round-robin pondéré déterministe. Chaque entrée: {seed, slots:[{slug,weight}], featured}. Rejouez pickWeighted(slots, seed+'#0') → doit donner 'featured'. Code: github.com/Wobani034/leparrain-mcp/blob/main/src/boost.js",
      entries: readLedger(limit),
    });
  }

  if (url.pathname !== MCP_PATH) {
    return send(res, 404, { error: "not_found", hint: `Le endpoint MCP est ${MCP_PATH}` });
  }

  // Préflight CORS (au cas où un client navigateur sonde) — sans auth.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
    });
    return res.end();
  }

  // ── Authentification (spec d'auth MCP) ──────────────────────────
  // Token via header `Authorization: Bearer` (OAuth « Se connecter ») OU `?k=`
  // (lien legacy). Sans token valide → 401 + WWW-Authenticate pointant vers les
  // métadonnées de ressource → le connecteur (Claude/ChatGPT) lance le flow
  // OAuth et nous renvoie ensuite un Bearer.
  const authz = req.headers["authorization"] || "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  const token = bearer || url.searchParams.get("k") || "";
  const identity = token ? await validateToken(token) : null;
  if (!identity?.user_id) {
    const meta = `${PUBLIC_BASE}/.well-known/oauth-protected-resource`;
    res.writeHead(401, {
      "www-authenticate": `Bearer resource_metadata="${meta}"`,
      "content-type": "application/json",
    });
    return res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Authentification requise : connectez-vous à Le Parrain." },
        id: null,
      })
    );
  }
  const caller = {
    user: identity.user_id,
    email: identity.email,
    emailConfirmed: identity.email_confirmed,
    platformOwner: PLATFORM_OWNER,
    token,
    client: req.headers["user-agent"] || null,
  };

  // En stateless, seul POST porte du JSON-RPC.
  if (req.method !== "POST") {
    return send(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: utilisez POST (mode stateless)." },
      id: null,
    });
  }

  const body = await readJsonBody(req);
  if (body === Symbol.for("invalid-json")) {
    return send(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
  }

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
