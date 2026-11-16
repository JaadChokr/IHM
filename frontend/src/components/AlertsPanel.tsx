import { useEffect, useRef, useState } from 'react';
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
  TO_REVIEW: 'À qualifier',
  PENDING: 'En attente du prestataire',
};
/** Les trois qualifications possibles d'une commande en test, dans l'ordre des boutons. */
const REVIEW_CHOICES: { verdict: ReviewVerdict; label: string }[] = [
  { verdict: 'FRAUD', label: 'Fraude avérée' },
  { verdict: 'RISKY', label: 'Risquée' },
  { verdict: 'NOT_FRAUD', label: 'RAS' },
];
/** Verdicts possibles dans chaque phase : en test, ceux des analystes ; en production, ceux du prestataire. */
const PHASE_VERDICTS: Record<AlertPhase, AlertVerdict[]> = {
  TEST: ['TO_REVIEW', 'FRAUD', 'RISKY', 'NOT_FRAUD'],
  PRODUCTION: ['PENDING', 'FRAUD', 'NOT_FRAUD'],
};
const PHASES: { phase: AlertPhase; label: string; ofRule: string; hint: string }[] = [
  { phase: 'TEST', label: 'Règles en test', ofRule: 'En test', hint: 'Commandes non transmises au prestataire : à qualifier par les analystes.' },
  { phase: 'PRODUCTION', label: 'Règles en production', ofRule: 'En production', hint: 'Commandes transmises au prestataire, qui rend le verdict.' },
];
const PERIODS = [7, 30, 90] as const;

/** Autres colonnes renvoyées par la règle, en une ligne lisible : « montant_eur : 1 240 · pays : NG ». */
function detailsText(d: Alert['details']): string {
  if (!d) return '';
  return Object.entries(d)
    .map(([k, v]) => `${k} : ${typeof v === 'number' ? fmtInt(v) : String(v)}`)
    .join(' · ');
}

/** Nombre d'alertes d'une phase, ou d'un verdict, dans une page (0 si absent). */
const phaseCountIn = (d: AlertPage | undefined, p: AlertPhase) => d?.phases.find((c) => c.phase === p)?.count ?? 0;
const verdictCountIn = (d: AlertPage | undefined, v: AlertVerdict) => d?.verdicts.find((c) => c.verdict === v)?.count ?? 0;

interface Props {
  /** Alertes d'une seule règle (onglet de la fiche) ; sans : toutes les règles, avec un filtre par règle. */
  ruleId?: string;
}

/**
 * Alertes remontées par les règles : une ligne par commande et par version. On choisit d'abord la phase :
 * - en test, les commandes ne sont pas transmises au prestataire ; les analystes les qualifient (fraude
 *   avérée, commande risquée ou RAS). La qualification porte sur la commande, toutes règles confondues, et
 *   entre dans la pertinence de la règle ;
 * - en production, le prestataire rend le verdict : rien à qualifier.
 * Les filtres ne proposent que des choix qui renvoient des alertes (nombres renvoyés par l'API).
 */
