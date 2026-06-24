# Le Parrain MCP — Programme de développement

> Serveur MCP (Model Context Protocol) permettant d'interroger l'annuaire de
> parrainage **leparrain.com** depuis un assistant IA (ChatGPT, Claude…) et
> d'injecter automatiquement le bon lien de parrainage.

**Repo séparé, par conception.** Aucun code source ni accès base du dépôt
principal Le Parrain. En production, le serveur tape une **API HTTP publique**
de leparrain.com ; il ne contient aucun secret. Le dépôt peut donc être public
sans rien exposer du Parrain.

---

## Décision produit actée

Quand un utilisateur connecté a publié son propre lien pour un programme, c'est
**son** lien qui ressort (pas celui d'Antoine). Antoine récupère tout le trafic
**anonyme** + tous les programmes sans lien communautaire. Loyal et incitatif.

## La chaîne de résolution du lien

Pour un programme + un appelant donnés :

| Ordre | Cas | Lien servi | `reason` |
|-------|-----|-----------|----------|
| 1 | Connecté **et** a publié son lien | Son lien | `user_own_link` |
| 2 | Connecté, pas de lien sur ce programme | Lien plateforme + invitation à créer le sien | `platform_default_no_user_link` |
| 3 | Anonyme | Lien plateforme (Antoine) par défaut | `platform_default` |
| 4 | Aucun lien plateforme | Tirage **pondéré** communauté (boost ↑ pour les payeurs) | `weighted_community` |

Chaque résolution est **traçable** (`reason`, `servedFor`, `boosted`) → base de
l'attribution et de la future facturation du boost.

---

## Les 3 couches (livrables indépendants)

### ✅ Couche 1 — POC (FAIT)
- Serveur MCP stdio, 4 tools, dataset d'exemple en mémoire.
- Chaîne de résolution complète + tirage pondéré.
- Garde-fous (auth requise, https only, modération des suggestions).
- Voix « The Mask ». Smoke test (11 assertions) + handshake JSON-RPC vérifiés.

### ⬜ Couche 2 — Branchement réel + création
- Backend `api` : le serveur tape l'API publique de leparrain.com (lecture
  programmes + écriture liens), **sans** accès DB direct ni source LP.
- Côté Le Parrain : exposer des endpoints dédiés `/api/mcp/*` (versionnés,
  clé API par utilisateur). Réutiliser l'anti-fraude existant (`referral.ts`,
  `hashIp` fail-closed) et la file de modération (`program_import_candidates`).
- Auth : MVP par **clé API** générée dans le compte LP (collée dans la config
  MCP). Évolution → OAuth 2.1 (spec MCP) pour le grand public.
- Transport **remote** (streamable HTTP) en plus du stdio, pour les connecteurs
  ChatGPT / Claude.ai.

### ⬜ Couche 3 — Rotation pondérée + boost payant (monétisation)
- Produit « boost » : un parrain paie pour augmenter son poids dans le tirage.
- Facturation + gestion des poids + journal d'attribution.
- **Transparence DGCCRF** : marquer les placements boostés comme mise en avant
  rémunérée (champ déjà prévu : `boosted` + `explainReason`).

---

## Garde-fous (transverses)
- Aucun secret en git (`.env` gitignored, `.env.example` documenté).
- Création de lien : appelant connecté, programme existant, URL https, anti-doublon.
- Suggestion de programme : **jamais** de publication auto → file de modération.
- Vouvoiement dans tout texte rendu à l'utilisateur.
- Rate-limit + log d'attribution (couche 2).

## Dette / exceptions documentées
- `"type": "module"` (ESM) et `zod@^3` : imposés par le SDK MCP officiel —
  exception assumée à la règle CommonJS maison.
- Dataset en mémoire = POC uniquement ; remplacé par l'API en couche 2.
