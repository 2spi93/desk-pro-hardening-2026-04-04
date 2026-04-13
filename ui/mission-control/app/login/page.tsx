import OperatorPanelGuide from "../../components/ui/OperatorPanelGuide";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; next?: string }>;
}) {
  const resolvedSearchParams = await searchParams;

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1fr" }}>
        <div className="panel txt-page-hero" style={{ maxWidth: 540, margin: "0 auto" }}>
          <div className="eyebrow">TXT</div>
          <h1 className="title" style={{ fontSize: 34 }}>Connexion securisee</h1>
          <p className="subtle">Authentification RBAC pour acceder au cockpit.</p>
          <OperatorPanelGuide
            title="Guide Connexion"
            what="L'acces RBAC ouvre le cockpit operateur et conditionne les ecrans live sensibles."
            why="Eviter les actions live hors role, hors session ou avec un secret invalide."
            example="Connecte-toi, verifie ensuite le mode dans Terminal et traite la rotation mot de passe avant toute action live."
          />
          {resolvedSearchParams?.error ? <p className="warn">Identifiants invalides ou redirection echouee.</p> : null}
          <div className="txt-page-guide-note">
            <strong>Note operateur</strong>
            Si Chrome refuse la connexion, vide les cookies du domaine TXT, desserre temporairement le blocage strict des cookies tiers pour le site, puis recharge /login. Edge peut reutiliser une ancienne session valide.
          </div>
          <form action="/api/auth/login" method="post" className="form-grid" style={{ marginTop: 16 }}>
            <input type="hidden" name="next" value={resolvedSearchParams?.next || ""} />
            <label className="subtle" htmlFor="username">Username</label>
            <input id="username" name="username" placeholder="admin" autoComplete="username" required />
            <label className="subtle" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required />
            <button type="submit">Se connecter</button>
          </form>
        </div>
      </section>
    </main>
  );
}
