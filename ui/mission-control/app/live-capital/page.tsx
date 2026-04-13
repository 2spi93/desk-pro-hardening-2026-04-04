"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import HelpHint from "../../components/HelpHint";
import OperatorPanelGuide from "../../components/ui/OperatorPanelGuide";
import { EXCHANGE_CONNECTION_CATALOG, WALLET_CONNECTION_CATALOG } from "../../lib/connectionCatalog";
import {
  getExchangeCapability,
  normalizeExchangeCapabilityMap,
  type ExchangeCapability,
} from "../../lib/exchangeCapabilities";
import { openOpsCopilotPrompt } from "../../lib/opsCopilot";

type JsonMap = Record<string, unknown>;

type AccountRow = {
  account_id: string;
  client_id: string;
  account_type: string;
  venue: string;
  connector_type: string;
  mode: string;
  status: string;
  display_name: string | null;
  external_ref: string | null;
  portfolio_id: string | null;
  latest_equity_usd: number | null;
  gross_exposure_usd: number | null;
  net_exposure_usd: number | null;
  metadata: JsonMap;
};

type ConnectorAccountRow = {
  provider: string;
  provider_type: string;
  account_id: string;
  label: string;
  mode: string;
  auth_method: string;
  client_id: string;
  owner_username: string;
  has_credentials: boolean;
  address: string | null;
  linked_at: string | null;
};

type PortfolioRow = {
  portfolio_id: string;
  client_id: string;
  name: string;
  mandate_type: string;
  risk_profile: string;
  status: string;
};

type StrategyRow = {
  strategy_id: string;
  name: string;
  market: string;
  setup_type: string;
  status: string;
  current_level: number;
};

type CapitalSourceRow = {
  key: string;
  account_id: string;
  client_id: string;
  source_type: "broker" | "exchange" | "wallet";
  platform: string;
  connector_type: string;
  environment: string;
  permission_label: string;
  status: string;
  display_name: string;
  latest_equity_usd: number | null;
  gross_exposure_usd: number | null;
  net_exposure_usd: number | null;
  canonical_account_id: string | null;
  canonical: boolean;
  address: string | null;
  summary: string;
};

type HelpCopy = {
  text: string;
  examples: string[];
};

const DESK_VEHICLE_HELP: Record<string, HelpCopy> = {
  "managed-account": {
    text: "Mandat opéré compte par compte. Le client garde son compte, le desk gère l'exécution et le risque dans un cadre dédié.",
    examples: ["Compte broker live d'un client avec limites propres.", "Compte exchange client alloué sans mutualiser les actifs avec d'autres investisseurs."],
  },
  "master-fund": {
    text: "Pool mutualisé. Le capital est géré dans un véhicule commun avec NAV, gouvernance et reporting consolidés.",
    examples: ["Plusieurs investisseurs exposés au même sleeve alpha.", "Structure adaptée si le desk mutualise exécution et collatéral."],
  },
  "segregated-mandate": {
    text: "Mandat séparé et fortement customisé. Le client conserve une gouvernance plus fine sur les règles, limites et exclusions.",
    examples: ["Client institutionnel avec règles d'exécution spécifiques.", "Compte live avec contraintes venue, levier ou actifs autorisés."],
  },
  treasury: {
    text: "Poche de réserve, collatéral ou conservation. On privilégie la disponibilité et la sécurité plutôt que l'alpha directionnel.",
    examples: ["USDT de réserve pour appels de marge.", "Wallet de custody non destiné au trading continu."],
  },
};

const CAPITAL_SLEEVE_HELP: Record<string, HelpCopy> = {
  "core-alpha": {
    text: "Poche centrale de performance. C'est là que les stratégies principales portent le risque et la génération d'alpha.",
    examples: ["Allocation principale sur signaux directionnels ou market-neutral.", "Compte live prioritaire pour les agents de production."],
  },
  "hedge-overlay": {
    text: "Poche de couverture. Elle réduit le risque du reste du portefeuille plutôt que de chercher le rendement brut.",
    examples: ["Perp short pour couvrir un inventaire spot.", "Overlay dérivés pour réduire le beta global."],
  },
  "liquidity-reserve": {
    text: "Réserve de liquidité immédiatement mobilisable pour marges, rachats ou redéploiement rapide du capital.",
    examples: ["USDT disponible pour renforcer un sleeve actif.", "Cash buffer avant transfert vers futures."],
  },
  "event-driven": {
    text: "Poche opportuniste orientée événements ou fenêtres tactiques, avec durée de détention et sizing plus spécifiques.",
    examples: ["Catalyseur court terme sur un listing ou une annonce macro.", "Déploiement tactique avec cap de risque dédié."],
  },
  "carry-basis": {
    text: "Poche de portage et basis. On exploite les écarts de financement, rendement ou structure terme plutôt qu'une vue purement directionnelle.",
    examples: ["Spot + short perp pour capter une prime de funding.", "Arbitrage basis sur futures liquides."],
  },
};

const EXECUTION_BOOK_HELP: Record<string, HelpCopy> = {
  "multi-venue": {
    text: "Le desk répartit l'exécution sur plusieurs venues pour optimiser liquidité, coûts et redondance opérationnelle.",
    examples: ["Spot sur un CEX, hedge sur un autre, réserve en custody.", "Acheminement conditionnel selon profondeur disponible."],
  },
  "spot-only": {
    text: "Exécution limitée au spot. Pas de levier ni de dérivés dans ce book.",
    examples: ["Wallet treasury qui ne doit pas ouvrir de positions perp.", "Compte client au mandat cash-only."],
  },
  "perp-futures": {
    text: "Book dédié aux dérivés perp/futures. Adapté aux overlays, couvertures et stratégies avec marge.",
    examples: ["Couverture d'un inventaire spot via perp USDT-M.", "Stratégie market-neutral portée surtout par futures."],
  },
  "options-overlay": {
    text: "Utilisé quand la couverture ou l'expression de vue passe d'abord par des options et non par le spot ou le perp.",
    examples: ["Overlay convexité sur un portefeuille directionnel.", "Gestion d'un risque événementiel par options."],
  },
  "custody-only": {
    text: "Aucune exécution de marché prévue. Le compte sert surtout à la conservation, au contrôle des fonds ou au settlement.",
    examples: ["Wallet Fireblocks de réserve.", "Adresse Ledger visible mais non signée par les agents."],
  },
};

const SETTLEMENT_POLICY_HELP: Record<string, HelpCopy> = {
  hybrid: {
    text: "Le capital circule entre venues d'exécution et réserve/custody selon les besoins du desk.",
    examples: ["Spot sur exchange, réserve en wallet, hedge sur futures.", "Allers-retours entre compte de fonds et compte de trading."],
  },
  "exchange-collateral": {
    text: "Le collatéral reste principalement sur l'exchange. Plus efficace pour trader, moins conservateur sur le risque de venue.",
    examples: ["USDT gardé sur BingX pour spot et futures.", "Compte actif qui évite les transferts permanents."],
  },
  "broker-margin": {
    text: "La marge est concentrée côté broker/prime line avec logique de reporting et de supervision plus proche d'un desk classique.",
    examples: ["Compte MT5 ou prime-broker avec contrôle centralisé.", "Mandat live où l'exécution passe par une ligne de marge dédiée."],
  },
  "cold-custody": {
    text: "Le règlement privilégie la sécurité et la conservation hors venue. On ne déploie le capital que ponctuellement.",
    examples: ["Réserve en cold wallet avant injection ponctuelle sur exchange.", "Trésorerie client gardée en custody institutionnelle."],
  },
};

const REBALANCE_CADENCE_HELP: Record<string, HelpCopy> = {
  "intra-day": {
    text: "Réallocation rapide au fil de la séance. Adaptée aux books actifs, couvertures tactiques et ajustements fréquents.",
    examples: ["Hedge réajusté plusieurs fois par jour.", "Rotation dynamique entre spot et futures."],
  },
  daily: {
    text: "Le desk recalcule et redistribue le capital sur un rythme journalier, compromis classique entre contrôle et friction opérationnelle.",
    examples: ["Révision des caps chaque fin de journée.", "Ajustement quotidien des sleeves actifs et réserve."],
  },
  weekly: {
    text: "Réglage plus lent, utile pour des mandats stables ou des poches moins tactiques.",
    examples: ["Treasury peu mobile.", "Mandat ségrégué avec comité d'allocation hebdomadaire."],
  },
};

const LIQUIDITY_TIER_HELP: Record<string, HelpCopy> = {
  "tier-1": {
    text: "Actifs et venues très liquides. C'est la base pour un déploiement institutionnel standard.",
    examples: ["BTC, ETH, SOL ou grandes paires USDT.", "Venues profondes avec exécution plus prévisible."],
  },
  "tier-2": {
    text: "Liquidité correcte mais moins profonde. Le sizing et la fréquence d'exécution doivent être plus contrôlés.",
    examples: ["Altcoins intermédiaires.", "Paires négociables mais avec impact de marché plus visible."],
  },
  "special-situations": {
    text: "Cas spéciaux ou opportunités moins liquides. Nécessite validation forte, caps réduits et monitoring serré.",
    examples: ["Event-driven sur actif moins profond.", "Poche tactique avec capacité limitée."],
  },
};

const MANDATE_TYPE_HELP: Record<string, HelpCopy> = {
  discretionary: {
    text: "Le desk décide et exécute dans le cadre mandaté. C'est le mode le plus proche d'une gestion déléguée réelle.",
    examples: ["Client donne le mandat, le desk pilote les ordres et allocations.", "Utilisable pour un déploiement live agentique sous gouvernance."],
  },
  advisory: {
    text: "Le desk recommande mais n'agit pas seul. La décision finale ou l'exécution reste côté client ou opérateur validateur.",
    examples: ["Copilot propose une allocation, l'opérateur confirme.", "Convient si le client veut garder le dernier mot."],
  },
  simulation: {
    text: "Mode bac à sable. On valide la logique de portefeuille et de risk sans impact live sur le capital du client.",
    examples: ["Shadow mode avant promotion live.", "Test d'un nouveau sleeve sur un capital fictif."],
  },
  treasury: {
    text: "Mandat orienté conservation, cash management et disponibilité du collatéral plutôt que recherche d'alpha.",
    examples: ["Wallet de réserve client.", "Portefeuille destiné au settlement ou à la marge."],
  },
};

const RISK_PROFILE_HELP: Record<string, HelpCopy> = {
  conservative: {
    text: "Priorité à la protection du capital, aux caps serrés et à une utilisation limitée du levier ou des poches tactiques.",
    examples: ["Treasury client ou premier passage live.", "Allocation réduite avec forte réserve de liquidité."],
  },
  balanced: {
    text: "Compromis entre rendement et contrôle du drawdown. C'est souvent le profil par défaut pour un desk client live.",
    examples: ["Sleeve principal avec poche hedge active.", "Capital live diversifié entre spot, réserve et couverture."],
  },
  aggressive: {
    text: "Tolérance plus forte au risque, au levier ou aux rotations tactiques. À réserver aux mandats explicitement calibrés pour cela.",
    examples: ["Book tactique futures avec overlay actif.", "Capital opportuniste encadré par des caps stricts."],
  },
};

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatUsd(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "-";
  }
  return Number(value).toLocaleString("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function toneForEnvironment(environment: string): "good" | "warn" | "metric" {
  const normalized = String(environment || "").trim().toLowerCase();
  if (normalized.includes("live")) {
    return "good";
  }
  if (normalized.includes("paper")) {
    return "warn";
  }
  return "metric";
}

function normalizeAccount(row: JsonMap): AccountRow {
  return {
    account_id: String(row.account_id || ""),
    client_id: String(row.client_id || ""),
    account_type: String(row.account_type || "broker"),
    venue: String(row.venue || ""),
    connector_type: String(row.connector_type || ""),
    mode: String(row.mode || ""),
    status: String(row.status || ""),
    display_name: row.display_name ? String(row.display_name) : null,
    external_ref: row.external_ref ? String(row.external_ref) : null,
    portfolio_id: row.portfolio_id ? String(row.portfolio_id) : null,
    latest_equity_usd: Number.isFinite(Number(row.latest_equity_usd)) ? Number(row.latest_equity_usd) : null,
    gross_exposure_usd: Number.isFinite(Number(row.gross_exposure_usd)) ? Number(row.gross_exposure_usd) : null,
    net_exposure_usd: Number.isFinite(Number(row.net_exposure_usd)) ? Number(row.net_exposure_usd) : null,
    metadata: typeof row.metadata === "object" && row.metadata ? (row.metadata as JsonMap) : {},
  };
}

function normalizeConnectorAccount(row: JsonMap): ConnectorAccountRow {
  return {
    provider: String(row.provider || ""),
    provider_type: String(row.provider_type || "exchange"),
    account_id: String(row.account_id || ""),
    label: String(row.label || row.account_id || ""),
    mode: String(row.mode || ""),
    auth_method: String(row.auth_method || ""),
    client_id: String(row.client_id || ""),
    owner_username: String(row.owner_username || ""),
    has_credentials: Boolean(row.has_credentials),
    address: row.address ? String(row.address) : null,
    linked_at: row.linked_at ? String(row.linked_at) : null,
  };
}

function normalizePortfolio(row: JsonMap): PortfolioRow {
  return {
    portfolio_id: String(row.portfolio_id || ""),
    client_id: String(row.client_id || ""),
    name: String(row.name || ""),
    mandate_type: String(row.mandate_type || ""),
    risk_profile: String(row.risk_profile || ""),
    status: String(row.status || ""),
  };
}

function normalizeStrategy(row: JsonMap): StrategyRow {
  return {
    strategy_id: String(row.strategy_id || ""),
    name: String(row.name || ""),
    market: String(row.market || ""),
    setup_type: String(row.setup_type || ""),
    status: String(row.status || ""),
    current_level: Math.max(0, toNumber(row.current_level, 0)),
  };
}

function environmentLabelForConnector(sourceType: "exchange" | "wallet"): string {
  return sourceType === "wallet" ? "wallet live" : "exchange live";
}

type VerificationPocketSummary = {
  key: string;
  label: string;
  totalUsd: number | null;
  assetCount: number;
  assets: string[];
};

type VerificationAssetRow = {
  key: string;
  pocketKey: string;
  pocketLabel: string;
  assetLabel: string;
  availableQty: number;
  lockedQty: number;
  totalQty: number;
  usdValue: number | null;
  markPriceUsd: number | null;
  change24hPct: number | null;
  quoteVolume24h: number | null;
  asOf: string;
};

type AttributionRow = {
  strategy_id: string | null;
  symbol: string | null;
  venue: string | null;
  realized_pnl_usd: number;
  pnl_contribution_pct: number;
  trade_count: number;
  fees_usd: number;
};

type PocketCapitalView = {
  pocket: string;
  equivalent_usd: number;
  raw_cash_usd: number;
  inventory_usd: number;
  asset_count: number;
  assets: string[];
};

type CapitalLedgerRow = {
  event_id: string;
  event_type: string;
  flow_direction: string;
  asset_symbol: string | null;
  amount_usd: number;
  pocket: string | null;
  counterparty: string | null;
  description: string | null;
  occurred_at: string | null;
  venue: string | null;
};

type CapitalLedgerSummary = {
  event_count: number;
  net_external_cashflow_usd: number;
  internal_transfer_usd: number;
  funding_fee_usd: number;
  realized_pnl_usd: number;
  reconciliation_usd: number;
  latest_event_at: string | null;
};

type PortfolioCapitalIntegrationRow = {
  sleeve: string;
  account_count: number;
  actual_equivalent_usd: number;
  actual_raw_cash_usd: number;
  target_cap_usd: number;
  actual_allocation_pct: number;
  target_allocation_pct: number;
  drift_pct: number;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  net_external_cashflow_usd: number;
  funding_fee_usd: number;
  internal_transfer_usd: number;
  venues: string[];
  pocket_breakdown: PocketCapitalView[];
};

type TimelineEvent = {
  key: string;
  label: string;
  detail: string;
  timestamp: string | null;
  tone: "good" | "warn" | "bad" | "metric";
};

function formatPct(value: number | null | undefined, digits = 1): string {
  if (!Number.isFinite(Number(value))) {
    return "-";
  }
  return `${Number(value).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

function formatQty(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "-";
  }
  return Number(value).toLocaleString("fr-FR", { maximumFractionDigits: 6 });
}

function formatSignedUsd(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "-";
  }
  const numeric = Number(value);
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${formatUsd(numeric)}`;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString("fr-FR", { hour12: false });
}

