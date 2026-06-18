# TXT — Doctrine de preuve autonome BingX-native (sans MT5)

Doctrine actée le **2026-06-18**, sur diagnostic read-only (aucun marché, aucun dry-run, aucun GO live).
Compagnons : [BINGX_MARKETABLE_LIMIT_PROTECTION_V1.md](BINGX_MARKETABLE_LIMIT_PROTECTION_V1.md) · [BINGX_MICRO_LIVE_V2_REPEATABILITY_GATE.md](BINGX_MICRO_LIVE_V2_REPEATABILITY_GATE.md).

## 0. État acté (preuves DB du diag)

Le **rail autonome BingX-native existe déjà**. Il n'est pas à construire comme nouveau système, et il ne doit **pas** être fusionné avec le rail opérateur direct-broker. Les 3 tables de preuve ne sont **pas structurellement dépendantes de MT5** :

| Table | Writer | Nature |
|---|---|---|
| `execution_fill_events` | `execution_router` | `fill_type='live-broker'` (broker) + paper fills ; venue-agnostic |
| `decision_outcomes` | `control_plane` (3 INSERT) | colonnes `provider` / `source` |
| `reality_gap_samples` | `control_plane._persist_reality_gap_artifacts` (replay décisionnel, + chemin rust) | venue-agnostic |

Évidence mesurée (read-only) :
```
decision_outcomes  provider=bingx  source=intent   status=pending    c=11  dernier 2026-06-17
decision_outcomes  provider=mt5-bridge source=mt5  status=finalized  c=32  dernier 2026-03-31
execution_fill_events fill_type=live-broker  venue=bingx  c=6  (avril 2026, aucun depuis)
execution_fill_events 7 derniers jours  =  book 23003 + hidden-liquidity 29  (0 live-broker = paper)
reality_gap_samples venue=bingx  c=13  dernier 2026-04-07
backend market-data-plane = sain (BTCUSDT/ETHUSDT/SOLUSDT actifs) ; terminal OHLCV = capture WS navigateur offline, découplée/non-bloquante (930d1a6)
```
Lecture : le rail BingX autonome **a réellement produit des fills `live-broker` en avril**. Il **émet encore des intents BingX** (06-17) mais ils restent `pending`, car le routage récent reste en **paper**. Les seules preuves `finalized` sont MT5 de mars — un **artefact historique**, pas une dépendance structurelle.

## 1. Doctrine — trois rails séparés

**Rail 1 — Opérateur direct-broker**
- Déclenché uniquement par **phrase-GO explicite** (`GO execute BingX marketable-limit protected side=…`).
- Marketable-limit protégé (control_plane → broker, direct).
- **Ne persiste pas** dans la preuve autonome canonique. **Ne doit jamais backfiller `execution_fill_events`.**

**Rail 2 — Historique MT5 / intent**
- Source historique de certaines preuves `finalized` (mars-avril).
- Dormant.
- **Ne doit plus être considéré comme l'unique chemin obligatoire** de preuve future.

**Rail 3 — Autonome BingX-native** (chemin canonique cible)
- Flux : `intent → risk gateway → execution_router → broker BingX → live-broker fill → finalized outcome → reality_gap sample`.
- **Distinct** du rail opérateur direct-broker. **Distinct** d'une promotion micro-live continue.
- Existant mais **dormant** (route paper).

## 2. Ligne rouge

**Aucun fill opérateur direct-broker ne doit être injecté dans `execution_fill_events`.** Si les fills opérateur doivent être tracés, ce sera dans une **voie séparée** — p.ex. `operator_direct_broker_evidence` / `external_execution_observation` / `manual_operator_fill_audit` — **jamais** pour rafraîchir la preuve autonome canonique. Sinon le système croirait avoir validé sa propre boucle alors qu'un humain est passé par une porte latérale : bug philosophique qui finit en bug financier.

## 3. Blocage réel — circularité preuve / exécution

```
preuve canonique fraîche   ⟸ nécessite fills live-broker + outcomes finalized
fills live-broker frais     ⟸ nécessitent une exécution autonome BingX réelle
exécution autonome live      ⟸ nécessite promotion / autorisation contrôlée
promotion autonome           ⟸ bloquée par preuve STALE
```
Donc : la preuve **ne peut pas** être fabriquée en read-only, et **ne peut pas** être réparée par backfill opérateur sans casser la séparation des rails.

## 4. Sortie propre — cycle de renouvellement de preuve autonome

Un **cycle de renouvellement de preuve** minuscule, explicitement autorisé, **via `execution_router`** (pas via le rail direct-broker opérateur). Propriétés obligatoires :
- BingX-native, routé par le rail autonome (persiste `provider=bingx`, `source=intent`, `fill_type='live-broker'`, finalise l'outcome, échantillonne le reality_gap) ;
- notional minimal · borné dans le temps · managed_live bref ;
- gated explicitement · persisté canoniquement · suivi d'un flatten/revert ;
- **séparé** d'une promotion micro-live continue · **séparé** du marketable-limit operator rail.

**Déclencheur :** ce cycle **ne doit PAS** être déclenché par les pings ambiants TXT-Hedge, ni par `clean_cycles 3/3`, ni par un statut `gate go`. Il exige une **phrase-GO dédiée et distincte** de `GO execute BingX marketable-limit`.

C'est un **bootstrap de preuve**, PAS une promotion live. Nuance énorme : le rail autonome reprend un battement cardiaque, sous défibrillateur réglementé, pas en freestyle.

## 5. Statut courant
```
rail opérateur direct-broker     séparé
backfill opérateur               interdit
rail autonome BingX-native       existant mais dormant
MT5                              non requis structurellement
preuve canonique                 stale (fill 59 j · outcome 79 j · gap 31 j)
coverage                         insuffisante (spread_rows=0, source MT5/spread dormante)
promotion probe→micro_live        bloquée
dry-run immédiat                 non utile tant que preuve/candidats vides
prochain chantier                spécifier le proof-renewal cycle autonome
```

## 6. Décision
- **Ne pas construire** un nouveau rail.
- **Ne pas fusionner** les rails.
- **Ne pas backfiller** la preuve.
- **Adapter / réactiver** le rail autonome BingX-native existant via un **cycle de renouvellement de preuve** explicitement autorisé, froidement spécifié, séparé du rail opérateur marketable-limit.

## 7. Suite logique (prochain chantier froid — NON démarré ici)

Livrable : **`spec autonomous-proof-renewal-cycle-v1`** (spécification, ne trade rien). Contenu attendu :
```
phrase-GO dédiée            préconditions             notional max
symbol / venue              managed_live window       kill-switch checks
risk-gateway checks         persist checks            finalized outcome checks
reality_gap checks          flatten / revert          abort rules
artefacts requis            preuve attendue           critères succès / échec
```
Cette spec est la vraie sortie de circularité : un bootstrap de preuve, pas une promotion. Elle reste froide tant qu'aucune phrase-GO dédiée n'est donnée.
