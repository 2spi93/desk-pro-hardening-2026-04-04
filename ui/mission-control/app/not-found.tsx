import Link from "next/link";

import OperatorPanelGuide from "../components/ui/OperatorPanelGuide";

export default function NotFound() {
  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1fr" }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">TXT</div>
          <h1 className="title" style={{ fontSize: 34 }}>Page introuvable</h1>
          <p className="subtle">Cette route n'existe pas ou n'est plus disponible.</p>
          <OperatorPanelGuide
            title="Guide Navigation"
            what="Le cockpit renvoie ici quand une route est absente, retiree ou inaccessible a ton contexte."
            why="Revenir vite vers une page valide sans perdre le fil operateur."
            example="Repars du dashboard ou de Live Ops, puis reviens vers la zone utile au lieu d'errer dans une route casse."
            compact
          />
          <div className="txt-page-guide-note">
            <strong>Note operateur</strong>
            Si ce lien devait exister, traite-le comme un incident UX ou routing, pas comme une invitation a contourner le cockpit.
          </div>
          <p>
            <Link href="/">Retour au dashboard</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
