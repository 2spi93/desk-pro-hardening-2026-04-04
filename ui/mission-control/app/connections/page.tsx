"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import HelpHint from "../../components/HelpHint";
import TxtMiniGuide from "../../components/ui/TxtMiniGuide";
import {
  BROKER_CONNECTION_CATALOG,
  EXCHANGE_CONNECTION_CATALOG,
  WALLET_CONNECTION_CATALOG,
  type ConnectionProviderType,
} from "../../lib/connectionCatalog";

type JsonMap = Record<string, unknown>;

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

function walletStatusLabel(item: JsonMap): string {
  const authMethod = String(item.auth_method || "").trim().toLowerCase();
  if (authMethod === "wallet_keys") {
    return "legacy signer a migrer";
  }
  if (authMethod === "custody_api" || authMethod === "safe_api") {
    return "custody / signer lié";
  }
  if (authMethod === "walletconnect") {
    return "wallet adapter";
  }
  return authMethod === "wallet_public_key" ? "watch-only" : (Boolean(item.has_credentials) ? "credential linked" : "watch-only");
}

export default function ConnectionsPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JsonMap | null>(null);
  const [mt5Accounts, setMt5Accounts] = useState<JsonMap[]>([]);
  const [linkedAccounts, setLinkedAccounts] = useState<JsonMap[]>([]);
  const [accountId, setAccountId] = useState("");
  const [broker, setBroker] = useState("metaquotes");
  const [server, setServer] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("paper");
  const [connectionProviderType, setConnectionProviderType] = useState<ConnectionProviderType>("broker");
  const [connectionProviderName, setConnectionProviderName] = useState("MT5 / MetaTrader 5");
  const [connectionMarketScope, setConnectionMarketScope] = useState("CFD / forex / futures / commodities / stocks");
  const [connectionMode, setConnectionMode] = useState("bridge-direct");
  const [connectionReference, setConnectionReference] = useState("");
  const [connectionNotes, setConnectionNotes] = useState("");
  const [connectionRequestBusy, setConnectionRequestBusy] = useState(false);
  const [connectionRequestResult, setConnectionRequestResult] = useState<JsonMap | null>(null);
  const [exchangeProviderId, setExchangeProviderId] = useState(String(EXCHANGE_CONNECTION_CATALOG[0]?.providerId || "bitget"));
  const [exchangeAccountId, setExchangeAccountId] = useState("");
  const [exchangeLabel, setExchangeLabel] = useState("");
  const [exchangeApiKey, setExchangeApiKey] = useState("");
  const [exchangeApiSecret, setExchangeApiSecret] = useState("");
  const [exchangePassphrase, setExchangePassphrase] = useState("");
  const [exchangeAccessMode, setExchangeAccessMode] = useState("trade");
  const [walletProviderId, setWalletProviderId] = useState(String(WALLET_CONNECTION_CATALOG[0]?.providerId || "metamask"));
  const [walletAccountId, setWalletAccountId] = useState("");
  const [walletLabel, setWalletLabel] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletPublicKey, setWalletPublicKey] = useState("");
  const [walletAccessMode, setWalletAccessMode] = useState("read");
  const selectedWalletProvider = WALLET_CONNECTION_CATALOG.find((item) => item.providerId === walletProviderId) || WALLET_CONNECTION_CATALOG[0];

  async function loadConnectionsState(): Promise<void> {
    const [mt5Response, connectorsResponse] = await Promise.all([
      fetch("/api/mt5/accounts", { cache: "no-store" }),
      fetch("/api/connectors/accounts", { cache: "no-store" }),
    ]);
    const mt5Payload = mt5Response.ok ? await mt5Response.json().catch(() => []) : [];
    const connectorsPayload = connectorsResponse.ok ? await connectorsResponse.json().catch(() => ({})) : {};
    setMt5Accounts(Array.isArray(mt5Payload) ? mt5Payload : []);
    setLinkedAccounts(Array.isArray(connectorsPayload?.accounts) ? (connectorsPayload.accounts as JsonMap[]) : []);
  }

  useEffect(() => {
    loadConnectionsState().catch(() => {
      setMt5Accounts([]);
      setLinkedAccounts([]);
    });
  }, []);

  async function connectMt5(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/mt5/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          broker,
          server,
          login,
          password,
          mode,
          metadata: { source: "client-connections-page" },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Connexion MT5 echouee"));
      }
      setResult((payload || null) as JsonMap | null);
      setPassword("");
      await loadConnectionsState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion MT5 echouee");
    } finally {
      setBusy(false);
    }
  }

  async function linkExchangeApiKey(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
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
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Connexion exchange impossible"));
      }
      setResult((payload || null) as JsonMap | null);
      setExchangeApiKey("");
      setExchangeApiSecret("");
      setExchangePassphrase("");
      await loadConnectionsState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion exchange impossible");
    } finally {
      setBusy(false);
    }
  }

  async function linkWalletAccount(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const hasWalletReference = Boolean(walletAddress || walletPublicKey);
      if (walletAccessMode === "trade" && !walletProviderSupportsAgentExecution(String(selectedWalletProvider?.mode || ""))) {
        throw new Error("Ce wallet doit rester en watch-only dans TXT. Pour trader, passe par Fireblocks, Safe ou un wallet adapter compatible.");
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
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Connexion wallet impossible"));
      }
      setResult((payload || null) as JsonMap | null);
      await loadConnectionsState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion wallet impossible");
    } finally {
      setBusy(false);
    }
  }

  async function requestConnectionOnboarding(): Promise<void> {
    setConnectionRequestBusy(true);
    setError(null);
    setConnectionRequestResult(null);
    try {
      const response = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `client_connection_onboarding:${connectionProviderName}`,
          severity: "medium",
          payload: {
            type: connectionProviderType,
            provider: connectionProviderName,
            market_scope: connectionMarketScope,
            connection_mode: connectionMode,
            reference: connectionReference,
            notes: connectionNotes,
            source: "client-connections-page",
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Demande d'onboarding impossible"));
      }
      setConnectionRequestResult((payload || null) as JsonMap | null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demande d'onboarding impossible");
    } finally {
      setConnectionRequestBusy(false);
    }
  }

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.2fr 0.8fr" }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">Client Connection Hub <HelpHint text="Page client pour raccorder broker, exchange ou wallet a TXT et trader avec vos agents." examples={["Si vous tradez via MT5, connectez d'abord le compte paper ici avant d'utiliser Terminal.", "Si vous voulez brancher un exchange ou un wallet, creez ici la demande d'onboarding pour l'adaptateur approprie."]} /></div>
          <h1 className="title" style={{ fontSize: 34 }}>Vos connexions de trading</h1>
          <p className="subtle">
            C'est ici que le client raccorde son broker, son exchange ou son wallet pour trader avec TXT ou deleguer l'execution a nos agents.
          </p>
          <TxtMiniGuide
            title="Guide Connections"
            what="Rattacher vos comptes et vos wallets au bon adaptateur TXT."
            why="Seul un compte ou wallet correctement raccorde peut etre utilise ensuite par le Terminal ou les agents TXT."
            example="Connectez un compte MT5 paper ici, puis ouvrez le Terminal pour executer avec les garde-fous TXT."
            terms={["broker", "exchange", "wallet", "paper"]}
          />
          <p>
            <Link href="/terminal">Trading Terminal</Link>
            {" | "}
            <Link href="/learn">Learn</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>

        <div className="panel">
          <div className="eyebrow">Ou TXT utilisera cette connexion</div>
          <div className="row"><span>MT5 / broker</span><span>execution via bridge TXT</span></div>
          <div className="row"><span>Exchange CEX</span><span>agents + terminal via API key</span></div>
          <div className="row"><span>Wallet / DEX</span><span>signature + execution on-chain</span></div>
          <div className="row"><span>Prop platform</span><span>adaptateur natif / FIX / OMS</span></div>
          <p className="subtle" style={{ marginTop: 10 }}>
            Une fois la connexion en place, le trading se fait ensuite dans le Terminal ou via les workflows agentiques TXT selon le venue raccorde.
          </p>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Connexion MT5 directe <HelpHint text="Point d'entree client pour rattacher un compte MetaTrader 5 paper ou live a TXT." examples={["Commencez par paper pour tester le pipeline complet sans risque reel.", "Si vous etes sur une prop firm sans MT5, utilisez plutot la demande d'onboarding a droite."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="account_id" />
            <input value={broker} onChange={(e) => setBroker(e.target.value)} placeholder="broker" />
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="server" />
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="login" />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="mot de passe MT5" />
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="paper">paper</option>
              <option value="live">live</option>
            </select>
            <button type="button" onClick={() => connectMt5()} disabled={busy}>{busy ? "Connexion…" : "Connecter le compte"}</button>
          </div>
          {mt5Accounts.length > 0 ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="eyebrow">Comptes MT5 visibles</div>
              {mt5Accounts.slice(0, 6).map((item) => (
                <div className="row" key={String(item.account_id)}>
                  <span>{String(item.account_id)} | {String(item.server || "-")} | {String(item.client_id || "client-n/a")}</span>
                  <span>{String(item.mode || "-")} / {String(item.status || "-")} / {item.has_credentials ? "secret ok" : "secret missing"}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="eyebrow">Connexion exchange par API key <HelpHint text="Liaison directe des comptes CEX supportes via cle API chiffree." examples={["Bitget ou BingX: renseignez account label, api key, secret et passphrase si requise.", "Utilisez read si vous voulez seulement supervision, trade si TXT doit executer."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <select value={exchangeProviderId} onChange={(e) => setExchangeProviderId(e.target.value)}>
              {EXCHANGE_CONNECTION_CATALOG.filter((item) => item.mode === "api-key").map((item) => (
                <option value={item.providerId} key={item.providerId}>{item.provider}</option>
              ))}
            </select>
            <input value={exchangeAccountId} onChange={(e) => setExchangeAccountId(e.target.value)} placeholder="exchange account_id / subaccount" />
            <input value={exchangeLabel} onChange={(e) => setExchangeLabel(e.target.value)} placeholder="label affichage" />
            <input value={exchangeApiKey} onChange={(e) => setExchangeApiKey(e.target.value)} placeholder="api key" />
            <input type="password" value={exchangeApiSecret} onChange={(e) => setExchangeApiSecret(e.target.value)} placeholder="api secret" />
            <input type="password" value={exchangePassphrase} onChange={(e) => setExchangePassphrase(e.target.value)} placeholder="passphrase (optionnelle)" />
            <select value={exchangeAccessMode} onChange={(e) => setExchangeAccessMode(e.target.value)}>
              <option value="read">read</option>
              <option value="trade">trade</option>
            </select>
            <button type="button" onClick={() => linkExchangeApiKey()} disabled={busy}>{busy ? "Connexion…" : "Lier API key"}</button>
          </div>
          {linkedAccounts.filter((item) => String(item.provider || "") !== "mt5" && String(item.provider_type || "") !== "wallet").length > 0 ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="eyebrow">Exchanges lies</div>
              {linkedAccounts.filter((item) => String(item.provider || "") !== "mt5" && String(item.provider_type || "") !== "wallet").slice(0, 6).map((item) => (
                <div className="row" key={`${String(item.provider)}-${String(item.account_id)}`}>
                  <span>{String(item.provider)} | {String(item.account_id)} | {String(item.label || "-")}</span>
                  <span>{String(item.mode || "-")} / {item.has_credentials ? "secret ok" : "secret missing"}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Connexion wallet / adresse on-chain <HelpHint text="Liez ici une adresse publique ou une référence custody. TXT ne doit jamais recevoir la clé privée du wallet." examples={["Solana: renseignez l'adresse publique et un label clair.", "Pour du trade on-chain agentique, utilisez Fireblocks, Safe ou un wallet adapter compatible."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <select value={walletProviderId} onChange={(e) => setWalletProviderId(e.target.value)}>
              {WALLET_CONNECTION_CATALOG.map((item) => (
                <option value={item.providerId} key={item.providerId}>{item.provider}</option>
              ))}
            </select>
            <input value={walletAccountId} onChange={(e) => setWalletAccountId(e.target.value)} placeholder="wallet account_id (optionnel)" />
            <input value={walletLabel} onChange={(e) => setWalletLabel(e.target.value)} placeholder="label wallet" />
            <input value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} placeholder="adresse publique / custody ref" />
            <input value={walletPublicKey} onChange={(e) => setWalletPublicKey(e.target.value)} placeholder="WALLET_PUBLIC_KEY (optionnel)" />
            <select value={walletAccessMode} onChange={(e) => setWalletAccessMode(e.target.value)}>
              <option value="read">read</option>
              <option value="trade">trade</option>
            </select>
            <button type="button" onClick={() => linkWalletAccount()} disabled={busy || !(walletAddress || walletPublicKey)}>{busy ? "Connexion…" : "Lier wallet"}</button>
          </div>
          <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
            <div className="row"><span>Trade CEX par les agents</span><span>OMS / adaptateur exchange avec API keys</span></div>
            <div className="row"><span>Trade wallet on-chain</span><span>custody API, Safe ou wallet adapter</span></div>
            <div className="row"><span>Signature</span><span>hors TXT, côté MPC / signer externe</span></div>
            <div className="row"><span>Politique</span><span>jamais de clé privée dans TXT</span></div>
          </div>
          <p className="subtle" style={{ marginTop: 10 }}>
            En mode institutionnel, TXT route les ordres et le signer externe valide la transaction. Une adresse publique suffit pour le suivi, la vérification et l'allocation watch-only.
          </p>
          {linkedAccounts.filter((item) => String(item.provider_type || "") === "wallet").length > 0 ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="eyebrow">Wallets lies</div>
              {linkedAccounts.filter((item) => String(item.provider_type || "") === "wallet").slice(0, 6).map((item) => (
                <div className="row" key={`${String(item.provider)}-${String(item.account_id)}`}>
                  <span>{String(item.provider)} | {String(item.address || item.account_id || "-")}</span>
                  <span>{String(item.mode || "-")} / {walletStatusLabel(item)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="eyebrow">Onboarding broker / exchange / wallet non standard <HelpHint text="Demande client pour les connexions hors parcours directs deja supportes." examples={["Choisissez prop firm si votre venue utilise une plateforme proprietaire.", "Utilisez ce bloc quand l'integration demande FIX, OAuth specifique ou un adaptateur dedie."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <select value={connectionProviderType} onChange={(e) => setConnectionProviderType(e.target.value as ConnectionProviderType)}>
              <option value="broker">broker</option>
              <option value="exchange">exchange</option>
              <option value="wallet">wallet</option>
              <option value="prop">prop firm</option>
            </select>
            <input value={connectionProviderName} onChange={(e) => setConnectionProviderName(e.target.value)} placeholder="provider" />
            <input value={connectionMarketScope} onChange={(e) => setConnectionMarketScope(e.target.value)} placeholder="coverage / market scope" />
            <input value={connectionMode} onChange={(e) => setConnectionMode(e.target.value)} placeholder="mode (api-key, walletconnect, FIX...)" />
            <input value={connectionReference} onChange={(e) => setConnectionReference(e.target.value)} placeholder="account label / wallet / API ref" />
            <input value={connectionNotes} onChange={(e) => setConnectionNotes(e.target.value)} placeholder="notes integration / permissions / prop rules" />
            <button type="button" onClick={() => requestConnectionOnboarding()} disabled={connectionRequestBusy}>{connectionRequestBusy ? "Envoi…" : "Creer demande d'onboarding"}</button>
          </div>
          {connectionRequestResult ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>Status</span><span>{String(connectionRequestResult.status || "-")}</span></div>
              <div className="row"><span>Ticket</span><span>{String(connectionRequestResult.ticket_key || "-")}</span></div>
              <div className="row"><span>Detail</span><span>{String(connectionRequestResult.detail || "-")}</span></div>
            </div>
          ) : null}
        </div>
      </section>

      {linkedAccounts.length > 0 ? (
        <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
          <div className="panel">
            <div className="eyebrow">Toutes les connexions liees</div>
            {linkedAccounts.slice(0, 12).map((item) => (
              <div className="row" key={`${String(item.provider)}-${String(item.account_id)}`}>
                <span>{String(item.provider)} | {String(item.account_id)} | {String(item.client_id || "-")}</span>
                <span>{String(item.mode || "-")} / {String(item.owner_username || "-")}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Catalogue brokers & exchanges</div>
          {[...BROKER_CONNECTION_CATALOG, ...EXCHANGE_CONNECTION_CATALOG].map((item) => (
            <div className="row" key={`${item.provider}-${item.mode}`}>
              <span>{item.provider} | {item.coverage}</span>
              <span>{item.mode}</span>
            </div>
          ))}
        </div>
        <div className="panel">
          <div className="eyebrow">Catalogue wallets</div>
          {WALLET_CONNECTION_CATALOG.map((item) => (
            <div className="row" key={`${item.provider}-${item.mode}`}>
              <span>{item.provider} | {item.coverage}</span>
              <span>{item.mode}</span>
            </div>
          ))}
        </div>
      </section>

      {result ? (
        <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
          <div className="panel">
            <div className="eyebrow">Dernier resultat</div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>
          </div>
        </section>
      ) : null}
    </main>
  );
}