import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { RULE_STATUSES, type RuleFilters, type RuleStatus } from '../api/types';
import { readyToSubmit } from '../lib/drafts';
import { Alert, Spinner, StatusBadge } from '../components/ui';
import { ACTION_LABEL } from './AuditPage';
import { fmtDate, fmtDateTime, fmtInt, fmtPct } from '../lib/format';
import { DEFAULT_WATCH_THRESHOLD, productionHealth, type ProductionHealth } from '../lib/metrics';
import { useAsync } from '../lib/useAsync';
import { readPref, writePref } from '../prefs/prefs';
import { usePageTitle } from '../nav/history';

/** Nombre d'éléments par liste : les trois cartes du bas gardent des hauteurs comparables. */
const LIST_MAX = 4;

/** Pied de carte : lien vers la page complète, aligné en bas de chaque carte. */
function CardFoot({ to, onClick, children }: { to: string; onClick?: () => void; children: ReactNode }) {
  return (
    <Link to={to} onClick={onClick} className="card-foot">
      {children} <span aria-hidden="true">→</span>
    </Link>
  );
}

const LIST_FILTERS: RuleFilters = { q: '', status: '', typology: '', owner: '', criticality: '', sort: 'updated_desc' };

export function OverviewPage() {
  usePageTitle("Vue d'ensemble");
  const nav = useNavigate();
  const rules = useAsync(() => api.listRules({}), []);
  const prod = useAsync(() => api.getConsolidated(), []);
  const audit = useAsync(() => api.listAudit({}), []);
  const drafts = useAsync(() => api.listDrafts(), []);
  const threshold = readPref<number>('watchPrecisionThreshold', DEFAULT_WATCH_THRESHOLD);

  const health = useMemo(
    () => (prod.data ?? []).map((r) => productionHealth(r, threshold)).sort((a, b) => (a.precision ?? -1) - (b.precision ?? -1)),
    [prod.data, threshold],
  );

  /** Ouvre la liste des règles avec un filtre déjà posé. */
  const openList = (patch: Partial<RuleFilters>) => {
    writePref('rulesFilters', { ...LIST_FILTERS, ...patch });
    nav('/rules');
  };

  if (rules.error) return <Alert kind="error" title={rules.error.message} />;
  if (!rules.data) return <Spinner />;

  const all = rules.data;
  const count = (s: RuleStatus) => all.filter((r) => r.status === s).length;
  const watch = health.filter((h) => h.reasons.length);
  const myDrafts = drafts.data ?? [];
  const myReady = myDrafts.filter(readyToSubmit);
  const activity = (audit.data ?? []).filter((e) => e.action !== 'LOGIN');
  const maxStatus = Math.max(1, ...RULE_STATUSES.map(count));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Vue d'ensemble</h1>
          <p>Le dispositif de détection au {fmtDate(new Date().toISOString())}.</p>
        </div>
      </div>

      <div className="stack">
        <div className="overview-kpis">
          <button type="button" className="card kpi kpi-link kpi-featured" onClick={() => openList({ status: 'IN_PRODUCTION' })}>
            <span className="kpi-label">En production</span>
            <span className="kpi-value">{fmtInt(count('IN_PRODUCTION'))}</span>
            <span className="kpi-sub">
              Envoyées au prestataire
              {count('INACTIVE') > 0 && ` · ${count('INACTIVE')} inactive${count('INACTIVE') > 1 ? 's' : ''} en plus`}
            </span>
          </button>
          <button type="button" className="card kpi kpi-link" onClick={() => openList({ status: 'OBSERVATION' })}>
            <span className="kpi-label">En observation</span>
            <span className="kpi-value">{fmtInt(count('OBSERVATION'))}</span>
            <span className="kpi-sub">
              Décision d'envoi attendue
              {count('SUBMITTED') > 0 && ` · ${count('SUBMITTED')} publiée${count('SUBMITTED') > 1 ? 's' : ''} en attente de première exécution`}
            </span>
          </button>
          <Link to="/production" className="card kpi kpi-link">
            <span className="kpi-label">À surveiller</span>
            <span className="kpi-value">{prod.data ? fmtInt(watch.length) : '…'}</span>
            <span className="kpi-sub">Précision sous {fmtPct(threshold)}, aucune remontée sur 30 jours ou exécution arrêtée</span>
            {watch.length > 0 && <span className="kpi-flag">⚠ Action requise</span>}
          </Link>
          <Link to="/drafts" className="card kpi kpi-link">
            <span className="kpi-label">Mes brouillons</span>
            <span className="kpi-value">{drafts.data ? fmtInt(myDrafts.length) : '…'}</span>
            <span className="kpi-sub">
              Visibles de vous seul · dont {myReady.length} prêt{myReady.length > 1 ? 's' : ''} à publier
            </span>
          </Link>
        </div>

        <div className="overview-row">
          <section className="card" aria-labelledby="ov-precision">
            <div className="card-head">
              <div>
                <h2 id="ov-precision">Précision des règles en production</h2>
                <p>30 derniers jours · confirmées frauduleuses ÷ commandes vérifiées · la moins précise en premier</p>
              </div>
            </div>
            <div className="card-pad card-body centered">
              {prod.error ? (
                <Alert kind="error" title={prod.error.message} />
              ) : !prod.data ? (
                <Spinner />
              ) : health.length === 0 ? (
                <div className="empty">Aucune règle en production.</div>
              ) : (
                <PrecisionBars rows={health.filter((h) => h.status !== 'OBSERVATION')} threshold={threshold} />
              )}
            </div>
            <CardFoot to="/production">Voir la vue production</CardFoot>
          </section>

          <section className="card" aria-labelledby="ov-lifecycle">
            <div className="card-head">
              <div>
                <h2 id="ov-lifecycle">Règles par statut</h2>
                <p>{fmtInt(all.length)} règles au total, version courante</p>
              </div>
            </div>
            <ul className="status-bars card-body">
              {RULE_STATUSES.map((s) => (
                <li key={s}>
                  <button type="button" className="status-bar" onClick={() => openList({ status: s })} title={`Voir les règles « ${s} »`}>
                    <StatusBadge status={s} />
                    <span className="status-track" aria-hidden="true">
                      <span style={{ width: `${(count(s) / maxStatus) * 100}%` }} />
                    </span>
                    <span className="status-count">{count(s)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <CardFoot to="/rules" onClick={() => writePref('rulesFilters', LIST_FILTERS)}>
              Voir toutes les règles
            </CardFoot>
          </section>
        </div>

        <div className="overview-cols">
          <section className="card" aria-labelledby="ov-watch">
            <div className="card-head">
              <h2 id="ov-watch">À surveiller</h2>
            </div>
            {watch.length === 0 ? (
              <div className="empty card-body">Aucune règle à surveiller.</div>
            ) : (
              <ul className="ov-list card-body">
                {watch.slice(0, LIST_MAX).map((w) => (
                  <li key={w.ruleId}>
                    <Link to={`/rules/${w.ruleId}`} className="rule-link">
                      {w.name}
                    </Link>
                    {w.reasons.map((r) => (
                      <span key={r} className="small" style={{ color: 'var(--bad)' }}>
                        {r}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            <CardFoot to="/production">{watch.length > LIST_MAX ? `Voir les ${watch.length} règles à surveiller` : 'Voir la vue production'}</CardFoot>
          </section>

          {/* Masquée sans brouillon : les cartes restantes se partagent la largeur. */}
          {myDrafts.length > 0 && (
          <section className="card" aria-labelledby="ov-drafts">
            <div className="card-head">
              <h2 id="ov-drafts">Mes brouillons</h2>
            </div>
              <ul className="ov-list card-body">
                {myDrafts.slice(0, LIST_MAX).map((r) => (
                  <li key={r.id}>
                    <Link to={`/drafts/${r.id}`} className="rule-link">
                      {r.name} <span className="muted small">{r.newRule ? 'nouvelle règle' : `v${(r.latestVersion ?? 0) + 1}`}</span>
                    </Link>
                    {readyToSubmit(r) ? (
                      <span className="small" style={{ color: 'var(--good)' }}>
                        ✓ Testée, prête à publier
                      </span>
                    ) : (
                      <span className="small muted">{r.lastTest ? 'Test à refaire sur la requête actuelle' : 'Jamais testée'}</span>
                    )}
                  </li>
                ))}
              </ul>
            <CardFoot to="/drafts">
              {myDrafts.length > LIST_MAX ? `Voir mes ${myDrafts.length} brouillons` : 'Voir mes brouillons'}
            </CardFoot>
          </section>
          )}

          <section className="card" aria-labelledby="ov-activity">
            <div className="card-head">
              <h2 id="ov-activity">Activité récente</h2>
            </div>
            {activity.length === 0 ? (
              <div className="empty card-body">Aucune activité.</div>
            ) : (
              <ul className="ov-list card-body">
                {activity.slice(0, LIST_MAX).map((e) => (
                  <li key={e.id}>
                    <span className="small">
                      <strong>{e.userName}</strong> · {ACTION_LABEL[e.action].toLowerCase()}
                      {e.ruleId && (
                        <>
                          {' '}
                          <Link to={`/rules/${e.ruleId}`}>{e.ruleName}</Link>
                          {e.version != null && <span className="muted"> v{e.version}</span>}
                        </>
                      )}
                    </span>
                    <span className="small muted">{fmtDateTime(e.at)}</span>
                  </li>
                ))}
              </ul>
            )}
            <CardFoot to="/audit">Tout le journal d'audit</CardFoot>
          </section>
        </div>
      </div>
    </>
  );
}

/** Une barre par règle, échelle 0–100 %, seuil « à surveiller » en repère. Jamais de total : les règles ne s'additionnent pas. */
function PrecisionBars({ rows, threshold }: { rows: ProductionHealth[]; threshold: number }) {
  return (
    <div className="pbars" role="table" aria-label="Taux de précision par règle en production">
      {rows.map((r) => {
        const label =
          r.precision === null
            ? r.ordersFlagged30d === 0
              ? 'Aucune remontée'
              : 'Aucune commande traitée'
            : `${fmtPct(r.precision)} — ${fmtInt(r.ordersConfirmed30d)} confirmées / ${fmtInt(r.ordersProcessed30d)} vérifiées`;
        return (
          <div className="pbar-row" role="row" key={r.ruleId}>
            <Link to={`/rules/${r.ruleId}`} className="pbar-name" role="rowheader" title={r.name}>
              {r.name}
            </Link>
            <div className="pbar-track" role="cell" title={label}>
              {r.precision !== null && (
                <span className="pbar-fill" style={{ width: `${Math.max(r.precision * 100, 0.5)}%` }} />
              )}
              <span className="pbar-threshold" style={{ left: `${threshold * 100}%` }} aria-hidden="true" />
            </div>
            <span className="pbar-value" role="cell">
              {r.precision === null ? (
                <span style={{ color: 'var(--bad)' }}>{label}</span>
              ) : (
                <strong>{fmtPct(r.precision)}</strong>
              )}
            </span>
          </div>
        );
      })}
      <div className="pbar-row pbar-axis" aria-hidden="true">
        <span />
        <div className="pbar-scale">
          {[0, 50, 100].map((t) => (
            <span key={t} style={{ left: `${t}%` }}>
              {t} %
            </span>
          ))}
        </div>
        <span className="small muted">┆ seuil {fmtPct(threshold)}</span>
      </div>
    </div>
  );
}
