# Le Parrain MCP

Serveur **MCP (Model Context Protocol)** pour interroger l'annuaire de
parrainage [leparrain.com](https://leparrain.com) directement depuis un
assistant IA (ChatGPT, Claude…), avec **injection automatique du bon lien de
parrainage**.

> **Repo volontairement séparé du Parrain.** Aucun code source ni accès base du
> dépôt principal. Aucun secret n'est commité. Ce dépôt peut être public sans
> rien exposer.

---

## Démarrage rapide (POC)

```bash
npm install
cp .env.example .env     # ajustez LP_USER pour simuler un appelant connecté
npm run smoke            # tests de la logique (11 assertions)
npm start                # lance le serveur MCP (transport stdio)
```

Le POC tourne sur un **dataset d'exemple en mémoire** (`LP_DATA_MODE=sample`) :
aucune infra Le Parrain requise.

### Simuler un appelant

| `.env` | Comportement |
|--------|--------------|
| `LP_USER=` (vide) | Appelant **anonyme** → lien plateforme par défaut |
| `LP_USER=marie` | **Connectée**, a déjà publié des liens → ses liens ressortent |
| `LP_USER=zoe` | **Connectée** sans lien → lien plateforme + invitation à créer |

## Les 4 tools

| Tool | Rôle |
|------|------|
| `search_programs` | Cherche des programmes, renvoie le lien résolu pour vous |
| `get_program` | Détail d'un programme + lien résolu |
| `create_referral_link` | Publie **votre** lien (connecté, https, anti-doublon) |
| `suggest_program` | Propose un programme → **modération** (pas de publication auto) |

La logique de choix du lien (« chaîne de résolution ») est décrite dans
[`PLAN.md`](./PLAN.md).

## Brancher à un client MCP

### Option A — Remote (URL à coller, recommandé)

Serveur en ligne, **aucun fichier à éditer** : collez l'URL dans un connecteur
custom de ChatGPT / Claude.

```
https://leparrain.com/mcp
```

POC ouvert sans auth → appelant anonyme → lien plateforme par défaut.
Endpoint de santé : `GET https://leparrain.com/mcp/health`.

Déploiement (serveur Plesk) : process PM2 `leparrain-mcp` (`src/http.js`, port
127.0.0.1:3005), reverse-proxy nginx `location /mcp` dans le `vhost_nginx.conf`
de leparrain.com. Process séparé : **aucun code ni base du Parrain**.

### Option B — Local (stdio)

**Claude Desktop** — `claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "leparrain": {
      "command": "node",
      "args": ["/chemin/absolu/vers/leparrain-mcp/src/server.js"],
      "env": { "LP_DATA_MODE": "sample", "LP_USER": "" }
    }
  }
}
```

**Inspecteur officiel** (pour tester visuellement) :

```bash
npm run inspect
```

## Structure

```
src/
  server.js     # serveur MCP : branche les tools sur le protocole (stdio)
  core.js       # logique métier pure des 4 tools (testable)
  resolver.js   # chaîne de résolution du lien + tirage pondéré
  data.js       # dataset d'exemple (remplacé par l'API en couche 2)
  flavor.js     # la voix du Parrain (clins d'œil The Mask)
test/smoke.js   # tests de la logique pure
landing/        # landing page de présentation
```

## Sécurité

- `.env` est gitignored. Ne commitez **jamais** de clé.
- En production (couche 2), le serveur tape l'**API publique** de leparrain.com
  via `LP_API_KEY` (fournie à l'exécution) — **jamais** d'accès base direct,
  jamais de source du Parrain dans ce repo.

— *Ssssplendide !*
