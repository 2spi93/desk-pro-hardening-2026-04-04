# SPEC — autonomous-proof-renewal-cycle-v1

**Cold design only. This spec trades nothing.** No market, no dry-run, no live, no merge, no backfill.
Parent doctrine: [TXT_AUTONOMOUS_PROOF_DOCTRINE_BINGX_NATIVE.md](TXT_AUTONOMOUS_PROOF_DOCTRINE_BINGX_NATIVE.md) (commit 548e38e). Drafted 2026-06-18.

## 1. Objectif

Renouveler la **preuve autonome canonique** BingX-native — `execution_fill_events (fill_type='live-broker', venue=bingx)` + `decision_outcomes (provider=bingx, status='finalized')` + `reality_gap_samples (venue=bingx)` — par **un** cycle minuscule, borné, explicitement autorisé, **routé par le rail autonome (execution_router)**. Sans MT5, sans backfill, sans le rail opérateur direct-broker. C'est un **bootstrap de preuve**, pas une promotion.

## 2. Non-objectifs

```
pas de promotion micro-live           pas de trading continu / boucle
pas d'ingestion direct-broker          pas de contournement du proof gate
pas de fusion de rails                 pas de backfill SQL manuel de la preuve
pas de dépendance MT5                  pas de réutilisation de la phrase-GO opérateur
```
Le marketable-limit operator rail reste séparé : ce cycle ne l'utilise PAS et ne s'y substitue PAS.

## 3. Phrase-GO dédiée

Déclencheur unique, **distinct** de `GO execute BingX marketable-limit protected side=…` :
```
GO renew BingX autonomous proof side=sell        (ou side=buy)
```
Un « GO » nu, un ping TXT-Hedge, `clean_cycles 3/3` ou `gate=go` **ne déclenchent JAMAIS** ce cycle (voir [[go-disambiguation-protocol]]). La phrase doit être littérale et exacte.

## 4. Préconditions (toutes obligatoires avant tout ordre)

```
system_mode = guarded_auto (au départ)     position = 0 (flat, BingX truth)
open_orders = 0                             kill_switch = false
opportunity gate = go                        risk-gateway /v1/checks/pre-trade = accept
account sync fraîche (bingx_account_state)   notional minuscule (cap = 7.5 USDT, aligné v1)
managed_live explicitement borné (fenêtre courte, fermée par trap)
```
Pré-check **read-only** d'abord (refus si un seul point manque), comme le harness opérateur.

## 5. Chemin autorisé (canonique — la différence essentielle)

Le cycle passe par le **rail autonome**, donc il **persiste** :
```
intent (TXT-originated, source=intent, provider=bingx)
  → control_plane /v1/intents/submit (auto_execute, live_execution provider=bingx)
  → risk-gateway /v1/checks/pre-trade
  → execution_router (live_context.enabled)
  → broker /v1/live/orders (BingX)
  → execution_router persiste execution_fill_events (fill_type='live-broker', venue='bingx')
  → decision_outcomes (provider=bingx, source=intent) → FINALIZED
  → reality_gap_samples (venue=bingx, depuis replay décisionnel)
```
**Interdit :** le chemin direct control_plane → broker `/v1/live/orders` (c'est le rail opérateur, il ne persiste pas). Le cycle DOIT transiter par execution_router.

### Design decisions à trancher dans l'implémentation (open points)
- **D1 — Déterminisme du fill.** Le rail autonome route via execution-AI v6, qui peut choisir un LIMIT passif (ne fille pas) ou MARKET (fille). Pour qu'une preuve se renouvelle, le cycle a besoin d'un **fill déterministe**. Option retenue à spécifier : contraindre l'action d'exécution à une forme qui fille (taker) **en restant routée par execution_router** (pas le direct-broker). La protection TP/SL native n'est PAS requise pour la preuve autonome (c'est une exigence du rail opérateur) — le cycle vise fill+outcome+gap, pas armed.
- **D2 — Finalisation de l'outcome.** `label_intent_outcomes.py` est read-only et **ne finalise pas** `decision_outcomes`. Aujourd'hui les intents bingx restent `pending`. La spec exige de **définir/vérifier le câblage canonique** qui amène l'outcome à `status='finalized'` (insert avec status, ou `/v1/outcomes/update` avec PnL/slippage mesurés) pour le rail BingX autonome — **jamais** par UPDATE SQL manuel. Si ce câblage manque, c'est un livrable préalable au premier cycle.
- **D3 — Fenêtre de mesure.** L'outcome finalisé nécessite une mesure (PnL/slippage 5m/1h selon le labeler). Décider si le cycle attend la fenêtre courte (5m) ou enregistre l'outcome à la fermeture immédiate (flatten) avec basis explicite.

