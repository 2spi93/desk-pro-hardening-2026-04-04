export default function GlobalLoading() {
  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1fr" }}>
        <div className="panel txt-page-hero" style={{ minHeight: 220 }}>
          <div className="eyebrow">TXT</div>
          <h1 className="title" style={{ fontSize: 30 }}>Chargement du cockpit</h1>
          <p className="subtle">La route se prepare. En sortie du terminal, tu as maintenant un retour visuel immediat pendant que la page suivante se charge.</p>
          <div className="txt-page-guide-note">
            <strong>Note operateur</strong>
            Si ce chargement devient frequent ou anormalement long, la cause vient en general du poids UI du terminal ou d'une page qui attend trop de fetchs au premier rendu.
          </div>
        </div>
      </section>
    </main>
  );
}