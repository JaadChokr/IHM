import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Alert, AlertFilters, AlertPage, AlertPhase, AlertVerdict, ReviewVerdict } from '../api/types';
import { addDays, fmtDateTime, fmtInt, isoDate } from '../lib/format';
import { usePref } from '../prefs/prefs';
import { Pager } from './Pager';
import { Alert as Notice, Card, InfoTip, Spinner } from './ui';

export const VERDICT_LABEL: Record<AlertVerdict, string> = {
  FRAUD: 'Fraude avérée',
  RISKY: 'Commande risquée',
  NOT_FRAUD: 'RAS',
  TO_REVIEW: 'À vérifier',
  PENDING: 'En attente de vérification',
};
/** Les trois qualifications possibles d'une commande en test, dans l'ordre de la liste. */
const REVIEW_CHOICES: ReviewVerdict[] = ['FRAUD', 'RISKY', 'NOT_FRAUD'];
/** Verdicts possibles selon la phase : en test, ceux des analystes ; en production, ceux du prestataire. */
const PHASE_VERDICTS: Record<AlertPhase | '', AlertVerdict[]> = {
  '': ['TO_REVIEW', 'PENDING', 'FRAUD', 'RISKY', 'NOT_FRAUD'],
  TEST: ['TO_REVIEW', 'FRAUD', 'RISKY', 'NOT_FRAUD'],
  PRODUCTION: ['PENDING', 'FRAUD', 'NOT_FRAUD'],
};
/** Sans phase choisie : toutes les règles, en test et en production. */
const ALL_HINT = 'en test, le verdict est donné par les analystes ; en production, par le prestataire.';
const PHASES: { phase: AlertPhase; label: string; ofRule: string; hint: string }[] = [
  { phase: 'TEST', label: 'Règles en test', ofRule: 'En test', hint: 'commandes non transmises au prestataire, dont le verdict est donné par les analystes.' },
  { phase: 'PRODUCTION', label: 'Règles en production', ofRule: 'En production', hint: 'commandes transmises au prestataire, qui rend le verdict.' },
];
const PERIODS = [7, 30, 90] as const;

/** Autres colonnes renvoyées par la règle, en une ligne lisible : « montant_eur : 1 240 · pays : NG ». */
function detailsText(d: Alert['details']): string {
  if (!d) return '';
  return Object.entries(d)
    .map(([k, v]) => `${k} : ${typeof v === 'number' ? fmtInt(v) : String(v)}`)
    .join(' · ');
}

/** Nombre d'alertes d'une phase (d'une seule règle si `ruleId`), ou d'un verdict, dans une page (0 si absent). */
const phaseCountIn = (d: AlertPage | undefined, p: AlertPhase, ruleId?: string) =>
  (d?.rules ?? []).filter((c) => c.phase === p && (!ruleId || c.ruleId === ruleId)).reduce((t, c) => t + c.count, 0);
const verdictCountIn = (d: AlertPage | undefined, v: AlertVerdict) => d?.verdicts.find((c) => c.verdict === v)?.count ?? 0;

interface Props {
  /** Alertes d'une seule règle (onglet de la fiche) ; sans : toutes les règles, avec un filtre par règle. */
  ruleId?: string;
}

/**
 * Alertes remontées par les règles : une ligne par commande et par version. Un seul menu choisit la phase et
 * la règle : toutes les règles (par défaut), puis les règles en test, puis les règles en production, chacune
 * avec son nombre d'alertes.
 * - en test, les commandes ne sont pas transmises au prestataire ; les analystes donnent leur verdict (fraude
 *   avérée, commande risquée ou RAS). Il porte sur la commande, toutes règles confondues, et entre dans la
 *   pertinence de la règle ;
 * - en production, le prestataire rend le verdict.
 * Les menus ne proposent que des choix qui renvoient des alertes (nombres renvoyés par l'API).
 */
