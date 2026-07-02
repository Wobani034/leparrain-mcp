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
  fetchMyEarnings,
  draftAnnouncement as draftAnnouncementApi,
} from "./backend.js";
import { resolveLink, explainReason } from "./resolver.js";
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

// ---- get_best_referral ----
// Point d'entrée DÉDIÉ « donne-moi le meilleur lien de parrainage pour X ».
// Applique la priorité maison via resolveLink (lien de l'utilisateur connecté
// s'il en a publié un → lien plateforme → tirage communauté pondéré) et rend
// une réponse claire + un texte humain. Accessible aux anonymes ET connectés.
export async function getBestReferral({ slug }, caller, seed = 0) {
  const p = await fetchProgramBySlug(slug);
  if (!p) {
    return {
      data: null,
      isError: true,
      text: `Je ne trouve pas ce programme. Faites une recherche par nom pour tomber sur la bonne fiche.`,
    };
  }
  const res = resolveLink(p, caller);
  // En mode api, le lien perso vient de l'annonce publiée (fetchMyLinks) ; en
  // sample il est déjà porté par resolveLink. On fait ressortir le lien perso.
  const own = caller.token ? (await fetchMyLinks(caller.token))[p.slug]?.referral_url : null;
  const link = own || res.link; // null = aucun parrain pour ce programme
  const isOwn = !!own || res.reason === "user_own_link";

  const body = [`Meilleur lien de parrainage pour ${p.name} (${p.category}) :`];
  if (link) {
    body.push("", `${link}${isOwn ? " (c'est le vôtre)" : ""}`);
  } else {
    // Pas encore de parrain : on invite à publier, sans inventer de lien.
    body.push("", res.invitation);
  }
  if (p.cashback) body.push("", `Cashback Le Parrain : ${p.cashback}`);

  return {
    data: {
      program: { slug: p.slug, name: p.name, category: p.category },
      referral_link: link,
      reason: explainReason(res, p),
      is_own: isOwn,
      boosted: !!res.boosted,
      invitation: link ? null : res.invitation,
      cashback: p.cashback || null,
      authenticated: !!caller.user,
    },
    text: withFlavor(body.join("\n"), seed),
  };
}

// ---- compare_programs ----
// Compare deux programmes côte à côte : récompenses, cashback et meilleur lien
// de parrainage résolu pour chacun (même priorité maison que get_best_referral).
// Accessible aux anonymes ET aux connectés.
async function resolveComparableSide(slug, caller, myLinks) {
  let p;
  try {
    p = await fetchProgramBySlug(slug);
  } catch {
    // API LP 5xx/timeout → traité comme introuvable (message lisible plutôt
    // qu'une erreur JSON-RPC brute remontée au modèle).
    return { slug, found: false };
  }
  if (!p) return { slug, found: false };
  const res = resolveLink(p, caller);
  const own = myLinks[p.slug]?.referral_url || null;
  const link = own || res.link; // null = aucun parrain pour ce programme
  const isOwn = !!own || res.reason === "user_own_link";
  return {
    found: true,
    slug: p.slug,
    name: p.name,
    category: p.category,
    sponsor_reward: p.sponsorReward || null,
    referral_reward: p.refereeReward || null,
    cashback: p.cashback || null,
    referral_link: link,
    is_own: isOwn,
    invitation: link ? null : res.invitation,
  };
}

