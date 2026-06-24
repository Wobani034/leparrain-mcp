// ─────────────────────────────────────────────────────────────
// Dataset d'exemple EN MÉMOIRE (mode "sample").
//
// ⚠️ Volontairement déconnecté de l'infra Le Parrain : aucune donnée
// réelle, aucun accès base, aucun secret. Ce fichier existe pour que le
// POC tourne tout seul. En production, ces lectures passeront par l'API
// HTTP de leparrain.com (voir src/backend.js, mode "api").
// ─────────────────────────────────────────────────────────────

// Programmes de parrainage référencés.
// `ownerLink` = lien par défaut de la plateforme (servi aux anonymes).
//   Mettre `null` pour simuler un programme où la plateforme n'a PAS de lien
//   → déclenche le fallback "tirage pondéré communauté".
export const programs = [
  {
    slug: "qonto",
    name: "Qonto",
    category: "Banque pro",
    description:
      "Compte pro pour indépendants et TPE/PME. Le parrainage offre généralement un bonus en euros au filleul après ouverture de compte.",
    ownerLink: "https://leparrain.com/go/qonto?ref=antoine",
  },
  {
    slug: "trade-republic",
    name: "Trade Republic",
    category: "Bourse / Épargne",
    description:
      "Courtier mobile pour investir en actions, ETF et crypto. Parrainage avec action offerte côté filleul.",
    ownerLink: "https://leparrain.com/go/trade-republic?ref=antoine",
  },
  {
    slug: "boursobank",
    name: "BoursoBank",
    category: "Banque en ligne",
    description:
      "Banque en ligne (ex-Boursorama). Prime de bienvenue à l'ouverture d'un compte via un code parrain.",
    ownerLink: "https://leparrain.com/go/boursobank?ref=antoine",
  },
  {
    slug: "vinted",
    name: "Vinted",
    category: "Seconde main",
    description:
      "Place de marché de vêtements d'occasion. Programme de parrainage avec bons d'achat.",
    // Pas de lien plateforme → fallback communauté pondéré.
    ownerLink: null,
  },
  {
    slug: "free-mobile",
    name: "Free Mobile",
    category: "Télécom",
    description:
      "Forfaits mobiles sans engagement. Le parrainage offre une réduction mensuelle au filleul.",
    ownerLink: "https://leparrain.com/go/free-mobile?ref=antoine",
  },
];

// Liens publiés par les membres de la communauté (parrains).
// `boost` = poids dans le tirage pondéré (1 = standard, >1 = a payé pour booster).
// La clé est le slug du programme.
export const communityLinks = {
  qonto: [
    { user: "marie", link: "https://qonto.com/r/marie-42", boost: 1 },
    { user: "kevin", link: "https://qonto.com/r/kevin-77", boost: 5 }, // a boosté
  ],
  vinted: [
    { user: "marie", link: "https://vinted.fr/invite/marie", boost: 1 },
    { user: "sancho", link: "https://vinted.fr/invite/sancho", boost: 8 }, // a boosté fort
    { user: "leo", link: "https://vinted.fr/invite/leo", boost: 1 },
  ],
  "trade-republic": [
    { user: "kevin", link: "https://traderepublic.com/r/kevin", boost: 1 },
  ],
};

// File de modération des programmes suggérés (n'apparaît PAS dans la recherche
// tant qu'un admin n'a pas validé). En POC, simple tableau en mémoire.
export const moderationQueue = [];

// Helpers de lecture (remplacés par des appels API en mode "api").
export function findProgramBySlug(slug) {
  return programs.find((p) => p.slug === slug) || null;
}

export function searchProgramsRaw(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return programs.slice();
  return programs.filter((p) =>
    [p.name, p.slug, p.category, p.description]
      .join(" ")
      .toLowerCase()
      .includes(q)
  );
}
