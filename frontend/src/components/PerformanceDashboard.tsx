import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { DailyPerformance, PeriodTotals, VersionDaily, VersionPerformance } from '../api/types';
import { addDays, daysBetween, fmtDate, fmtInt, fmtPct, isoDate } from '../lib/format';
import { delta, totals } from '../lib/metrics';
import { useAsync } from '../lib/useAsync';
import { KpiTile } from './KpiTile';
import { LineChart, versionColor, type Series } from './LineChart';
import { Alert, InfoTip, Spinner } from './ui';

type Preset = 7 | 30 | 90 | 'all' | 'custom';

/** Sans courbe par version (ancienne API) : une série par version, d'après les chiffres de la règle. */
const fallback = (daily: DailyPerformance[]): VersionDaily[] =>
  daily.map((d) => ({ date: d.date, ruleVersion: d.ruleVersion ?? 1, toSend: (d.ordersToSend ?? 0) > 0, ordersFlagged: d.ordersFlagged, ordersProcessed: d.ordersProcessed, ordersConfirmedFraud: d.ordersConfirmedFraud }));

/**
 * Une courbe par version sur toute la période : pleine quand elle est en production, pointillée en
 * observation (avant sa mise en production, ou candidate à côté de la version en production). La précision
 * ne se trace qu'en production : en observation, le prestataire ne traite que les commandes aussi remontées
 * par une règle envoyée.
 */
function byVersion(dates: string[], rows: VersionDaily[]) {
  const versions = [...new Set(rows.map((r) => r.ruleVersion))].sort((a, b) => a - b);
  const at = new Map(dates.map((d, i) => [d, i]));
  const volume: Series[] = [];
  const precision: Series[] = [];
  const markers: { date: string; label: string }[] = [];
  for (const v of versions) {
    const vol: Series = { version: v, values: dates.map(() => null), observed: dates.map(() => false), details: dates.map(() => undefined) };
    const pre: Series = { version: v, values: dates.map(() => null), observed: dates.map(() => false), details: dates.map(() => undefined) };
    const processed = dates.map(() => 0);
    const confirmed = dates.map(() => 0);
    const sent = dates.map(() => false);
    for (const r of rows.filter((x) => x.ruleVersion === v)) {
      const i = at.get(r.date);
      if (i === undefined) continue;
      // Un jour à cheval sur une décision (règle horaire) : les deux états s'additionnent, trait plein.
      vol.values[i] = (vol.values[i] ?? 0) + r.ordersFlagged;
      if (r.toSend) {
        sent[i] = true;
        processed[i] += r.ordersProcessed;
        confirmed[i] += r.ordersConfirmedFraud;
      }
    }
    dates.forEach((_, i) => {
      vol.observed[i] = !sent[i];
      if (processed[i] > 0) {
        pre.values[i] = confirmed[i] / processed[i];
        pre.details![i] = `${fmtInt(confirmed[i])} confirmées / ${fmtInt(processed[i])} vérifiées`;
      }
    });
    volume.push(vol);
    precision.push(pre);
    // Repère au premier jour de chaque version dans la période (sauf la première courbe affichée).
    const first = vol.values.findIndex((x) => x !== null);
    if (first > 0 && volume.length > 1) markers.push({ date: dates[first], label: `v${v}` });
  }
  return { volume, precision, markers };
}

/** Remplit les jours sans ligne (aucune version en production) par des trous. */
function fill(from: string, to: string, rows: DailyPerformance[]) {
  const by = new Map(rows.map((r) => [r.date, r]));
  const out: { date: string; row?: DailyPerformance }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, row: by.get(d) });
  return out;
}

interface Props {
  ruleId: string;
  /** Date du tout premier run Airflow de la règle (absente : jamais exécutée). */
  firstRunDate?: string;
  /** Nombre de versions qui ont tourné : à partir de 2, l'historique complet est affiché d'emblée pour les comparer. */
  versionsRun: number;
  /** Règle en observation (aucune version en production) : ses chiffres sont ses commandes observées. */
  observing?: boolean;
}

