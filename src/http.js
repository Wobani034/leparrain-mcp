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

// Page affichée à un NAVIGATEUR qui ouvre /mcp à la main (humain), au lieu du
// JSON 401 réservé aux assistants. Les clients MCP (Accept: application/json)
// continuent de recevoir le défi 401.
const LANDING_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Connecteur IA — Le Parrain</title><style>
:root{--bg:#0b1220;--card:#121a2b;--fg:#e8eef9;--muted:#9fb0c9;--primary:#3B82F6;--accent:#00D4FF;--border:#1f2b40}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:1.5rem}
.card{max-width:34rem;background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:2rem}
h1{margin:.2rem 0 .6rem;font-size:1.45rem}
.badge{display:inline-block;font-size:.7rem;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);border:1px solid var(--border);border-radius:999px;padding:.2rem .6rem}
p{color:var(--muted);line-height:1.6}ol{color:var(--muted);line-height:1.8;padding-left:1.2rem}
code{background:#0b1220;border:1px solid var(--border);border-radius:.4rem;padding:.15rem .4rem;color:var(--fg);font-size:.85em}
a.btn{display:inline-block;margin-top:1rem;background:linear-gradient(135deg,var(--primary),var(--accent));color:#04121f;font-weight:600;text-decoration:none;padding:.6rem 1.1rem;border-radius:.6rem}
.foot{margin-top:1.4rem;font-size:.82rem;color:var(--muted)}.foot a{color:var(--accent)}
</style></head><body><div class="card">
<span class="badge">Connecteur IA</span>
<h1>Le Parrain — connecteur pour assistants</h1>
<p>Cette adresse permet à un assistant IA (Claude, ChatGPT) d'interroger l'annuaire de parrainage Le Parrain et d'y publier vos liens. Elle n'est pas faite pour être ouverte dans un navigateur — d'où ce message.</p>
<p style="color:var(--fg)"><strong>Pour l'utiliser dans Claude :</strong></p>
<ol><li>Réglages → <strong>Connecteurs</strong> → <em>Ajouter un connecteur personnalisé</em>.</li>
<li>Collez l'adresse <code>https://leparrain.com/mcp</code>.</li>
<li>Cliquez sur <strong>« Se connecter »</strong> et identifiez-vous avec votre compte Le Parrain.</li></ol>
<a class="btn" href="https://leparrain.com/connecteur-ia">Comment ça marche</a>
<div class="foot">Vous cherchiez le site ? <a href="https://leparrain.com">leparrain.com</a></div>
</div></body></html>`;

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

  // Visite NAVIGATEUR (humain) : page d'explication au lieu du JSON 401. Les
  // clients MCP envoient Accept: application/json/event-stream → ils passent à
  // l'auth ci-dessous et reçoivent le défi 401.
  if (req.method === "GET" && (req.headers["accept"] || "").includes("text/html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(LANDING_HTML);
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
