/**
 * MarketDataEngine V3 — Single Source of Truth
 *
 * Architecture institutionnelle (hedge fund / prop desk) :
 *
 *   ingestSnapshot(bars) → bootstrap REST (une seule fois par session config)
 *   ingestWsBar(bar)     → mise à jour depuis WS OHLCV (snapshot / update)
 *   ingestTick(price, tsMs) → tick live (quotes WS) → update bougie active
 *   getSeries()          → sortie canonique (slot-aligned, gap-filled, séquencée)
 *
 * Invariants garantis :
 *   - Tous les slots sont alignés sur la borne inférieure du TF
 *   - La série est triée ASC par timestamp
 *   - Pas de doublons de slot
 *   - Séquence monotone (seq = index + 1)
 *   - ingestTick retourne false si aucun changement → stabilité useMemo downstream
 */

import { alignIsoToSlot, buildTimeSeries, normalizeBarToSlot, timeframeToMs } from "./ohlcvDataEngine";
import type { NormalizedOhlcvBar } from "./ohlcvIntegrity";

export class MarketDataEngineV3 {
  private series: NormalizedOhlcvBar[] = [];
  private tf: string;
  private slotMs: number;
  private instrument: string;
  private venue: string;

  constructor(tf: string, instrument: string, venue: string) {
    this.tf = tf || "1m";
    this.slotMs = Math.max(1_000, timeframeToMs(this.tf));
    this.instrument = instrument;
    this.venue = venue;
  }

  // ── Configuration (changement d'instrument / TF) ────────────────────────────

  configure(tf: string, instrument: string, venue: string): void {
    this.tf = tf || "1m";
    this.slotMs = Math.max(1_000, timeframeToMs(this.tf));
    this.instrument = instrument;
    this.venue = venue;
    this.series = [];
  }

  reset(): void {
    this.series = [];
  }

  // ── Ingestion ────────────────────────────────────────────────────────────────

  /**
   * Bootstrap REST : remplace la série ssi le nouveau snapshot est plus riche.
   * Ex: au démarrage ou après reconnexion.
   */
  ingestSnapshot(bars: NormalizedOhlcvBar[]): void {
    if (bars.length === 0) return;
    const aligned = bars.map((b) => normalizeBarToSlot(b, this.tf));
    const built = buildTimeSeries(aligned, this.tf);
    // N'écrase que si le snapshot couvre plus de périodes
    if (built.length >= this.series.length) {
      this.series = built;
    }
  }

  /**
   * WS OHLCV : met à jour ou insère une bougie dans la série canonique.
   * Utilisé depuis le handler socket.onmessage (snapshot & update).
   */
  ingestWsBar(bar: NormalizedOhlcvBar): void {
    if (!bar?.t) return;
    const norm = normalizeBarToSlot(bar, this.tf);
    const slotIso = alignIsoToSlot(norm.t, this.tf);
    const slotMs = Date.parse(slotIso);

    // Trouver une bougie existante sur ce slot
    let found = -1;
    for (let i = this.series.length - 1; i >= 0; i--) {
      if (this.series[i].t === slotIso) {
        found = i;
        break;
      }
    }

    if (found >= 0) {
      // Mise à jour : fusionner OHLCV (WS peut n'avoir que le close partiel)
      const ex = this.series[found];
      const updated: NormalizedOhlcvBar = {
        ...ex,
        h: Math.max(ex.h, norm.h),
        l: ex.l > 0 ? Math.min(ex.l, norm.l) : norm.l,
        c: norm.c,
        v: Math.max(ex.v, norm.v),
        source: "ws-update",
      };
      const next = [...this.series];
      next[found] = updated;
      this.series = next;
    } else {
      // Insertion en position ordonnée
      const insertAt = this.series.findIndex((b) => Date.parse(b.t) > slotMs);
      const aligned: NormalizedOhlcvBar = { ...norm, t: slotIso };
      const next = [...this.series];
      if (insertAt < 0) {
        next.push(aligned);
      } else {
        next.splice(insertAt, 0, aligned);
      }
      this.series = next.map((b, i) => ({ ...b, seq: i + 1 }));
    }
  }

  /**
   * Tick live (quotes WS / price feed).
   * Met à jour c/h/l de la bougie active.
   * Crée une nouvelle bougie si le tick tombe dans un slot plus récent.
   *
   * Retourne true si la série a changé → l'appelant peut décider d'émettre.
   */
  ingestTick(price: number, tsMs: number = Date.now()): boolean {
    if (!Number.isFinite(price) || price <= 0 || this.series.length === 0) return false;

    const tickSlot = Math.floor(tsMs / this.slotMs) * this.slotMs;
    const tickSlotIso = new Date(tickSlot).toISOString();
    const lastBar = this.series[this.series.length - 1];
    const lastSlot = Date.parse(lastBar.t);

    // Tick dans un slot plus récent → nouvelle bougie synthétique
    if (tickSlot > lastSlot) {
      const openPrice = lastBar.c > 0 ? lastBar.c : price;
      const newBar: NormalizedOhlcvBar = {
        t: tickSlotIso,
        o: openPrice,
        h: Math.max(openPrice, price),
        l: Math.min(openPrice, price),
        c: price,
        v: 0,
        tf: this.tf,
        seq: lastBar.seq + 1,
        venue: this.venue || lastBar.venue,
        instrument: this.instrument || lastBar.instrument,
        source: "tick-new-bar",
      };
      this.series = [...this.series, newBar];
      return true;
    }

    // Tick dans le slot courant → update close/high/low
    if (tickSlot === lastSlot) {
      if (price === lastBar.c) return false; // identique → stable ref
      const updated: NormalizedOhlcvBar = {
        ...lastBar,
        h: Math.max(lastBar.h, price),
        l: lastBar.l > 0 ? Math.min(lastBar.l, price) : price,
        c: price,
        source: "tick-update",
      };
      this.series = [...this.series.slice(0, -1), updated];
      return true;
    }

    // Tick retardataire (dans un slot passé) → ignorer pour éviter la réécriture
    return false;
  }

  // ── Lecture ──────────────────────────────────────────────────────────────────

  /**
   * Série canonique courante.
   * Reference stable si aucun changement (compatible useMemo React).
   */
  getSeries(): NormalizedOhlcvBar[] {
    return this.series;
  }

  /**
   * Bougie active (dernière de la série).
   */
  getCurrentBar(): NormalizedOhlcvBar | null {
    return this.series.length > 0 ? this.series[this.series.length - 1] : null;
  }

  /**
   * Diagnostic : résumé de l'engine pour le HUD.
   */
  getStats(): { bars: number; tf: string; instrument: string; lastTs: string | null } {
    return {
      bars: this.series.length,
      tf: this.tf,
      instrument: this.instrument,
      lastTs: this.series.length > 0 ? this.series[this.series.length - 1].t : null,
    };
  }
}