function parseChangePct(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value || "").trim().replace("%", "");
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function walletProviderSupportsAgentExecution(providerMode: string): boolean {
  const normalized = String(providerMode || "").trim().toLowerCase();
  return normalized === "custody-api" || normalized === "safe-api" || normalized === "walletconnect";
}

function walletAuthMethod(providerMode: string, accessMode: string, hasWalletReference: boolean): string {
  const normalized = String(providerMode || "").trim().toLowerCase();
  if (normalized === "custody-api") {
    return accessMode === "trade" ? "custody_api" : "custody_reference";
  }
  if (normalized === "safe-api") {
    return accessMode === "trade" ? "safe_api" : "safe_reference";
  }
  if (normalized === "walletconnect") {
    return accessMode === "trade" ? "walletconnect" : hasWalletReference ? "wallet_public_key" : "manual";
  }
  return hasWalletReference ? "wallet_public_key" : "manual";
}

function walletAuthMethodLabel(authMethod: string, hasCredentials: boolean): string {
  const normalized = String(authMethod || "").trim().toLowerCase();
  if (normalized === "wallet_keys") {
    return "legacy signer a migrer";
  }
  if (normalized === "custody_api" || normalized === "safe_api") {
    return "custody / signer lié";
  }
  if (normalized === "walletconnect") {
    return "wallet adapter";
  }
  if (normalized === "wallet_public_key") {
    return "watch-only";
  }
  return hasCredentials ? "credential linked" : "watch-only";
}

function balanceRowUsdValue(row: JsonMap): number | null {
  const equityUsd = Number(row.equity_usd);
  if (Number.isFinite(equityUsd) && equityUsd !== 0) {
    return equityUsd;
  }
  const availableQty = Number(row.available_qty);
  const lockedQty = Number(row.locked_qty);
  const markPriceUsd = Number(row.mark_price_usd);
  const quantity = (Number.isFinite(availableQty) ? availableQty : 0) + (Number.isFinite(lockedQty) ? lockedQty : 0);
  if (Number.isFinite(markPriceUsd) && markPriceUsd > 0) {
    return quantity * markPriceUsd;
  }
  return null;
}

function balanceRowChangePct(row: JsonMap): number | null {
  const direct = parseChangePct(row.change_24h_pct);
  if (direct != null) {
    return direct;
  }
  const payload = row.payload && typeof row.payload === "object" ? (row.payload as JsonMap) : null;
  return parseChangePct(payload?.change_24h_pct || payload?.priceChangePercent);
}

function normalizePocketKey(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "other";
  }
  if (normalized.includes("spot")) {
    return "spot";
  }
  if (normalized.includes("fund")) {
    return "fund";
  }
  if (
    normalized.includes("future")
    || normalized.includes("perp")
    || normalized.includes("swap")
    || normalized.includes("contract")
    || normalized.includes("deriv")
  ) {
    return "futures";
  }
  return normalized;
}

const VERIFICATION_POCKET_ORDER = new Map([
  ["spot", 0],
  ["fund", 1],
  ["futures", 2],
  ["other", 3],
]);

function balancePocketKey(row: JsonMap): string {
  const source = String(row.source || "").trim().toLowerCase();
  if (source.startsWith("bingx-")) {
    return normalizePocketKey(source.slice("bingx-".length));
  }
  const assetSymbol = String(row.asset_symbol || row.asset || "").trim();
  if (assetSymbol.includes("-")) {
    const parts = assetSymbol.split("-");
    return normalizePocketKey(parts[parts.length - 1] || "other");
  }
  return "other";
}

function balanceAssetLabel(row: JsonMap): string {
  const assetSymbol = String(row.asset_symbol || row.asset || "").trim().toUpperCase();
  if (assetSymbol.includes("-")) {
    return assetSymbol.slice(0, assetSymbol.lastIndexOf("-"));
  }
  return assetSymbol;
}

function pocketLabel(key: string): string {
  switch (normalizePocketKey(key)) {
    case "spot":
      return "Spot";
    case "fund":
      return "Fund";
    case "futures":
      return "Futures";
    default:
      return key || "Autre";
  }
}

function summarizeVerificationPockets(rows: unknown[]): VerificationPocketSummary[] {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }
  const buckets = new Map<string, { totalUsd: number; hasValue: boolean; assets: Set<string> }>();
  for (const item of rows) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as JsonMap;
    const key = balancePocketKey(row);
    const bucket = buckets.get(key) || { totalUsd: 0, hasValue: false, assets: new Set<string>() };
    const usdValue = balanceRowUsdValue(row);
    if (usdValue != null) {
      bucket.totalUsd += usdValue;
      bucket.hasValue = true;
    }
    const assetLabel = balanceAssetLabel(row);
    if (assetLabel) {
      bucket.assets.add(assetLabel);
    }
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort((left, right) => (VERIFICATION_POCKET_ORDER.get(left[0]) ?? 99) - (VERIFICATION_POCKET_ORDER.get(right[0]) ?? 99))
    .map(([key, bucket]) => ({
      key,
      label: pocketLabel(key),
      totalUsd: bucket.hasValue ? bucket.totalUsd : null,
      assetCount: bucket.assets.size,
      assets: [...bucket.assets].sort((left, right) => left.localeCompare(right)),
    }));
}

function mergeVerificationPocketSummaries(
  balanceSummaries: VerificationPocketSummary[],
  pocketViews: PocketCapitalView[],
): VerificationPocketSummary[] {
  const merged = new Map<string, VerificationPocketSummary>();
  for (const summary of balanceSummaries) {
    merged.set(summary.key, {
      ...summary,
      key: normalizePocketKey(summary.key),
      label: pocketLabel(summary.key),
    });
  }
  for (const pocketView of pocketViews) {
    const key = normalizePocketKey(pocketView.pocket);
    const existing = merged.get(key);
    const fallbackAssets = pocketView.assets.filter(Boolean);
    const fallbackAssetCount = pocketView.asset_count > 0 ? pocketView.asset_count : fallbackAssets.length;
    const fallbackTotalUsd = pocketView.equivalent_usd > 0 ? pocketView.equivalent_usd : null;
    if (!existing) {
      merged.set(key, {
        key,
        label: pocketLabel(key),
        totalUsd: fallbackTotalUsd,
        assetCount: fallbackAssetCount,
        assets: [...fallbackAssets].sort((left, right) => left.localeCompare(right)),
      });
      continue;
    }
    merged.set(key, {
      ...existing,
      key,
      label: pocketLabel(key),
      totalUsd: existing.totalUsd != null && existing.totalUsd > 0 ? existing.totalUsd : fallbackTotalUsd,
      assetCount: Math.max(existing.assetCount, fallbackAssetCount),
      assets: [...new Set([...existing.assets, ...fallbackAssets])].sort((left, right) => left.localeCompare(right)),
    });
  }
  return [...merged.values()].sort((left, right) => (VERIFICATION_POCKET_ORDER.get(left.key) ?? 99) - (VERIFICATION_POCKET_ORDER.get(right.key) ?? 99));
}

function buildVerificationAssetRows(rows: unknown[]): VerificationAssetRow[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .filter((item): item is JsonMap => Boolean(item) && typeof item === "object")
    .map((row, index) => {
      const availableQty = toNumber(row.available_qty, 0);
      const lockedQty = toNumber(row.locked_qty, 0);
      const totalQty = availableQty + lockedQty;
      const markPriceUsd = Number.isFinite(Number(row.mark_price_usd)) ? Number(row.mark_price_usd) : null;
      return {
        key: `${String(row.asset_symbol || row.asset || index)}-${index}`,
        pocketKey: balancePocketKey(row),
        pocketLabel: pocketLabel(balancePocketKey(row)),
        assetLabel: balanceAssetLabel(row),
        availableQty,
        lockedQty,
        totalQty,
        usdValue: balanceRowUsdValue(row),
        markPriceUsd,
        change24hPct: balanceRowChangePct(row),
        quoteVolume24h: Number.isFinite(Number(row.quote_volume_24h)) ? Number(row.quote_volume_24h) : null,
        asOf: String(row.as_of || ""),
      } satisfies VerificationAssetRow;
    })
    .sort((left, right) => {
      const byPocket = (VERIFICATION_POCKET_ORDER.get(left.pocketKey) ?? 99) - (VERIFICATION_POCKET_ORDER.get(right.pocketKey) ?? 99);
      if (byPocket !== 0) {
        return byPocket;
      }
      return (right.usdValue || 0) - (left.usdValue || 0);
    });
}

function normalizeAttributionRow(row: JsonMap): AttributionRow {
  return {
    strategy_id: row.strategy_id ? String(row.strategy_id) : null,
    symbol: row.symbol ? String(row.symbol) : null,
    venue: row.venue ? String(row.venue) : null,
    realized_pnl_usd: toNumber(row.realized_pnl_usd, 0),
    pnl_contribution_pct: toNumber(row.pnl_contribution_pct, 0),
    trade_count: toNumber(row.trade_count, 0),
    fees_usd: toNumber(row.fees_usd, 0),
  };
}

function normalizePocketCapitalView(row: JsonMap): PocketCapitalView {
  return {
    pocket: normalizePocketKey(row.pocket || "other"),
    equivalent_usd: toNumber(row.equivalent_usd, 0),
    raw_cash_usd: toNumber(row.raw_cash_usd, 0),
    inventory_usd: toNumber(row.inventory_usd, 0),
    asset_count: toNumber(row.asset_count, 0),
    assets: Array.isArray(row.assets) ? row.assets.map((item) => String(item || "")).filter(Boolean) : [],
  };
}

function normalizeCapitalLedgerRow(row: JsonMap): CapitalLedgerRow {
  return {
    event_id: String(row.event_id || ""),
    event_type: String(row.event_type || "unknown"),
    flow_direction: String(row.flow_direction || "neutral"),
    asset_symbol: row.asset_symbol ? String(row.asset_symbol) : null,
    amount_usd: toNumber(row.amount_usd, 0),
    pocket: row.pocket ? String(row.pocket) : null,
    counterparty: row.counterparty ? String(row.counterparty) : null,
    description: row.description ? String(row.description) : null,
    occurred_at: row.occurred_at ? String(row.occurred_at) : null,
    venue: row.venue ? String(row.venue) : null,
  };
}

function normalizeCapitalLedgerSummary(row: JsonMap | null | undefined): CapitalLedgerSummary {
  return {
    event_count: toNumber(row?.event_count, 0),
    net_external_cashflow_usd: toNumber(row?.net_external_cashflow_usd, 0),
    internal_transfer_usd: toNumber(row?.internal_transfer_usd, 0),
    funding_fee_usd: toNumber(row?.funding_fee_usd, 0),
    realized_pnl_usd: toNumber(row?.realized_pnl_usd, 0),
    reconciliation_usd: toNumber(row?.reconciliation_usd, 0),
    latest_event_at: row?.latest_event_at ? String(row.latest_event_at) : null,
  };
}

function normalizePortfolioCapitalIntegrationRow(row: JsonMap): PortfolioCapitalIntegrationRow {
  return {
    sleeve: String(row.sleeve || "unassigned"),
    account_count: toNumber(row.account_count, 0),
    actual_equivalent_usd: toNumber(row.actual_equivalent_usd, 0),
    actual_raw_cash_usd: toNumber(row.actual_raw_cash_usd, 0),
    target_cap_usd: toNumber(row.target_cap_usd, 0),
    actual_allocation_pct: toNumber(row.actual_allocation_pct, 0),
    target_allocation_pct: toNumber(row.target_allocation_pct, 0),
    drift_pct: toNumber(row.drift_pct, 0),
    realized_pnl_usd: toNumber(row.realized_pnl_usd, 0),
    unrealized_pnl_usd: toNumber(row.unrealized_pnl_usd, 0),
    net_external_cashflow_usd: toNumber(row.net_external_cashflow_usd, 0),
    funding_fee_usd: toNumber(row.funding_fee_usd, 0),
    internal_transfer_usd: toNumber(row.internal_transfer_usd, 0),
    venues: Array.isArray(row.venues) ? row.venues.map((item) => String(item || "")).filter(Boolean) : [],
    pocket_breakdown: Array.isArray(row.pocket_breakdown) ? row.pocket_breakdown.map((item) => normalizePocketCapitalView(item as JsonMap)) : [],
  };
}

function aggregateAttribution(rows: AttributionRow[], field: "strategy_id" | "symbol" | "venue"): Array<{ key: string; realizedPnlUsd: number; tradeCount: number; contributionPct: number }> {
  const buckets = new Map<string, { realizedPnlUsd: number; tradeCount: number; contributionPct: number }>();
  for (const row of rows) {
    const key = String(row[field] || "unassigned");
    const bucket = buckets.get(key) || { realizedPnlUsd: 0, tradeCount: 0, contributionPct: 0 };
    bucket.realizedPnlUsd += row.realized_pnl_usd;
    bucket.tradeCount += row.trade_count;
    bucket.contributionPct += row.pnl_contribution_pct;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({ key, ...bucket }))
    .sort((left, right) => Math.abs(right.realizedPnlUsd) - Math.abs(left.realizedPnlUsd));
}

function sumBalanceRowsUsd(rows: unknown[]): number | null {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  let total = 0;
  let hasValue = false;
  for (const item of rows) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as JsonMap;
    const usdValue = balanceRowUsdValue(row);
    if (usdValue != null) {
      total += usdValue;
      hasValue = true;
    }
  }
  return hasValue ? total : null;
}

