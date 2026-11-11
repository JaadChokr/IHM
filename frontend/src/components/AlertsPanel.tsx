import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Alert, AlertFilters, AlertPage, AlertPhase, AlertVerdict, RuleSummary } from '../api/types';
import { addDays, fmtDateTime, fmtInt, isoDate } from '../lib/format';
import { usePref } from '../prefs/prefs';
import { Pager } from './Pager';
import { Alert as Notice, Card, InfoTip, Spinner } from './ui';

export const VERDICT_LABEL: Record<AlertVerdict, string> = {
  FRAUD: 'Fraude',
  NOT_FRAUD: 'Pas une fraude',
  TO_REVIEW: 'À qualifier',
  PENDING: 'En attente',
};
const PHASE_LABEL: Record<AlertPhase, string> = { TEST: 'En test', PRODUCTION: 'En production' };
const PERIODS = [7, 30, 90] as const;

/** Autres colonnes renvoyées par la règle, en une ligne lisible : « montant_eur : 1 240 · pays : NG ». */
function detailsText(d: Alert['details']): string {
  if (!d) return '';
  return Object.entries(d)
    .map(([k, v]) => `${k} : ${typeof v === 'number' ? fmtInt(v) : String(v)}`)
    .join(' · ');
}

/** Qui a donné le verdict : le prestataire, ou l'analyste qui a qualifié la commande. */
function verdictSource(a: Alert): string | undefined {
  if (a.providerIsFraud !== null && a.providerIsFraud !== undefined) return 'selon le prestataire';
  if (a.review) return `${a.review.byName}, ${fmtDateTime(a.review.at)}`;
  return undefined;
}

interface Props {
  /** Alertes d'une seule règle (onglet de la fiche) ; sans : toutes les règles, avec un filtre par règle. */
  ruleId?: string;
}

/**
 * Alertes remontées par les règles : une ligne par commande et par version. Les commandes d'une version EN
 * TEST (non transmises au prestataire) se qualifient ici : fraude ou pas. La qualification porte sur la
 * commande (toutes règles confondues) et entre dans les chiffres de la règle en test. Les commandes
 * transmises sont vérifiées par le prestataire.
 */
