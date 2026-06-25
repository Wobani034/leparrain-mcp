// ─────────────────────────────────────────────────────────────
// Logique métier PURE des 4 tools, indépendante du transport MCP.
// Testable directement (voir test/smoke.js). Le serveur (src/server.js)
// ne fait que brancher ces fonctions sur le protocole MCP.
// ─────────────────────────────────────────────────────────────

import { findProgramBySlug, communityLinks, moderationQueue } from "./data.js";
import {
  fetchPrograms,
  fetchProgramBySlug,
  publishAnnouncement,
  patchAnnouncement,
  removeAnnouncement,
  fetchMyLinks,
  fetchArticles,
  postCashbackRequest,
} from "./backend.js";
import { resolveLink } from "./resolver.js";
import { withFlavor } from "./flavor.js";
import { timeBucket, orderSponsored } from "./boost.js";
import { appendLedger } from "./ledger.js";

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
export async function searchPrograms({ query }, caller, seed = 0) {
  const results = await fetchPrograms(query);
  if (results.length === 0) {
    return {
      data: { results: [] },
      text: withFlavor(
        `Aucun programme ne correspond à « ${query} » dans l'annuaire. Vous pouvez en proposer un avec suggest_program.`,
        seed
      ),
    };
  }
  // Placement sponsorisé AUDITABLE : on met les programmes boostés (qui ont
  // payé) en avant, dans un ordre de rotation pondérée déterministe, et on
  // trace la mise en avant dans le journal public (preuve d'équité).
  const bucket = timeBucket(now());
  const { ordered, featured, slots } = orderSponsored(results, bucket);
  if (slots.length >= 2) {
    appendLedger({ ts: now(), seed: bucket, query, slots, featured: featured?.slug ?? null });
  }

  // Si la personne est connectée, on fait ressortir SON lien (issu de son
  // annonce publiée) plutôt que le lien plateforme par défaut.
  const myLinks = caller.token ? await fetchMyLinks(caller.token) : {};

  const enriched = ordered.map((p) => {
    const res = resolveLink(p, caller);
    const own = myLinks[p.slug]?.referral_url || null;
    const link = own || res.link; // null = pas encore de parrain
    const desc = (p.description || "").trim();
    return {
      slug: p.slug,
      name: p.name,
      category: p.category,
      description: desc.length > 160 ? desc.slice(0, 157) + "…" : desc,
      referralLink: link,
      hasSponsor: !!link,
      isOwn: !!own,
      sponsored: !!p.boosted,
    };
  });

  const lines = enriched.map((e) => {
    let l = `• ${e.name} (${e.category})`;
    if (e.referralLink) l += ` — ${e.referralLink}${e.isOwn ? " (votre lien)" : ""}`;
    else l += ` — pas encore de parrain (vous pouvez publier la vôtre)`;
    if (e.description) l += `\n  ${e.description}`;
    return l;
  });

  const text = [
    `Voici des programmes pour « ${query} » :`,
    "",
    lines.join("\n"),
  ].join("\n");

  return {
    data: { results: enriched, authenticated: !!caller.user, featured: featured?.slug ?? null },
    text: withFlavor(text, seed),
  };
}

// Horodatage isolé (facilite un éventuel mock ; Date.now() autorisé hors workflow).
function now() {
  return Date.now();
}

