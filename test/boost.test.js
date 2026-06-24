// ─────────────────────────────────────────────────────────────
// Prouve que le moteur de boost est ÉQUITABLE et REJOUABLE :
//   node test/boost.test.js
// ─────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { pickWeighted, orderSponsored, timeBucket } from "../src/boost.js";

let pass = 0;
const ok = (l) => { pass++; console.log(`  ✓ ${l}`); };

console.log("\nDéterminisme / rejouabilité :");

// Même (slots, seed) → toujours le même gagnant (n'importe qui peut recalculer)
{
  const slots = [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }, { slug: "c", weight: 1 }];
  const first = pickWeighted(slots, "tb10-42#0");
  for (let i = 0; i < 100; i++) {
    assert.equal(pickWeighted(slots, "tb10-42#0").slug, first.slug);
  }
  ok(`graine fixe → gagnant fixe (${first.slug}) sur 100 essais`);
}

// orderSponsored produit un ORDRE complet rejouable
{
  const progs = [
    { slug: "a", boosted: true }, { slug: "b", boosted: true },
    { slug: "c", boosted: true }, { slug: "x", boosted: false },
  ];
  const r1 = orderSponsored(progs, "tb10-7");
  const r2 = orderSponsored(progs, "tb10-7");
  assert.deepEqual(r1.ordered.map((p) => p.slug), r2.ordered.map((p) => p.slug));
  assert.equal(r1.ordered.at(-1).slug, "x", "le non-sponsorisé reste en dernier");
  ok(`ordre rejouable à l'identique : [${r1.ordered.map((p) => p.slug).join(", ")}]`);
}

console.log("\nÉquité (proportionnelle aux poids = aux IpCoins payés) :");

// Sur beaucoup de fenêtres, la fréquence de 1ʳᵉ position ≈ poids relatif
{
  const slots = [{ slug: "petit", weight: 1 }, { slug: "gros", weight: 4 }];
  const counts = { petit: 0, gros: 0 };
  const N = 20000;
  for (let i = 0; i < N; i++) {
    counts[pickWeighted(slots, `seed-${i}`).slug]++;
  }
  const ratio = counts.gros / counts.petit; // attendu ~4
  assert.ok(ratio > 3.4 && ratio < 4.6, `ratio gros/petit=${ratio.toFixed(2)} (attendu ~4)`);
  ok(`poids 4 vs 1 → ratio observé ${ratio.toFixed(2)} (${JSON.stringify(counts)})`);
}

// Poids égaux → exposition équilibrée (personne favorisé)
{
  const slots = [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }, { slug: "c", weight: 1 }];
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 30000; i++) counts[pickWeighted(slots, `s${i}`).slug]++;
  const vals = Object.values(counts);
  const spread = (Math.max(...vals) - Math.min(...vals)) / 30000;
  assert.ok(spread < 0.03, `écart max ${(spread * 100).toFixed(1)}% (doit être ~0)`);
  ok(`poids égaux → équilibré (${JSON.stringify(counts)}, écart ${(spread * 100).toFixed(1)}%)`);
}

console.log("\nGraine = fenêtre temporelle publique :");
{
  assert.equal(timeBucket(0, 10), "tb10-0");
  assert.equal(timeBucket(10 * 60_000, 10), "tb10-1");
  assert.equal(timeBucket(9 * 60_000, 10), "tb10-0", "même fenêtre de 10 min → même graine");
  ok("la graine est dérivée du temps (rotation 10 min), publique et vérifiable");
}

console.log(`\n✅ ${pass} assertions passées. Équitable ET rejouable — c'est du sssolide !\n`);
