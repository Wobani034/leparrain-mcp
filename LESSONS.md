# Corrections retenues

## 2026-09-27 — Découverte MCP anonyme bloquée

- Origine : l'entrée HTTP renvoyait `401` avant de créer le serveur MCP dès
  qu'aucun token n'était présent, bien que les cinq outils de découverte
  acceptent déjà un appelant anonyme dans la logique métier.
- Correction : créer un appelant anonyme en l'absence de token, conserver le
  défi OAuth `401` pour un token fourni mais invalide et le `503` en cas de
  panne de l'API. Les outils qui modifient des données restent réservés aux
  comptes connectés. `suggest_program` est retiré de l'exposition MCP car sa
  file de modération en mémoire ne conserve pas les propositions durablement.
- Vérification : le test HTTP local exerce les cinq lectures anonymes, la
  liste des outils protégés, la connexion valide, le défi OAuth et la panne
  de l'API. Les annotations MCP sont contrôlées pour chaque outil.

## 2026-09-27 — Annotation de lecture malgré des écritures de journal

- Origine : les outils déclarés en lecture seule pouvaient écrire dans le
  journal des placements (`search_programs`) ou envoyer une mesure d'usage
  quand l'appelant était connecté.
- Correction : `readOnlyHint` vaut `false` dès qu'une de ces écritures est
  possible. Les autres lectures anonymes conservent `readOnlyHint: true`.
  Les journaux de placement et la mesure d'usage restent actifs.
- Vérification : le test HTTP contrôle les annotations, une entrée du journal
  de placement et l'envoi de la mesure d'usage après une lecture connectée.
