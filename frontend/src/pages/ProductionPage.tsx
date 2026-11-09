import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Alert, CriticalityBadge, Spinner, StatusBadge } from '../components/ui';
import { fmtInt, fmtPct } from '../lib/format';
import { DEFAULT_WATCH_THRESHOLD, productionHealth, type ProductionHealth } from '../lib/metrics';
import { useAsync } from '../lib/useAsync';
import { usePref } from '../prefs/prefs';
import { usePageTitle } from '../nav/history';

type SortKey = 'precision' | 'volume' | 'pending' | 'name';

type Row = ProductionHealth;

export function ProductionPage() {
  usePageTitle('Production');
  const data = useAsync(() => api.getConsolidated(), []);
  const [threshold, setThreshold] = usePref<number>('watchPrecisionThreshold', DEFAULT_WATCH_THRESHOLD);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'precision', dir: 1 });
  const [onlyWatch, setOnlyWatch] = useState(false);

  const rows = useMemo<Row[]>(() => (data.data ?? []).map((r) => productionHealth(r, threshold)), [data.data, threshold]);

  const sorted = useMemo(() => {
    const val = (r: Row): number | string =>
      sort.key === 'name' ? r.name : sort.key === 'volume' ? r.ordersFlagged30d : sort.key === 'pending' ? r.pending : r.precision ?? -1;
    return rows
      .filter((r) => !onlyWatch || r.reasons.length)
      .sort((a, b) => {
        const x = val(a);
        const y = val(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
  }, [rows, sort, onlyWatch]);

  const watchCount = rows.filter((r) => r.reasons.length).length;

  const th = (key: SortKey, label: string, num = true) => (
    <th className={num ? 'num' : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="th-sort" onClick={() => setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 })}>
        {label} <span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Règles en production</h1>
          <p>Toutes les règles exécutées par Airflow sur les 30 derniers jours : envoyées au prestataire, en observation ou devenues inactives.</p>
        </div>
      </div>
      <div className="stack">
        <Alert kind="info">
          Une commande remontée par plusieurs règles est comptée pour chacune : les volumes de ce tableau <strong>ne s'additionnent pas</strong>.
        </Alert>
        <div className="card prod-card">
          <div className="card-pad row" style={{ borderBottom: '1px solid var(--border)' }}>
            <label htmlFor="thr" className="small">
              Seuil de précision « à surveiller »
            </label>
            <input
              id="thr"
              type="number"
              min={0}
              max={100}
              step={1}
              value={Math.round(threshold * 100)}
              onChange={(e) => setThreshold(Math.max(0, Math.min(100, Number(e.target.value))) / 100)}
              style={{ width: 80 }}
            />
            <span className="small muted">%</span>
            <span className="spacer" />
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={onlyWatch} onChange={(e) => setOnlyWatch(e.target.checked)} />
              Seulement les règles à surveiller ({watchCount})
            </label>
          </div>
          {data.error && <Alert kind="error" title={data.error.message} />}
          {!data.data ? (
            <div className="card-pad">
              <Spinner />
            </div>
          ) : sorted.length === 0 ? (
            <div className="empty">{onlyWatch ? 'Aucune règle à surveiller.' : 'Aucune règle en production.'}</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {th('name', 'Règle', false)}
                    <th className="col-crit">Criticité</th>
                    {th('volume', 'Volume remonté')}
                    {th('pending', 'En attente de retour')}
                    {th('precision', 'Taux de précision')}
                    <th>À surveiller</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.ruleId}>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          <Link to={`/rules/${r.ruleId}`} className="rule-link">
                            {r.name}
                          </Link>
                          {(r.status === 'INACTIVE' || r.status === 'OBSERVATION') && <StatusBadge status={r.status} lastRunAt={r.lastRunAt} />}
                        </div>
                        <div className="small muted">
                          v{r.version} · {r.fraudTypology} · {r.ownerName}
                        </div>
                      </td>
                      <td className="col-crit">
                        <CriticalityBadge value={r.criticality} />
                      </td>
                      <td className="num">{fmtInt(r.ordersFlagged30d)}</td>
                      <td className="num">{fmtInt(r.pending)}</td>
                      <td className="num">
                        <strong>{fmtPct(r.precision)}</strong>
                        {r.lowSample && r.precision !== null && (
                          <div className="small" style={{ color: 'var(--warn)' }} title="Moins de 20 commandes avec retour du prestataire">
                            ⚠ échantillon faible
                          </div>
                        )}
                      </td>
                      <td className="small">
                        {r.reasons.length ? (
                          <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--bad)' }}>
                            {r.reasons.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="muted">—</span>
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