## 6. Artefacts obligatoires (capture sanitisée, secrets jamais loggés)

```
entry_request_sanitized            (intent + live_execution, sans secret)
entry_response_raw (redacted)      (router/broker, order_id, fill)
execution_fill_events row          (id, fill_type='live-broker', venue=bingx, decision_id)
decision_outcomes finalized        (decision_id, provider=bingx, status=finalized, pnl/slippage)
reality_gap_samples                (sample_id lié au decision_id)
post_entry_checks                  (position_truth, open_orders, balance before/after)
flatten evidence                   (close order + position=0)
revert evidence                    (system_mode back to guarded_auto)
```
Redaction identique au harness v1 (api_key/secret/signature/auth/cookie/token/signed_url → `<redacted>`), artefact gitignored.

## 7. Abort rules (no-retry)

```
une rupture = abort immédiat
→ flatten hedge-safe (BUY positionSide=SHORT / SELL positionSide=LONG, no reduceOnly)
→ revert guarded_auto (trap EXIT, toujours)
→ artefact conservé
→ NO retry (nouvelle tentative = nouvelle phrase-GO dédiée)
```
Ruptures = STOP conditions : risk reject · order non tracé (pas de decision_id/fill) · fill non persisté dans execution_fill_events · outcome non finalisable · position truth diverge · kill_switch · sync compte périmée · mode non revert.

## 8. Critères de succès / échec

**Succès** (tous) :
```
execution_fill_events : ≥1 row fill_type='live-broker' venue=bingx, decision_id du cycle
decision_outcomes      : status='finalized' provider=bingx pour ce decision_id
reality_gap_samples    : ≥1 sample lié au decision_id
position finale = 0 · open_orders = 0 · system_mode = guarded_auto
rails intacts (aucun backfill, aucune écriture opérateur dans la preuve)
proof staleness rafraîchie (ack/fill/outcome/gap remis à ~0 j)
artefact persisté + leak-clean
```
**Échec** (tous tenus aussi) :
```
aucune promotion déclenchée · artefact conservé · position flat · mode guarded_auto
état des rails inchangé · aucune dette de vérité créée
```

## 9. Rapport avec les autres rails / lignes rouges
- Le fill de ce cycle **est** canonique (rail autonome) — c'est tout l'intérêt.
- Le fill opérateur direct-broker reste **hors** preuve canonique (ligne rouge inchangée).
- Ce cycle **n'est pas** une promotion : il produit *une* preuve, puis revient flat. La promotion probe→micro_live reste un GO séparé ultérieur, gated par la fraîcheur de preuve que ce cycle restaure.

### Références
`TXT_AUTONOMOUS_PROOF_DOCTRINE_BINGX_NATIVE.md` · `BINGX_MARKETABLE_LIMIT_PROTECTION_V1.md` · `BINGX_MICRO_LIVE_V2_REPEATABILITY_GATE.md` · writers : `apps/execution_router/main.py` (execution_fill_events), `apps/control_plane/main.py` (decision_outcomes, reality_gap_samples) · commit doctrine `548e38e`.

---
**Statut : SPEC (design). Rien n'est implémenté, rien n'est tradé. Le premier cycle exigera la phrase-GO dédiée — et probablement D2 (câblage finalisation) livré d'abord.**
