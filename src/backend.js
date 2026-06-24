// ─────────────────────────────────────────────────────────────
// Couche d'accès aux données : aiguille entre
//   - "sample" : dataset d'exemple en mémoire (src/data.js) — POC / tests
//   - "api"    : vraie API publique de leparrain.com (lecture seule)
//
// L'API ne donne ni base ni code source : juste des programmes publiés en
// JSON. Aucun credential côté MCP. Voir LP_DATA_MODE / LP_API_BASE_URL.
// ─────────────────────────────────────────────────────────────

import { searchProgramsRaw, findProgramBySlug } from "./data.js";

const MODE = process.env.LP_DATA_MODE || "sample";
const API_BASE = process.env.LP_API_BASE_URL || "";
const TIMEOUT_MS = Number(process.env.LP_API_TIMEOUT_MS || 8000);

// Normalise un programme renvoyé par l'API LP vers la forme attendue par le
// resolver / les tools (notamment `ownerLink` = lien plateforme par défaut).
function mapApiProgram(p) {
  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    description: p.description,
    ownerLink: p.referral_link || null,
    referralCode: p.referral_code || null,
    sponsorReward: p.sponsor_reward || null,
    refereeReward: p.referral_reward || null,
    cashback: p.cashback || null,
    boosted: !!p.is_boosted,
  };
}

async function apiGet(params) {
  if (!API_BASE) throw new Error("LP_API_BASE_URL manquant en mode api");
  const url = new URL("/api/public/programs", API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`API LP ${r.status}`);
    const j = await r.json();
    return Array.isArray(j.programs) ? j.programs : [];
  } finally {
    clearTimeout(t);
  }
}

/** Recherche de programmes. Renvoie un tableau de programmes (forme interne). */
export async function fetchPrograms(query) {
  if (MODE === "api") {
    const rows = await apiGet({ search: query, limit: 20 });
    return rows.map(mapApiProgram);
  }
  return searchProgramsRaw(query); // sample (sync)
}

/** Détail d'un programme par slug, ou null. */
export async function fetchProgramBySlug(slug) {
  if (MODE === "api") {
    const rows = await apiGet({ slug, limit: 1 });
    return rows.length ? mapApiProgram(rows[0]) : null;
  }
  return findProgramBySlug(slug);
}
