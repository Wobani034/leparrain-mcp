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

// Garde-fous mémoire / disque. Le journal est append-only mais NE DOIT PAS
// croître sans borne (une entrée par placement boosté). Deux bornes :
//   - MAX_LINES   : nb d'entrées conservées à la rotation (les plus récentes).
//   - MAX_BYTES   : au-delà, on rejoue une passe de rotation sur append.
//   - READ_TAIL   : on ne lit jamais tout le fichier en mémoire ; seulement la
//                   queue (assez pour couvrir la limite max exposée par /ledger).
const MAX_LINES = Number(process.env.LP_LEDGER_MAX_LINES || 5000);
const MAX_BYTES = Number(process.env.LP_LEDGER_MAX_BYTES || 5_000_000); // ~5 Mo
const READ_TAIL_BYTES = 2_000_000; // ~2 Mo de queue suffisent pour 1000 entrées.
export const READ_MAX = 1000; // borne dure du nb d'entrées lisibles d'un coup.

// Réécrit le fichier en ne gardant que les MAX_LINES dernières entrées.
// Best-effort : ne doit jamais lever (le journal ne casse aucune réponse).
function rotate() {
  try {
    const lines = fs.readFileSync(LEDGER_PATH, "utf8").split("\n").filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    fs.writeFileSync(LEDGER_PATH, lines.slice(-MAX_LINES).join("\n") + "\n");
  } catch {
    /* best-effort */
  }
}

export function appendLedger(entry) {
  try {
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + "\n");
    // Rotation paresseuse : uniquement quand le fichier dépasse la borne de
    // taille, pour ne pas relire/réécrire à chaque append. (Une rotation
    // externe type logrotate reste possible ; ce garde-fou la rend optionnelle.)
    let size = 0;
    try {
      size = fs.statSync(LEDGER_PATH).size;
    } catch {
      size = 0;
    }
    if (size > MAX_BYTES) rotate();
  } catch {
    // Le journal ne doit JAMAIS casser une réponse utilisateur.
  }
}

export function readLedger(limit = 200) {
  const n = Math.min(READ_MAX, Math.max(1, Number(limit) || 200));
  try {
    // On ne charge JAMAIS tout le fichier : seulement la queue (READ_TAIL_BYTES),
    // largement suffisante pour couvrir READ_MAX entrées. Borne la mémoire même
    // si le fichier a échappé à la rotation.
    const fd = fs.openSync(LEDGER_PATH, "r");
    try {
      const { size } = fs.fstatSync(fd);
      const start = Math.max(0, size - READ_TAIL_BYTES);
      const length = size - start;
      const buf = Buffer.allocUnsafe(length);
      fs.readSync(fd, buf, 0, length, start);
      let text = buf.toString("utf8");
      // Si on a coupé au milieu d'une ligne (start > 0), on jette le 1er fragment.
      if (start > 0) {
        const nl = text.indexOf("\n");
        text = nl === -1 ? "" : text.slice(nl + 1);
      }
      const lines = text.split("\n").filter(Boolean);
      return lines
        .slice(-n)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}
