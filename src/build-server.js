// ─────────────────────────────────────────────────────────────
// Fabrique du serveur MCP : enregistre les 4 tools sur une instance
// McpServer. Partagé par les deux transports :
//   - src/server.js  → stdio  (install locale)
//   - src/http.js    → HTTP   (serveur remote, URL à coller)
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  searchPrograms,
  getProgram,
  createReferralLink,
  suggestProgram,
} from "./core.js";

// Instructions de STYLE envoyées au modèle (le client les transmet au LLM).
// But : conversation humaine, vouvoiement, zéro jargon, et exactitude sur
// l'état de connexion (ne jamais prétendre « votre lien » si non connecté).
const INSTRUCTIONS = `Le Parrain MCP donne accès à un annuaire de programmes de parrainage et au bon lien à partager.

Règles de réponse, à respecter strictement :
- Répondez comme un humain, en français, en vouvoyant la personne. Conversation naturelle.
- Ne mentionnez JAMAIS les noms techniques des outils (search_programs, get_program, etc.), ni de "codes", ni de détails de fonctionnement interne. La personne ne connaît rien au développement.
- N'affirmez jamais que la personne possède "son" lien de parrainage tant qu'elle n'est pas connectée à son compte Le Parrain. Si elle n'est pas connectée, présentez simplement les liens comme ceux proposés par Le Parrain, et proposez-lui de connecter son compte pour faire ressortir ses propres liens.
- Soyez concis : donnez directement le ou les liens utiles. Pas de blabla technique.`;

function toResult(out) {
  return {
    content: [{ type: "text", text: out.text }],
    ...(out.isError ? { isError: true } : {}),
  };
}

/**
 * Construit un serveur MCP configuré.
 * @param {object} opts
 * @param {{user: string|null, platformOwner: string}} opts.caller - identité de l'appelant
 */
export function buildServer({ caller }) {
  const server = new McpServer(
    { name: "leparrain-mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS }
  );
  let seed = 0; // varie la réplique humoristique d'un appel à l'autre

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
    async ({ query }) => toResult(await searchPrograms({ query }, caller, seed++))
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
    async ({ slug }) => toResult(await getProgram({ slug }, caller, seed++))
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
      toResult(createReferralLink({ slug, url }, caller, seed++))
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
      toResult(suggestProgram({ name, url, category }, caller, seed++))
  );

  return server;
}
