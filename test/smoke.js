// ─────────────────────────────────────────────────────────────
// Smoke test SANS dépendance : exerce la logique pure (core + resolver)
// pour vérifier la chaîne de résolution et les garde-fous.
//   node test/smoke.js
// ─────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import {
  searchPrograms,
  getProgram,
  getBestReferral,
  comparePrograms,
  createReferralLink,
  suggestProgram,
} from "../src/core.js";
import { resolveLink } from "../src/resolver.js";
import { findProgramBySlug } from "../src/data.js";
import { buildServer } from "../src/build-server.js";

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

// get_best_referral : anonyme → lien plateforme (le lien d'Antoine)
{
  const out = await getBestReferral({ slug: "qonto" }, ANON);
  assert.equal(out.data.is_own, false);
  assert.match(out.data.referral_link, /ref=antoine/);
  assert.ok(out.text.includes("ref=antoine"));
  ok("get_best_referral anonyme → lien plateforme");
}

// get_best_referral : connectée avec lien publié → SON lien (is_own=true)
{
  const out = await getBestReferral({ slug: "qonto" }, MARIE);
  assert.equal(out.data.is_own, true);
  assert.equal(out.data.referral_link, "https://qonto.com/r/marie-42");
  ok("get_best_referral connectée avec lien → SON lien (is_own)");
}

// get_best_referral : programme inconnu → erreur propre
{
  const out = await getBestReferral({ slug: "nexiste-pas" }, ANON);
  assert.equal(out.isError, true);
  ok("get_best_referral inconnu → erreur lisible");
}

// compare_programs : deux programmes connus → comparaison des deux côtés
{
  const out = await comparePrograms({ slug_a: "qonto", slug_b: "boursobank" }, ANON);
  assert.ok(!out.isError);
  assert.equal(out.data.a.slug, "qonto");
  assert.equal(out.data.b.slug, "boursobank");
  assert.match(out.data.a.referral_link, /ref=antoine/);
  assert.match(out.data.b.referral_link, /ref=antoine/);
  assert.ok(out.text.includes("Qonto") && out.text.includes("BoursoBank"));
  ok("compare_programs deux programmes connus → comparaison");
}

// compare_programs : un slug inconnu → erreur lisible mentionnant le manquant
{
  const out = await comparePrograms({ slug_a: "qonto", slug_b: "nexiste-pas" }, ANON);
  assert.equal(out.isError, true);
  assert.ok(out.text.includes("nexiste-pas"));
  ok("compare_programs slug inconnu → erreur lisible");
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

console.log("\nGating des outils connectés (sans réseau) :");

// Les tools réservés aux connectés ne sont PAS enregistrés en anonyme, mais le
// sont dès qu'il y a un utilisateur (token). On introspecte le registre MCP.
{
  const anonServer = buildServer({ caller: { user: null, platformOwner: "antoine" } });
  const connServer = buildServer({
    caller: { user: "marie", token: "tok-test", platformOwner: "antoine" },
  });
  const anonTools = Object.keys(anonServer._registeredTools);
  const connTools = Object.keys(connServer._registeredTools);

  assert.ok(!anonTools.includes("get_my_earnings"), "get_my_earnings absent en anonyme");
  assert.ok(!anonTools.includes("draft_announcement"), "draft_announcement absent en anonyme");
  ok("get_my_earnings & draft_announcement absents en anonyme");

  assert.ok(connTools.includes("get_my_earnings"), "get_my_earnings présent en connecté");
  assert.ok(connTools.includes("draft_announcement"), "draft_announcement présent en connecté");
  ok("get_my_earnings & draft_announcement présents en connecté");

  // compare_programs est hors gate → présent dans les deux.
  assert.ok(anonTools.includes("compare_programs") && connTools.includes("compare_programs"));
  ok("compare_programs disponible en anonyme ET en connecté");
}

console.log(`\n✅ ${pass} assertions passées. C'est du sssolide !\n`);