export async function comparePrograms({ slug_a, slug_b }, caller, seed = 0) {
  // Résout la map des liens perso UNE fois (évite 2 requêtes /me/links parallèles
  // à froid) puis la passe aux deux côtés.
  const myLinks = caller.token ? await fetchMyLinks(caller.token).catch(() => ({})) : {};
  const [a, b] = await Promise.all([
    resolveComparableSide(slug_a, caller, myLinks),
    resolveComparableSide(slug_b, caller, myLinks),
  ]);

  const missing = [!a.found ? slug_a : null, !b.found ? slug_b : null].filter(Boolean);
  if (missing.length) {
    return {
      data: null,
      isError: true,
      text:
        missing.length === 2
          ? `Je ne trouve ni « ${slug_a} » ni « ${slug_b} ». Faites une recherche par nom pour tomber sur les bonnes fiches.`
          : `Je ne trouve pas « ${missing[0]} ». Faites une recherche par nom pour tomber sur la bonne fiche.`,
    };
  }

  // Bloc lisible par programme, mis en regard.
  function block(side) {
    const rows = [`${side.name} (${side.category})`];
    if (side.referral_reward) rows.push(`  Pour vous (filleul) : ${side.referral_reward}`);
    if (side.sponsor_reward) rows.push(`  Pour le parrain : ${side.sponsor_reward}`);
    rows.push(`  Cashback Le Parrain : ${side.cashback ? side.cashback : "aucun"}`);
    if (side.referral_link) {
      rows.push(`  Lien à partager : ${side.referral_link}${side.is_own ? " (le vôtre)" : ""}`);
    } else {
      rows.push(`  Pas encore de parrain pour ce programme.`);
    }
    return rows.join("\n");
  }

  const text = [
    `Comparatif ${a.name} / ${b.name} :`,
    "",
    block(a),
    "",
    block(b),
  ].join("\n");

  return {
    data: { a, b, authenticated: !!caller.user },
    text: withFlavor(text, seed),
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

// Libellés lisibles des statuts de cashback (fallback = valeur brute).
const CASHBACK_STATUS_LABELS = {
  pending: "en attente",
  processing: "en cours de traitement",
  approved: "approuvé",
  paid: "payé",
  rejected: "refusé",
};
function cashbackStatusLabel(status) {
  if (!status) return "statut inconnu";
  return CASHBACK_STATUS_LABELS[String(status).toLowerCase()] || String(status);
}

// ---- get_my_earnings (connecté) ----
// Récapitule les gains de l'utilisateur : solde IpCoins + cashback (par statut
// et détail des demandes). Lecture seule, réservée aux appelants connectés.
export async function getMyEarnings(_args, caller, seed = 0) {
  if (!caller.user || !caller.token) {
    return { data: null, isError: true, text: "Vous devez être connecté pour consulter vos gains." };
  }
  const res = await fetchMyEarnings(caller.token);
  if (!res.ok) {
    return { data: null, isError: true, text: res.data?.error || "La récupération de vos gains a échoué." };
  }
  const d = res.data || {};
  const ip = d.ipcoins || {};
  const cb = d.cashback || {};
  const byStatus = cb.by_status || {};
  const requests = Array.isArray(cb.requests) ? cb.requests : [];

  const lines = [
    `Solde IpCoins : ${ip.balance ?? 0}`,
  ];
  if (ip.total_earned != null || ip.total_spent != null) {
    lines.push(`  (gagnés : ${ip.total_earned ?? 0} · dépensés : ${ip.total_spent ?? 0})`);
  }

  lines.push("", `Demandes de cashback : ${cb.total ?? 0}`);
  const statusEntries = Object.entries(byStatus);
  if (statusEntries.length) {
    lines.push("Par statut :");
    for (const [status, amount] of statusEntries) {
      lines.push(`  • ${cashbackStatusLabel(status)} : ${amount}`);
    }
  }
  if (requests.length) {
    lines.push("Demandes :");
    for (const r of requests) {
      const label = r.program_name || r.program || "programme";
      lines.push(`  • ${label} — ${r.amount ?? "?"} (${cashbackStatusLabel(r.status)})`);
    }
  } else {
    lines.push("Aucune demande de cashback pour l'instant.");
  }

  return {
    data: d,
    text: withFlavor(lines.join("\n"), seed),
  };
}

// ---- draft_announcement (connecté) ----
// Génère un brouillon d'annonce (titre + texte) pour un programme, à relire
// avant publication. NE PUBLIE RIEN : c'est un simple brouillon.
export async function draftAnnouncement({ program, notes }, caller, seed = 0) {
  if (!caller.user || !caller.token) {
    return { data: null, isError: true, text: "Vous devez être connecté pour préparer un brouillon d'annonce." };
  }
  const res = await draftAnnouncementApi(caller.token, { program, notes });
  if (res.ok) {
    const draft = res.data?.draft || {};
    // Un 200 sans titre ni contenu = génération vide : ne pas présenter un
    // brouillon creux comme un succès.
    if (!draft.title && !draft.content) {
      return { data: null, isError: true, text: "La génération n'a rien produit pour le moment. Réessayez dans un instant." };
    }
    const body = [
      `Voici un brouillon d'annonce pour « ${res.data?.program || program} » :`,
      "",
      draft.title ? `Titre : ${draft.title}` : null,
      draft.content ? `\n${draft.content}` : null,
      "",
      "Relisez-le puis publiez-le via create_announcement si cela vous convient.",
    ].filter((l) => l !== null);
    return {
      data: res.data,
      text: withFlavor(body.join("\n"), seed),
    };
  }
  if (res.status === 503) {
    return { data: null, isError: true, text: "La génération de brouillon est momentanément indisponible. Réessayez dans un instant." };
  }
  if (res.status === 404) {
    return { data: null, isError: true, text: `Je ne trouve pas le programme « ${program} ». Vérifiez le nom ou faites une recherche.` };
  }
  if (res.status === 422) {
    return { data: null, isError: true, text: res.data?.error || "Le brouillon doit être rédigé en vouvoiement. Reformulez vos consignes." };
  }
  return { data: null, isError: true, text: res.data?.error || "La préparation du brouillon a échoué." };
}
