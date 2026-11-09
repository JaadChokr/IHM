import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/ui';

export const MATRICULE_RE = /^\d{6}$/;

export function LoginPage() {
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [matricule, setMatricule] = useState('');
  const [step, setStep] = useState<'code' | 'profile'>('code');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const from = (loc.state as { from?: string } | null)?.from ?? '/';
  if (user && step === 'code') return <Navigate to={from} replace />;

  const formatError = touched && !MATRICULE_RE.test(matricule) ? 'Le matricule doit comporter exactement 6 chiffres.' : undefined;

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!MATRICULE_RE.test(matricule)) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.login(matricule);
      if (r.needsProfile) setStep('profile');
      else {
        await refresh();
        nav(from, { replace: true });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitProfile(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.completeProfile(firstName, lastName);
      await refresh();
      nav(from, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <aside className="login-aside">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          Fraud Rules
        </div>
        <div className="login-pitch">
          <p className="login-title">Les règles de détection de fraude, de l'idée à la production.</p>
          <ul>
            <li>Écrivez la règle en SQL et testez-la sur les vraies données.</li>
            <li>Observez ce qu'elle remonte avant de l'envoyer au prestataire.</li>
            <li>Suivez sa précision et ses exécutions, version par version.</li>
          </ul>
        </div>
      </aside>
      <div className="login-main">
      <div className="card login-card stack">
        <div className="row gap-3">
          <span className="brand-mark login-card-mark" aria-hidden="true">F</span>
          <h1>Connexion</h1>
        </div>
        {step === 'code' ? (
          <form className="stack" onSubmit={submitCode} noValidate>
            <p className="muted m-0">
              Plateforme de gestion des règles de détection de fraude.
            </p>
            <div className="field">
              <label htmlFor="matricule">Matricule</label>
              <input
                id="matricule"
                type="text"
                inputMode="numeric"
                autoComplete="username"
                maxLength={6}
                className="code-input"
                placeholder="000000"
                value={matricule}
                aria-invalid={!!formatError}
                aria-describedby="matricule-help"
                onChange={(e) => setMatricule(e.target.value.replace(/\s/g, ''))}
                onBlur={() => matricule && setTouched(true)}
                autoFocus
              />
              <span id="matricule-help" className={formatError ? 'error-text' : 'hint'}>
                {formatError ?? 'Votre code à 6 chiffres.'}
              </span>
            </div>
            {error && <Alert kind="error" title={error} />}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              Continuer
            </button>
            <p className="small muted m-0">
              Le matricule sert à attribuer vos actions dans le journal d'audit ; il n'est pas vérifié. L'accès à la plateforme est
              restreint au réseau interne. Session de 8 h, prolongée à chaque action.
            </p>
          </form>
        ) : (
          <form className="stack" onSubmit={submitProfile}>
            <Alert kind="info" title="Première connexion">
              Le matricule <span className="mono">{matricule}</span> est inconnu. Indiquez vos nom et prénom : ils apparaîtront comme
              propriétaire de vos règles et dans le journal d'audit.
            </Alert>
            <div className="field">
              <label htmlFor="firstName">
                Prénom<span className="req" aria-hidden="true">*</span>
              </label>
              <input id="firstName" type="text" autoComplete="given-name" required value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label htmlFor="lastName">
                Nom<span className="req" aria-hidden="true">*</span>
              </label>
              <input id="lastName" type="text" autoComplete="family-name" required value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
            {error && <Alert kind="error" title={error} />}
            <div className="row">
              <button type="button" className="btn" onClick={() => setStep('code')}>
                Retour
              </button>
              <span className="spacer" />
              <button className="btn btn-primary" type="submit" disabled={busy || !firstName.trim() || !lastName.trim()}>
                Accéder à la plateforme
              </button>
            </div>
          </form>
        )}
      </div>
      </div>
    </div>
  );
}