export function AlertsPanel({ ruleId }: Props) {
  const [days, setDays] = usePref<(typeof PERIODS)[number]>('alertsDays', 7);
  // '' : toutes les phases.
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

  // Un choix qui ne renvoie plus rien (autre période, autre phase) est retiré plutôt que d'afficher une liste vide.
  useEffect(() => {
    if (!data) return;
    if (rule && !data.rules.some((c) => c.ruleId === rule && c.phase === phase)) return setRule('');
    if (verdict && !data.verdicts.some((c) => c.verdict === verdict)) setVerdict('');
    // Seulement à l'arrivée de nouveaux résultats : ceux affichés pendant un rechargement correspondent encore aux
    // anciens filtres et retireraient à tort un choix qui vient d'être fait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  /** Qualifie la commande ; `null` (« À vérifier ») retire la qualification. */
  async function review(a: Alert, next: ReviewVerdict | null) {
    if ((a.review?.verdict ?? null) === next) return;
    setBusy(a.orderId + a.ruleId + a.ruleVersion);
    setError(undefined);
    try {
      await api.reviewAlert({ orderId: a.orderId, ruleId: a.ruleId, ruleVersion: a.ruleVersion, verdict: next });
      setData(await api.listAlerts(filters));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  /** Choix du menu « phase et règle » : « » (toutes), « TEST » (toutes les règles en test) ou « TEST:<ruleId> ». */
  function chooseScope(value: string) {
    const [p, r = ''] = value.split(':') as [AlertPhase | '', string?];
    if (p !== phase) setVerdict('');
    setPhase(p);
    setRule(r);
  }

  const phaseCount = (p: AlertPhase) => phaseCountIn(data, p, ruleId);
  const verdictCount = (v: AlertVerdict) => verdictCountIn(data, v);
  const all = phaseCount('TEST') + phaseCount('PRODUCTION');
  const inPhase = data ? (phase ? phaseCount(phase) : phaseCount('TEST') + phaseCount('PRODUCTION')) : 0;
  const current = PHASES.find((p) => p.phase === phase);
  const pages = data ? Math.max(1, Math.ceil(data.total / size)) : 1;

  return (
    <Card
      title="Alertes remontées"
      subtitle={
        data ? (
          <>
            {fmtInt(all)} alerte{all > 1 ? 's' : ''} sur {days} jours
            {data.toReview > 0 && (
              <>
                {' · '}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    setPhase('TEST');
                    setVerdict('TO_REVIEW');
                  }}
                >
                  {fmtInt(data.toReview)} à vérifier
                </button>
              </>
            )}
          </>
        ) : (
          '…'
        )
      }
      info="Une ligne par commande remontée et par version de règle. Le premier menu choisit les règles en test ou en production, toutes ou une seule. En test, les commandes ne sont pas transmises au prestataire : donnez votre verdict (fraude avérée, commande risquée ou RAS). Il vaut pour la commande, toutes règles confondues, et entre dans la pertinence de la règle. En production, le prestataire rend le verdict."
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
      <div className="card-pad stack gap-3 divider-bottom">
        <div className="row gap-3 alerts-filters">
          {ruleId ? (
            <select className="select-sm" value={phase} onChange={(e) => chooseScope(e.target.value)} aria-label="Phase">
              <option value="">
                En test et en production
                {data ? ` (${fmtInt(phaseCount('TEST') + phaseCount('PRODUCTION'))})` : ''}
              </option>
              {PHASES.map((p) => (
                <option key={p.phase} value={p.phase} disabled={!!data && phaseCount(p.phase) === 0 && phase !== p.phase}>
                  {p.ofRule}
                  {data ? ` (${fmtInt(phaseCount(p.phase))})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <select className="select-sm" value={rule ? `${phase}:${rule}` : phase} onChange={(e) => chooseScope(e.target.value)} aria-label="Phase et règle">
              <option value="">
                Toutes les règles
                {data ? ` (${fmtInt(phaseCount('TEST') + phaseCount('PRODUCTION'))})` : ''}
              </option>
              {PHASES.map((p) => (
                <optgroup key={p.phase} label={p.label}>
                  <option value={p.phase} disabled={!!data && phaseCount(p.phase) === 0 && !(phase === p.phase && !rule)}>
                    Toutes les {p.label.toLowerCase()}
                    {data ? ` (${fmtInt(phaseCount(p.phase))})` : ''}
                  </option>
                  {data?.rules
                    .filter((c) => c.phase === p.phase)
                    .map((c) => (
                      <option key={c.ruleId} value={`${p.phase}:${c.ruleId}`}>
                        {c.ruleName} ({fmtInt(c.count)})
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          )}
          <select className="select-sm" value={verdict} onChange={(e) => setVerdict(e.target.value as AlertVerdict | '')} aria-label="Verdict">
            <option value="">Tous les verdicts</option>
            {PHASE_VERDICTS[phase].map((v) => (
              <option key={v} value={v} disabled={!!data && verdictCount(v) === 0 && verdict !== v}>
                {VERDICT_LABEL[v]}
                {data ? ` (${fmtInt(verdictCount(v))})` : ''}
              </option>
            ))}
          </select>
          <div className="field grow-field">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Numéro de commande…" aria-label="Rechercher une commande" />
          </div>
        </div>
        <p className="small muted m-0">
          <strong>{current ? (ruleId ? current.ofRule : current.label) : ruleId ? 'En test et en production' : 'Toutes les règles'}</strong> :{' '}
          {current ? current.hint : ALL_HINT}
        </p>
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
        <div className="empty">
          {inPhase === 0
            ? `Aucune alerte ${ruleId ? 'de cette règle' : "d'une règle"}${current ? (phase === 'TEST' ? ' en test' : ' en production') : ''} sur ${days} jours.`
            : 'Aucune alerte avec ces critères.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data alerts-table">
            <thead>
              <tr>
                <th>Détectée le</th>
                <th>Commande</th>
                <th>{ruleId ? 'Version' : 'Règle'}</th>
                <th>Détails</th>
                <th>
                  Verdict
                  <InfoTip align="end">
                    {phase !== 'PRODUCTION' &&
                      "En test, donné par les analystes : fraude avérée, commande risquée ou RAS (rien à signaler). Il vaut pour la commande, toutes règles confondues. « À vérifier » retire le verdict donné. "}
                    {phase !== 'TEST' && 'En production, donné par le prestataire, à qui la commande a été transmise.'}
                  </InfoTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => {
                const id = a.orderId + a.ruleId + a.ruleVersion;
                const testing = a.phase === 'TEST';
                // Une commande en test déjà vérifiée par le prestataire (transmise par une autre règle) : son verdict prime.
                const byProvider = a.providerIsFraud !== null && a.providerIsFraud !== undefined;
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
                      {!phase && <div className="small muted">{a.phase === 'TEST' ? 'en test' : 'en production'}</div>}
                    </td>
                    <td className="small muted alert-details">
                      <div className="ellipsis" title={detailsText(a.details)}>
                        {detailsText(a.details) || '—'}
                      </div>
                    </td>
                    <td>
                      {testing && !byProvider ? (
                        <>
                          <select
                            className={`select-sm verdict-select verdict-${a.review?.verdict ?? 'TO_REVIEW'}`}
                            value={a.review?.verdict ?? ''}
                            disabled={busy === id}
                            onChange={(e) => review(a, (e.target.value || null) as ReviewVerdict | null)}
                            aria-label={`Qualifier la commande ${a.orderId}`}
                          >
                            <option value="">{VERDICT_LABEL.TO_REVIEW}</option>
                            {REVIEW_CHOICES.map((v) => (
                              <option key={v} value={v}>
                                {VERDICT_LABEL[v]}
                              </option>
                            ))}
                          </select>
                          {a.review && (
                            <div className="small muted">
                              {a.review.byName}, {fmtDateTime(a.review.at)}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <span className={`badge verdict verdict-${a.verdict}`}>{VERDICT_LABEL[a.verdict]}</span>
                          {testing && <div className="small muted">Déjà vérifiée par le prestataire</div>}
                        </>
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