export default function LiveCapitalPage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [connectorAccounts, setConnectorAccounts] = useState<ConnectorAccountRow[]>([]);
  const [portfolios, setPortfolios] = useState<PortfolioRow[]>([]);
  const [strategies, setStrategies] = useState<StrategyRow[]>([]);
  const [pendingLive, setPendingLive] = useState<JsonMap[]>([]);
  const [verification, setVerification] = useState<JsonMap | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JsonMap | null>(null);

  const [selectedSourceKey, setSelectedSourceKey] = useState("");
  const [selectedPortfolioId, setSelectedPortfolioId] = useState("");
  const [allocationWeight, setAllocationWeight] = useState(1);
  const [allocationCapUsd, setAllocationCapUsd] = useState(10_000);
  const [allocationStatus, setAllocationStatus] = useState("active");

  const [exchangeProviderId, setExchangeProviderId] = useState(String(EXCHANGE_CONNECTION_CATALOG[0]?.providerId || "bitget"));
  const [exchangeAccountId, setExchangeAccountId] = useState("");
  const [exchangeLabel, setExchangeLabel] = useState("");
  const [exchangeApiKey, setExchangeApiKey] = useState("");
  const [exchangeApiSecret, setExchangeApiSecret] = useState("");
  const [exchangePassphrase, setExchangePassphrase] = useState("");
  const [exchangeAccessMode, setExchangeAccessMode] = useState("trade");
  const [exchangeClientId, setExchangeClientId] = useState("");
  const [exchangeCapabilities, setExchangeCapabilities] = useState<Record<string, ExchangeCapability>>({});
  const [credentialUpdateApiKey, setCredentialUpdateApiKey] = useState("");
  const [credentialUpdateApiSecret, setCredentialUpdateApiSecret] = useState("");
  const [credentialUpdatePassphrase, setCredentialUpdatePassphrase] = useState("");

  const [walletProviderId, setWalletProviderId] = useState(String(WALLET_CONNECTION_CATALOG[0]?.providerId || "metamask"));
  const [walletAccountId, setWalletAccountId] = useState("");
  const [walletLabel, setWalletLabel] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletPublicKey, setWalletPublicKey] = useState("");
  const [walletAccessMode, setWalletAccessMode] = useState("read");
  const [walletClientId, setWalletClientId] = useState("");

  const [portfolioRisk, setPortfolioRisk] = useState<JsonMap | null>(null);
  const [portfolioAttribution, setPortfolioAttribution] = useState<AttributionRow[]>([]);
  const [portfolioCapitalIntegration, setPortfolioCapitalIntegration] = useState<JsonMap | null>(null);

  const [deskVehicle, setDeskVehicle] = useState("managed-account");
  const [capitalSleeve, setCapitalSleeve] = useState("core-alpha");
  const [executionBook, setExecutionBook] = useState("multi-venue");
  const [settlementPolicy, setSettlementPolicy] = useState("hybrid");
  const [rebalanceCadence, setRebalanceCadence] = useState("daily");
  const [liquidityTier, setLiquidityTier] = useState("tier-1");

  const [createPortfolioId, setCreatePortfolioId] = useState("pf-live-main");
  const [createPortfolioClientId, setCreatePortfolioClientId] = useState("");
  const [createPortfolioName, setCreatePortfolioName] = useState("Live Main Portfolio");
  const [createMandateType, setCreateMandateType] = useState("discretionary");
  const [createRiskProfile, setCreateRiskProfile] = useState("balanced");

  const [strategyId, setStrategyId] = useState("agent-live-primary");
  const [strategyName, setStrategyName] = useState("Agent Live Primary");
  const [strategyMarket, setStrategyMarket] = useState("fx");
  const [strategySetupType, setStrategySetupType] = useState("regime-execution");
  const [strategyNotes, setStrategyNotes] = useState("Live allocation linked to a governed source with hard USD cap and explicit venue controls.");

  function upsertConnectorAccount(nextAccount: ConnectorAccountRow): void {
    setConnectorAccounts((current) => {
      const remaining = current.filter((row) => !(row.provider === nextAccount.provider && row.account_id === nextAccount.account_id));
      return [...remaining, nextAccount].sort((left, right) => `${left.provider}:${left.account_id}`.localeCompare(`${right.provider}:${right.account_id}`));
    });
  }

  async function refreshDesk(): Promise<void> {
    const [accountsRes, connectorsRes, portfoliosRes, strategiesRes, pendingRes, capabilitiesRes] = await Promise.all([
      fetch("/api/accounts", { cache: "no-store" }),
      fetch("/api/connectors/accounts", { cache: "no-store" }),
      fetch("/api/portfolios", { cache: "no-store" }),
      fetch("/api/strategies", { cache: "no-store" }),
      fetch("/api/mt5/orders/live-pending", { cache: "no-store" }),
      fetch("/api/connectors/exchange-capabilities", { cache: "no-store" }),
    ]);

    if (!accountsRes.ok || !connectorsRes.ok || !portfoliosRes.ok || !strategiesRes.ok || !pendingRes.ok || !capabilitiesRes.ok) {
      throw new Error("Impossible de charger le desk Live Capital");
    }

    const accountsPayload = await accountsRes.json().catch(() => []);
    const connectorsPayload = await connectorsRes.json().catch(() => ({}));
    const portfoliosPayload = await portfoliosRes.json().catch(() => []);
    const strategiesPayload = await strategiesRes.json().catch(() => []);
    const pendingPayload = await pendingRes.json().catch(() => []);
    const capabilitiesPayload = await capabilitiesRes.json().catch(() => ({}));

    setAccounts(Array.isArray(accountsPayload) ? accountsPayload.map((item) => normalizeAccount(item as JsonMap)) : []);
    setConnectorAccounts(Array.isArray((connectorsPayload as JsonMap).accounts) ? ((connectorsPayload as JsonMap).accounts as JsonMap[]).map((item) => normalizeConnectorAccount(item)) : []);
    setPortfolios(Array.isArray(portfoliosPayload) ? portfoliosPayload.map((item) => normalizePortfolio(item as JsonMap)) : []);
    setStrategies(Array.isArray(strategiesPayload) ? strategiesPayload.map((item) => normalizeStrategy(item as JsonMap)) : []);
    setPendingLive(Array.isArray(pendingPayload) ? pendingPayload as JsonMap[] : []);
    setExchangeCapabilities(normalizeExchangeCapabilityMap(capabilitiesPayload));
  }

  useEffect(() => {
    refreshDesk().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Erreur inconnue"));
  }, []);

  const canonicalAccountMap = useMemo(() => new Map(accounts.map((row) => [row.account_id, row])), [accounts]);

  const capitalSources = useMemo<CapitalSourceRow[]>(() => {
    const canonicalRows = accounts.map((row) => {
      const sourceType = String(row.account_type || "broker").toLowerCase();
      const normalizedType = sourceType === "exchange" || sourceType === "wallet" ? sourceType : "broker";
      return {
        key: `canonical:${row.account_id}`,
        account_id: row.account_id,
        client_id: row.client_id,
        source_type: normalizedType,
        platform: row.venue || row.display_name || row.account_id,
        connector_type: row.connector_type || normalizedType,
        environment: normalizedType === "broker" ? row.mode || "unknown" : `${normalizedType} live`,
        permission_label: normalizedType === "broker" ? "trade path" : "canonique",
        status: row.status || "unknown",
        display_name: row.display_name || row.account_id,
        latest_equity_usd: row.latest_equity_usd,
        gross_exposure_usd: row.gross_exposure_usd,
        net_exposure_usd: row.net_exposure_usd,
        canonical_account_id: row.account_id,
        canonical: true,
        address: typeof row.metadata.address === "string" ? row.metadata.address : null,
        summary: normalizedType === "broker"
          ? `Compte ${row.mode || "unknown"} déjà gouverné pour portefeuille.`
          : `Source ${normalizedType} canonisée pour allocation, reporting et vérification.`,
      } satisfies CapitalSourceRow;
    });

    const connectorRows = connectorAccounts
      .filter((row) => row.account_id && String(row.provider || "").toLowerCase() !== "mt5" && !canonicalAccountMap.has(row.account_id))
      .map((row) => {
        const sourceType = String(row.provider_type || "exchange").toLowerCase() === "wallet" ? "wallet" : "exchange";
        return {
          key: `linked:${row.provider}:${row.account_id}`,
          account_id: row.account_id,
          client_id: row.client_id,
          source_type: sourceType,
          platform: row.provider || row.label || row.account_id,
          connector_type: row.provider || sourceType,
          environment: environmentLabelForConnector(sourceType),
          permission_label: row.mode === "trade" ? "trade enabled" : row.mode === "read" ? "read only" : row.mode || "linked",
          status: row.has_credentials ? "linked" : "credential-missing",
          display_name: row.label || row.account_id,
          latest_equity_usd: null,
          gross_exposure_usd: null,
          net_exposure_usd: null,
          canonical_account_id: null,
          canonical: false,
          address: row.address,
          summary: "Source connecteur visible côté plateforme, à canoniser avant allocation portefeuille.",
        } satisfies CapitalSourceRow;
      });

    return [...canonicalRows, ...connectorRows].sort((left, right) => {
      const leftCanonical = left.canonical ? 0 : 1;
      const rightCanonical = right.canonical ? 0 : 1;
      if (leftCanonical !== rightCanonical) {
        return leftCanonical - rightCanonical;
      }
      return left.display_name.localeCompare(right.display_name);
    });
  }, [accounts, canonicalAccountMap, connectorAccounts]);

  const selectedSource = useMemo(
    () => capitalSources.find((row) => row.key === selectedSourceKey) || capitalSources[0] || null,
    [capitalSources, selectedSourceKey],
  );
  const selectedPortfolio = useMemo(
    () => portfolios.find((row) => row.portfolio_id === selectedPortfolioId) || null,
    [portfolios, selectedPortfolioId],
  );
  const selectedStrategy = useMemo(
    () => strategies.find((row) => row.strategy_id === strategyId) || null,
    [strategies, strategyId],
  );
  const selectedCanonicalAccount = useMemo(
    () => (selectedSource?.canonical_account_id ? canonicalAccountMap.get(selectedSource.canonical_account_id) || null : null),
    [canonicalAccountMap, selectedSource],
  );
  const selectedExchangeConnectorAccount = useMemo(() => {
    if (!selectedSource || selectedSource.source_type !== "exchange") {
      return null;
    }
    const providerKey = String(selectedSource.connector_type || selectedSource.platform || "").trim().toLowerCase();
    const candidateIds = new Set(
      [selectedSource.account_id, selectedSource.canonical_account_id, selectedCanonicalAccount?.external_ref]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    );
    return connectorAccounts.find((row) => {
      const providerMatches = String(row.provider || "").trim().toLowerCase() === providerKey;
      const accountMatches = candidateIds.has(String(row.account_id || "").trim());
      return providerMatches && accountMatches;
    }) || null;
  }, [connectorAccounts, selectedCanonicalAccount?.external_ref, selectedSource]);
  const matchedPortfolios = useMemo(
    () => (selectedSource ? portfolios.filter((row) => row.client_id === selectedSource.client_id) : []),
    [portfolios, selectedSource],
  );
  const selectedExchangeProvider = useMemo(
    () => EXCHANGE_CONNECTION_CATALOG.find((item) => item.providerId === exchangeProviderId) || EXCHANGE_CONNECTION_CATALOG[0],
    [exchangeProviderId],
  );
  const selectedExchangeCapability = useMemo(
    () => getExchangeCapability(exchangeCapabilities, exchangeProviderId),
    [exchangeCapabilities, exchangeProviderId],
  );
  const exchangePassphraseRequired = useMemo(
    () => selectedExchangeCapability.api_key_requires_passphrase || ["okx", "bitget"].includes(String(exchangeProviderId || "").trim().toLowerCase()),
    [exchangeProviderId, selectedExchangeCapability],
  );
  const selectedExchangeConnectorCapability = useMemo(
    () => getExchangeCapability(exchangeCapabilities, String(selectedExchangeConnectorAccount?.provider || "")),
    [exchangeCapabilities, selectedExchangeConnectorAccount?.provider],
  );
  const credentialUpdatePassphraseRequired = useMemo(
    () => selectedExchangeConnectorCapability.api_key_requires_passphrase || ["okx", "bitget"].includes(String(selectedExchangeConnectorAccount?.provider || "").trim().toLowerCase()),
    [selectedExchangeConnectorAccount?.provider, selectedExchangeConnectorCapability],
  );
  const selectedWalletProvider = useMemo(
    () => WALLET_CONNECTION_CATALOG.find((item) => item.providerId === walletProviderId) || WALLET_CONNECTION_CATALOG[0],
    [walletProviderId],
  );
  const verificationBalances = Array.isArray(verification?.balances) ? (verification.balances as unknown[]) : [];
  const verificationPositions = Array.isArray(verification?.positions) ? (verification.positions as unknown[]) : [];
  const verificationOpenOrders = Array.isArray(verification?.open_orders) ? (verification.open_orders as JsonMap[]) : [];
  const verificationNormalizedState = verification?.normalized_state && typeof verification.normalized_state === "object" ? (verification.normalized_state as JsonMap) : null;
  const verificationNotes = Array.isArray(verificationNormalizedState?.notes)
    ? (verificationNormalizedState.notes as unknown[]).map((item) => String(item || "")).filter(Boolean)
    : [];
  const verificationWarnings = Array.isArray(verificationNormalizedState?.warnings)
    ? (verificationNormalizedState.warnings as unknown[]).map((item) => String(item || "")).filter(Boolean)
    : [];
  const verificationCashVsEquivalent = verification?.cash_vs_equivalent && typeof verification.cash_vs_equivalent === "object"
    ? (verification.cash_vs_equivalent as JsonMap)
    : verificationNormalizedState?.cash_vs_equivalent && typeof verificationNormalizedState.cash_vs_equivalent === "object"
      ? (verificationNormalizedState.cash_vs_equivalent as JsonMap)
      : null;
  const verificationPocketViews = useMemo(
    () => Array.isArray(verificationCashVsEquivalent?.pockets)
      ? (verificationCashVsEquivalent.pockets as JsonMap[]).map((item) => normalizePocketCapitalView(item))
      : [],
    [verificationCashVsEquivalent],
  );
  const verificationCapitalLedger = verification?.capital_ledger && typeof verification.capital_ledger === "object"
    ? (verification.capital_ledger as JsonMap)
    : verificationNormalizedState?.capital_ledger && typeof verificationNormalizedState.capital_ledger === "object"
      ? (verificationNormalizedState.capital_ledger as JsonMap)
      : null;
  const verificationCapitalLedgerRows = useMemo(
    () => Array.isArray(verificationCapitalLedger?.rows)
      ? (verificationCapitalLedger.rows as JsonMap[]).map((item) => normalizeCapitalLedgerRow(item))
      : [],
    [verificationCapitalLedger],
  );
  const verificationCapitalLedgerSummary = useMemo(
    () => normalizeCapitalLedgerSummary(verificationCapitalLedger?.summary as JsonMap | null | undefined),
    [verificationCapitalLedger],
  );
  const balanceVerificationPocketSummaries = useMemo(() => summarizeVerificationPockets(verificationBalances), [verificationBalances]);
  const verificationPocketSummaries = useMemo(() => {
    const merged = mergeVerificationPocketSummaries(balanceVerificationPocketSummaries, verificationPocketViews);
    // For BingX accounts: always surface the Fund pocket even when empty,
    // so the operator can see it was checked (earn/savings sub-account).
    const providerKey = String(selectedSource?.connector_type || "").trim().toLowerCase();
    if (providerKey === "bingx" && merged.length > 0 && !merged.some((p) => p.key === "fund")) {
      merged.push({ key: "fund", label: "Fund", totalUsd: null, assetCount: 0, assets: [] });
      merged.sort((l, r) => (VERIFICATION_POCKET_ORDER.get(l.key) ?? 99) - (VERIFICATION_POCKET_ORDER.get(r.key) ?? 99));
    }
    return merged;
  }, [balanceVerificationPocketSummaries, verificationPocketViews, selectedSource]);
  const verificationAssetRows = useMemo(() => buildVerificationAssetRows(verificationBalances), [verificationBalances]);
  const verificationPocketHeadline = verificationPocketSummaries.length > 0
    ? verificationPocketSummaries.map((item) => `${item.label} ${item.totalUsd != null ? formatUsd(item.totalUsd) : `${item.assetCount} actif(s)`}`).join(" · ")
    : "";
  const verificationTotalUsd = useMemo(() => {
    const byEquivalent = Number(verificationCashVsEquivalent?.total_equivalent_usd);
    if (Number.isFinite(byEquivalent) && byEquivalent > 0) {
      return byEquivalent;
    }
    const byPockets = verificationPocketSummaries.reduce<number>((sum, item) => sum + (item.totalUsd || 0), 0);
    if (byPockets > 0) {
      return byPockets;
    }
    const byBalances = sumBalanceRowsUsd(verificationBalances);
    if (byBalances != null) {
      return byBalances;
    }
    if (selectedCanonicalAccount?.latest_equity_usd != null) {
      return selectedCanonicalAccount.latest_equity_usd;
    }
    const snapshotList = Array.isArray(verification?.latest_portfolio_snapshots) ? (verification.latest_portfolio_snapshots as unknown[]) : [];
    const firstSnapshot = snapshotList[0];
    if (firstSnapshot && typeof firstSnapshot === "object") {
      const equityUsd = Number((firstSnapshot as JsonMap).equity_usd);
      if (Number.isFinite(equityUsd)) {
        return equityUsd;
      }
    }
    return null;
  }, [selectedCanonicalAccount, verification, verificationBalances, verificationCashVsEquivalent, verificationPocketSummaries]);
  const activePortfolioId = selectedPortfolioId || selectedCanonicalAccount?.portfolio_id || "";
  const verificationAsOf = useMemo(() => {
    if (typeof verificationNormalizedState?.as_of === "string" && verificationNormalizedState.as_of) {
      return verificationNormalizedState.as_of;
    }
    const firstBalance = verificationAssetRows[0];
    if (firstBalance?.asOf) {
      return firstBalance.asOf;
    }
    return null;
  }, [verificationAssetRows, verificationNormalizedState]);
  const assetRowsByPocket = useMemo(() => {
    const buckets = new Map<string, VerificationAssetRow[]>();
    for (const row of verificationAssetRows) {
      const existing = buckets.get(row.pocketKey) || [];
      existing.push(row);
      buckets.set(row.pocketKey, existing);
    }
    return buckets;
  }, [verificationAssetRows]);
  const verificationPocketViewMap = useMemo(
    () => new Map(verificationPocketViews.map((item) => [String(item.pocket || "other").toLowerCase(), item])),
    [verificationPocketViews],
  );
  const verificationTotalFromPockets = useMemo(
    () => verificationPocketSummaries.reduce<number>((sum, item) => sum + (item.totalUsd || 0), 0),
    [verificationPocketSummaries],
  );
  const concentrationAsset = verificationAssetRows[0] || null;
  const concentrationPct = concentrationAsset && verificationTotalUsd
    ? ((concentrationAsset.usdValue || 0) / verificationTotalUsd) * 100
    : null;
  const riskProfileLimitPct = createRiskProfile === "conservative" ? 6 : createRiskProfile === "aggressive" ? 20 : 12;
  const riskProfileMaxLeverage = createRiskProfile === "conservative" ? 1.25 : createRiskProfile === "aggressive" ? 3.5 : 2.0;
  const futuresNotionalUsd = verificationPositions.reduce<number>((sum, item) => {
    const row = item as JsonMap;
    return sum + Math.abs(toNumber(row.notional_usd, 0));
  }, 0);
  const balanceExposureUsd = verificationAssetRows.reduce<number>((sum, row) => sum + (row.usdValue || 0), 0);
  const grossExposureUsd = balanceExposureUsd + futuresNotionalUsd;
  const leverageGlobal = verificationTotalUsd && verificationTotalUsd > 0 ? grossExposureUsd / verificationTotalUsd : 0;
  const unrealizedPnlUsd = verificationPositions.reduce<number>((sum, item) => sum + toNumber((item as JsonMap).pnl_unrealized_usd, 0), 0);
  const realizedPnlUsd = verificationPositions.reduce<number>((sum, item) => sum + toNumber((item as JsonMap).pnl_realized_usd, 0), 0);
  const currentDrawdownPct = portfolioRisk && Number.isFinite(Number(portfolioRisk.drawdown_pct))
    ? Number(portfolioRisk.drawdown_pct)
    : verificationTotalUsd && verificationTotalUsd > 0 && unrealizedPnlUsd < 0
      ? Math.abs(unrealizedPnlUsd) / verificationTotalUsd * 100
      : 0;
  const ddHeadroomPct = Math.max(riskProfileLimitPct - currentDrawdownPct, 0);
  const riskBudgetUsedPct = riskProfileMaxLeverage > 0 ? Math.min((leverageGlobal / riskProfileMaxLeverage) * 100, 999) : 0;
  const structuralCorrelation = useMemo(() => {
    const spotAssets = new Set((assetRowsByPocket.get("spot") || []).map((item) => item.assetLabel));
    const futuresAssets = new Set((assetRowsByPocket.get("futures") || []).map((item) => item.assetLabel));
    if (spotAssets.size === 0 || futuresAssets.size === 0) {
      return "Faible";
    }
    const overlap = [...spotAssets].filter((asset) => futuresAssets.has(asset)).length;
    if (overlap >= Math.min(spotAssets.size, futuresAssets.size)) {
      return "Elevee";
    }
    if (overlap > 0) {
      return "Moderee";
    }
    return "Faible";
  }, [assetRowsByPocket]);
  const riskAssetExposureUsd = verificationAssetRows.reduce<number>((sum, row) => {
    const normalizedAsset = row.assetLabel.toUpperCase();
    const isStable = ["USD", "USDT", "USDC", "BUSD", "DAI", "FDUSD", "TUSD"].includes(normalizedAsset);
    return sum + (isStable ? 0 : (row.usdValue || 0));
  }, 0) + futuresNotionalUsd;
  const stressScenarios = useMemo(() => ([
    { label: "-5% risk assets", pnlUsd: -0.05 * riskAssetExposureUsd },
    { label: "-10% risk assets", pnlUsd: -0.10 * riskAssetExposureUsd },
    { label: "Vol spike", pnlUsd: -0.015 * riskAssetExposureUsd * Math.max(leverageGlobal, 1) },
  ]), [leverageGlobal, riskAssetExposureUsd]);
  const capitalBadge = useMemo(() => {
    if (!verification) {
      return { tone: "warn", label: "Capital Pending", detail: "Appeler ou synchroniser la source pour valider les poches." };
    }
    const mismatchUsd = verificationTotalUsd != null ? Math.abs(verificationTotalUsd - verificationTotalFromPockets) : 0;
    const mismatchThreshold = verificationTotalUsd != null ? Math.max(1, verificationTotalUsd * 0.02) : 1;
    if (verification.status === "ok" && verificationTotalUsd != null && verificationPocketSummaries.length > 0 && verificationWarnings.length === 0 && mismatchUsd <= mismatchThreshold) {
      return { tone: "good", label: "Capital Verified", detail: "Toutes les poches remontent de façon cohérente." };
    }
    if (verificationWarnings.length > 0 || verification.status === "partial" || mismatchUsd > mismatchThreshold) {
      return { tone: mismatchUsd > mismatchThreshold ? "bad" : "warn", label: mismatchUsd > mismatchThreshold ? "Capital Mismatch" : "Capital Review", detail: verificationWarnings[0] || "Le desk a besoin d'une revue opérateur avant allocation." };
    }
    return { tone: "warn", label: "Capital Partial", detail: "La lecture existe, mais reste incomplète." };
  }, [verification, verificationPocketSummaries.length, verificationTotalFromPockets, verificationTotalUsd, verificationWarnings]);
  const forensicNote = useMemo(() => {
    if (verificationNotes.length > 0) {
      return verificationNotes[0];
    }
    if (verificationCashVsEquivalent) {
      const totalEquivalent = toNumber(verificationCashVsEquivalent.total_equivalent_usd, 0);
      const totalRawCash = toNumber(verificationCashVsEquivalent.total_raw_cash_usd, 0);
      if (totalEquivalent > totalRawCash + 0.5) {
        return `Le compte remonte ${formatUsd(totalRawCash)} de cash brut visible pour ${formatUsd(totalEquivalent)} de valeur plateforme équivalente. Le delta correspond à de l'inventaire valorisé, pas à du cash client immédiatement mobilisable.`;
      }
    }
    if (verificationTotalUsd != null && verificationPocketSummaries.length > 0) {
      return `Le total vérifié ${formatUsd(verificationTotalUsd)} est reconstruit à partir des poches ${verificationPocketSummaries.map((item) => item.label).join(", ")}.`; 
    }
    return "Aucune note forensic disponible tant que la source n'a pas encore été vérifiée.";
  }, [verificationCashVsEquivalent, verificationNotes, verificationPocketSummaries, verificationTotalUsd]);
  const syncTimeline = useMemo<TimelineEvent[]>(() => {
    const connectorAccount = verification?.connector_account && typeof verification.connector_account === "object"
      ? (verification.connector_account as JsonMap)
      : null;
    const snapshotList = Array.isArray(verification?.latest_portfolio_snapshots)
      ? (verification.latest_portfolio_snapshots as JsonMap[])
      : [];
    const events: TimelineEvent[] = [];
    if (connectorAccount?.linked_at) {
      events.push({ key: "linked", label: "Source linked", detail: `${String(connectorAccount.provider || selectedSource?.platform || "source")} rattaché au desk.`, timestamp: String(connectorAccount.linked_at), tone: "metric" });
    }
    if (verificationAsOf) {
      events.push({ key: "sync", label: "Latest sync", detail: verificationPocketHeadline || "synchronisation desk disponible", timestamp: verificationAsOf, tone: capitalBadge.tone === "bad" ? "bad" : "good" });
    }
    snapshotList.slice(0, 2).forEach((snapshot, index) => {
      events.push({ key: `snapshot-${index}`, label: `Portfolio snapshot ${index + 1}`, detail: `${String(snapshot.portfolio_id || "portfolio")} · ${formatUsd(toNumber(snapshot.equity_usd, 0))}`, timestamp: String(snapshot.as_of || ""), tone: "metric" });
    });
    verificationWarnings.slice(0, 2).forEach((warning, index) => {
      events.push({ key: `warning-${index}`, label: "Anomaly detected", detail: warning, timestamp: verificationAsOf, tone: "warn" });
    });
    return events.sort((left, right) => String(right.timestamp || "").localeCompare(String(left.timestamp || "")));
  }, [capitalBadge.tone, selectedSource?.platform, verification, verificationAsOf, verificationPocketHeadline, verificationWarnings]);
  const attributionByVenue = useMemo(() => aggregateAttribution(portfolioAttribution, "venue").slice(0, 5), [portfolioAttribution]);
  const attributionByStrategy = useMemo(() => aggregateAttribution(portfolioAttribution, "strategy_id").slice(0, 5), [portfolioAttribution]);
  const attributionByAsset = useMemo(() => aggregateAttribution(portfolioAttribution, "symbol").slice(0, 5), [portfolioAttribution]);
  const capitalIntegrationSleeves = useMemo(
    () => Array.isArray(portfolioCapitalIntegration?.sleeves)
      ? (portfolioCapitalIntegration.sleeves as JsonMap[]).map((item) => normalizePortfolioCapitalIntegrationRow(item))
      : [],
    [portfolioCapitalIntegration],
  );
  const capitalIntegrationTotals = portfolioCapitalIntegration?.totals && typeof portfolioCapitalIntegration.totals === "object"
    ? (portfolioCapitalIntegration.totals as JsonMap)
    : null;
  const fundingFeesUsd = verificationPositions.reduce<number>((sum, item) => {
    const row = item as JsonMap;
    const payload = row.payload && typeof row.payload === "object" ? (row.payload as JsonMap) : null;
    const fundingValue = Number(payload?.fundingFee || payload?.funding_fee_usd || payload?.fundingFeesUsd);
    return sum + (Number.isFinite(fundingValue) ? fundingValue : 0);
  }, 0);
  const fundingFeesAvailable = verificationPositions.some((item) => {
    const row = item as JsonMap;
    const payload = row.payload && typeof row.payload === "object" ? (row.payload as JsonMap) : null;
    return payload?.fundingFee != null || payload?.funding_fee_usd != null || payload?.fundingFeesUsd != null;
  });
  const latestSnapshotEquityUsd = Array.isArray(verification?.latest_portfolio_snapshots) && verification.latest_portfolio_snapshots.length > 0
    ? toNumber(((verification.latest_portfolio_snapshots as JsonMap[])[0] || {}).equity_usd, 0)
    : null;
  const netCapitalDeltaUsd = verificationTotalUsd != null && latestSnapshotEquityUsd != null
    ? verificationTotalUsd - latestSnapshotEquityUsd
    : null;

  useEffect(() => {
    let cancelled = false;
    if (!activePortfolioId) {
      setPortfolioRisk(null);
      setPortfolioAttribution([]);
      setPortfolioCapitalIntegration(null);
      return () => {
        cancelled = true;
      };
    }

    Promise.all([
      fetch(`/api/portfolios/${encodeURIComponent(activePortfolioId)}/risk`, { cache: "no-store" }),
      fetch(`/api/performance/attribution?scope_type=portfolio&scope_id=${encodeURIComponent(activePortfolioId)}&group_by=strategy,symbol,venue`, { cache: "no-store" }),
      fetch(`/api/portfolios/${encodeURIComponent(activePortfolioId)}/capital-integration`, { cache: "no-store" }),
    ])
      .then(async ([riskResponse, attributionResponse, capitalIntegrationResponse]) => {
        const riskPayload = riskResponse.ok ? await riskResponse.json().catch(() => null) : null;
        const attributionPayload = attributionResponse.ok ? await attributionResponse.json().catch(() => ({})) : {};
        const capitalIntegrationPayload = capitalIntegrationResponse.ok ? await capitalIntegrationResponse.json().catch(() => null) : null;
        if (cancelled) {
          return;
        }
        setPortfolioRisk(riskPayload && typeof riskPayload === "object" ? (riskPayload as JsonMap) : null);
        setPortfolioAttribution(Array.isArray((attributionPayload as JsonMap).rows)
          ? (((attributionPayload as JsonMap).rows as JsonMap[]).map((row) => normalizeAttributionRow(row)))
          : []);
        setPortfolioCapitalIntegration(capitalIntegrationPayload && typeof capitalIntegrationPayload === "object" ? (capitalIntegrationPayload as JsonMap) : null);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setPortfolioRisk(null);
        setPortfolioAttribution([]);
        setPortfolioCapitalIntegration(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activePortfolioId, verificationAsOf]);

  const selectedVenueSpec = useMemo(() => {
    if (!selectedSource) {
      return null;
    }
    const providerKey = String(selectedSource.connector_type || selectedSource.platform || "").trim().toLowerCase();
    if (selectedSource.source_type === "exchange") {
      return EXCHANGE_CONNECTION_CATALOG.find((item) => item.providerId === providerKey) || null;
    }
    if (selectedSource.source_type === "wallet") {
      return WALLET_CONNECTION_CATALOG.find((item) => item.providerId === providerKey) || null;
    }
    return null;
  }, [selectedSource]);
  const venuePockets = useMemo(() => {
    if (selectedSource?.source_type === "broker") {
      return ["margin account", "execution line", selectedSource.environment === "paper" ? "sandbox sleeve" : "live sleeve"];
    }
    const coverage = String(selectedVenueSpec?.coverage || "").toLowerCase();
    const pockets: string[] = [];
    if (coverage.includes("spot")) {
      pockets.push("spot");
    }
    if (coverage.includes("perp") || coverage.includes("futures")) {
      pockets.push("futures/perp");
    }
    if (coverage.includes("option")) {
      pockets.push("options");
    }
    if (coverage.includes("custody") || selectedSource?.source_type === "wallet") {
      pockets.push("custody");
    }
    if (coverage.includes("defi") || coverage.includes("on-chain") || coverage.includes("dex")) {
      pockets.push("on-chain");
    }
    return pockets.length > 0 ? pockets : [selectedSource?.source_type === "wallet" ? "custody" : "exchange book"];
  }, [selectedSource, selectedVenueSpec]);
  const verificationSyncMessage = useMemo(() => {
    if (verificationPocketSummaries.length > 0 || verificationPositions.length > 0) {
      return verificationPocketHeadline || "balances / positions synchronisées";
    }
    if (selectedSource?.source_type === "exchange") {
      const providerLabel = selectedSource.platform || selectedSource.connector_type || "cet exchange";
      return `${providerLabel}: aucune sync backend vers balances / positions`;
    }
    if (selectedSource?.source_type === "wallet") {
      return "wallet connecté mais sans inventaire custody / on-chain synchronisé";
    }
    return "connecté mais sans sous-compte sync visible";
  }, [selectedSource, verificationPocketHeadline, verificationPocketSummaries.length, verificationPositions.length]);
  const spotFuturesReadMessage = useMemo(() => {
    if (verificationPocketSummaries.length > 0 || verificationPositions.length > 0) {
      return verificationPocketHeadline
        ? `Oui: ${verificationPocketHeadline}.`
        : "Oui, seulement si l'adaptateur a synchronisé ces sous-comptes dans balances/positions.";
    }
    if (selectedSource?.source_type === "exchange") {
      const providerLabel = selectedSource.platform || selectedSource.connector_type || "cet exchange";
      return `Pas encore: aucun adaptateur ${providerLabel} n'alimente account_balances / consolidated_positions. Les soldes spot/futures visibles sur la plateforme ne sont donc pas encore synchronisés dans le desk.`;
    }
    if (selectedSource?.source_type === "wallet") {
      return "Pas encore: aucun inventaire wallet / custody n'est encore synchronisé côté backend pour cette source.";
    }
    return "Pas encore: aucun flux spot/futures synchronisé côté backend.";
  }, [selectedSource, verificationPocketHeadline, verificationPocketSummaries.length, verificationPositions.length]);
  const hedgeFundChecks = useMemo(() => {
    const totalKnown = verificationTotalUsd != null;
    const sameClient = !selectedSource || !selectedPortfolio || selectedPortfolio.client_id === selectedSource.client_id;
    const canTrade = Boolean(selectedSource?.permission_label.toLowerCase().includes("trade") || selectedSource?.source_type === "broker");
    const capOk = verificationTotalUsd != null ? allocationCapUsd <= verificationTotalUsd : false;
    const verified = verification != null && (verificationTotalUsd != null || verificationBalances.length > 0 || verificationPositions.length > 0);
    const strategyReady = Boolean(selectedStrategy && selectedStrategy.current_level >= 2 && selectedStrategy.status !== "suspended");
    return [
      { label: "Client / portefeuille alignés", ok: sameClient && Boolean(selectedPortfolioId), detail: sameClient ? "Le portefeuille correspond au client de la source." : "Source et portefeuille ne pointent pas sur le même client." },
      { label: "Connecteur exécutable", ok: canTrade, detail: canTrade ? "La permission permet un chemin d'exécution." : "Source visible mais lecture seule ou non exécutable." },
      { label: "Capital vérifié", ok: verified, detail: verified ? `Le desk a une lecture du capital (${totalKnown ? formatUsd(verificationTotalUsd) : "partielle"}).` : "Aucun total ni balance exploitable n'a encore été remonté." },
      { label: "Cap <= capital", ok: capOk, detail: totalKnown ? `Cap ${formatUsd(allocationCapUsd)} vs total ${formatUsd(verificationTotalUsd)}.` : "Impossible de comparer le cap tant que le total n'est pas remonté." },
      { label: "Stratégie desk-ready", ok: strategyReady, detail: strategyReady ? "La stratégie a déjà un niveau opérable pour desk review." : "La stratégie n'est pas encore au bon niveau pour un passage live crédible." },
      { label: "Source canonique", ok: Boolean(selectedSource?.canonical_account_id), detail: selectedSource?.canonical_account_id ? "Le compte est bien dans le registre capital." : "La source doit encore être canonisée pour entrer dans la gouvernance portefeuille." },
    ];
  }, [allocationCapUsd, selectedPortfolio, selectedPortfolioId, selectedSource, selectedStrategy, verification, verificationBalances.length, verificationPositions.length, verificationTotalUsd]);
  const hedgeFundReadinessScore = hedgeFundChecks.reduce((sum, item) => sum + (item.ok ? 1 : 0), 0);

  const brokerLiveSources = capitalSources.filter((row) => row.source_type === "broker" && row.environment === "live");
  const brokerPaperSources = capitalSources.filter((row) => row.source_type === "broker" && row.environment === "paper");
  const exchangeSources = capitalSources.filter((row) => row.source_type === "exchange");
  const walletSources = capitalSources.filter((row) => row.source_type === "wallet");
  const allocableSources = capitalSources.filter((row) => row.canonical_account_id);
  const totalLiveEquityUsd = brokerLiveSources.reduce((sum, row) => sum + (row.latest_equity_usd || 0), 0);
  const totalPaperEquityUsd = brokerPaperSources.reduce((sum, row) => sum + (row.latest_equity_usd || 0), 0);
  const liveReady = Boolean(
    selectedCanonicalAccount
      && selectedSource?.environment.toLowerCase() === "live"
      && selectedCanonicalAccount.status.toLowerCase() === "active"
      && selectedPortfolioId,
  );

  useEffect(() => {
    if (!selectedSourceKey && capitalSources.length > 0) {
      setSelectedSourceKey(capitalSources[0].key);
    }
  }, [capitalSources, selectedSourceKey]);

  useEffect(() => {
    if (!selectedSource) {
      return;
    }
    if (!createPortfolioClientId) {
      setCreatePortfolioClientId(selectedSource.client_id);
    }
    if (!exchangeClientId && selectedSource.client_id) {
      setExchangeClientId(selectedSource.client_id);
    }
    if (!walletClientId && selectedSource.client_id) {
      setWalletClientId(selectedSource.client_id);
    }
    if (!selectedPortfolioId && selectedCanonicalAccount?.portfolio_id) {
      setSelectedPortfolioId(selectedCanonicalAccount.portfolio_id);
    }
    if (!(allocationCapUsd > 0) && selectedSource.latest_equity_usd && selectedSource.latest_equity_usd > 0) {
      setAllocationCapUsd(Math.max(1000, Math.round(selectedSource.latest_equity_usd * 0.25)));
    }
  }, [allocationCapUsd, createPortfolioClientId, exchangeClientId, selectedCanonicalAccount, selectedPortfolioId, selectedSource, walletClientId]);

  useEffect(() => {
    setCredentialUpdateApiKey("");
    setCredentialUpdateApiSecret("");
    setCredentialUpdatePassphrase("");
  }, [selectedExchangeConnectorAccount?.account_id, selectedExchangeConnectorAccount?.provider]);

  async function createPortfolio(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/portfolios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portfolio_id: createPortfolioId,
          client_id: createPortfolioClientId,
          name: createPortfolioName,
          mandate_type: createMandateType,
          risk_profile: createRiskProfile,
          status: "active",
          metadata: {
            source: "live-capital-desk",
            desk_vehicle: deskVehicle,
            capital_sleeve: capitalSleeve,
            execution_book: executionBook,
            settlement_policy: settlementPolicy,
            rebalance_cadence: rebalanceCadence,
            liquidity_tier: liquidityTier,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Creation portfolio impossible"));
      }
      setResult(payload as JsonMap);
      setSelectedPortfolioId(createPortfolioId);
      await refreshDesk();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Creation portfolio impossible");
    } finally {
      setBusy(false);
    }
  }

  async function syncCanonicalAccount(accountId: string): Promise<JsonMap> {
    const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/sync`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String((payload as JsonMap).detail || "Sync compte impossible"));
    }
    return payload as JsonMap;
  }

  async function linkExchangeSource(): Promise<void> {
    if (!exchangeAccountId.trim()) {
      setError("Ajoute l'identifiant du compte ou du sous-compte sur l'exchange.");
      return;
    }
    if (!exchangeApiKey.trim()) {
      setError("Ajoute la clé API.");
      return;
    }
    if (!exchangeApiSecret.trim()) {
      setError("Ajoute le secret API.");
      return;
    }
    if (exchangePassphraseRequired && !exchangePassphrase.trim()) {
      setError(`Pour ${selectedExchangeProvider?.provider || "cet exchange"}, ajoute aussi la passphrase créée avec la clé API.`);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const resolvedClientId = exchangeClientId || createPortfolioClientId || selectedSource?.client_id || "";
      const response = await fetch("/api/connectors/accounts/link-api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: exchangeProviderId,
          account_id: exchangeAccountId,
          label: exchangeLabel || exchangeAccountId,
          mode: exchangeAccessMode,
          api_key: exchangeApiKey,
          api_secret: exchangeApiSecret,
          passphrase: exchangePassphrase,
          client_id: resolvedClientId || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Connexion exchange impossible"));
      }
      const linkedAccount = Array.isArray((payload as JsonMap).accounts)
        ? (((payload as JsonMap).accounts as JsonMap[])
          .map((item) => normalizeConnectorAccount(item))
          .find((item) => item.provider === exchangeProviderId && item.account_id === exchangeAccountId) || null)
        : null;
      const nextLinkedAccount = linkedAccount || {
        provider: exchangeProviderId,
        provider_type: "exchange",
        account_id: exchangeAccountId,
        label: exchangeLabel || exchangeAccountId,
        mode: exchangeAccessMode,
        auth_method: "api_key",
        client_id: resolvedClientId,
        owner_username: "",
        has_credentials: true,
        address: null,
        linked_at: null,
      } satisfies ConnectorAccountRow;
      upsertConnectorAccount(nextLinkedAccount);
      const bootstrapSource: CapitalSourceRow = {
        key: `linked:${exchangeProviderId}:${exchangeAccountId}`,
        account_id: exchangeAccountId,
        client_id: nextLinkedAccount.client_id || resolvedClientId,
        source_type: "exchange",
        platform: nextLinkedAccount.provider || exchangeProviderId,
        connector_type: nextLinkedAccount.provider || exchangeProviderId,
        environment: environmentLabelForConnector("exchange"),
        permission_label: exchangeAccessMode === "trade" ? "trade enabled" : exchangeAccessMode === "read" ? "read only" : exchangeAccessMode,
        status: nextLinkedAccount.has_credentials ? "linked" : "credential-missing",
        display_name: exchangeLabel || nextLinkedAccount.label || exchangeAccountId,
        latest_equity_usd: null,
        gross_exposure_usd: null,
        net_exposure_usd: null,
        canonical_account_id: null,
        canonical: false,
        address: nextLinkedAccount.address || null,
        summary: "Source connecteur visible côté plateforme, à canoniser avant allocation portefeuille.",
      };
      setExchangeApiKey("");
      setExchangeApiSecret("");
      setExchangePassphrase("");
      let bootstrapError: string | null = null;
      let nextResult: JsonMap = { ...(payload as JsonMap), operation: "exchange-link" };
      try {
        const canonicalAccountId = await ensureCanonicalAccount(bootstrapSource);
        if (!canonicalAccountId) {
          throw new Error("Impossible de déterminer le compte canonique après liaison");
        }
        const syncPayload = await syncCanonicalAccount(canonicalAccountId);
        nextResult = {
          ...(payload as JsonMap),
          operation: "exchange-link",
          detail: "Exchange lié, canonisé puis synchronisé automatiquement.",
          bootstrap: {
            status: "ok",
            canonical_account_id: canonicalAccountId,
            sync_status: String(syncPayload.status || "ok"),
          },
        };
        await refreshDesk();
        setSelectedSourceKey(`canonical:${canonicalAccountId}`);
      } catch (bootstrapRequestError) {
        bootstrapError = bootstrapRequestError instanceof Error ? bootstrapRequestError.message : "Bootstrap initial impossible";
        nextResult = {
          ...(payload as JsonMap),
          operation: "exchange-link",
          status: "partial",
          detail: `Accès exchange lié, mais bootstrap initial impossible: ${bootstrapError}`,
        };
        await refreshDesk();
        setSelectedSourceKey(`linked:${exchangeProviderId}:${exchangeAccountId}`);
      }
      setResult(nextResult);
      if (bootstrapError) {
        setError(bootstrapError);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Connexion exchange impossible");
    } finally {
      setBusy(false);
    }
  }

  async function linkWalletSource(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const resolvedClientId = walletClientId || createPortfolioClientId || selectedSource?.client_id || "";
      const hasWalletReference = Boolean(walletAddress || walletPublicKey);
      if (walletAccessMode === "trade" && !walletProviderSupportsAgentExecution(String(selectedWalletProvider?.mode || ""))) {
        throw new Error("Ce provider wallet ne doit pas etre branche en trade direct dans TXT. Utilise Safe, Fireblocks ou un wallet adapter compatible.");
      }
      const response = await fetch("/api/connectors/accounts/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: walletProviderId,
          account_id: walletAccountId || walletAddress || walletPublicKey,
          label: walletLabel || walletAddress || walletPublicKey,
          mode: walletAccessMode,
          auth_method: walletAuthMethod(String(selectedWalletProvider?.mode || ""), walletAccessMode, hasWalletReference),
          provider_type: "wallet",
          address: walletAddress || walletPublicKey,
          wallet_public_key: walletPublicKey || walletAddress,
          client_id: resolvedClientId || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Connexion wallet impossible"));
      }
      upsertConnectorAccount({
        provider: walletProviderId,
        provider_type: "wallet",
        account_id: walletAccountId || walletAddress || walletPublicKey,
        label: walletLabel || walletAddress || walletPublicKey,
        mode: walletAccessMode,
        auth_method: walletAuthMethod(String(selectedWalletProvider?.mode || ""), walletAccessMode, hasWalletReference),
        client_id: resolvedClientId,
        owner_username: "",
        has_credentials: Boolean((payload as JsonMap).credential_id),
        address: walletAddress || walletPublicKey,
        linked_at: null,
      });
      setResult(payload as JsonMap);
      await refreshDesk();
      setSelectedSourceKey(`linked:${walletProviderId}:${walletAccountId || walletAddress || walletPublicKey}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Connexion wallet impossible");
    } finally {
      setBusy(false);
    }
  }

  async function updateSelectedExchangeCredentials(): Promise<void> {
    if (!selectedExchangeConnectorAccount) {
      setError("Sélectionne d'abord une source exchange avec accès API déjà lié");
      return;
    }
    if (!credentialUpdateApiKey || !credentialUpdateApiSecret) {
      setError("Nouvelle api key et nouveau secret requis");
      return;
    }
    if (credentialUpdatePassphraseRequired && !credentialUpdatePassphrase.trim()) {
      setError(`Pour ${selectedExchangeConnectorAccount.provider}, ajoute aussi la passphrase créée avec la clé API.`);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/connectors/accounts/link-api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedExchangeConnectorAccount.provider,
          account_id: selectedExchangeConnectorAccount.account_id,
          label: selectedExchangeConnectorAccount.label || selectedSource?.display_name || selectedExchangeConnectorAccount.account_id,
          mode: selectedExchangeConnectorAccount.mode || "trade",
          client_id: selectedExchangeConnectorAccount.client_id || selectedSource?.client_id || undefined,
          api_key: credentialUpdateApiKey,
          api_secret: credentialUpdateApiSecret,
          passphrase: credentialUpdatePassphrase,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Mise à jour des accès API impossible"));
      }
      if (selectedSource?.canonical_account_id) {
        try {
          const syncPayload = await syncCanonicalAccount(selectedSource.canonical_account_id);
          setResult({
            ...(payload as JsonMap),
            detail: "Accès API mis à jour puis synchronisation relancée.",
            sync_status: String(syncPayload.status || "ok"),
          });
        } catch (syncError) {
          setResult({
            ...(payload as JsonMap),
            status: "partial",
            detail: `Accès API mis à jour, mais la synchronisation a échoué: ${syncError instanceof Error ? syncError.message : "erreur inconnue"}`,
          });
        }
      } else {
        setResult({
          ...(payload as JsonMap),
          detail: "Accès API mis à jour. Canonise la source pour relancer une synchronisation immédiate.",
        });
      }
      setCredentialUpdateApiKey("");
      setCredentialUpdateApiSecret("");
      setCredentialUpdatePassphrase("");
      await refreshDesk();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Mise à jour des accès API impossible");
    } finally {
      setBusy(false);
    }
  }

  async function ensureCanonicalAccount(source: CapitalSourceRow): Promise<string | null> {
    if (source.canonical_account_id) {
      return source.canonical_account_id;
    }
    const resolvedClientId = source.client_id || selectedPortfolio?.client_id || createPortfolioClientId;
    if (!resolvedClientId) {
      throw new Error("Client ID requis avant de canoniser un exchange ou un wallet");
    }
    const response = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: source.account_id,
        client_id: resolvedClientId,
        account_type: source.source_type,
        venue: source.platform,
        connector_type: source.connector_type,
        mode: "live",
        status: "active",
        external_ref: source.account_id,
        display_name: source.display_name,
        metadata: {
          source: "live-capital-desk",
          linked_connector: true,
          permission_label: source.permission_label,
          address: source.address,
          desk_vehicle: deskVehicle,
          capital_sleeve: capitalSleeve,
          execution_book: executionBook,
          settlement_policy: settlementPolicy,
          rebalance_cadence: rebalanceCadence,
          liquidity_tier: liquidityTier,
        },
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String((payload as JsonMap).detail || "Canonisation du compte impossible"));
    }
    await refreshDesk();
    return String((payload as JsonMap).account_id || source.account_id);
  }

  async function canonicalizeSelectedSource(): Promise<void> {
    if (!selectedSource) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const accountId = await ensureCanonicalAccount(selectedSource);
      setResult({ status: "ok", account_id: accountId, detail: "Source canonisée et allocable" });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Canonisation du compte impossible");
    } finally {
      setBusy(false);
    }
  }

  async function deleteCanonicalAccount(accountId: string): Promise<void> {
    if (!accountId) {
      return;
    }
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Supprimer le compte canonique ${accountId} du registre capital ?`);
      if (!confirmed) {
        return;
      }
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Suppression du compte impossible"));
      }
      if (selectedSource?.canonical_account_id === accountId || selectedSource?.account_id === accountId) {
        setSelectedSourceKey("");
        setVerification(null);
      }
      setResult(payload as JsonMap);
      await refreshDesk();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Suppression du compte impossible");
    } finally {
      setBusy(false);
    }
  }

  async function attachAccountAllocation(): Promise<void> {
    if (!selectedSource || !selectedPortfolioId) {
      setError("Choisis d'abord une source et un portefeuille");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const canonicalAccountId = await ensureCanonicalAccount(selectedSource);
      if (!canonicalAccountId) {
        throw new Error("Impossible de déterminer le compte canonique à allouer");
      }
      const response = await fetch(`/api/portfolios/${encodeURIComponent(selectedPortfolioId)}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: canonicalAccountId,
          allocation_weight: allocationWeight,
          allocation_cap_usd: allocationCapUsd,
          status: allocationStatus,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Allocation impossible"));
      }
      setResult(payload as JsonMap);
      await refreshDesk();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Allocation impossible");
    } finally {
      setBusy(false);
    }
  }

  async function verifySelectedSource(): Promise<void> {
    if (!selectedSource) {
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const verifiedAccountId = selectedSource.canonical_account_id || await ensureCanonicalAccount(selectedSource);
      if (!verifiedAccountId) {
        throw new Error("Impossible de déterminer le compte à vérifier");
      }

      if (selectedSource.source_type !== "wallet") {
        const syncResponse = await fetch(`/api/accounts/${encodeURIComponent(verifiedAccountId)}/sync`, { method: "POST" });
        const syncPayload = await syncResponse.json().catch(() => ({}));
        if (!syncResponse.ok) {
          throw new Error(String((syncPayload as JsonMap).detail || "Sync compte impossible"));
        }
      }

      const response = await fetch(`/api/internal/accounts/${encodeURIComponent(verifiedAccountId)}/verification`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Verification compte impossible"));
      }
      setVerification(payload as JsonMap);
      try {
        await refreshDesk();
      } catch {
        // noop: la vérification a déjà réussi, le refresh global du desk reste secondaire.
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Verification source impossible");
    } finally {
      setVerifying(false);
    }
  }

  async function syncSelectedBroker(): Promise<void> {
    if (!selectedSource?.canonical_account_id) {
      setError("Canonise d'abord la source avant de lancer une synchronisation");
      return;
    }
    if (selectedSource.source_type === "wallet") {
      await verifySelectedSource();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(selectedSource.canonical_account_id)}/sync`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Sync compte impossible"));
      }
      setResult(payload as JsonMap);
      setVerification(payload as JsonMap);
      await refreshDesk();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Sync compte impossible");
    } finally {
      setBusy(false);
    }
  }

  async function createStrategy(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy_id: strategyId,
          name: strategyName,
          market: strategyMarket,
          setup_type: strategySetupType,
          notes: strategyNotes,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Creation strategie impossible"));
      }
      setResult(payload as JsonMap);
      await refreshDesk();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Creation strategie impossible");
    } finally {
      setBusy(false);
    }
  }

  async function promoteStrategy(nextLevel: number): Promise<void> {
    if (!(nextLevel > 0)) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/strategies/${encodeURIComponent(strategyId)}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_level: nextLevel,
          rationale: `Live capital desk promotion for ${strategyId}`,
          metrics: {
            sample_count: 250,
            oos_sharpe: 1.15,
            fee_impact_bps: 8,
            slippage_bps: 6,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Promotion strategie impossible"));
      }
      setResult(payload as JsonMap);
      await refreshDesk();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Promotion strategie impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell txt-page-shell" data-testid="mission-control-live-capital-page">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.35fr 0.9fr" }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">Live Capital Desk</div>
          <h1 className="title" style={{ fontSize: 34 }}>Sources connectées → capital gouverné → agents live</h1>
          <p className="subtle txt-page-hero-copy">
            Le bloc Performance Desk du terminal doit distinguer les fonds issus d'un broker paper, d'un broker live, d'un exchange ou d'un wallet.
            Cette page sert de bureau de contrôle: elle montre les sources réelles, permet de les canoniser si besoin, vérifie les informations disponibles de la plateforme,
            puis attache un cap USD à un portefeuille avant toute promotion live.
          </p>
          <OperatorPanelGuide
            title="Guide Live Capital"
            what="Voir toutes les sources de capital, distinguer leur nature, vérifier ce qui est réellement contrôlable et allouer seulement les sources gouvernées."
            why="Un exchange ou un wallet connecté n'est pas automatiquement prêt pour allocation. Il faut rendre la source canonique, lisible et vérifiable."
            example="Sélectionne une source Bitget ou wallet, canonise-la si nécessaire, vérifie les informations plateforme/fonds disponibles, puis rattache-la à un portefeuille avec un cap USD."
            terms={["allocation", "portfolio", "paper", "live", "exchange", "wallet"]}
          />
          <div className="txt-page-guide-note">
            <strong>Avant d'allouer</strong>
            1. Identifie la nature de la source. 2. Verifie si elle est canonique et vraiment pilotable. 3. Controle les informations plateforme disponibles. 4. Seulement ensuite, attache un cap USD au portefeuille.
          </div>
          <p>
            <Link href="/terminal">Terminal</Link>
            {" | "}
            <Link href="/ai">AI Desk</Link>
            {" | "}
            <Link href="/connectors">Connectors</Link>
            {" | "}
            <Link href="/connections">Connections</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>

        <div className="panel">
          <div className="eyebrow">Scope courant</div>
          <div className="row"><span>Broker live</span><span className="good">{brokerLiveSources.length} · {formatUsd(totalLiveEquityUsd)}</span></div>
          <div className="row"><span>Broker paper</span><span className="warn">{brokerPaperSources.length} · {formatUsd(totalPaperEquityUsd)}</span></div>
          <div className="row"><span>Exchange</span><span>{exchangeSources.length}</span></div>
          <div className="row"><span>Wallet</span><span>{walletSources.length}</span></div>
          <div className="row"><span>Sources allocables</span><span>{allocableSources.length}</span></div>
          <div className="row"><span>Approvals live en attente</span><span>{pendingLive.length}</span></div>
          <div className="row"><span>Source sélectionnée prête</span><span className={liveReady ? "good" : "warn"}>{liveReady ? "oui" : "non"}</span></div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Sources canoniques allocables <HelpHint text="Ces sources sont déjà prêtes dans le registre principal. Tu peux donc les vérifier, les rattacher à un portefeuille et les utiliser." examples={["Un compte réel déjà validé peut être alloué directement.", "Un exchange déjà préparé peut afficher ses montants avant allocation."]} /></div>
          {capitalSources.filter((row) => row.canonical).length === 0 ? <p className="subtle">Aucune source canonique visible.</p> : null}
          <div className="txt-scroll-shell">
            {capitalSources.filter((row) => row.canonical).map((row) => (
              <div key={row.key} className="row">
                <span>{row.display_name} · {row.source_type} · {row.platform}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span className={toneForEnvironment(row.environment)}>{row.environment} · {row.status} · {formatUsd(row.latest_equity_usd)}</span>
                  <button type="button" onClick={() => deleteCanonicalAccount(row.account_id)} disabled={busy}>
                    Supprimer
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Sources plateforme non encore canonisées <HelpHint text="Ces sources sont déjà branchées, mais pas encore prêtes pour une allocation officielle." examples={["Un exchange relié par clé API peut apparaître ici sans être encore utilisable.", "Un wallet en lecture seule peut être visible mais rester hors allocation."]} /></div>
          {capitalSources.filter((row) => !row.canonical).length === 0 ? <p className="subtle">Tous les exchange/wallet visibles sont déjà canonisés ou aucune source connecteur additionnelle n'est présente.</p> : null}
          <div className="txt-scroll-shell">
            {capitalSources.filter((row) => !row.canonical).map((row) => (
              <div key={row.key} className="row">
                <span>{row.display_name} · {row.source_type} · {row.platform}</span>
                <span>{row.permission_label} · {row.summary}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Desk Structuring <HelpHint text="Ce bloc sert à décrire comment tu veux utiliser la source: type de compte, rôle du capital, lieu d'exécution et rythme de remise à niveau." examples={["Un compte principal peut servir au cœur de l'activité avec plusieurs plateformes.", "Une réserve peut rester séparée avec un usage plus prudent."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Véhicule <HelpHint text={DESK_VEHICLE_HELP[deskVehicle].text} examples={DESK_VEHICLE_HELP[deskVehicle].examples} label={deskVehicle} /></div>
              <select value={deskVehicle} onChange={(event) => setDeskVehicle(event.target.value)}>
                <option value="managed-account">managed-account</option>
                <option value="master-fund">master-fund</option>
                <option value="segregated-mandate">segregated-mandate</option>
                <option value="treasury">treasury</option>
              </select>
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Sleeve de capital <HelpHint text={CAPITAL_SLEEVE_HELP[capitalSleeve].text} examples={CAPITAL_SLEEVE_HELP[capitalSleeve].examples} label={capitalSleeve} /></div>
              <select value={capitalSleeve} onChange={(event) => setCapitalSleeve(event.target.value)}>
                <option value="core-alpha">core-alpha</option>
                <option value="hedge-overlay">hedge-overlay</option>
                <option value="liquidity-reserve">liquidity-reserve</option>
                <option value="event-driven">event-driven</option>
                <option value="carry-basis">carry-basis</option>
              </select>
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Book d'exécution <HelpHint text={EXECUTION_BOOK_HELP[executionBook].text} examples={EXECUTION_BOOK_HELP[executionBook].examples} label={executionBook} /></div>
              <select value={executionBook} onChange={(event) => setExecutionBook(event.target.value)}>
                <option value="multi-venue">multi-venue</option>
                <option value="spot-only">spot-only</option>
                <option value="perp-futures">perp-futures</option>
                <option value="options-overlay">options-overlay</option>
                <option value="custody-only">custody-only</option>
              </select>
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Settlement <HelpHint text={SETTLEMENT_POLICY_HELP[settlementPolicy].text} examples={SETTLEMENT_POLICY_HELP[settlementPolicy].examples} label={settlementPolicy} /></div>
              <select value={settlementPolicy} onChange={(event) => setSettlementPolicy(event.target.value)}>
                <option value="hybrid">hybrid</option>
                <option value="exchange-collateral">exchange-collateral</option>
                <option value="broker-margin">broker-margin</option>
                <option value="cold-custody">cold-custody</option>
              </select>
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Cadence de rebalance <HelpHint text={REBALANCE_CADENCE_HELP[rebalanceCadence].text} examples={REBALANCE_CADENCE_HELP[rebalanceCadence].examples} label={rebalanceCadence} /></div>
              <select value={rebalanceCadence} onChange={(event) => setRebalanceCadence(event.target.value)}>
                <option value="intra-day">intra-day</option>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
              </select>
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Tier de liquidité <HelpHint text={LIQUIDITY_TIER_HELP[liquidityTier].text} examples={LIQUIDITY_TIER_HELP[liquidityTier].examples} label={liquidityTier} /></div>
              <select value={liquidityTier} onChange={(event) => setLiquidityTier(event.target.value)}>
                <option value="tier-1">tier-1</option>
                <option value="tier-2">tier-2</option>
                <option value="special-situations">special-situations</option>
              </select>
            </div>
          </div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="row"><span>Véhicule</span><span>{deskVehicle}</span></div>
            <div className="row"><span>Sleeve</span><span>{capitalSleeve}</span></div>
            <div className="row"><span>Book d'exécution</span><span>{executionBook}</span></div>
            <div className="row"><span>Settlement</span><span>{settlementPolicy}</span></div>
            <div className="row"><span>Rebalance</span><span>{rebalanceCadence}</span></div>
            <div className="row"><span>Liquidité</span><span>{liquidityTier}</span></div>
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Venue Pockets & Prime Logic <HelpHint text="Montre où l'argent est rangé sur la source: comptant, dérivés, options, garde ou on-chain." examples={["Une plateforme peut avoir plusieurs poches, mais elles n'apparaissent que si la synchronisation les remonte bien.", "Un wallet de réserve sera plutôt vu comme garde ou réserve que comme compte d'exécution rapide."]} /></div>
          <div className="row"><span>Source active</span><span>{selectedSource ? `${selectedSource.display_name} / ${selectedSource.platform}` : "-"}</span></div>
          <div className="row"><span>Coverage théorique</span><span>{selectedVenueSpec?.coverage || (selectedSource?.source_type === "broker" ? "broker margin / live or paper" : "-")}</span></div>
          <div className="row"><span>Poches desk</span><span>{venuePockets.join(", ")}</span></div>
          <div className="row"><span>Vision back-end actuelle</span><span>{verificationSyncMessage}</span></div>
          <div className="row"><span>Prime-like view</span><span>{selectedSource?.source_type === "broker" ? "execution line / margin / reporting" : selectedSource?.source_type === "exchange" ? "venue collateral / spot-futures pockets" : "custody / treasury / on-chain reserve"}</span></div>
          <p className="subtle" style={{ marginTop: 12 }}>
            {verificationNotes[0]
              || (verificationPocketHeadline
                ? `Lecture desk actuelle: ${verificationPocketHeadline}. Le desk peut distinguer spot, fund et futures dès que l'adaptateur pousse ces poches dans balances/positions.`
                : "Réponse directe: oui, le desk peut afficher spot, futures et autres poches uniquement si l'adaptateur backend pousse ces données dans account_balances et consolidated_positions.")}
          </p>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Enregistrer un compte exchange avant allocation <HelpHint text="Renseigne ici les accès créés sur l'exchange. TXT vérifie maintenant la clé tout de suite pour éviter d'enregistrer un mauvais accès." examples={["Pour OKX, remplis la clé API, le secret API, la passphrase créée avec la clé et l'identifiant du compte ou du sous-compte.", "Choisis Lecture seule pour surveiller, ou Trading autorisé si la source doit vraiment exécuter."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <select value={exchangeProviderId} onChange={(event) => setExchangeProviderId(event.target.value)}>
              {EXCHANGE_CONNECTION_CATALOG.filter((item) => item.mode === "api-key").map((item) => (
                <option value={item.providerId} key={item.providerId}>{item.provider}</option>
              ))}
            </select>
            <input value={exchangeAccountId} onChange={(event) => setExchangeAccountId(event.target.value)} placeholder="Identifiant du compte sur l'exchange ou sous-compte" />
            <input value={exchangeLabel} onChange={(event) => setExchangeLabel(event.target.value)} placeholder="Nom affiché du compte (facultatif)" />
            <input value={exchangeClientId} onChange={(event) => setExchangeClientId(event.target.value)} placeholder="Client interne (facultatif)" />
            <input value={exchangeApiKey} onChange={(event) => setExchangeApiKey(event.target.value)} placeholder="Clé API" />
            <input type="password" value={exchangeApiSecret} onChange={(event) => setExchangeApiSecret(event.target.value)} placeholder="Secret API" />
            <input type="password" value={exchangePassphrase} onChange={(event) => setExchangePassphrase(event.target.value)} placeholder={exchangePassphraseRequired ? "Passphrase API (obligatoire)" : "Passphrase API (laisser vide si non demandée)"} />
            <select value={exchangeAccessMode} onChange={(event) => setExchangeAccessMode(event.target.value)}>
              <option value="read">Lecture seule</option>
              <option value="trade">Trading autorisé</option>
            </select>
            <button type="button" onClick={() => linkExchangeSource()} disabled={busy}>Enregistrer le compte</button>
          </div>
          <p className="subtle" style={{ marginTop: 10 }}>
            {exchangePassphraseRequired
              ? `Pour ${selectedExchangeProvider?.provider || "cet exchange"}, la passphrase est obligatoire et doit être exactement celle créée en même temps que la clé API.`
              : "Colle ici exactement les accès visibles dans l'interface de l'exchange. TXT vérifie la clé avant de la garder."}
          </p>
          {error ? <p className="warn" style={{ marginTop: 10 }}>{error}</p> : null}
          {result?.operation === "exchange-link" ? (
            <p className={String(result.status || "ok") === "partial" ? "warn" : "good"} style={{ marginTop: 10 }}>
              {String(result.detail || "Compte exchange enregistré.")}
            </p>
          ) : null}
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="eyebrow">Sources exchange actuellement visibles</div>
            {exchangeSources.length === 0 ? <p className="subtle">Aucun compte exchange n'est enregistré pour l'instant. Tant qu'il n'est pas accepté ici, il n'apparaîtra pas dans Allouer une source connectée.</p> : null}
            {exchangeSources.slice(0, 6).map((row) => (
              <div className="row" key={row.key}>
                <span>{row.display_name} · {row.platform}</span>
                <span>{row.canonical ? "canonique" : "lié"} · {row.permission_label}</span>
              </div>
            ))}
          </div>
          {selectedExchangeProvider ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>Provider</span><span>{selectedExchangeProvider.provider}</span></div>
              <div className="row"><span>Coverage</span><span>{selectedExchangeProvider.coverage}</span></div>
              <div className="row"><span>Mode d'intégration</span><span>{selectedExchangeProvider.mode}</span></div>
              <div className="row"><span>Guide</span><span>{selectedExchangeProvider.detail}</span></div>
            </div>
          ) : null}
          <p className="subtle" style={{ marginTop: 10 }}>
            Les venues de type wallet-signing comme Hyperliquid, dYdX, Polymarket ou Pump.fun passent par le bloc wallet / custody ci-contre, pas par une API key CEX classique.
          </p>
          <p className="subtle" style={{ marginTop: 10 }}>
            Après liaison, TXT essaie maintenant de canoniser automatiquement la source et de lancer une première synchronisation pour la rendre appelable sans étape manuelle supplémentaire.
          </p>
        </div>

        <div className="panel">
          <div className="eyebrow">Connecter un wallet / custody <HelpHint text="Ce bloc sert à brancher un wallet ou une solution de garde avant vérification puis allocation." examples={["Une adresse publique suffit pour suivre un wallet.", "La signature doit rester hors TXT, via un système externe prévu pour ça."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <select value={walletProviderId} onChange={(event) => setWalletProviderId(event.target.value)}>
              {WALLET_CONNECTION_CATALOG.map((item) => (
                <option value={item.providerId} key={item.providerId}>{item.provider}</option>
              ))}
            </select>
            <input value={walletAccountId} onChange={(event) => setWalletAccountId(event.target.value)} placeholder="wallet account_id (optionnel)" />
            <input value={walletLabel} onChange={(event) => setWalletLabel(event.target.value)} placeholder="label wallet" />
            <input value={walletClientId} onChange={(event) => setWalletClientId(event.target.value)} placeholder="client_id (optionnel)" />
            <input value={walletAddress} onChange={(event) => setWalletAddress(event.target.value)} placeholder="adresse publique / custody ref" />
            <input value={walletPublicKey} onChange={(event) => setWalletPublicKey(event.target.value)} placeholder="WALLET_PUBLIC_KEY (optionnel)" />
            <select value={walletAccessMode} onChange={(event) => setWalletAccessMode(event.target.value)}>
              <option value="read">read</option>
              <option value="trade">trade</option>
            </select>
            <button type="button" onClick={() => linkWalletSource()} disabled={busy || !(walletAddress || walletPublicKey)}>Lier le wallet</button>
          </div>
          {selectedWalletProvider ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>Provider</span><span>{selectedWalletProvider.provider}</span></div>
              <div className="row"><span>Coverage</span><span>{selectedWalletProvider.coverage}</span></div>
              <div className="row"><span>Mode d'intégration</span><span>{selectedWalletProvider.mode}</span></div>
              <div className="row"><span>Guide</span><span>{selectedWalletProvider.detail}</span></div>
              <div className="row"><span>Execution agentique</span><span>{walletProviderSupportsAgentExecution(String(selectedWalletProvider.mode || "")) ? "oui, via signer externe / adapter" : "non, watch-only tant qu'aucun signer institutionnel n'est raccorde"}</span></div>
            </div>
          ) : null}
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="row"><span>Trade CEX par les agents</span><span>OMS / adaptateur exchange avec API keys</span></div>
            <div className="row"><span>Trade wallet on-chain</span><span>Fireblocks, Safe ou wallet adapter</span></div>
            <div className="row"><span>Signature</span><span>faite hors TXT par MPC / signer externe</span></div>
            <div className="row"><span>Politique</span><span>jamais de clé privée dans TXT</span></div>
          </div>
          <p className="subtle" style={{ marginTop: 10 }}>
            Pour un wallet Solana ou EVM tradé par les agents, TXT doit envoyer l'intention d'ordre vers un signer institutionnel ou un wallet adapter. Une adresse publique suffit pour la verification, le suivi et l'allocation watch-only.
          </p>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
        <div className="panel">
          <div className="eyebrow">Mettre à jour les accès API d'une plateforme <HelpHint text="Cette section sert à remplacer la clé API, le secret ou la passphrase d'un exchange déjà lié sans recréer toute la source." examples={["Sélectionne d'abord la source exchange active, puis remplace ses accès API.", "Après mise à jour, TXT relance automatiquement une sync si le compte est déjà canonique."]} /></div>
          {selectedExchangeConnectorAccount ? (
            <>
              <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
                <div className="row"><span>Plateforme</span><span>{selectedExchangeConnectorAccount.provider}</span></div>
                <div className="row"><span>Compte lié</span><span>{selectedExchangeConnectorAccount.account_id}</span></div>
                <div className="row"><span>Label</span><span>{selectedExchangeConnectorAccount.label || selectedSource?.display_name || "-"}</span></div>
                <div className="row"><span>Mode</span><span>{selectedExchangeConnectorAccount.mode || "trade"}</span></div>
                <div className="row"><span>Client</span><span>{selectedExchangeConnectorAccount.client_id || selectedSource?.client_id || "-"}</span></div>
              </div>
              <div className="form-grid" style={{ marginTop: 12 }}>
                <input value={credentialUpdateApiKey} onChange={(event) => setCredentialUpdateApiKey(event.target.value)} placeholder="Nouvelle clé API" />
                <input type="password" value={credentialUpdateApiSecret} onChange={(event) => setCredentialUpdateApiSecret(event.target.value)} placeholder="Nouveau secret API" />
                <input type="password" value={credentialUpdatePassphrase} onChange={(event) => setCredentialUpdatePassphrase(event.target.value)} placeholder={credentialUpdatePassphraseRequired ? "Nouvelle passphrase API (obligatoire)" : "Nouvelle passphrase API (laisser vide si non demandée)"} />
                <button type="button" onClick={() => updateSelectedExchangeCredentials()} disabled={busy}>
                  Mettre à jour les accès API
                </button>
              </div>
              <p className="subtle" style={{ marginTop: 10 }}>
                Cette action remplace les credentials du compte exchange sélectionné. La clé précédente n'est pas conservée dans le connecteur actif.
              </p>
            </>
          ) : (
            <p className="subtle" style={{ marginTop: 12 }}>
              Sélectionne une source de type exchange pour afficher ici le remplacement de sa clé API, de son secret et de sa passphrase.
            </p>
          )}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Create Portfolio <HelpHint text="Le portefeuille sert à ranger la source dans le bon cadre, avec un poids et une limite en dollars." examples={["Crée d'abord le portefeuille du client, puis rattache la source.", "Une réserve peut vivre dans un portefeuille séparé du capital actif."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <input value={createPortfolioId} onChange={(event) => setCreatePortfolioId(event.target.value)} placeholder="portfolio_id" />
            <input value={createPortfolioClientId} onChange={(event) => setCreatePortfolioClientId(event.target.value)} placeholder="client_id" />
            <input value={createPortfolioName} onChange={(event) => setCreatePortfolioName(event.target.value)} placeholder="portfolio name" />
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Mandate type <HelpHint text={MANDATE_TYPE_HELP[createMandateType].text} examples={MANDATE_TYPE_HELP[createMandateType].examples} label={createMandateType} /></div>
              <select value={createMandateType} onChange={(event) => setCreateMandateType(event.target.value)}>
                <option value="discretionary">discretionary</option>
                <option value="advisory">advisory</option>
                <option value="simulation">simulation</option>
                <option value="treasury">treasury</option>
              </select>
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Risk profile <HelpHint text={RISK_PROFILE_HELP[createRiskProfile].text} examples={RISK_PROFILE_HELP[createRiskProfile].examples} label={createRiskProfile} /></div>
              <select value={createRiskProfile} onChange={(event) => setCreateRiskProfile(event.target.value)}>
                <option value="conservative">conservative</option>
                <option value="balanced">balanced</option>
                <option value="aggressive">aggressive</option>
              </select>
            </div>
            <button type="button" onClick={() => createPortfolio()} disabled={busy}>Créer le portefeuille</button>
          </div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="row"><span>Client ciblé</span><span>{createPortfolioClientId || selectedSource?.client_id || "-"}</span></div>
            <div className="row"><span>Portefeuilles compatibles</span><span>{matchedPortfolios.length}</span></div>
            {matchedPortfolios.slice(0, 4).map((row) => (
              <div key={row.portfolio_id} className="row">
                <span>{row.portfolio_id} · {row.name}</span>
                <button type="button" onClick={() => setSelectedPortfolioId(row.portfolio_id)}>Utiliser</button>
              </div>
            ))}
            {matchedPortfolios.length === 0 ? <p className="subtle" style={{ marginTop: 8 }}>Aucun portefeuille existant pour ce client. Le portefeuille créé ici sera le bon candidat pour l'allocation.</p> : null}
          </div>
        </div>

        <div className="panel" data-testid="live-capital-allocation-desk">
          <div className="eyebrow">Allouer une source connectée <HelpHint text="C'est ici que la source passe d'un simple branchement à un capital vraiment encadré." examples={["Vérifie d'abord le montant réel, puis fixe une limite inférieure ou égale à ce qui a été confirmé.", "Pour une réserve, commence avec une limite prudente."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <select value={selectedSource?.key || ""} onChange={(event) => setSelectedSourceKey(event.target.value)}>
              <option value="">Choisir une source</option>
              {capitalSources.map((row) => (
                <option key={row.key} value={row.key}>{row.display_name} · {row.source_type} · {row.environment}</option>
              ))}
            </select>
            <select value={selectedPortfolioId} onChange={(event) => setSelectedPortfolioId(event.target.value)}>
              <option value="">Choisir un portefeuille</option>
              {portfolios.map((row) => (
                <option key={row.portfolio_id} value={row.portfolio_id}>{row.portfolio_id} · {row.client_id}</option>
              ))}
            </select>
            <input type="number" step="0.1" value={allocationWeight} onChange={(event) => setAllocationWeight(Number(event.target.value || 0))} placeholder="allocation_weight" />
            <input type="number" step="100" value={allocationCapUsd} onChange={(event) => setAllocationCapUsd(Number(event.target.value || 0))} placeholder="allocation_cap_usd" />
            <select value={allocationStatus} onChange={(event) => setAllocationStatus(event.target.value)}>
              <option value="active">active</option>
              <option value="paused">paused</option>
            </select>
            <button type="button" onClick={() => attachAccountAllocation()} disabled={busy}>Allouer la source</button>
            {!selectedSource?.canonical ? (
              <button type="button" onClick={() => canonicalizeSelectedSource()} disabled={busy || !selectedSource}>
                Canoniser pour allocation
              </button>
            ) : null}
            {selectedSource?.canonical_account_id ? (
              <button type="button" onClick={() => deleteCanonicalAccount(selectedSource.canonical_account_id || selectedSource.account_id)} disabled={busy}>
                Supprimer le compte canonique
              </button>
            ) : null}
          </div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="row"><span>Source</span><span>{selectedSource ? `${selectedSource.display_name} · ${selectedSource.source_type}` : "-"}</span></div>
            <div className="row"><span>Plateforme</span><span>{selectedSource?.platform || "-"}</span></div>
            <div className="row"><span>Environnement</span><span className={selectedSource ? toneForEnvironment(selectedSource.environment) : "metric"}>{selectedSource?.environment || "-"}</span></div>
            <div className="row"><span>Permission / mode</span><span>{selectedSource?.permission_label || "-"}</span></div>
            <div className="row"><span>Canonique</span><span>{selectedSource?.canonical ? "oui" : "non"}</span></div>
            <div className="row"><span>Portefeuilles du client</span><span>{matchedPortfolios.length > 0 ? matchedPortfolios.map((row) => row.portfolio_id).slice(0, 2).join(", ") : "Créer ou choisir un portefeuille"}</span></div>
            <div className="row"><span>Total vérifié</span><span>{verificationTotalUsd != null ? formatUsd(verificationTotalUsd) : "Appeler le compte pour remonter le total"}</span></div>
            <div className="row"><span>Cap USD</span><span>{formatUsd(allocationCapUsd)}</span></div>
            <div className="row"><span>Live readiness</span><span className={liveReady ? "good" : "warn"}>{liveReady ? "allocable pour agents live" : "vérifier source / portefeuille / statut"}</span></div>
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Verification plateforme et fonds <HelpHint text="Ce bloc lit le compte pour afficher ce qui est vraiment visible: montants, positions et total confirmé." examples={["Avant d'allouer, commence toujours par cette vérification.", "Si aucun total ne remonte, la source est branchée mais pas encore bien lue par le système."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <button type="button" onClick={() => verifySelectedSource()} disabled={verifying || !selectedSource}>
              {verifying ? "Verification..." : "Appeler et vérifier le compte"}
            </button>
            <button type="button" onClick={() => syncSelectedBroker()} disabled={busy || !selectedSource?.canonical_account_id}>
              Synchroniser la source
            </button>
            <button
              type="button"
              disabled={!selectedSource}
              onClick={() => openOpsCopilotPrompt({
                message: `Résume-moi en langage naturel la source ${selectedSource?.display_name || "sélectionnée"}, la différence entre son mode et un compte paper/live, et ce qu'il est réellement possible de vérifier sur la plateforme.`,
                autoSend: true,
              })}
            >
              Demander le résumé au Copilot
            </button>
          </div>
          {verification ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>Status</span><span>{String(verification.status || "-")}</span></div>
              <div className="row"><span>Connecteur lié</span><span>{verification.connector_account ? `${String((verification.connector_account as JsonMap).provider || "-")} / ${String((verification.connector_account as JsonMap).auth_method || "-")} / ${String((verification.connector_account as JsonMap).mode || "-")}` : "Aucun connecteur rattaché visible"}</span></div>
              <div className="row"><span>Total compte</span><span>{verificationTotalUsd != null ? formatUsd(verificationTotalUsd) : "Total indisponible"}</span></div>
              {verificationPocketSummaries.map((item) => (
                <div key={`verification-pocket-${item.key}`} className="row">
                  <span>{item.label}</span>
                  <span>{item.totalUsd != null ? `${formatUsd(item.totalUsd)} · ${item.assetCount} actif(s)` : `${item.assetCount} actif(s)`}</span>
                </div>
              ))}
              <div className="row"><span>Balances</span><span>{Array.isArray(verification.balances) ? `${(verification.balances as unknown[]).length} ligne(s)` : String(verification.note || "-")}</span></div>
              <div className="row"><span>Positions</span><span>{verificationPositions.length > 0 ? `${verificationPositions.length} ligne(s)` : "-"}</span></div>
              {verificationOpenOrders.length > 0 ? (
                <div className="row" style={{ color: "#f5a623" }}>
                  <span>Ordres en attente</span>
                  <span>
                    {verificationOpenOrders.map((o, i) => (
                      <span key={i} style={{ display: "block", fontSize: 11 }}>
                        {String(o.side || "")} {String(o.quantity || "")} {String(o.symbol || "")} @ {typeof o.price === "number" ? o.price.toLocaleString("fr-FR") : String(o.price || "")} USDT
                      </span>
                    ))}
                  </span>
                </div>
              ) : null}
              <div className="row"><span>Portfolio links</span><span>{Array.isArray(verification.portfolio_links) ? `${(verification.portfolio_links as unknown[]).length}` : "-"}</span></div>
              <div className="row"><span>Lecture spot / futures</span><span>{spotFuturesReadMessage}</span></div>
              {Array.isArray(verification.latest_portfolio_snapshots) ? (
                <div className="row"><span>Snapshots</span><span>{(verification.latest_portfolio_snapshots as unknown[]).length}</span></div>
              ) : null}
              {verificationNotes.map((note, index) => (
                <p key={`verification-note-${index}`} className="subtle" style={{ marginTop: 8 }}>
                  {note}
                </p>
              ))}
              {verificationBalances.slice(0, 4).map((item, index) => {
                const row = item as JsonMap;
                return (
                  <div key={`verification-balance-${index}`} className="row">
                    <span>{String(row.asset_symbol || row.asset || `asset-${index + 1}`)}</span>
                    <span>{Number.isFinite(Number(row.equity_usd)) ? formatUsd(Number(row.equity_usd)) : `${Number(row.available_qty || 0)} disponible`}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="subtle" style={{ marginTop: 12 }}>
              Utilise ce bloc pour faire des appels de vérification: fonds visibles, positions, liens portefeuille et statut plateforme selon la nature de la source.
            </p>
          )}
        </div>

        <div className="panel">
          <div className="eyebrow">Agent Strategy Readiness <HelpHint text="Une stratégie ne doit passer sur du vrai capital que si la source est claire, vérifiée et bien limitée." examples={["L'agent peut proposer, mais c'est à l'opérateur de valider le passage.", "Si le compte montre 10k USD, évite une limite plus haute que le montant confirmé."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <input value={strategyId} onChange={(event) => setStrategyId(event.target.value)} placeholder="strategy_id" />
            <input value={strategyName} onChange={(event) => setStrategyName(event.target.value)} placeholder="strategy name" />
            <input value={strategyMarket} onChange={(event) => setStrategyMarket(event.target.value)} placeholder="market" />
            <input value={strategySetupType} onChange={(event) => setStrategySetupType(event.target.value)} placeholder="setup_type" />
            <input value={strategyNotes} onChange={(event) => setStrategyNotes(event.target.value)} placeholder="notes" style={{ gridColumn: "1 / -1" }} />
            <button type="button" onClick={() => createStrategy()} disabled={busy}>Créer la stratégie</button>
            <button
              type="button"
              disabled={!selectedSource}
              onClick={() => openOpsCopilotPrompt({
                message: `Propose si la stratégie ${strategyId} doit être promue vers un usage live en tenant compte de la source ${selectedSource?.display_name || "sélectionnée"}, du cap ${allocationCapUsd} USD et du portefeuille ${selectedPortfolioId || "non attaché"}.`,
                autoSend: true,
              })}
            >
              Demander une proposition d'agent
            </button>
          </div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="row"><span>Strategie sélectionnée</span><span>{selectedStrategy ? `${selectedStrategy.strategy_id} · L${selectedStrategy.current_level}` : strategyId}</span></div>
            <div className="row"><span>Promotion</span><span>{selectedStrategy ? `next L${Math.min(selectedStrategy.current_level + 1, 6)}` : "L1"}</span></div>
            <div className="row"><span>Source liée</span><span>{selectedSource ? `${selectedSource.display_name} · ${selectedSource.environment}` : "-"}</span></div>
            <button
              type="button"
              disabled={busy || !selectedStrategy || selectedStrategy.current_level >= 6}
              onClick={() => promoteStrategy(Math.min((selectedStrategy?.current_level || 0) + 1, 6))}
              style={{ marginTop: 10 }}
            >
              Promouvoir la stratégie
            </button>
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Capital Verified <HelpHint text="Ce badge dit si la lecture du capital est fiable ou si un humain doit relire la situation." examples={["Vert si les différentes poches retombent bien sur le total attendu.", "Orange si quelque chose semble incomplet.", "Rouge si les montants se contredisent vraiment."]} /></div>
          <div className={`live-capital-badge ${capitalBadge.tone}`}>{capitalBadge.label}</div>
          <div className="row" style={{ marginTop: 12 }}><span>Detail</span><span>{capitalBadge.detail}</span></div>
          <div className="row"><span>Valeur plateforme équivalente</span><span>{verificationCashVsEquivalent ? formatUsd(toNumber(verificationCashVsEquivalent.total_equivalent_usd, 0)) : verificationTotalUsd != null ? formatUsd(verificationTotalUsd) : "-"}</span></div>
          <div className="row"><span>Cash brut</span><span>{verificationCashVsEquivalent ? formatUsd(toNumber(verificationCashVsEquivalent.total_raw_cash_usd, 0)) : "-"}</span></div>
          <div className="row"><span>Inventaire non-cash</span><span>{verificationCashVsEquivalent ? formatUsd(toNumber(verificationCashVsEquivalent.inventory_usd, 0)) : "-"}</span></div>
          <div className="row"><span>Poches totalisées</span><span>{verificationPocketSummaries.length > 0 ? formatUsd(verificationTotalFromPockets) : "-"}</span></div>
          <div className="row"><span>Source</span><span>{selectedSource ? `${selectedSource.display_name} / ${selectedSource.platform}` : "-"}</span></div>
          <div className="row"><span>Auth method</span><span>{verification?.connector_account && typeof verification.connector_account === "object" ? walletAuthMethodLabel(String((verification.connector_account as JsonMap).auth_method || ""), Boolean((verification.connector_account as JsonMap).has_credentials)) : "-"}</span></div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="eyebrow">Forensic Note</div>
            <p className="subtle" style={{ marginTop: 8 }}>{forensicNote}</p>
          </div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="eyebrow">Timeline des syncs</div>
            {syncTimeline.length === 0 ? <p className="subtle" style={{ marginTop: 8 }}>Aucun evenement de sync disponible.</p> : null}
            {syncTimeline.map((event) => (
              <div key={event.key} className="live-capital-timeline-item">
                <div>
                  <strong>{event.label}</strong>
                  <div className="subtle">{event.detail}</div>
                </div>
                <span className={`live-capital-pill ${event.tone}`}>{formatTimestamp(event.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Breakdown par actif <HelpHint text="Montre le détail de chaque poche avec les actifs, leur valeur et leur poids dans le total." examples={["Tu peux voir rapidement quels actifs dominent la source.", "La couleur aide à repérer ce qui monte ou baisse sur la période affichée."]} /></div>
          {verificationPocketSummaries.length === 0 ? <p className="subtle">Aucune poche détaillée tant que la source n'a pas encore été vérifiée.</p> : null}
          {verificationPocketSummaries.map((pocket) => (
            <div key={`asset-pocket-${pocket.key}`} className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>{pocket.label}</span><span>{pocket.totalUsd != null ? `${formatUsd(pocket.totalUsd)} · ${pocket.assetCount} actif(s)` : `${pocket.assetCount} actif(s)`}</span></div>
              {verificationPocketViewMap.get(pocket.key) ? (
                <div className="live-capital-pocket-compare">
                  <div>
                    <span className="subtle">Valeur plateforme</span>
                    <strong>{formatUsd(verificationPocketViewMap.get(pocket.key)?.equivalent_usd || 0)}</strong>
                  </div>
                  <div>
                    <span className="subtle">Cash brut</span>
                    <strong>{formatUsd(verificationPocketViewMap.get(pocket.key)?.raw_cash_usd || 0)}</strong>
                  </div>
                  <div>
                    <span className="subtle">Inventaire</span>
                    <strong>{formatUsd(verificationPocketViewMap.get(pocket.key)?.inventory_usd || 0)}</strong>
                  </div>
                </div>
              ) : null}
              {(assetRowsByPocket.get(pocket.key) || []).map((asset) => {
                const weightPct = verificationTotalUsd && asset.usdValue != null ? (asset.usdValue / verificationTotalUsd) * 100 : 0;
                return (
                  <div key={asset.key} className="live-capital-asset-row">
                    <span>{asset.assetLabel}</span>
                    <span>{formatQty(asset.totalQty)}</span>
                    <span>{asset.markPriceUsd != null ? formatUsd(asset.markPriceUsd) : "-"}</span>
                    <span>{asset.usdValue != null ? formatUsd(asset.usdValue) : "-"}</span>
                    <span>{asset.change24hPct != null ? formatPct(asset.change24hPct, 2) : "-"}</span>
                    <span>{weightPct > 0 ? formatPct(weightPct, 1) : "-"}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {verificationAssetRows.length > 0 ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="eyebrow">Mini-heatmap de valorisation</div>
              <div className="live-capital-heatmap">
                {verificationAssetRows.map((asset) => {
                  const weightPct = verificationTotalUsd && asset.usdValue != null ? Math.max((asset.usdValue / verificationTotalUsd) * 100, 8) : 8;
                  const tone = asset.change24hPct == null ? "neutral" : asset.change24hPct > 0 ? "positive" : asset.change24hPct < 0 ? "negative" : "neutral";
                  return (
                    <div
                      key={`heatmap-${asset.key}`}
                      className={`live-capital-heatmap-cell ${tone}`}
                      style={{ flexGrow: Math.max(weightPct / 8, 1), minWidth: `${Math.max(weightPct * 3, 88)}px` }}
                    >
                      <strong>{asset.assetLabel}</strong>
                      <span>{asset.usdValue != null ? formatUsd(asset.usdValue) : "-"}</span>
                      <span>{asset.change24hPct != null ? formatPct(asset.change24hPct, 2) : "24h n/a"}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Risk Overlay Capital <HelpHint text="Ce bloc résume le niveau de risque pris par la source: taille globale, concentration et marge de sécurité restante." examples={["Un compte simple reste souvent peu levierisé.", "Si une poche grossit trop, elle fait monter le risque total."]} /></div>
          <div className="live-capital-kpi-grid">
            <div className="live-capital-kpi"><span>Leverage global</span><strong>{leverageGlobal > 0 ? `${leverageGlobal.toFixed(2)}x` : "0.00x"}</strong></div>
            <div className="live-capital-kpi"><span>Gross exposure</span><strong>{formatUsd(grossExposureUsd)}</strong></div>
            <div className="live-capital-kpi"><span>Concentration risk</span><strong>{concentrationPct != null ? `${formatPct(concentrationPct, 1)} ${concentrationAsset ? `· ${concentrationAsset.assetLabel}` : ""}` : "-"}</strong></div>
            <div className="live-capital-kpi"><span>Distance au max DD</span><strong>{formatPct(ddHeadroomPct, 1)}</strong></div>
            <div className="live-capital-kpi"><span>Risk budget utilisé</span><strong>{formatPct(riskBudgetUsedPct, 1)}</strong></div>
            <div className="live-capital-kpi"><span>Corrélation poches</span><strong>{structuralCorrelation}</strong></div>
          </div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="eyebrow">Exposure par poche</div>
            {verificationPocketSummaries.map((item) => {
              const pct = verificationTotalUsd && item.totalUsd != null ? (item.totalUsd / verificationTotalUsd) * 100 : null;
              return (
                <div key={`risk-pocket-${item.key}`} className="row">
                  <span>{item.label}</span>
                  <span>{item.totalUsd != null ? `${formatUsd(item.totalUsd)} · ${pct != null ? formatPct(pct, 1) : "-"}` : "-"}</span>
                </div>
              );
            })}
          </div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="eyebrow">Stress tests rapides</div>
            {stressScenarios.map((scenario) => (
              <div key={scenario.label} className="row">
                <span>{scenario.label}</span>
                <span>{formatUsd(scenario.pnlUsd)}</span>
              </div>
            ))}
            {portfolioRisk ? <p className="subtle" style={{ marginTop: 8 }}>Snapshot portefeuille: drawdown {formatPct(toNumber(portfolioRisk.drawdown_pct, 0), 2)} · VaR 95 {formatUsd(toNumber(portfolioRisk.var_95_usd, 0))}.</p> : null}
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Capital Flow Engine <HelpHint text="Ici, tu vois les mouvements d'argent observés sur la source: entrées, sorties, transferts et résultat encaissé." examples={["Un déplacement entre deux poches apparaît comme un vrai mouvement suivi dans le temps.", "Les frais et le résultat réalisé sont regroupés ici pour raconter l'histoire du compte."]} /></div>
          <div className="row"><span>Entrées / sorties nettes</span><span>{verificationCapitalLedgerRows.length > 0 ? formatSignedUsd(verificationCapitalLedgerSummary.net_external_cashflow_usd) : netCapitalDeltaUsd != null ? formatSignedUsd(netCapitalDeltaUsd) : "ledger vide"}</span></div>
          <div className="row"><span>Transferts internes</span><span>{verificationCapitalLedgerRows.length > 0 ? formatUsd(verificationCapitalLedgerSummary.internal_transfer_usd) : "aucun transfert historisé"}</span></div>
          <div className="row"><span>Funding fees</span><span>{verificationCapitalLedgerRows.length > 0 ? formatSignedUsd(verificationCapitalLedgerSummary.funding_fee_usd) : fundingFeesAvailable ? formatSignedUsd(fundingFeesUsd) : "non remontées"}</span></div>
          <div className="row"><span>PnL réalisé</span><span>{verificationCapitalLedgerRows.length > 0 ? formatSignedUsd(verificationCapitalLedgerSummary.realized_pnl_usd) : formatSignedUsd(realizedPnlUsd)}</span></div>
          <div className="row"><span>PnL latent</span><span>{formatSignedUsd(unrealizedPnlUsd)}</span></div>
          <div className="row"><span>Delta de réconciliation</span><span>{verificationCapitalLedgerRows.length > 0 ? formatSignedUsd(verificationCapitalLedgerSummary.reconciliation_usd) : "n/a"}</span></div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="eyebrow">Derniers événements de ledger</div>
            {verificationCapitalLedgerRows.length === 0 ? <p className="subtle" style={{ marginTop: 8 }}>Aucun événement historisé pour cette source tant qu'une sync enrichie n'a pas tourné.</p> : null}
            {verificationCapitalLedgerRows.slice(0, 6).map((event) => (
              <div key={event.event_id} className="live-capital-ledger-row">
                <div>
                  <strong>{event.description || event.event_type}</strong>
                  <div className="subtle">{[event.asset_symbol, event.pocket, event.counterparty].filter(Boolean).join(" · ") || (event.venue || "source")}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <strong>{formatSignedUsd(event.amount_usd)}</strong>
                  <div className="subtle">{formatTimestamp(event.occurred_at)}</div>
                </div>
              </div>
            ))}
          </div>
          {capitalIntegrationSleeves.length > 0 ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="eyebrow">Capital integration par sleeve</div>
              {capitalIntegrationTotals ? <div className="row"><span>Total portefeuille</span><span>{formatUsd(toNumber(capitalIntegrationTotals.actual_equivalent_usd, 0))} eq · {formatUsd(toNumber(capitalIntegrationTotals.actual_raw_cash_usd, 0))} cash</span></div> : null}
              {capitalIntegrationSleeves.slice(0, 5).map((sleeve) => (
                <div key={sleeve.sleeve} className="row">
                  <span>{sleeve.sleeve}</span>
                  <span>{formatUsd(sleeve.actual_equivalent_usd)} eq · {formatUsd(sleeve.actual_raw_cash_usd)} cash · drift {formatPct(sleeve.drift_pct, 1)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
        <div className="panel">
          <div className="eyebrow">Portfolio Attribution <HelpHint text="Ce bloc aide à comprendre d'où vient le résultat: quelle source, quelle stratégie ou quel actif a le plus compté." examples={["Tu peux voir si le résultat vient surtout d'une plateforme précise.", "Tu peux aussi repérer quelle stratégie ou quel actif pèse le plus dans le bilan."]} /></div>
          <div className="row"><span>Sleeve courant</span><span>{capitalSleeve}</span></div>
          <div className="row"><span>Portefeuille</span><span>{activePortfolioId || "non sélectionné"}</span></div>
          {portfolioAttribution.length === 0 ? <p className="subtle" style={{ marginTop: 10 }}>Aucune ligne d'attribution disponible pour ce portefeuille sur la période courante.</p> : null}
          {portfolioAttribution.length > 0 ? (
            <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "1fr 1fr 1fr" }}>
              <div className="panel" style={{ borderRadius: 12 }}>
                <div className="eyebrow">Par source</div>
                {attributionByVenue.map((item) => (
                  <div key={`attr-venue-${item.key}`} className="row">
                    <span>{item.key}</span>
                    <span>{formatUsd(item.realizedPnlUsd)} · {formatPct(item.contributionPct, 1)}</span>
                  </div>
                ))}
              </div>
              <div className="panel" style={{ borderRadius: 12 }}>
                <div className="eyebrow">Par stratégie</div>
                {attributionByStrategy.map((item) => (
                  <div key={`attr-strategy-${item.key}`} className="row">
                    <span>{item.key}</span>
                    <span>{formatUsd(item.realizedPnlUsd)} · {item.tradeCount} trade(s)</span>
                  </div>
                ))}
              </div>
              <div className="panel" style={{ borderRadius: 12 }}>
                <div className="eyebrow">Par actif</div>
                {attributionByAsset.map((item) => (
                  <div key={`attr-asset-${item.key}`} className="row">
                    <span>{item.key}</span>
                    <span>{formatUsd(item.realizedPnlUsd)} · {formatPct(item.contributionPct, 1)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Live Runbook <HelpHint text="C'est la checklist simple avant d'autoriser un agent à toucher du vrai capital." examples={["Branchement, vérification, préparation, allocation, puis seulement après passage en live.", "S'il manque une étape, considère la source comme non prête."]} /></div>
          <div className="row"><span>1. Nature de la source</span><span>{selectedSource ? `${selectedSource.source_type} / ${selectedSource.environment}` : "Choisir une source"}</span></div>
          <div className="row"><span>2. Statut plateforme</span><span>{selectedSource?.status || "-"}</span></div>
          <div className="row"><span>3. Canonisation</span><span>{selectedSource?.canonical ? "faite" : "requise avant allocation"}</span></div>
          <div className="row"><span>4. Portefeuille</span><span>{selectedPortfolioId || "A attacher"}</span></div>
          <div className="row"><span>5. Cap allocation</span><span>{formatUsd(allocationCapUsd)}</span></div>
          <div className="row"><span>6. Promotion live</span><span>{pendingLive.length > 0 ? `${pendingLive.length} approval(s) en attente` : "pipeline prêt si la source est gouvernée"}</span></div>
          <p className="subtle" style={{ marginTop: 12 }}>
            Paper et live doivent rester séparés dans la lecture client. Exchange et wallet doivent être présentés comme des plateformes ou réserves distinctes,
            avec une explication claire de ce qui est vérifiable immédiatement et de ce qui demande une synchronisation ou un adaptateur dédié.
          </p>
        </div>

        <div className="panel">
          <div className="eyebrow">Allocator Readiness Matrix <HelpHint text="Cette matrice résume ce qu'il manque encore avant d'utiliser la source dans de bonnes conditions." examples={["Un score complet veut dire que la source est claire et prête.", "Si la limite dépasse l'argent confirmé, la préparation n'est pas terminée."]} /></div>
          <div className="row"><span>Score desk</span><span className={hedgeFundReadinessScore >= 5 ? "good" : hedgeFundReadinessScore >= 3 ? "warn" : "metric"}>{hedgeFundReadinessScore}/6</span></div>
          {hedgeFundChecks.map((item) => (
            <div key={item.label} className="row">
              <span>{item.label}</span>
              <span className={item.ok ? "good" : "warn"}>{item.ok ? "ok" : item.detail}</span>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="eyebrow">Strategies <HelpHint text="Rappel du niveau des stratégies pour éviter d'envoyer trop vite du vrai capital sur un setup encore fragile." examples={["Une stratégie encore en observation mérite une relecture avant tout passage réel.", "Regarde toujours son niveau actuel avant de la promouvoir."]} /></div>
          {strategies.length === 0 ? <p className="subtle">Aucune stratégie disponible.</p> : null}
          {strategies.slice(0, 8).map((row) => (
            <div key={row.strategy_id} className="row">
              <span>{row.strategy_id} | {row.name} | {row.market}</span>
              <span>L{row.current_level} / {row.status} / {row.setup_type}</span>
            </div>
          ))}
        </div>
      </section>

      {result ? (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="eyebrow">Dernier résultat</div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>
        </section>
      ) : null}
    </main>
  );
}