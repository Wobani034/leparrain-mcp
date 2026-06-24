#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Protocole de test LIVE du serveur Le Parrain MCP.
# À lancer SUR le serveur Plesk (accès psql + node /opt/leparrain-mcp +
# curl vers l'URL publique). Utilise un user de référence (par email) :
# génère un token de test, exerce tout le parcours, PUIS nettoie et vérifie
# que le compte est revenu à son état initial (aucun effet de bord).
#
#   TEST_EMAIL=antoine.dematte@gmail.com bash test/live-protocol.sh
# ─────────────────────────────────────────────────────────────
set -u
U="https://leparrain.com/mcp"
H1='content-type: application/json'; H2='accept: application/json, text/event-stream'
TEST_EMAIL="${TEST_EMAIL:-antoine.dematte@gmail.com}"
MARK="https://example.com/r/PROTOCOL-$(date +%s)"   # marqueur unique de l'annonce de test

cd /var/www/vhosts/leparrain.com/build 2>/dev/null || cd /var/www/vhosts/leparrain.com/httpdocs
DBURL=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
q(){ psql "$DBURL" -t -A -c "$1"; }
post(){ curl -s -X POST "$1" -H "$H1" -H "$H2" -d "$2"; }
code(){ curl -s -o /dev/null -w '%{http_code}' -X POST "$1" -H "$H1" -H "$H2" -d "$2"; }

PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
ko(){ echo "  ❌ $1 — $2"; FAIL=$((FAIL+1)); }
has(){ case "$2" in *"$3"*) ok "$1";; *) ko "$1" "manque «$3» | reçu: ${2:0:140}";; esac; }
hasnt(){ case "$2" in *"$3"*) ko "$1" "« $3 » présent à tort";; *) ok "$1";; esac; }
eq(){ [ "$2" = "$3" ] && ok "$1" || ko "$1" "attendu «$3», obtenu «$2»"; }

