import Link from "next/link";

const WORKSPACE_CARDS = [
  {
    href: "/terminal",
    title: "Terminal",
    summary: "Pour voir le marche, preparer une idee et agir vite.",
    when: "Ouvre cet ecran si tu veux suivre le prix, lire le flux et passer un ordre.",
  },
  {
    href: "/",
    title: "Dashboard",
    summary: "Pour avoir la vue d'ensemble avant de commencer.",
    when: "Ouvre-le le matin pour savoir si tout est sain et s'il y a des alertes ou des validations en attente.",
  },
  {
    href: "/connections",
    title: "Connections",
    summary: "Pour brancher vos comptes si vous etes cote client.",
    when: "Va ici si tu dois relier un broker, un exchange ou un wallet a TXT.",
  },
  {
    href: "/connectors",
    title: "Connecteurs",
    summary: "Pour verifier que les integrations repondent bien.",
    when: "Utilise cette page si une venue, un broker ou un bridge semble en panne ou en retard.",
  },
  {
    href: "/live-ops",
    title: "Live Ops",
    summary: "Pour savoir si le systeme peut continuer a tourner sans danger.",
    when: "Ouvre cette page si tu vois une degradation, un blocage ou un doute sur la sante globale.",
  },
  {
    href: "/live-readiness",
    title: "Readiness",
    summary: "Pour verifier si une strategie ou un environnement est pret.",
    when: "Passe ici avant d'augmenter le risque ou de remettre une strategie en route.",
  },
  {
    href: "/live-capital",
    title: "Live Capital",
    summary: "Pour comprendre d'ou vient l'argent et ce qui est vraiment disponible.",
    when: "Utilise cette page si tu dois verifier des fonds, allouer du capital ou distinguer paper et live.",
  },
  {
    href: "/fund-manager",
    title: "Fund Manager",
    summary: "Pour piloter le portefeuille dans son ensemble.",
    when: "Va ici si tu veux lire la performance, la repartition du risque et la logique d'allocation.",
  },
  {
    href: "/ai",
    title: "IA",
    summary: "Pour voir ce que fait la partie intelligence et ses routes.",
    when: "Ouvre cette page si tu veux comprendre pourquoi l'IA propose, bloque ou reroute une action.",
  },
  {
    href: "/incidents",
    title: "Incidents",
    summary: "Pour traiter proprement un probleme sans le perdre.",
    when: "Utilise cette page si un souci doit etre assigne, suivi puis cloture avec une note claire.",
  },
  {
    href: "/advanced",
    title: "Advanced",
    summary: "Pour les analyses plus poussees et les vues de debug.",
    when: "Ouvre cette zone seulement si tu es en phase de test, d'analyse ou de recherche plus fine.",
  },
];

const QUICK_START = [
  "1. Commence par Dashboard pour voir si la machine est saine.",
  "2. Passe au Terminal pour lire le marche et agir.",
  "3. Si quelque chose cloche, ouvre Live Ops, Readiness ou Incidents selon le type de probleme.",
];

export default function TxtWorkspaceHelper() {
  return (
    <section className="panel txt-workspace-helper">
      <div className="eyebrow">Helper TXT</div>
      <h2 className="title" style={{ fontSize: 28, marginBottom: 8 }}>Quel ecran ouvrir ?</h2>
      <p className="subtle" style={{ marginTop: 0 }}>
        Ce guide explique simplement a quoi sert chaque grande page de TXT et quand l'utiliser, sans langage complique.
      </p>
      <div className="txt-workspace-helper-steps">
        {QUICK_START.map((step) => (
          <div key={step} className="txt-workspace-helper-step">{step}</div>
        ))}
      </div>
      <div className="txt-workspace-helper-grid">
        {WORKSPACE_CARDS.map((card) => (
          <article key={card.href} className="txt-workspace-helper-card">
            <div className="txt-workspace-helper-card-head">
              <h3>{card.title}</h3>
              <Link href={card.href}>Ouvrir</Link>
            </div>
            <p>{card.summary}</p>
            <p className="subtle">{card.when}</p>
          </article>
        ))}
      </div>
    </section>
  );
}