import Link from "next/link";
import { redirect } from "next/navigation";

import { cpFetch } from "../../lib/controlPlane";

type MePayload = {
  username?: string;
  role?: string;
  password_must_change?: boolean;
};

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}) {
  const response = await cpFetch("/v1/auth/me");
  if (!response.ok) {
    return (
      <main className="shell">
        <section className="hero" style={{ gridTemplateColumns: "1fr" }}>
          <div className="panel" style={{ maxWidth: 560, margin: "0 auto" }}>
            <div className="eyebrow">TXT</div>
            <h1 className="title" style={{ fontSize: 34 }}>Session requise</h1>
            <p className="subtle">Connecte-toi avant de changer ton mot de passe.</p>
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
    <main className="shell">
      <section className="hero" style={{ gridTemplateColumns: "1fr" }}>
        <div className="panel" style={{ maxWidth: 620, margin: "0 auto" }}>
          <div className="eyebrow">Change Password</div>
          <h1 className="title" style={{ fontSize: 34 }}>Rotation obligatoire du mot de passe</h1>
          <p className="subtle">Compte: {String(me.username)} ({String(me.role)}). Choisis un nouveau mot de passe d’au moins 12 caracteres.</p>
          <div className="txt-auth-guide" aria-label="Guide rotation mot de passe">
            <strong>Guide rapide</strong>
            <p className="subtle">1) Saisis l'ancien mot de passe. 2) Definis un nouveau mot de passe fort (12+). 3) Reconnecte-toi et valide l'etat global sur Dashboard puis Terminal.</p>
          </div>
          {searchParams?.error ? <p className="warn">Le changement de mot de passe a echoue.</p> : null}
          <form action="/api/auth/change-password" method="post" className="form-grid" style={{ marginTop: 16 }}>
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
