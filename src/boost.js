// ─────────────────────────────────────────────────────────────
// Moteur de placement « boosté » AUDITABLE.
//
// Principe : les programmes sponsorisés (qui ont payé en IpCoins) sont mis en
// avant dans les réponses du MCP, mais leur ordre est tiré par un round-robin
// PONDÉRÉ DÉTERMINISTE — donc rejouable et prouvable. Personne n'est favorisé
// en douce : à graine + poids + ce code identiques, n'importe qui recalcule
// exactement le même classement (voir test/boost.test.js et le journal public
// GET /mcp/ledger).
//
// Pas d'aléatoire caché : la "graine" est une fenêtre temporelle publique.
// ─────────────────────────────────────────────────────────────

import crypto from "node:crypto";

// Fenêtre temporelle publique servant de graine (rotation toutes N minutes).
// Le timestamp est INJECTÉ (pas de Date.now() caché) → testable et rejouable.
export function timeBucket(msTimestamp, minutes = 10) {
  const bucket = Math.floor(msTimestamp / (minutes * 60_000));
  return `tb${minutes}-${bucket}`;
}

// Choix pondéré déterministe : hash(seed) → point dans la somme des poids.
// (slots, seed) identiques → toujours le même gagnant. Rejouable à la main.
export function pickWeighted(slots, seed) {
  const list = slots.filter((s) => (s.weight ?? 1) > 0);
  if (list.length === 0) return null;
  const total = list.reduce((sum, s) => sum + (s.weight ?? 1), 0);
  // 48 bits du SHA-256 de la graine, normalisés dans [0, total).
  const digest = crypto.createHash("sha256").update(String(seed)).digest();
  const r = (digest.readUIntBE(0, 6) / 0x1000000000000) * total;
  let acc = 0;
  for (const s of list) {
    acc += s.weight ?? 1;
    if (r < acc) return s;
  }
  return list[list.length - 1];
}

// Ordonne des programmes : les sponsors (boostés) d'abord, dans un ORDRE de
// rotation pondérée déterministe (tirage successif sans remise), puis le reste
// inchangé. Renvoie aussi le sponsor « featured » (1ʳᵉ position) + la trace.
export function orderSponsored(programs, seed) {
  const sponsored = programs.filter((p) => p.boosted);
  const rest = programs.filter((p) => !p.boosted);
  if (sponsored.length <= 1) {
    return {
      ordered: programs,
      featured: sponsored[0] ?? null,
      slots: sponsored.map((p) => ({ slug: p.slug, weight: p.weight ?? 1 })),
    };
  }
  const pool = sponsored.map((p) => ({ slug: p.slug, weight: p.weight ?? 1, p }));
  const slots = pool.map((s) => ({ slug: s.slug, weight: s.weight }));
  const order = [];
  let i = 0;
  while (pool.length > 0) {
    const pick = pickWeighted(pool, `${seed}#${i++}`);
    order.push(pick.p);
    pool.splice(pool.indexOf(pick), 1);
  }
  return { ordered: [...order, ...rest], featured: order[0] ?? null, slots };
}
