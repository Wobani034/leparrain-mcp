// ─────────────────────────────────────────────────────────────
// La petite voix du Parrain — clins d'œil à *The Mask*.
// Vouvoiement de rigueur, humour léger, jamais au détriment de l'info.
// ─────────────────────────────────────────────────────────────

const QUIPS = [
  "Ssssplendide !",
  "C'est du sssolide !",
  "Sancho le Cubain approuve.",
  "Fumez-moi ça, c'est du belge !",
  "Quelle classe… et en plus c'est gratuit.",
  "Tout est sous contrôle, très chère.",
];

// Renvoie une réplique, en variant selon une graine (index d'appel) pour
// éviter le hasard non déterministe (et garder les tests reproductibles).
export function quip(seed = 0) {
  const i = Math.abs(Math.trunc(seed)) % QUIPS.length;
  return QUIPS[i];
}

// Ajoute une réplique en fin de message, mais SEULEMENT de temps en temps
// (~1 fois sur 4) pour rester léger et ne pas saouler à chaque réponse.
// Désactivable via LP_FLAVOR=off.
export function withFlavor(text, seed = 0) {
  if (process.env.LP_FLAVOR === "off") return text;
  if (Math.random() > 0.25) return text;
  const i = Math.floor(Math.random() * QUIPS.length);
  return `${text}\n\n— ${QUIPS[i]}`;
}
