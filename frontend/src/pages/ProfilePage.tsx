import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/ui';
import { useTheme, type ThemePref } from '../prefs/prefs';
import { usePageTitle } from '../nav/history';

export function ProfilePage() {
  usePageTitle('Profil');
  const { user, refresh, logout } = useAuth();
  const nav = useNavigate();
  const [theme, setTheme] = useTheme();
  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.updateProfile(firstName, lastName);
      await refresh();
      setMsg({ kind: 'success', text: 'Profil mis à jour.' });
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  }

  function clearPrefs() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('rm.pref.'))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* rien à effacer */
    }
    setTheme('system');
    setMsg({ kind: 'success', text: 'Préférences locales effacées.' });
  }

  if (!user) return null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Profil et préférences</h1>
          <p>
            Matricule <span className="mono">{user.matricule}</span>
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            await logout();
            nav('/login');
          }}
        >
          Se déconnecter
        </button>
      </div>
      <div className="grid-2">
        <form className="card" onSubmit={save}>
          <div className="card-head">
            <div>
              <h2>Identité</h2>
              <p>Stockée côté serveur ; affichée comme propriétaire de vos règles et dans l'audit.</p>
            </div>
          </div>
          <div className="card-pad stack">
            <div className="field">
              <label htmlFor="p-first">Prénom</label>
              <input id="p-first" type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="p-last">Nom</label>
              <input id="p-last" type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
            {msg && <Alert kind={msg.kind} title={msg.text} />}
            <div>
              <button type="submit" className="btn btn-primary">
                Enregistrer
              </button>
            </div>
          </div>
        </form>
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Préférences d'affichage</h2>
              <p>Stockées dans ce navigateur uniquement (thème, filtres, onglet actif, brouillons non enregistrés).</p>
            </div>
          </div>
          <div className="card-pad stack">
            <fieldset className="field fieldset-reset">
              <legend className="label">Thème</legend>
              <div className="seg mt-1">
                {(
                  [
                    ['system', 'Système'],
                    ['light', 'Clair'],
                    ['dark', 'Sombre'],
                  ] as [ThemePref, string][]
                ).map(([v, l]) => (
                  <button key={v} type="button" aria-pressed={theme === v} onClick={() => setTheme(v)}>
                    {l}
                  </button>
                ))}
              </div>
            </fieldset>
            <div>
              <button type="button" className="btn btn-sm" onClick={clearPrefs}>
                Effacer les préférences locales
              </button>
            </div>
            {api.demo && (
              <div className="demo-panel stack gap-2">
                <span className="small">
                  <strong>Mode démo</strong> — réinitialiser les données simulées.
                </span>
                <div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      await api.demo!.reset();
                      setMsg({ kind: 'success', text: 'Données de démo réinitialisées.' });
                    }}
                  >
                    Réinitialiser la démo
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