echo "════════ A. ANONYME (découverte) ════════"
R=$(post "$U" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"proto","version":"1"}}}')
has "A1 initialize → protocole" "$R" '"protocolVersion"'
TOOLS=$(post "$U" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
has  "A2 tools/list contient search_programs" "$TOOLS" '"search_programs"'
hasnt "A2 tools/list n'expose PAS create_announcement (anonyme)" "$TOOLS" '"create_announcement"'
SR=$(post "$U" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_programs","arguments":{"query":"banque"}}}')
has "A3 search « banque » → BoursoBank" "$SR" 'BoursoBank'
GP=$(post "$U" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_program","arguments":{"slug":"boursobank"}}}')
has "A4 get_program boursobank → vrai lien bour.so" "$GP" 'bour.so'
GP404=$(post "$U" '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_program","arguments":{"slug":"zzz-inexistant"}}}')
has "A5 get_program inconnu → message d'erreur propre" "$GP404" 'trouve'
SG=$(post "$U" '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"suggest_program","arguments":{"name":"ProtoTestBank"}}}')
has "A6 suggest_program → modération (pas de publication auto)" "$SG" 'modération'

echo "════════ B. BOOST AUDITABLE ════════"
post "$U" '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search_programs","arguments":{"query":"banque"}}}' >/dev/null
LED=$(curl -s "$U/ledger?limit=1")
has "B1 journal public expose une entrée" "$LED" '"featured"'
# Rejoue le dernier tirage depuis le code OSS → doit redonner le featured du journal
REPLAY=$(cd /opt/leparrain-mcp && node --input-type=module -e '
import { pickWeighted } from "./src/boost.js";
const r = await (await fetch("https://leparrain.com/mcp/ledger?limit=1")).json();
const e = r.entries.at(-1);
if(!e){console.log("NO_ENTRY");process.exit(0);}
const got = pickWeighted(e.slots, e.seed+"#0").slug;
console.log(got===e.featured ? "MATCH" : "MISMATCH("+got+"!="+e.featured+")");
' 2>/dev/null)
eq "B2 rejouabilité : recalcul == featured du journal" "$REPLAY" "MATCH"

echo "════════ C. SÉCURITÉ AUTH ════════"
BADTOK="lpm_token-invalide-de-test"   # volontairement faux (pas un secret)
eq "C1 token bidon → /api/mcp/me 401" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/mcp/me -H "Authorization: Bearer $BADTOK")" "401"
BADTOOLS=$(post "$U?k=$BADTOK" '{"jsonrpc":"2.0","id":8,"method":"tools/list"}')
hasnt "C2 token invalide → reste anonyme (pas create_announcement)" "$BADTOOLS" '"create_announcement"'

echo "════════ D. CONNECTÉ — user de référence ($TEST_EMAIL) ════════"
USERID=$(q "SELECT id FROM users WHERE email='$TEST_EMAIL'")
[ -n "$USERID" ] && ok "D0 user trouvé: $USERID" || { ko "D0 user introuvable" "$TEST_EMAIL"; echo "ABANDON"; exit 1; }
# Snapshot AVANT
ANN_BEFORE=$(q "SELECT count(*) FROM announcements WHERE user_id='$USERID'")
BAL_BEFORE=$(q "SELECT COALESCE((SELECT balance FROM user_wallets WHERE user_id='$USERID'),0)")
echo "  · snapshot avant — annonces: $ANN_BEFORE | solde IpCoins: $BAL_BEFORE"
SLUG=$(q "SELECT slug FROM programs p WHERE is_active AND status='published' AND NOT EXISTS (SELECT 1 FROM announcements a WHERE a.program_id=p.id AND a.user_id='$USERID') ORDER BY name LIMIT 1")
# Génère un token de test pour CE user
RAW="lpm_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
HASH=$(printf '%s' "$RAW" | sha256sum | cut -d' ' -f1)
psql "$DBURL" -q -c "INSERT INTO api_tokens (label,hash,scopes,created_by) VALUES ('mcp-test-$(date +%s)','$HASH',ARRAY['mcp'],'$USERID')"
ME=$(curl -s http://127.0.0.1:3001/api/mcp/me -H "Authorization: Bearer $RAW")
has "D1 /api/mcp/me → identité du user" "$ME" "$USERID"
has "D1 /api/mcp/me → email du user" "$ME" "$TEST_EMAIL"
CTOOLS=$(post "$U?k=$RAW" '{"jsonrpc":"2.0","id":9,"method":"tools/list"}')
has "D2 tools/list connecté → create_announcement présent" "$CTOOLS" '"create_announcement"'
CR=$(post "$U?k=$RAW" "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"tools/call\",\"params\":{\"name\":\"create_announcement\",\"arguments\":{\"program\":\"$SLUG\",\"title\":\"Protocole\",\"content\":\"Annonce de protocole, supprimée immediatement.\",\"referral_url\":\"$MARK\"}}}")
has "D3 create_announcement → publié" "$CR" 'publié'
DBROW=$(q "SELECT status FROM announcements WHERE referral_url='$MARK'")
eq "D4 annonce en base → PUBLISHED" "$DBROW" "PUBLISHED"
DUP=$(post "$U?k=$RAW" "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"create_announcement\",\"arguments\":{\"program\":\"$SLUG\",\"content\":\"doublon\"}}}")
has "D5 doublon même programme → refusé (déjà une annonce)" "$DUP" 'déjà'
eq "D6 POST /api/mcp/announcements sans programme → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3001/api/mcp/announcements -H "Authorization: Bearer $RAW" -H "$H1" -d '{"title":"x"}')" "400"

echo "════════ E. CYCLE DE VIE TOKEN + NETTOYAGE ════════"
AID=$(q "SELECT id FROM announcements WHERE referral_url='$MARK'")
psql "$DBURL" -q -c "DELETE FROM announcement_security_analysis WHERE announcement_id='$AID'" 2>/dev/null
psql "$DBURL" -q -c "DELETE FROM announcement_events WHERE announcement_id='$AID'" 2>/dev/null
psql "$DBURL" -q -c "DELETE FROM announcement_votes WHERE announcement_id='$AID'" 2>/dev/null
psql "$DBURL" -q -c "DELETE FROM announcements WHERE referral_url='$MARK'"
psql "$DBURL" -q -c "UPDATE api_tokens SET revoked_at=now() WHERE label LIKE 'mcp-test-%' AND created_by='$USERID' AND revoked_at IS NULL"
eq "E1 token révoqué → /api/mcp/me 401" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/mcp/me -H "Authorization: Bearer $RAW")" "401"
psql "$DBURL" -q -c "DELETE FROM api_tokens WHERE label LIKE 'mcp-test-%' AND created_by='$USERID'"

echo "════════ F. AUCUN EFFET DE BORD (snapshot après) ════════"
ANN_AFTER=$(q "SELECT count(*) FROM announcements WHERE user_id='$USERID'")
BAL_AFTER=$(q "SELECT COALESCE((SELECT balance FROM user_wallets WHERE user_id='$USERID'),0)")
eq "F1 nombre d'annonces inchangé" "$ANN_AFTER" "$ANN_BEFORE"
eq "F2 solde IpCoins inchangé" "$BAL_AFTER" "$BAL_BEFORE"
eq "F3 zéro token de test résiduel" "$(q "SELECT count(*) FROM api_tokens WHERE label LIKE 'mcp-test-%'")" "0"
eq "F4 zéro annonce de protocole résiduelle" "$(q "SELECT count(*) FROM announcements WHERE referral_url='$MARK'")" "0"

echo
echo "════════════════════════════════════════"
echo "RÉSULTAT : $PASS réussis / $FAIL échoués"
[ "$FAIL" -eq 0 ] && echo "✅ TOUT VERT — c'est du sssolide !" || echo "⚠️ des cas ont échoué"
echo "════════════════════════════════════════"
