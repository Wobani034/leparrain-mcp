// ─────────────────────────────────────────────────────────────
// Logique métier PURE des 4 tools, indépendante du transport MCP.
// Testable directement (voir test/smoke.js). Le serveur (src/server.js)
// ne fait que brancher ces fonctions sur le protocole MCP.
// ─────────────────────────────────────────────────────────────

import {
  searchProgramsRaw,
  findProgramBySlug,
  communityLinks,
  moderationQueue,
} from "./data.js";
import { resolveLink, explainReason } from "./resolver.js";
import { withFlavor } from "./flavor.js";

// Identité de l'appelant déduite de la config (POC) ou de l'auth (prod).
export function callerFromEnv(env = process.env) {
  return {
    user: env.LP_USER && env.LP_USER.trim() ? env.LP_USER.trim() : null,
    platformOwner: env.LP_PLATFORM_OWNER || "antoine",
  };
}

// ---- Garde-fous partagés ----
function assertSafeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL invalide : fournissez une URL complète (https://…).");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Seules les URLs en https sont acceptées.");
  }
  return parsed;
}

// ---- search_programs ----
export function searchPrograms({ query }, caller, seed = 0) {
  const results = searchProgramsRaw(query);
  if (results.length === 0) {
    return {
      data: { results: [] },
      text: withFlavor(
        `Aucun programme ne correspond à « ${query} » dans l'annuaire. Vous pouvez en proposer un avec suggest_program.`,
        seed
      ),
    };
  }
  const enriched = results.map((p) => {
    const res = resolveLink(p, caller);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category,
      referralLink: res.link,
      reason: res.reason,
      boosted: res.boosted,
      invitation: res.invitation,
    };
  });

  const lines = enriched.map((e) => {
    let l = `• ${e.name} (${e.category}) → ${e.referralLink || "aucun lien"}`;
    if (e.invitation) l += `\n  ↳ ${e.invitation}`;
    return l;
  });

  return {
    data: { results: enriched },
    text: withFlavor(
      `${enriched.length} programme(s) pour « ${query} » :\n\n${lines.join("\n")}`,
      seed
    ),
  };
}

// ---- get_program ----
export function getProgram({ slug }, caller, seed = 0) {
  const p = findProgramBySlug(slug);
  if (!p) {
    return {
      data: null,
      isError: true,
      text: `Programme « ${slug} » introuvable. Essayez search_programs pour trouver le bon identifiant.`,
    };
  }
  const res = resolveLink(p, caller);
  const body = [
    `${p.name} — ${p.category}`,
    "",
    p.description,
    "",
    `Lien de parrainage : ${res.link || "aucun lien disponible"}`,
    `(${explainReason(res, p)})`,
  ];
  if (res.invitation) body.push("", `↳ ${res.invitation}`);

  return {
    data: {
      slug: p.slug,
      name: p.name,
      category: p.category,
      description: p.description,
      referralLink: res.link,
      reason: res.reason,
      boosted: res.boosted,
    },
    text: withFlavor(body.join("\n"), seed),
  };
}

// ---- create_referral_link ----
// Publie le lien de l'appelant pour un programme. Garde-fous : appelant
// connecté, programme existant, URL https, pas de doublon.
export function createReferralLink({ slug, url, boost }, caller, seed = 0) {
  if (!caller.user) {
    return {
      data: null,
      isError: true,
      text: "Vous devez être connecté à votre compte Le Parrain pour publier un lien. (En POC : définissez LP_USER dans votre .env.)",
    };
  }
  const p = findProgramBySlug(slug);
  if (!p) {
    return {
      data: null,
      isError: true,
      text: `Programme « ${slug} » introuvable. Utilisez suggest_program s'il n'existe pas encore.`,
    };
  }
  let parsed;
  try {
    parsed = assertSafeUrl(url);
  } catch (e) {
    return { data: null, isError: true, text: e.message };
  }

  const list = communityLinks[slug] || (communityLinks[slug] = []);
  const existing = list.find((c) => c.user === caller.user);
  if (existing) {
    existing.link = parsed.toString(); // mise à jour idempotente
    return {
      data: { slug, user: caller.user, link: existing.link, updated: true },
      text: withFlavor(
        `Votre lien pour ${p.name} a été mis à jour. C'est lui qui ressortira désormais quand vous interrogez ce programme.`,
        seed
      ),
    };
  }

  // boost ignoré ici en POC (la facturation arrivera en couche 3) : on force 1.
  list.push({ user: caller.user, link: parsed.toString(), boost: 1 });
  return {
    data: { slug, user: caller.user, link: parsed.toString(), created: true },
    text: withFlavor(
      `Lien publié pour ${p.name}. Désormais, quand vous interrogez ce programme, c'est VOTRE lien qui ressort.`,
      seed
    ),
  };
}

// ---- suggest_program ----
// Propose un nouveau programme. NE PUBLIE PAS : passe en file de modération.
export function suggestProgram({ name, url, category }, caller, seed = 0) {
  if (!name || name.trim().length < 2) {
    return {
      data: null,
      isError: true,
      text: "Indiquez au moins le nom du programme à proposer.",
    };
  }
  let parsed = null;
  if (url) {
    try {
      parsed = assertSafeUrl(url);
    } catch (e) {
      return { data: null, isError: true, text: e.message };
    }
  }
  const entry = {
    id: `cand_${moderationQueue.length + 1}`,
    name: name.trim(),
    category: (category || "").trim() || "Non classé",
    url: parsed ? parsed.toString() : null,
    suggestedBy: caller.user || "anonyme",
    status: "pending_moderation",
  };
  moderationQueue.push(entry);
  return {
    data: entry,
    text: withFlavor(
      `Merci ! « ${entry.name} » a été soumis et passe en modération avant publication. Un humain vérifie l'offre — pas de publication automatique dans l'annuaire.`,
      seed
    ),
  };
}