export function AlertsPanel({ ruleId }: Props) {
  const [days, setDays] = usePref<(typeof PERIODS)[number]>('alertsDays', 7);
  const [phase, setPhase] = useState<AlertPhase | ''>('');
  const [verdict, setVerdict] = useState<AlertVerdict | ''>('');
  const [rule, setRule] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [size, setSize] = usePref<number>('pageSize.alerts', 25);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<AlertPage>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [rules, setRules] = useState<RuleSummary[]>([]);

  useEffect(() => {
    if (!ruleId) api.listRules({ q: '', status: '', typology: '', owner: '', criticality: '', sort: 'updated_desc' }).then(setRules, () => undefined);
  }, [ruleId]);

  // Recherche par numéro de commande : appliquée après une courte pause de saisie.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filters: AlertFilters = {
    from: addDays(isoDate(new Date()), -(days - 1)),
    ruleId: ruleId ?? (rule || undefined),
    phase: phase || undefined,
    verdict: verdict || undefined,
    q: query || undefined,
    limit: size,
    offset: page * size,
  };
  const key = JSON.stringify(filters);
  useEffect(() => setPage(0), [days, phase, verdict, rule, query, size]);
  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    api.listAlerts(filters).then(
      (d) => !cancelled && setData(d),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function review(a: Alert, isFraud: boolean) {
    // Un second clic sur le même choix retire la qualification.
    const next = a.review?.isFraud === isFraud ? null : isFraud;
    setBusy(a.orderId + a.ruleId + a.ruleVersion);
    setError(undefined);
    try {
      await api.reviewAlert({ orderId: a.orderId, ruleId: a.ruleId, ruleVersion: a.ruleVersion, isFraud: next });
      setData(await api.listAlerts(filters));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / size)) : 1;
  return (
    <Card
      title="Alertes remontées"
      subtitle={
        data ? (
          <>
            {fmtInt(data.total)} alerte{data.total > 1 ? 's' : ''} sur {days} jours
            {data.toReview > 0 && (
              <>
                {' · '}
                <button type="button" className="linkish" onClick={() => setVerdict('TO_REVIEW')}>
                  {fmtInt(data.toReview)} à qualifier
                </button>
              </>
            )}
          </>
        ) : (
          '…'
        )
      }
      info="Une ligne par commande remontée et par version de règle. Les commandes d'une version en test ne sont pas transmises au prestataire : qualifiez-les vous-même (fraude ou pas) ; votre qualification vaut pour la commande, toutes règles confondues, et entre dans la précision de la règle en test. Les commandes d'une version en production sont vérifiées par le prestataire."
      actions={
        <div className="seg" role="group" aria-label="Période">
          {PERIODS.map((p) => (
            <button key={p} type="button" aria-pressed={days === p} onClick={() => setDays(p)}>
              {p} jours
            </button>
          ))}
        </div>
      }
    >
      <div className="card-pad row gap-3 divider-bottom alerts-filters">
        <div className="field grow-field">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Numéro de commande…" aria-label="Rechercher une commande" />
        </div>
        {!ruleId && (
          <select className="select-sm" value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Règle">
            <option value="">Toutes les règles</option>
            {rules.map((r) => (
              <option key={r.ruleId} value={r.ruleId}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        <select className="select-sm" value={phase} onChange={(e) => setPhase(e.target.value as AlertPhase | '')} aria-label="Phase">
          <option value="">En test et en production</option>
          <option value="TEST">En test</option>
          <option value="PRODUCTION">En production</option>
        </select>
        <select className="select-sm" value={verdict} onChange={(e) => setVerdict(e.target.value as AlertVerdict | '')} aria-label="Verdict">
          <option value="">Tous les verdicts</option>
          {(Object.keys(VERDICT_LABEL) as AlertVerdict[]).map((v) => (
            <option key={v} value={v}>
              {VERDICT_LABEL[v]}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <div className="card-pad">
          <Notice kind="error" title={error} />
        </div>
      )}
      {!data ? (
        <div className="card-pad">
          <Spinner />
        </div>
      ) : data.items.length === 0 ? (
        <div className="empty">Aucune alerte avec ces critères.</div>
      ) : (
        <div className="table-wrap">
          <table className="data alerts-table">
            <thead>
              <tr>
                <th>Détectée le</th>
                <th>Commande</th>
                <th>{ruleId ? 'Version' : 'Règle'}</th>
                <th>Détails</th>
                <th>Verdict</th>
                <th>
                  Qualification
                  <InfoTip align="end">Commandes en test : fraude ou pas. Un second clic sur le même choix retire la qualification.</InfoTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => {
                const id = a.orderId + a.ruleId + a.ruleVersion;
                const qualifiable = a.phase === 'TEST' && (a.providerIsFraud === null || a.providerIsFraud === undefined);
                const source = verdictSource(a);
                return (
                  <tr key={id}>
                    <td className="small nowrap">{fmtDateTime(a.detectedAt)}</td>
                    <td className="mono small nowrap">{a.orderId}</td>
                    <td className={ruleId ? 'nowrap' : 'alert-rule'}>
                      {ruleId ? (
                        <span className="small">v{a.ruleVersion}</span>
                      ) : (
                        <>
                          <Link to={`/rules/${a.ruleId}`} className="rule-link">
                            {a.ruleName}
                          </Link>{' '}
                          <span className="small muted">v{a.ruleVersion}</span>
                        </>
                      )}
                      <div>
                        <span className={`badge ${a.phase === 'TEST' ? 'st-OBSERVATION' : 'st-IN_PRODUCTION'}`}>
                          <span className="badge-dot" aria-hidden="true" />
                          {PHASE_LABEL[a.phase]}
                        </span>
                      </div>
                    </td>
                    <td className="small muted alert-details">
                      <div className="ellipsis" title={detailsText(a.details)}>
                        {detailsText(a.details) || '—'}
                      </div>
                    </td>
                    <td>
                      <span className={`badge verdict verdict-${a.verdict}`}>{VERDICT_LABEL[a.verdict]}</span>
                      {source && <div className="small muted">{source}</div>}
                    </td>
                    <td>
                      {qualifiable ? (
                        <div className="seg verdict-seg" role="group" aria-label={`Qualifier la commande ${a.orderId}`}>
                          <button type="button" aria-pressed={a.review?.isFraud === true} disabled={busy === id} onClick={() => review(a, true)}>
                            Fraude
                          </button>
                          <button type="button" aria-pressed={a.review?.isFraud === false} disabled={busy === id} onClick={() => review(a, false)}>
                            Pas fraude
                          </button>
                        </div>
                      ) : (
                        <span className="small muted nowrap">{a.phase === 'PRODUCTION' ? 'Par le prestataire' : 'Déjà vérifiée par le prestataire'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pager page={page} pages={pages} size={size} total={data.total} onPage={setPage} onSize={setSize} />
        </div>
      )}
    </Card>
  );
}
