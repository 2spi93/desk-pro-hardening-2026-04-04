import Link from "next/link";

import TxtMiniGuide from "../../components/ui/TxtMiniGuide";

const TOPICS = [
  "Comprendre les bougies",
  "Comprendre le DOM",
  "Comprendre le footprint",
  "Comprendre le volume profile",
  "Comprendre les ordres",
  "Comprendre le risque",
  "Comprendre les marches",
];

export default function LearnPage() {
  return (
    <main className="shell txt-page-shell">
      <section className="panel txt-page-hero">
        <div className="eyebrow">TXT Learn</div>
        <h1 className="title" style={{ fontSize: 34 }}>Apprendre le trading de facon claire</h1>
        <p className="subtle">Parcours pedagogique concu pour les debutants avec exemples, schemas et vocabulaire simple.</p>
        <TxtMiniGuide
          title="Guide Learn"
          what="Des modules pedagogiques progressifs pour comprendre le trading sans pre-requis institutionnel."
          why="Permettre a un debutant d'etre autonome et de lire le terminal rapidement."
          example="Commence par bougies + ordres, puis enchaine DOM et footprint avec exemples concrets."
          terms={["dom", "footprint", "vwap"]}
        />
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        {TOPICS.map((topic) => (
          <article className="panel txt-topic-card" key={topic}>
            <div className="eyebrow">Guide</div>
            <h2 style={{ margin: "8px 0", fontSize: 20 }}>{topic}</h2>
            <p className="subtle">Version novice avec definitions simples, exemples pratiques et erreurs frequentes.</p>
            <button type="button" disabled>Disponible bientot</button>
          </article>
        ))}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="row">
          <span>Besoin de pratique live ?</span>
          <Link href="/terminal">Ouvrir le terminal TXT</Link>
        </div>
      </section>
    </main>
  );
}