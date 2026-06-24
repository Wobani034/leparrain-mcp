// ─────────────────────────────────────────────────────────────
// Charge le fichier .env dans process.env.
//
// DOIT être le TOUT PREMIER import des entrées (http.js, server.js) : en ESM
// les modules importés sont évalués avant le corps du module importateur, et
// backend.js lit process.env.LP_DATA_MODE dès son initialisation. En important
// ce fichier en premier, le .env est chargé avant cette lecture.
//
// Utilise le loader natif Node (>=20.12) — aucune dépendance.
// ─────────────────────────────────────────────────────────────

import { join } from "node:path";

try {
  // Chemin absolu basé sur l'emplacement du fichier (robuste au cwd de PM2).
  process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
} catch {
  // Pas de .env (ex: tests locaux) → on garde process.env tel quel.
}