export function PerformanceDashboard({ ruleId, firstRunDate, versionsRun, observing }: Props) {
  const today = isoDate(new Date());
  const [preset, setPreset] = useState<Preset>(versionsRun > 1 ? 'all' : 30);
  const [custom, setCustom] = useState({ from: addDays(today, -59), to: today });
  const from =
    preset === 'custom' ? custom.from : preset === 'all' ? (firstRunDate ?? addDays(today, -29)) : addDays(today, -(preset - 1));
  const to = preset === 'custom' ? custom.to : today;
  const everInProduction = !!firstRunDate;
  const validRange = from <= to;

  const perf = useAsync(() => (validRange ? api.getPerformance(ruleId, from, to) : Promise.resolve(undefined)), [ruleId, from, to]);
  const data = perf.data;

  const view = useMemo(() => {
    if (!data) return null;
    // Totaux exacts du serveur (commandes distinctes : une commande remontée par deux versions compte une
    // fois) ; à défaut, la somme des jours.
    const exact = (t: PeriodTotals | undefined, rows: DailyPerformance[]) =>
      t
        ? totals([{ date: '', ordersFlagged: t.ordersFlagged, ordersProcessed: t.ordersProcessed, ordersConfirmedFraud: t.ordersConfirmedFraud }])
        : totals(rows);
    const cur = exact(data.totals, data.daily);
    const prev = exact(data.previousTotals, data.previous);
    const dates = fill(data.from, data.to, []).map((d) => d.date);
    const { volume, precision, markers } = byVersion(dates, data.byVersion ?? fallback(data.daily));
    const toSend = data.totals?.ordersToSend ?? 0;
    const observed = data.totals?.ordersObserved ?? 0;
    return { cur, prev, dates, volume, precision, markers, toSend, observed };
  }, [data, today]);

  if (!everInProduction) {
    return (
      <div className="card empty">
        Cette règle ne s'est pas encore exécutée : aucun indicateur pour l'instant.
      </div>
    );
  }

  const fmtDelta = (d: number | null, kind: 'relative' | 'points') =>
    d === null
      ? null
      : {
          text: kind === 'points' ? `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1).replace('.', ',')} pts` : `${d >= 0 ? '+' : '−'}${fmtPct(Math.abs(d))}`,
          direction: (Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'up' : 'down') as 'up' | 'down' | 'flat',
        };

  return (
    <div className="stack">
      {observing && (
        <p className="small muted" style={{ margin: 0 }}>
          En observation : rien n'est envoyé au prestataire.
          <InfoTip align="start">
            Le volume remonté est réel. La précision, elle, ne porte que sur les commandes qu'une autre règle a envoyées au prestataire :
            elle n'est pas représentative tant que cette règle n'est pas envoyée.
          </InfoTip>
        </p>
      )}
      <div className="row">
        <div className="seg" role="group" aria-label="Période">
          {([7, 30, 90] as const).map((p) => (
            <button key={p} type="button" aria-pressed={preset === p} onClick={() => setPreset(p)}>
              {p} jours
            </button>
          ))}
          <button type="button" aria-pressed={preset === 'all'} onClick={() => setPreset('all')} title="Depuis la première exécution de la v1 : toutes les versions sur la même courbe">
            Tout l'historique
          </button>
          <button type="button" aria-pressed={preset === 'custom'} onClick={() => setPreset('custom')}>
            Personnalisée
          </button>
        </div>
        {preset === 'custom' && (
          <div className="row">
            <label className="small muted" htmlFor="from">
              Du
            </label>
            <input id="from" type="date" value={custom.from} max={today} onChange={(e) => setCustom({ ...custom, from: e.target.value })} style={{ width: 'auto' }} />
            <label className="small muted" htmlFor="to">
              au
            </label>
            <input id="to" type="date" value={custom.to} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} style={{ width: 'auto' }} />
          </div>
        )}
        <span className="spacer" />
        {validRange && (
          <span className="small muted">
            {fmtDate(from)} → {fmtDate(to)} · {daysBetween(from, to)} jours
          </span>
        )}
      </div>

      {!validRange && <Alert kind="error" title="La date de début doit précéder la date de fin." />}
      {perf.error && <Alert kind="error" title={perf.error.message} />}
      {perf.loading && !data && <Spinner />}

      {view && data && (
        <>
          <div className="grid-3">
            <KpiTile
              featured
              label="Volume remonté"
              value={fmtInt(view.cur.flagged)}
              delta={fmtDelta(delta(view.cur.flagged, view.prev.flagged, 'relative'), 'relative')}
              sub={`${fmtInt(view.toSend)} envoyées au prestataire · ${fmtInt(view.observed)} en observation`}
              info={
                <>
                  Commandes remontées sur la période. « Envoyées » : par la version en production. « En observation » : par une version
                  pas encore envoyée. Une commande trouvée par plusieurs règles compte pour chacune : n'additionnez pas les règles.
                </>
              }
            />
            <KpiTile
              label="En attente de vérification"
              value={fmtInt(view.cur.pending)}
              sub={`${fmtInt(view.cur.processed)} déjà vérifiées`}
              info="Commandes remontées que le prestataire n'a pas encore vérifiées : elles n'apparaissent pas encore dans son retour."
            />
            <KpiTile
              label="Taux de précision"
              value={fmtPct(view.cur.precision)}
              delta={fmtDelta(delta(view.cur.precision, view.prev.precision, 'points'), 'points')}
              sub={`${fmtInt(view.cur.confirmed)} confirmées frauduleuses / ${fmtInt(view.cur.processed)} vérifiées`}
              info="Part des commandes vérifiées par le prestataire qui sont confirmées frauduleuses. Les fraudes que la règle n'a pas trouvées ne sont pas mesurables."
            />
          </div>

          <section className="card">
            <div className="card-head">
              <div>
                <h3>
                  Volume remonté par jour
                  <InfoTip>Une courbe par version. Trait plein : la version est en production (commandes envoyées au prestataire). Pointillé : en observation.</InfoTip>
                </h3>
              </div>
            </div>
            <div className="card-pad">
              <LineChart
                label="Volume remonté par jour"
                dates={view.dates}
                series={view.volume}
                format={(v) => fmtInt(Math.round(v))}
                markers={view.markers}
              />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h3>
                  Taux de précision par jour
                  <InfoTip>Confirmées frauduleuses ÷ commandes vérifiées, pour les versions en production. Pas de point les jours sans commande vérifiée.</InfoTip>
                </h3>
              </div>
            </div>
            <div className="card-pad">
              <LineChart
                label="Taux de précision par jour"
                dates={view.dates}
                series={view.precision}
                format={(v) => fmtPct(v)}
                yMax={1}
                markers={view.markers}
              />
            </div>
          </section>

          <details className="card card-pad">
            <summary>Voir les données journalières</summary>
            <div className="table-wrap" style={{ marginTop: 10, maxHeight: 320, overflow: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Remontées</th>
                    <th className="num">Traitées</th>
                    <th className="num">Confirmées</th>
                    <th className="num">Précision</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.daily].reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{fmtDate(d.date)}</td>
                      <td className="num">{fmtInt(d.ordersFlagged)}</td>
                      <td className="num">{fmtInt(d.ordersProcessed)}</td>
                      <td className="num">{fmtInt(d.ordersConfirmedFraud)}</td>
                      <td className="num">{fmtPct(d.ordersProcessed ? d.ordersConfirmedFraud / d.ordersProcessed : null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

/** Indicateurs de chaque version sur toute sa période d'exécution, pour juger l'effet d'une modification. */
/** Tableau de comparaison des versions (onglet Versions de la fiche). */
export function VersionComparison({ versions }: { versions: VersionPerformance[] }) {
  const rows = versions.map((v) => {
    const t = totals([{ date: v.lastDate, ordersFlagged: v.ordersFlagged, ordersProcessed: v.ordersProcessed, ordersConfirmedFraud: v.ordersConfirmedFraud }]);
    return { ...v, ...t, perDay: v.days ? v.ordersFlagged / v.days : 0 };
  });
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>
            Comparaison des versions
            <InfoTip>
              Chaque version sur toute sa durée d'exécution, y compris en observation. Une commande trouvée
              par deux versions compte pour chacune : les lignes ne s'additionnent pas.
            </InfoTip>
          </h3>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Version</th>
              <th>Période d'exécution</th>
              <th className="num">Remontées / jour</th>
              <th className="num">En attente de vérification</th>
              <th className="num">Taux de précision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const before = i > 0 ? rows[i - 1] : null;
              const d = before ? delta(r.precision, before.precision, 'points') : null;
              return (
                <tr key={r.version}>
                  <td>
                    <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                      <span className="legend-key" style={{ background: versionColor(r.version) }} aria-hidden="true" />
                      <strong>v{r.version}</strong>
                    </span>
                  </td>
                  <td className="small">
                    {fmtDate(r.firstDate)} → {fmtDate(r.lastDate)} <span className="muted">· {fmtInt(r.days)} j</span>
                  </td>
                  <td className="num">{fmtInt(Math.round(r.perDay))}</td>
                  <td className="num">{fmtInt(r.pending)}</td>
                  <td className="num">
                    <strong>{fmtPct(r.precision)}</strong>
                    {d !== null && (
                      <span className="small muted">
                        {' '}
                        ({d >= 0 ? '+' : '−'}
                        {Math.abs(d * 100).toFixed(1).replace('.', ',')} pts)
                      </span>
                    )}
                    {r.ordersFlagged === 0 && <div className="small" style={{ color: 'var(--bad)' }}>✕ aucune remontée : requête à vérifier</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
