import { redirect } from "next/navigation";
import TxtMiniGuide from "../../components/ui/TxtMiniGuide";
import Link from "next/link";
import { getServerRoleGroup } from "../../lib/serverAuth";
import RustExecutionAdminDesk from "../../components/internal/RustExecutionAdminDesk";

const MODULES = [
  "Strategies",
  "Signaux",
  "Alertes",
  "Backtests",
  "Statistiques",
  "Journaling",
];

export default async function AdvancedPage() {
  const roleGroup = await getServerRoleGroup();
  if (roleGroup === "client") redirect("/terminal");

  return (
    <main className="shell txt-page-shell">
      <section className="panel txt-page-hero">
        <div className="eyebrow">TXT Advanced</div>
        <h1 className="title" style={{ fontSize: 34 }}>Outils de trading avance</h1>
        <p className="subtle">Espace expert pour construire, tester et monitorer des approches plus sophistiquees.</p>
        <TxtMiniGuide
          title="Guide Advanced"
          what="Modules de performance, strategie et journaling pour traders confirmes."
          why="Donner de la profondeur analytique sans degrader la vitesse de decision."
          example="Valide une hypothese via stats et backtests avant de l'activer en execution reelle."
          terms={["allocation", "brier", "slippage"]}
        />
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <article className="panel txt-topic-card">
          <div className="eyebrow">Ops Debug</div>
          <h2 style={{ margin: "8px 0", fontSize: 20 }}>Chart Auto Stability</h2>
          <p className="subtle">Vue live des snapshots de calibration auto avec heat, sparkline et diagnostics de switch.</p>
          <Link href="/advanced/chart-auto-stability">Open debug view</Link>
        </article>
        <article className="panel txt-topic-card">
          <div className="eyebrow">Predictor</div>
          <h2 style={{ margin: "8px 0", fontSize: 20 }}>Failure LR Calibration</h2>
          <p className="subtle">Compare les fenetres offline 24h/7j/30j/all replay et l'historique des recalculs predictor.</p>
          <Link href="/advanced/predictor-calibration">Open calibration admin</Link>
        </article>
        <article className="panel txt-topic-card">
          <div className="eyebrow">Execution Learning</div>
          <h2 style={{ margin: "8px 0", fontSize: 20 }}>Reality Gap Monitor</h2>
          <p className="subtle">Observe les derniers samples predits vs realises et les profils de calibration actifs par venue, symbole et regime.</p>
          <Link href="/advanced/reality-gap">Open reality-gap view</Link>
        </article>
        {MODULES.map((moduleName) => (
          <article className="panel txt-topic-card" key={moduleName}>
            <div className="eyebrow">Module</div>
            <h2 style={{ margin: "8px 0", fontSize: 20 }}>{moduleName}</h2>
            <p className="subtle">Version expert compacte avec controles rapides et vue haute densite.</p>
            <button type="button" disabled>Bientot</button>
          </article>
        ))}
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
        <RustExecutionAdminDesk />
      </section>
    </main>
  );
}