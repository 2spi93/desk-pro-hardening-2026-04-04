import Link from "next/link";
import { redirect } from "next/navigation";

import OperatorPanelGuide from "../../components/ui/OperatorPanelGuide";
import { cpFetch } from "../../lib/controlPlane";

type MePayload = {
  username?: string;
  role?: string;
  password_must_change?: boolean;
};

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams?: { error?: string; next?: string };
}) {
  const response = await cpFetch("/v1/auth/me");
  if (!response.ok) {
    return (
      <main className="shell txt-page-shell">
        <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1fr" }}>
          <div className="panel txt-page-hero" style={{ maxWidth: 560, margin: "0 auto" }}>
            <div className="eyebrow">TXT</div>
            <h1 className="title" style={{ fontSize: 34 }}>Session requise</h1>
            <p className="subtle">Connecte-toi avant de changer ton mot de passe.</p>
            <OperatorPanelGuide
              title="Guide Acces"
              what="Le changement de mot de passe reste reserve a une session operateur valide."
              why="Eviter une rotation hors contexte ou une action anonyme sur un compte sensible."
              example="Si la session n'est plus valide, reconnecte-toi puis reviens ici depuis le cockpit."
              compact
            />
            <div className="txt-page-guide-note">
              <strong>Note operateur</strong>
              Reviens d'abord sur le login, restaure une session propre, puis valide ensuite l'etat global sur Dashboard et Terminal.
            </div>
            <p><Link href="/login">Aller au login</Link></p>
          </div>
        </section>
      </main>
    );
  }

  const me = (await response.json()) as MePayload;
  if (!me.password_must_change) {
    redirect("/");
  }

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1fr" }}>
        <div className="panel txt-page-hero" style={{ maxWidth: 620, margin: "0 auto" }}>
          <div className="eyebrow">Change Password</div>
          <h1 className="title" style={{ fontSize: 34 }}>Rotation obligatoire du mot de passe</h1>
          <p className="subtle">Compte: {String(me.username)} ({String(me.role)}). Choisis un nouveau mot de passe d’au moins 12 caracteres.</p>
          <OperatorPanelGuide
            title="Guide Rotation"
            what="La rotation remplace le secret courant et force un retour a une session propre."
            why="Couper les credentials faibles ou exposes avant toute exploitation live."
            example="Saisis l'ancien mot de passe, definis un secret 12+ caracteres, reconnecte-toi puis relis Dashboard et Terminal."
          />
          <div className="txt-page-guide-note">
            <strong>Note operateur</strong>
            Ne valide pas la rotation si tu n'es pas pret a rouvrir une session et a recontroler le mode systeme juste apres.
          </div>
          {searchParams?.error ? <p className="warn">Le changement de mot de passe a echoue.</p> : null}
          <form action="/api/auth/change-password" method="post" className="form-grid" style={{ marginTop: 16 }}>
            <input type="hidden" name="next" value={searchParams?.next || ""} />
            <label className="subtle" htmlFor="old_password">Mot de passe actuel</label>
            <input id="old_password" name="old_password" type="password" required />
            <label className="subtle" htmlFor="new_password">Nouveau mot de passe</label>
            <input id="new_password" name="new_password" type="password" minLength={12} required />
            <label className="subtle" htmlFor="confirm_password">Confirmer le nouveau mot de passe</label>
            <input id="confirm_password" name="confirm_password" type="password" minLength={12} required />
            <button type="submit">Mettre a jour le mot de passe</button>
          </form>
        </div>
      </section>
    </main>
  );
}
