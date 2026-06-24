// ─────────────────────────────────────────────────────────────
// Journal PUBLIC et append-only des placements boostés.
//
// Chaque mise en avant d'un sponsor est tracée : graine, liste des sponsors
// éligibles + leurs poids, sponsor mis en 1ʳᵉ position, horodatage. N'importe
// qui peut lire le journal (GET /mcp/ledger), rejouer le code open-source et
// vérifier que le classement servi correspond bien à la rotation pondérée.
// C'est la preuve « pas du pipo ».
// ─────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";

const LEDGER_PATH =
  process.env.LP_LEDGER_PATH || path.join(import.meta.dirname, "..", "ledger.jsonl");

export function appendLedger(entry) {
  try {
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Le journal ne doit JAMAIS casser une réponse utilisateur.
  }
}

export function readLedger(limit = 200) {
  try {
    const lines = fs.readFileSync(LEDGER_PATH, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
