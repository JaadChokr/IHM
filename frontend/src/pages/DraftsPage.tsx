import { Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { Alert, CriticalityBadge, Spinner } from '../components/ui';
import { draftKind, readyToSubmit } from '../lib/drafts';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { usePageTitle } from '../nav/history';

/** Brouillons personnels : le travail en cours de l'utilisateur, visible de lui seul. */
export function DraftsPage() {
  usePageTitle('Mes brouillons');
  const loc = useLocation();
  const flash = (loc.state as { flash?: string } | null)?.flash;
  const drafts = useAsync(() => api.listDrafts(), []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mes brouillons</h1>
          <p>Votre travail en cours, visible de vous seul. Une règle n'apparaît dans le référentiel qu'une fois publiée.</p>
        </div>
      </div>

      <div className="stack">
        {flash === 'draftDeleted' && <Alert kind="success" title="Brouillon supprimé." />}
        {drafts.error && <Alert kind="error" title={drafts.error.message} />}
        <div className="card">
          {!drafts.data ? (
            <div className="card-pad">
              <Spinner />
            </div>
          ) : drafts.data.length === 0 ? (
            <div className="empty">
              Aucun brouillon en cours. <Link to="/rules/new">Créer une règle</Link> ou partir d'une règle existante (« Créer une nouvelle version »).
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Brouillon</th>
                    <th>Nature</th>
                    <th>Criticité</th>
                    <th>Enregistré le</th>
                    <th>Test</th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.data.map((d) => (
                    <tr key={d.id}>
                      <td className="cell-wide">
                        <Link to={`/drafts/${d.id}`} className="rule-link">
                          {d.name}
                        </Link>
                        <div className="small muted ellipsis">
                          {d.description}
                        </div>
                      </td>
                      <td className="small">
                        {d.newRule ? (
                          draftKind(d)
                        ) : (
                          <>
                            {draftKind(d)}
                            {d.latestVersion !== d.baseVersion && (
                              <div className="text-warn">⚠ v{d.latestVersion} publiée depuis</div>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        <CriticalityBadge value={d.criticality} />
                      </td>
                      <td className="small">{fmtDateTime(d.updatedAt)}</td>
                      <td className="small nowrap">
                        {readyToSubmit(d) ? (
                          <span className="text-good">✓ Prêt à publier</span>
                        ) : !d.lastTest ? (
                          <span className="muted">Jamais testé</span>
                        ) : !d.lastTest.success ? (
                          <span className="text-bad">✕ Dernier test de la requête en échec</span>
                        ) : (
                          <span className="muted">Test à refaire</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
