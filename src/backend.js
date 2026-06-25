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
// Base PUBLIQUE (pour transformer un logo_url relatif en URL affichable).
const PUBLIC_BASE = process.env.LP_PUBLIC_URL || "https://leparrain.com";

// Normalise un programme renvoyé par l'API LP vers la forme attendue par le
// resolver / les tools (notamment `ownerLink` = lien plateforme par défaut).
function mapApiProgram(p) {
  let logoUrl = null;
  if (p.logo_url) {
    logoUrl = p.logo_url.startsWith("http") ? p.logo_url : `${PUBLIC_BASE}${p.logo_url}`;
  }
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
    logoUrl,
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

// ─────────────────────────────────────────────────────────────
// Auth + écriture par token personnel (mode api uniquement).
// Le MCP ne stocke aucun secret : il relaie le token à leparrain.com qui
// valide et renvoie l'identité. Petit cache (60 s) pour éviter de revalider
// à chaque requête.
// ─────────────────────────────────────────────────────────────
const tokenCache = new Map(); // token -> { identity, exp }

async function lpFetch(pathname, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(new URL(pathname, API_BASE), { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Valide un token personnel → identité {user_id, email, email_confirmed} ou null. */
export async function validateToken(token) {
  if (!token || MODE !== "api" || !API_BASE) return null;
  const cached = tokenCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.identity;
  try {
    const r = await lpFetch("/api/mcp/me", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const identity = r.ok ? await r.json() : null;
    tokenCache.set(token, { identity, exp: Date.now() + (identity ? 60_000 : 15_000) });
    return identity;
  } catch {
    return null;
  }
}

/** Publie une annonce au nom du token. Renvoie {ok, status, data}. */
export async function publishAnnouncement(token, payload) {
  if (!API_BASE) return { ok: false, status: 0, data: { error: "API indisponible" } };
  try {
    const r = await lpFetch("/api/mcp/announcements", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e) } };
  }
}

// Liens de parrainage PUBLIÉS par l'utilisateur du token, indexés par slug.
// Sert à faire ressortir SON lien plutôt que le lien plateforme. Cache 30 s.
const linksCache = new Map(); // token -> { links, exp }
export async function fetchMyLinks(token) {
  if (!token || MODE !== "api" || !API_BASE) return {};
  const cached = linksCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.links;
  try {
    const r = await lpFetch("/api/mcp/me/links", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const links = r.ok ? (await r.json()).links || {} : {};
    linksCache.set(token, { links, exp: Date.now() + 30_000 });
    return links;
  } catch {
    return {};
  }
}
