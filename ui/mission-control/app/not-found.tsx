import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1fr" }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">TXT</div>
          <h1 className="title" style={{ fontSize: 34 }}>Page introuvable</h1>
          <p className="subtle">Cette route n'existe pas ou n'est plus disponible.</p>
          <p>
            <Link href="/">Retour au dashboard</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
