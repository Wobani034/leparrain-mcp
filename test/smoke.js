// ─────────────────────────────────────────────────────────────
// Smoke test SANS dépendance : exerce la logique pure (core + resolver)
// pour vérifier la chaîne de résolution et les garde-fous.
//   node test/smoke.js
// ─────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import {
  searchPrograms,
  getProgram,
  createReferralLink,
  suggestProgram,
} from "../src/core.js";
import { resolveLink } from "../src/resolver.js";
import { findProgramBySlug } from "../src/data.js";

const ANON = { user: null, platformOwner: "antoine" };
const MARIE = { user: "marie", platformOwner: "antoine" };
const NOBODY = { user: "zoe", platformOwner: "antoine" };

let pass = 0;
function ok(label) {
  pass++;
  console.log(`  ✓ ${label}`);
}

console.log("\nChaîne de résolution :");

// 3. Anonyme sur un programme avec lien plateforme → lien d'Antoine
{
  const r = resolveLink(findProgramBySlug("qonto"), ANON);
  assert.equal(r.reason, "platform_default");
  assert.match(r.link, /ref=antoine/);
  ok("anonyme → lien plateforme par défaut (Antoine)");
}

// 1. Connectée AVEC son lien publié → son lien
{
  const r = resolveLink(findProgramBySlug("qonto"), MARIE);
  assert.equal(r.reason, "user_own_link");
  assert.equal(r.servedFor, "marie");
  ok("connectée avec lien publié → SON lien");
}

// 2. Connectée SANS lien sur ce programme → lien plateforme + invitation
{
  const r = resolveLink(findProgramBySlug("qonto"), NOBODY);
  assert.equal(r.reason, "platform_default_no_user_link");
  assert.ok(r.invitation, "doit inviter à créer son lien");
  ok("connectée sans lien → lien plateforme + invitation");
}

// 4. Programme sans lien plateforme (vinted) → tirage pondéré communauté
{
  // rng forcé → tombe sur le 1er candidat (marie) puis sur le boosté (sancho)
  const low = resolveLink(findProgramBySlug("vinted"), ANON, { rng: () => 0 });
  assert.equal(low.reason, "weighted_community");
  ok("anonyme sur prog sans lien plateforme → tirage communauté");

  // Vérifie que le boost biaise : sur 1000 tirages, sancho (boost 8) domine
  const counts = {};
  for (let i = 0; i < 1000; i++) {
    const r = resolveLink(findProgramBySlug("vinted"), ANON, {
      rng: () => (i + 0.5) / 1000,
    });
    counts[r.servedFor] = (counts[r.servedFor] || 0) + 1;
  }
  assert.ok(
    counts.sancho > counts.marie && counts.sancho > (counts.leo || 0),
    `le parrain boosté doit dominer (${JSON.stringify(counts)})`
  );
  ok(`boost pondère le tirage (${JSON.stringify(counts)})`);
}

console.log("\nTools & garde-fous :");

// search renvoie des résultats enrichis
{
  const out = await searchPrograms({ query: "banque" }, ANON);
  assert.ok(out.data.results.length >= 1);
  assert.ok(out.text.includes("ref=antoine"));
  ok("search_programs enrichit avec le lien résolu");
}

// get_program inconnu → erreur propre
{
  const out = await getProgram({ slug: "nexiste-pas" }, ANON);
  assert.equal(out.isError, true);
  ok("get_program inconnu → erreur lisible");
}

// create_referral_link : anonyme refusé
{
  const out = createReferralLink(
    { slug: "qonto", url: "https://qonto.com/r/x" },
    ANON
  );
  assert.equal(out.isError, true);
  ok("create_referral_link bloque l'anonyme");
}

// create_referral_link : URL non https refusée
{
  const out = createReferralLink(
    { slug: "qonto", url: "http://pas-secure.com" },
    MARIE
  );
  assert.equal(out.isError, true);
  ok("create_referral_link refuse le non-https");
}

// create_referral_link : publication OK → puis c'est SON lien qui ressort
{
  const out = createReferralLink(
    { slug: "free-mobile", url: "https://free.fr/parrain/zoe" },
    NOBODY
  );
  assert.ok(!out.isError);
  const after = resolveLink(findProgramBySlug("free-mobile"), NOBODY);
  assert.equal(after.reason, "user_own_link");
  ok("create_referral_link publie → le lien de l'utilisateur prend le relais");
}

// suggest_program : passe en modération, jamais publié direct
{
  const out = suggestProgram({ name: "Revolut", category: "Banque" }, MARIE);
  assert.equal(out.data.status, "pending_moderation");
  const inSearch = await searchPrograms({ query: "Revolut" }, ANON);
  assert.equal(inSearch.data.results.length, 0, "ne doit PAS apparaître avant modération");
  ok("suggest_program → modération, pas de publication auto");
}

console.log(`\n✅ ${pass} assertions passées. C'est du sssolide !\n`);
