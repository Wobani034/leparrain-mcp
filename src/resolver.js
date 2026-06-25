// ─────────────────────────────────────────────────────────────
// Chaîne de résolution du lien de parrainage.
//
// Pour un programme donné et un appelant donné, décide QUEL lien servir :
//
//   1. Appelant connecté + a publié SON lien pour ce programme → son lien
//   2. Appelant connecté SANS lien pour ce programme → lien plateforme
//      (+ on l'invite à publier le sien)
//   3. Appelant anonyme → lien plateforme par défaut (le lien du propriétaire)
//   4. Aucun lien plateforme (fallback) → tirage pondéré parmi la communauté,
//      poids ↑ pour les parrains qui ont "boosté"
//
// Chaque résolution renvoie une `reason` traçable (pour l'attribution / la
// facturation du boost) et, le cas échéant, une `invitation` à créer son lien.
// ─────────────────────────────────────────────────────────────

import { communityLinks } from "./data.js";

// Tirage pondéré par `boost`. `rng` injectable pour des tests déterministes.
function weightedPick(candidates, rng = Math.random) {
  const total = candidates.reduce((s, c) => s + (c.boost || 1), 0);
  let r = rng() * total;
  for (const c of candidates) {
    r -= c.boost || 1;
    if (r <= 0) return c;
  }
  return candidates[candidates.length - 1];
}

/**
 * @param {object} program  - objet programme (doit contenir slug, ownerLink)
 * @param {object} caller    - { user: string|null, platformOwner: string }
 * @param {object} [opts]    - { rng } pour injecter un générateur déterministe
 * @returns {{ link: string|null, reason: string, servedFor: string|null,
 *            invitation: string|null, boosted: boolean }}
 */
export function resolveLink(program, caller, opts = {}) {
  const rng = opts.rng || Math.random;
  const community = communityLinks[program.slug] || [];

  // 1. Appelant connecté qui a publié son propre lien
  if (caller.user) {
    const own = community.find((c) => c.user === caller.user);
    if (own) {
      return {
        link: own.link,
        reason: "user_own_link",
        servedFor: caller.user,
        invitation: null,
        boosted: false,
      };
    }
  }

  // 2 + 3. Un lien plateforme existe → on le sert
  if (program.ownerLink) {
    return {
      link: program.ownerLink,
      reason: caller.user ? "platform_default_no_user_link" : "platform_default",
      servedFor: caller.platformOwner,
      // Si l'appelant est connecté mais n'a pas SON lien : on l'invite.
      invitation: caller.user
        ? `Vous n'avez pas encore publié votre lien pour « ${program.name} ». Voulez-vous que je publie votre annonce pour que ce soit le vôtre qui ressorte ?`
        : null,
      boosted: false,
    };
  }

  // 4. Aucun lien plateforme → tirage pondéré communauté (le boost compte)
  if (community.length > 0) {
    const pick = weightedPick(community, rng);
    return {
      link: pick.link,
      reason: "weighted_community",
      servedFor: pick.user,
      invitation: caller.user
        ? `Voulez-vous publier votre annonce pour « ${program.name} » et entrer dans la rotation ?`
        : `Connectez votre compte Le Parrain pour publier votre annonce sur « ${program.name} ».`,
      boosted: (pick.boost || 1) > 1,
    };
  }

  // Rien du tout : aucun parrain pour ce programme.
  return {
    link: null,
    reason: "no_link_available",
    servedFor: null,
    invitation: caller.user
      ? `Il n'y a pas encore de parrain pour « ${program.name} ». Voulez-vous publier votre annonce avec votre lien (ou votre code) ?`
      : `Il n'y a pas encore de parrain pour « ${program.name} ». Connectez votre compte Le Parrain pour publier la vôtre.`,
    boosted: false,
  };
}

// Phrase lisible décrivant pourquoi ce lien a été servi (transparence /
// loyauté DGCCRF : on assume quand c'est un placement boosté).
export function explainReason(res, program) {
  switch (res.reason) {
    case "user_own_link":
      return `Votre lien de parrainage pour ${program.name}.`;
    case "platform_default":
      return `Lien de parrainage proposé par Le Parrain pour ${program.name}.`;
    case "platform_default_no_user_link":
      return `Lien Le Parrain pour ${program.name} (vous n'avez pas encore publié le vôtre).`;
    case "weighted_community":
      return res.boosted
        ? `Lien d'un parrain de la communauté pour ${program.name} (placement mis en avant).`
        : `Lien d'un parrain de la communauté pour ${program.name}.`;
    case "no_link_available":
      return `Aucun lien disponible pour ${program.name} pour l'instant.`;
    default:
      return "";
  }
}

export const _internals = { weightedPick };
