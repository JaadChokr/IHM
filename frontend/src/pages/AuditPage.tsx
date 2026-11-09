import { Pager, usePaged } from '../components/Pager';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { AuditAction, AuditEvent } from '../api/types';
import { Alert, InfoTip, Spinner } from '../components/ui';
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
  RULE_SUBMIT: 'Publication',
  RULE_WITHDRAW: 'Publication retirée',
  RULE_SEND_TO_PROVIDER: 'Envoi au prestataire',
  RULE_SUSPEND_SENDING: 'Envoi suspendu',
  RULE_DISCARD: 'Version écartée',
};

export function AuditTable({ events, showRule = true }: { events: AuditEvent[]; showRule?: boolean }) {
  const { rows, pager } = usePaged(events, showRule ? 'audit' : 'ruleAudit');
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
          {rows.map((e) => (
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
      <Pager {...pager} />
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
          <p>
            Qui a créé, modifié, testé ou publié quoi, et quand. Immuable, conservé 24 mois.
            <InfoTip>
              Le journal trace le matricule saisi à la connexion, qui n'est pas vérifié : il sert à reconstituer une chronologie, pas de preuve.
            </InfoTip>
          </p>
        </div>
      </div>
      <div className="stack">
        <div className="card">
          <div className="card-pad row divider-bottom">
            <label htmlFor="au-user" className="small muted">
              Utilisateur
            </label>
            <select id="au-user" value={matricule} onChange={(e) => setMatricule(e.target.value)} className="w-auto">
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
            <select id="au-action" value={action} onChange={(e) => setAction(e.target.value as AuditAction | '')} className="w-auto">
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
