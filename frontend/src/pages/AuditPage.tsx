import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { AuditAction, AuditEvent } from '../api/types';
import { Alert, Spinner } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { usePageTitle } from '../nav/history';

export const ACTION_LABEL: Record<AuditAction, string> = {
  LOGIN: 'Connexion',
  PROFILE_UPDATE: 'Profil modifié',
  RULE_CREATE: 'Création',
  RULE_UPDATE: 'Modification',
  RULE_NEW_VERSION: 'Nouvelle version',
  RULE_TEST: 'Test',
  RULE_SUBMIT: 'Soumission',
  RULE_WITHDRAW: 'Soumission retirée',
  RULE_SEND_TO_PROVIDER: 'Envoi au prestataire',
  RULE_SUSPEND_SENDING: 'Envoi suspendu',
  RULE_DISCARD: 'Version écartée',
};

export function AuditTable({ events, showRule = true }: { events: AuditEvent[]; showRule?: boolean }) {
  if (events.length === 0) return <div className="empty">Aucun événement.</div>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Date</th>
            <th>Qui</th>
            <th>Action</th>
            {showRule && <th>Règle</th>}
            <th>Détail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="small nowrap">{fmtDateTime(e.at)}</td>
              <td className="small nowrap">
                {e.userName} <span className="mono muted">{e.matricule}</span>
              </td>
              <td className="small nowrap">{ACTION_LABEL[e.action]}</td>
              {showRule && (
                <td className="small">
                  {e.ruleId ? (
                    <>
                      <Link to={`/rules/${e.ruleId}`}>{e.ruleName}</Link>
                      {e.version != null && <span className="muted"> v{e.version}</span>}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              )}
              <td className="small">{e.details ?? (!showRule && e.version != null ? `v${e.version}` : '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditPage() {
  usePageTitle("Journal d'audit");
  const [matricule, setMatricule] = useState('');
  const [action, setAction] = useState<AuditAction | ''>('');
  const users = useAsync(() => api.listUsers(), []);
  const events = useAsync(() => api.listAudit({ matricule: matricule || undefined }), [matricule]);
  const shown = (events.data ?? []).filter((e) => !action || e.action === action);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Journal d'audit</h1>
          <p>Qui a créé, modifié, testé ou soumis quoi, et quand. Immuable, conservé 24 mois.</p>
        </div>
      </div>
      <div className="stack">
        <Alert kind="info">
          Journal <strong>déclaratif</strong> : il trace un matricule saisi, pas une identité vérifiée. Utile pour reconstituer une
          chronologie, il ne constitue pas une preuve opposable.
        </Alert>
        <div className="card">
          <div className="card-pad row" style={{ borderBottom: '1px solid var(--border)' }}>
            <label htmlFor="au-user" className="small muted">
              Utilisateur
            </label>
            <select id="au-user" value={matricule} onChange={(e) => setMatricule(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Tous</option>
              {users.data?.map((u) => (
                <option key={u.matricule} value={u.matricule}>
                  {u.firstName} {u.lastName} ({u.matricule})
                </option>
              ))}
            </select>
            <label htmlFor="au-action" className="small muted">
              Action
            </label>
            <select id="au-action" value={action} onChange={(e) => setAction(e.target.value as AuditAction | '')} style={{ width: 'auto' }}>
              <option value="">Toutes</option>
              {Object.entries(ACTION_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <span className="spacer" />
            <span className="small muted">{shown.length} événement{shown.length > 1 ? 's' : ''}</span>
          </div>
          {events.error && <Alert kind="error" title={events.error.message} />}
          {!events.data ? <div className="card-pad"><Spinner /></div> : <AuditTable events={shown} />}
        </div>
      </div>
    </>
  );
}