export function AlertsPanel({ ruleId }: Props) {
  const [days, setDays] = usePref<(typeof PERIODS)[number]>('alertsDays', 7);
  const [phase, setPhase] = useState<AlertPhase>('TEST');
  const [verdict, setVerdict] = useState<AlertVerdict | ''>('');
  const [rule, setRule] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [size, setSize] = usePref<number>('pageSize.alerts', 25);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<AlertPage>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  // Phase choisie d'office une seule fois : en production si la règle n'a rien en test.
  const phaseSettled = useRef(false);

  // Recherche par numéro de commande : appliquée après une courte pause de saisie.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filters: AlertFilters = {
    from: addDays(isoDate(new Date()), -(days - 1)),
    ruleId: ruleId ?? (rule || undefined),
    phase,
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

  // Un choix qui ne renvoie plus rien (autre phase, autre période) est retiré plutôt que d'afficher une liste vide.
  useEffect(() => {
    if (!data) return;
    if (!phaseSettled.current) {
      phaseSettled.current = true;
      if (phaseCountIn(data, 'TEST') === 0 && phaseCountIn(data, 'PRODUCTION') > 0) return setPhase('PRODUCTION');
    }
    if (rule && !data.rules.some((c) => c.ruleId === rule)) return setRule('');
    if (verdict && !data.verdicts.some((c) => c.verdict === verdict)) setVerdict('');
  }, [data, rule, verdict]);

  async function review(a: Alert, choice: ReviewVerdict) {
    // Un second clic sur le même choix retire la qualification.
    const next = a.review?.verdict === choice ? null : choice;
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

  function choosePhase(p: AlertPhase) {
    setPhase(p);
    setVerdict('');
  }

  const phaseCount = (p: AlertPhase) => phaseCountIn(data, p);
  const verdictCount = (v: AlertVerdict) => verdictCountIn(data, v);
  const all = phaseCount('TEST') + phaseCount('PRODUCTION');
  const inPhase = data ? phaseCount(phase) : 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / size)) : 1;
  const testing = phase === 'TEST';

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
                  {fmtInt(data.toReview)} à qualifier
                </button>
              </>
            )}
          </>
        ) : (
          '…'
        )
      }
      info="Une ligne par commande remontée et par version de règle. Choisissez d'abord la phase. En test, les commandes ne sont pas transmises au prestataire : qualifiez-les (fraude avérée, commande risquée ou RAS). Votre qualification vaut pour la commande, toutes règles confondues, et entre dans la pertinence de la règle. En production, le prestataire rend le verdict."
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
        <div className="seg phase-seg" role="group" aria-label="Phase des règles">
          {PHASES.map((p) => (
            <button key={p.phase} type="button" aria-pressed={phase === p.phase} onClick={() => choosePhase(p.phase)} title={p.hint}>
              {ruleId ? p.ofRule : p.label}
              {data && <span className="count">{fmtInt(phaseCount(p.phase))}</span>}
            </button>
          ))}
        </div>
        <p className="small muted m-0">{PHASES.find((p) => p.phase === phase)!.hint}</p>
        <div className="row gap-3 alerts-filters">
          <div className="field grow-field">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Numéro de commande…" aria-label="Rechercher une commande" />
          </div>
          {!ruleId && (
            <select className="select-sm" value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Règle">
              <option value="">Toutes les règles{data ? ` (${fmtInt(inPhase)})` : ''}</option>
              {data?.rules.map((c) => (
                <option key={c.ruleId} value={c.ruleId}>
                  {c.ruleName} ({fmtInt(c.count)})
                </option>
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
        </div>
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
            ? `Aucune alerte ${ruleId ? 'de cette règle' : "d'une règle"} ${testing ? 'en test' : 'en production'} sur ${days} jours.`
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
                {testing ? (
                  <th>
                    Qualification
                    <InfoTip align="end">
                      Fraude avérée, commande risquée ou RAS (rien à signaler). Un second clic sur le même choix retire la qualification.
                    </InfoTip>
                  </th>
                ) : (
                  <th>Verdict du prestataire</th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => {
                const id = a.orderId + a.ruleId + a.ruleVersion;
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
                    </td>
                    <td className="small muted alert-details">
                      <div className="ellipsis" title={detailsText(a.details)}>
                        {detailsText(a.details) || '—'}
                      </div>
                    </td>
                    <td>
                      {testing && !byProvider ? (
                        <>
                          <div className="seg verdict-seg" role="group" aria-label={`Qualifier la commande ${a.orderId}`}>
                            {REVIEW_CHOICES.map((c) => (
                              <button
                                key={c.verdict}
                                type="button"
                                data-verdict={c.verdict}
                                aria-pressed={a.review?.verdict === c.verdict}
                                disabled={busy === id}
                                onClick={() => review(a, c.verdict)}
                              >
                                {c.label}
                              </button>
                            ))}
                          </div>
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