// ---- get_program ----
export async function getProgram({ slug }, caller, seed = 0) {
  const p = await fetchProgramBySlug(slug);
  if (!p) {
    return {
      data: null,
      isError: true,
      text: `Je ne trouve pas ce programme. Faites une recherche par nom pour tomber sur la bonne fiche.`,
    };
  }
  const res = resolveLink(p, caller);
  const own = caller.token ? (await fetchMyLinks(caller.token))[p.slug]?.referral_url : null;
  const link = own || res.link; // null = aucun parrain pour ce programme

  const body = [`${p.name} — ${p.category}`, "", p.description];
  // Détails de récompense quand l'annuaire les connaît.
  if (p.refereeReward) body.push("", `Pour vous (filleul) : ${p.refereeReward}`);
  if (p.sponsorReward) body.push(`Pour le parrain : ${p.sponsorReward}`);
  if (p.cashback) body.push(`Cashback Le Parrain : ${p.cashback}`);
  if (link) {
    body.push("", `Lien à partager : ${link}${own ? " (c'est le vôtre)" : ""}`);
  } else {
    // Pas encore de parrain : on invite à publier. On NE présente PAS le site
    // officiel comme un lien de parrainage.
    body.push("", res.invitation);
  }
  if (p.logoUrl) body.push("", `Logo : ${p.logoUrl}`);

  return {
    data: {
      slug: p.slug,
      name: p.name,
      category: p.category,
      description: p.description,
      referralLink: link,
      hasSponsor: !!link,
      isOwn: !!own,
      invitation: link ? null : res.invitation,
      cashback: p.cashback || null,
      logoUrl: p.logoUrl || null,
      authenticated: !!caller.user,
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

// ---- create_announcement (connecté uniquement) ----
// Publie une annonce de parrainage au nom de l'utilisateur connecté, via
// l'API leparrain.com (anti-fraude + unicité gérés côté serveur).
export async function createAnnouncement(
  { program, title, content, referral_url, referral_code },
  caller,
  seed = 0
) {
  if (!caller.user || !caller.token) {
    return {
      data: null,
      isError: true,
      text: "Vous devez être connecté pour publier une annonce (connecteur avec votre token personnel).",
    };
  }
  const referral_type = referral_url && referral_code ? "BOTH" : referral_code ? "CODE" : "LINK";
  const res = await publishAnnouncement(caller.token, {
    program,
    title,
    content,
    referral_type,
    referral_url: referral_url || null,
    referral_code: referral_code || null,
  });
  if (res.ok) {
    return {
      data: res.data,
      text: withFlavor(`C'est publié ! Votre annonce pour « ${program} » est en ligne : ${res.data.url}`, seed),
    };
  }
  if (res.status === 409) {
    return { data: res.data, text: `Vous avez déjà une annonce pour « ${program} ».` };
  }
  return { data: null, isError: true, text: res.data?.error || "La publication de l'annonce a échoué." };
}

// ---- update_announcement (connecté) ----
// Modifie l'annonce existante de l'utilisateur (uniquement les champs fournis).
export async function updateAnnouncement(
  { program, title, content, referral_url, referral_code },
  caller,
  seed = 0
) {
  if (!caller.user || !caller.token) {
    return { data: null, isError: true, text: "Vous devez être connecté pour modifier votre annonce." };
  }
  const payload = { program };
  if (title !== undefined) payload.title = title;
  if (content !== undefined) payload.content = content;
  if (referral_url !== undefined) payload.referral_url = referral_url;
  if (referral_code !== undefined) payload.referral_code = referral_code;
  if (referral_url || referral_code) {
    payload.referral_type = referral_url && referral_code ? "BOTH" : referral_code ? "CODE" : "LINK";
  }
  const res = await patchAnnouncement(caller.token, payload);
  if (res.ok) {
    return {
      data: res.data,
      text: withFlavor(`C'est modifié. Votre annonce pour « ${program} » est à jour : ${res.data.url}`, seed),
    };
  }
  if (res.status === 404) {
    return { data: null, isError: true, text: `Vous n'avez pas encore d'annonce pour « ${program} ». Publiez-en une d'abord.` };
  }
  return { data: null, isError: true, text: res.data?.error || "La modification a échoué." };
}

// ---- search_blog ----
// Cherche dans les articles du blog Le Parrain (conseils, comparatifs, bons
// plans) et renvoie les programmes liés pour croiser avec l'annuaire.
export async function searchBlog({ query }, caller, seed = 0) {
  const articles = await fetchArticles(query);
  if (articles.length === 0) {
    return {
      data: { articles: [] },
      text: `Aucun article de blog ne correspond à « ${query} ».`,
    };
  }
  const lines = articles.map((a) => {
    let l = `• ${a.title}\n  ${a.url}`;
    if (a.excerpt) l += `\n  ${a.excerpt}`;
    if (a.programs && a.programs.length) l += `\n  Programmes liés : ${a.programs.join(", ")}`;
    return l;
  });
  return {
    data: { articles },
    text: withFlavor(`Articles du blog pour « ${query} » :\n\n${lines.join("\n\n")}`, seed),
  };
}

// ---- request_cashback (connecté) ----
// Demande le cashback Le Parrain pour un programme, au nom de l'utilisateur.
export async function requestCashback({ program, inscription_date }, caller, seed = 0) {
  if (!caller.user || !caller.token) {
    return { data: null, isError: true, text: "Vous devez être connecté pour demander votre cashback." };
  }
  const payload = { program };
  if (inscription_date) payload.inscription_date = inscription_date;
  const res = await postCashbackRequest(caller.token, payload);
  if (res.ok) {
    return {
      data: res.data,
      text: withFlavor(
        `Votre demande de cashback (${res.data.amount}) pour « ${program} » a bien été envoyée. L'équipe Le Parrain la traitera.`,
        seed
      ),
    };
  }
  if (res.status === 409) {
    return { data: res.data, text: `Vous avez déjà une demande de cashback en cours pour « ${program} ».` };
  }
  return { data: null, isError: true, text: res.data?.error || "La demande de cashback a échoué." };
}

// ---- delete_announcement (connecté) ----
export async function deleteAnnouncement({ program }, caller, seed = 0) {
  if (!caller.user || !caller.token) {
    return { data: null, isError: true, text: "Vous devez être connecté pour supprimer votre annonce." };
  }
  const res = await removeAnnouncement(caller.token, program);
  if (res.ok) {
    return { data: res.data, text: withFlavor(`Votre annonce pour « ${program} » a été supprimée.`, seed) };
  }
  if (res.status === 404) {
    return { data: null, isError: true, text: `Vous n'avez pas d'annonce pour « ${program} ».` };
  }
  return { data: null, isError: true, text: res.data?.error || "La suppression a échoué." };
}
