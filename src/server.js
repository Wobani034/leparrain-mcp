#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Le Parrain MCP — serveur Model Context Protocol (transport stdio).
//
// Branche les 4 tools (logique pure dans src/core.js) sur le protocole MCP
// pour qu'un assistant IA (Claude Desktop, ChatGPT en mode connecteur, etc.)
// puisse les appeler.
//
// ⚠️ Ce serveur ne contient AUCUN secret et AUCUN code source de Le Parrain.
// En POC il lit un dataset d'exemple en mémoire (LP_DATA_MODE=sample).
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  callerFromEnv,
  searchPrograms,
  getProgram,
  createReferralLink,
  suggestProgram,
} from "./core.js";

const server = new McpServer({
  name: "leparrain-mcp",
  version: "0.1.0",
});

const caller = callerFromEnv();
let callSeed = 0; // varie la réplique humoristique à chaque appel

function toResult(out) {
  return {
    content: [{ type: "text", text: out.text }],
    ...(out.isError ? { isError: true } : {}),
  };
}

server.registerTool(
  "search_programs",
  {
    title: "Rechercher des programmes de parrainage",
    description:
      "Cherche des programmes de parrainage dans l'annuaire Le Parrain. Renvoie pour chaque résultat le bon lien de parrainage (le vôtre si vous êtes connecté et l'avez publié, sinon le lien par défaut).",
    inputSchema: {
      query: z.string().describe("Mot-clé : nom de marque, catégorie, secteur…"),
    },
  },
  async ({ query }) => toResult(searchPrograms({ query }, caller, callSeed++))
);

server.registerTool(
  "get_program",
  {
    title: "Détail d'un programme",
    description:
      "Renvoie le détail d'un programme de parrainage (description + lien de parrainage résolu pour vous).",
    inputSchema: {
      slug: z.string().describe("Identifiant du programme (ex: 'qonto'). Voir search_programs."),
    },
  },
  async ({ slug }) => toResult(getProgram({ slug }, caller, callSeed++))
);

server.registerTool(
  "create_referral_link",
  {
    title: "Publier mon lien de parrainage",
    description:
      "Publie VOTRE lien de parrainage pour un programme existant. Une fois publié, c'est votre lien qui ressortira quand vous interrogez ce programme. Nécessite d'être connecté.",
    inputSchema: {
      slug: z.string().describe("Identifiant du programme concerné."),
      url: z.string().describe("Votre lien de parrainage (https obligatoire)."),
    },
  },
  async ({ slug, url }) =>
    toResult(createReferralLink({ slug, url }, caller, callSeed++))
);

server.registerTool(
  "suggest_program",
  {
    title: "Proposer un nouveau programme",
    description:
      "Propose un programme de parrainage absent de l'annuaire. La proposition passe en modération (vérification humaine) avant toute publication — aucune mise en ligne automatique.",
    inputSchema: {
      name: z.string().describe("Nom de la marque / du programme."),
      url: z.string().optional().describe("Lien officiel du programme (https), optionnel."),
      category: z.string().optional().describe("Catégorie suggérée, optionnel."),
    },
  },
  async ({ name, url, category }) =>
    toResult(suggestProgram({ name, url, category }, caller, callSeed++))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only (stdout est réservé au protocole MCP).
  console.error("[leparrain-mcp] prêt — Ssssplendide ! (transport stdio)");
}

main().catch((err) => {
  console.error("[leparrain-mcp] erreur fatale :", err);
  process.exit(1);
});
