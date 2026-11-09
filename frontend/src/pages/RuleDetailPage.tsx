import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { DecisionAction, RuleDetail, RuleRun, RuleVersion, SqlIssue } from '../api/types';
import { SqlEditor, type SqlEditorHandle } from '../components/SqlEditor';
import { TestActions, TestResults, useQueryTest } from '../components/TestPanel';
import { Breadcrumb } from '../components/Breadcrumb';
import { usePageTitle } from '../nav/history';
import { DiffView } from '../components/DiffView';
import { PerformanceDashboard } from '../components/PerformanceDashboard';
import { KpiTile } from '../components/KpiTile';
import { Alert, CriticalityBadge, idleFor, InfoTip, Lifecycle, Spinner, StatusBadge } from '../components/ui';
import { AuditTable } from './AuditPage';
import { SCHEDULE_LABEL, SCHEDULE_WHEN, fmtDateTime, fmtDuration, fmtInt } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { usePref } from '../prefs/prefs';

type Tab = 'definition' | 'performance' | 'runs' | 'versions' | 'audit';
const TABS: Tab[] = ['definition', 'performance', 'runs', 'versions', 'audit'];

export function RuleDetailPage() {
  const { ruleId = '' } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const rule = useAsync(() => api.getRule(ruleId), [ruleId]);
  const [savedTab, setTab] = usePref<Tab>('ruleTab', 'definition');
  // Un onglet mémorisé qui n'existe plus (ancien onglet « Tests ») revient à la définition.
  const tab: Tab = TABS.includes(savedTab) ? savedTab : 'definition';
  const [flash] = useState<string | undefined>((loc.state as { flash?: string } | null)?.flash);

  useEffect(() => {
    if (flash) nav(loc.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePageTitle(rule.data?.name);

  if (rule.error) return <Alert kind="error" title={rule.error.message} />;
  if (!rule.data) return <Spinner />;
  const r = rule.data;

  const ran = r.versions.filter((v) => !!v.firstRunAt);
  const firstRunDate = ran.map((v) => v.firstRunAt!.slice(0, 10)).sort()[0];

  /** Ouvre l'onglet Définition et fait défiler jusqu'au bloc de test. */
  function showTest() {
    setTab('definition');
    setTimeout(() => document.getElementById('rule-test')?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        }), 50);
  }

  const tabs: [Tab, string, number?][] = [
    ['definition', 'Définition'],
    ['performance', 'Performance'],
    ['runs', 'Exécutions'],
    ['versions', 'Versions', r.versions.length],
    ['audit', 'Audit'],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <Breadcrumb items={[{ label: 'Règles', to: '/rules' }, { label: r.name }]} />
          <div className="row" style={{ gap: 10 }}>
            <h1>{r.name}</h1>
            <span className="tag">v{r.version}</span>
            <StatusBadge status={r.status} lastRunAt={r.lastRunAt} />
          </div>
          <p className="row small" style={{ gap: 14 }}>
            <span>{r.fraudTypology}</span>
            <CriticalityBadge value={r.criticality} />
            <span>{SCHEDULE_LABEL[r.schedule]}</span>
            <span>Propriétaire : {r.ownerName}</span>
            <span>Modifiée le {fmtDateTime(r.updatedAt)}</span>
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={showTest}>
            ▶ Tester
          </button>
          {r.myDraftId ? (
            <Link to={`/drafts/${r.myDraftId}`} className="btn btn-primary">
              Reprendre mon brouillon
            </Link>
          ) : (
            <Link to={`/rules/${r.ruleId}/edit`} className="btn btn-primary">
              {r.canWithdraw ? 'Modifier' : 'Créer une nouvelle version'}
            </Link>
          )}
        </div>
      </div>

      <div className="stack" style={{ marginBottom: 16 }}>
        {flash === 'draftDeleted' && <Alert kind="success" title="Brouillon supprimé." />}
        {flash === 'submitted' && (
          <Alert
            kind="success"
            title={
              <>
                v{r.version} publiée : première exécution {SCHEDULE_WHEN[r.schedule]}, en observation.
                <InfoTip align="start">
                  Ses commandes ne seront envoyées au prestataire qu'après votre décision.
                  {r.candidate && r.productionVersion && ` La v${r.productionVersion} reste en production pendant ce temps.`} Tant qu'elle ne
                  s'est pas exécutée, vous pouvez encore la modifier : elle redeviendra votre brouillon.
                </InfoTip>
              </>
            }
          />
        )}
        <DecisionPanel r={r} onChange={rule.setData} />
        {r.myDraftId && !flash && (
          <Alert
            kind="info"
            title={
              <>
                Vous préparez une nouvelle version de cette règle. <Link to={`/drafts/${r.myDraftId}`}>Reprendre le brouillon</Link>
                <InfoTip>Votre brouillon n'est visible que de vous.</InfoTip>
              </>
            }
          />
        )}
        {r.status === 'INACTIVE' && r.lastRunAt && (
          <Alert
            kind="warn"
            title={
              <>
                Ne s'exécute plus depuis {idleFor(r.lastRunAt)} : prévenez l'équipe data.
                <InfoTip align="start">
                  Dernière exécution le {fmtDateTime(r.lastRunAt)}. Le traitement automatique est arrêté ou en panne ; la règle reprendra son
                  statut dès qu'il redémarrera.
                </InfoTip>
              </>
            }
          />
        )}
        {r.productionVersion && !r.candidate && (
          <Alert kind="info" title={`La v${r.version} remplacera la v${r.productionVersion} à sa première exécution, en observation.`} />
        )}
        {r.candidate && r.productionVersion && r.status === 'SUBMITTED' && (
          <Alert
            kind="info"
            title={
              <>
                La v{r.version} s'exécutera à côté de la v{r.productionVersion}, qui reste en production.
                <InfoTip align="start">
                  La v{r.productionVersion} continue d'être envoyée au prestataire ; la v{r.version} est observée sans envoi. Vous pourrez la
                  mettre en production après sa première exécution.
                </InfoTip>
              </>
            }
          />
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Sections de la règle">
        {tabs.map(([id, label, count]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} className="tab" onClick={() => setTab(id)}>
            {label}
            {count !== undefined && <span className="count">{count}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'definition' && <DefinitionTab r={r} onTested={rule.reload} />}
        {tab === 'performance' && <PerformanceDashboard ruleId={r.ruleId} firstRunDate={firstRunDate} versionsRun={ran.length} observing={r.status === 'OBSERVATION' && !r.candidate} />}
        {tab === 'runs' && <RunsTab r={r} />}
        {tab === 'versions' && (
          <VersionsTab
            r={r}
            onRestored={(draftId, from) => nav(`/drafts/${draftId}`, { state: { flash: `restored:${from}` } })}
          />
        )}
        {tab === 'audit' && <RuleAudit ruleId={r.ruleId} />}
      </div>

      {api.demo && <DemoPanel r={r} onChange={(d) => rule.setData(d)} />}
    </>
  );
}

function DefinitionTab({ r, onTested }: { r: RuleDetail; onTested: () => void }) {
  const editor = useRef<SqlEditorHandle>(null);
  const [issues, setIssues] = useState<SqlIssue[]>();
  const test = useQueryTest({ sql: r.sqlQuery, target: { ruleId: r.ruleId }, schedule: r.schedule, onIssues: setIssues, onTested });
  return (
    <div className="stack">
      <div className="card card-pad stack" style={{ gap: 12 }}>
        <Lifecycle status={r.status} lastRunAt={r.lastRunAt} />
        <p style={{ margin: 0 }}>{r.description}</p>
        <dl className="kv">
          <dt>Identifiant</dt>
          <dd className="mono small">{r.ruleId}</dd>
          <dt>Créée le</dt>
          <dd>{fmtDateTime(r.createdAt)}</dd>
          <dt>Publiée le</dt>
          <dd>
            {fmtDateTime(r.submittedAt)} par {r.submittedByName}
          </dd>
          <dt>Exécution</dt>
          <dd>
            {SCHEDULE_LABEL[r.schedule]}, {SCHEDULE_WHEN[r.schedule]}
            {r.airflowDagId && <InfoTip>Traitement de l'équipe data : {r.airflowDagId}</InfoTip>}
          </dd>
          {r.firstRunAt && (
            <>
              <dt>Première exécution</dt>
              <dd>{fmtDateTime(r.firstRunAt)}</dd>
              <dt>Dernière exécution</dt>
              <dd>{r.lastRunAt ? fmtDateTime(r.lastRunAt) : '—'}</dd>
            </>
          )}
        </dl>
      </div>
      <section className="card" id="rule-test" aria-labelledby="rule-test-title">
        <div className="card-head">
          <div>
            <h2 id="rule-test-title">
              Requête SQL
              <InfoTip>La v{r.version} telle que publiée. Le test l'exécute sans rien modifier.</InfoTip>
            </h2>
          </div>
        </div>
        <div className="card-pad stack">
          <SqlEditor ref={editor} value={r.sqlQuery} readOnly issues={issues} ariaLabel="Requête SQL (lecture seule)" />
          <TestActions t={test} />
        </div>
      </section>
      <TestResults t={test} onGoTo={(l, c) => editor.current?.goTo(l, c)} />
    </div>
  );
}

/** Historique des exécutions automatiques : l'utilisateur voit si elles se sont bien déroulées. */
function RunsTab({ r }: { r: RuleDetail }) {
  const DAYS = 90;
  const runs = useAsync(() => api.getRuns(r.ruleId, DAYS), [r.ruleId]);
  const [onlyFailed, setOnlyFailed] = useState(false);
  if (runs.error) return <Alert kind="error" title={runs.error.message} />;
  if (!runs.data) return <Spinner />;
  const all = runs.data;
  if (all.length === 0) return <div className="card empty">Cette règle ne s'est pas encore exécutée.</div>;
  const failed = all.filter((x) => x.status === 'FAILED');
  const shown = onlyFailed ? failed : all;
  const last = all[0];
  const duration = (x: RuleRun) =>
    x.finishedAt ? fmtDuration(new Date(x.finishedAt).getTime() - new Date(x.startedAt).getTime()) : '—';
  return (
    <div className="stack">
      <div className="grid-3">
        <KpiTile
          label="Dernière exécution"
          value={last.status === 'SUCCESS' ? 'Réussie' : 'En échec'}
          sub={`${fmtDateTime(last.startedAt)} · v${last.ruleVersion}`}
        />
        <KpiTile label="Exécutions réussies" value={`${fmtInt(all.length - failed.length)} / ${fmtInt(all.length)}`} sub={`${DAYS} derniers jours`} />
        <KpiTile
          label="En échec"
          value={fmtInt(failed.length)}
          sub={failed.length ? `Dernier échec le ${fmtDateTime(failed[0].startedAt)}` : 'Aucun échec'}
          info="Une exécution en échec est retentée automatiquement. Si les échecs se répètent, prévenez l'équipe data."
        />
      </div>
      <div className="card">
        <div className="card-head">
          <h2>
            Historique des exécutions
            <InfoTip>Une ligne par exécution automatique, la plus récente en premier, toutes versions confondues.</InfoTip>
          </h2>
          <label className="row small">
            <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
            Échecs uniquement ({failed.length})
          </label>
        </div>
        {shown.length === 0 ? (
          <div className="empty">Aucune exécution en échec sur les {DAYS} derniers jours.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Exécution</th>
                  <th>Version</th>
                  <th>Durée</th>
                  <th className="num">Commandes remontées</th>
                  <th className="num">Envoyées</th>
                  <th>Résultat</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.runId}>
                    <td>
                      {fmtDateTime(x.startedAt)}
                      {x.periodStart && x.periodEnd && (
                        <div className="small muted">
                          Période du {fmtDateTime(x.periodStart)} au {fmtDateTime(x.periodEnd)}
                        </div>
                      )}
                    </td>
                    <td>v{x.ruleVersion}</td>
                    <td className="small">{duration(x)}</td>
                    <td className="num">{x.rowsReturned == null ? '—' : fmtInt(x.rowsReturned)}</td>
                    <td className="num">{x.rowsToSend == null ? '—' : fmtInt(x.rowsToSend)}</td>
                    <td>
                      {x.status === 'SUCCESS' ? (
                        <span style={{ color: 'var(--good)' }}>
                          ✓ Réussie
                          {(x.attempts ?? 1) > 1 && <span className="small muted"> après {x.attempts} tentatives</span>}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--bad)' }}>
                          ✕ Échec
                          {(x.attempts ?? 1) > 1 && <span className="small muted"> ({x.attempts} tentatives)</span>}
                          {x.errorMessage && <InfoTip align="end">Détail technique, à transmettre à l'équipe data : {x.errorMessage}</InfoTip>}
                        </span>
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
  );
}

function VersionsTab({ r, onRestored }: { r: RuleDetail; onRestored: (draftId: string, from: number) => void }) {
  const versions = r.versions; // plus récente d'abord
  const [confirming, setConfirming] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string>();

  /** Recopie une version antérieure dans le brouillon personnel de l'utilisateur (créé au besoin). */
  async function restore(v: RuleVersion) {
    setRestoring(true);
    setRestoreError(undefined);
    try {
      const content = {
        name: r.name, // le nom identifie la règle : on garde le nom actuel
        description: v.description,
        fraudTypology: v.fraudTypology,
        criticality: v.criticality,
        schedule: v.schedule,
        sqlQuery: v.sqlQuery,
      };
      const d = r.myDraftId ? await api.updateDraft(r.myDraftId, content) : await api.createDraft({ ...content, ruleId: r.ruleId });
      setConfirming(null);
      onRestored(d.id, v.version);
    } catch (e) {
      setRestoreError((e as Error).message);
    } finally {
      setRestoring(false);
    }
  }

  const [a, setA] = useState(versions[1]?.version ?? versions[0].version);
  const [b, setB] = useState(versions[0].version);
  const [shown, setShown] = useState<RuleVersion | null>(null);
  const va = versions.find((v) => v.version === a)!;
  const vb = versions.find((v) => v.version === b)!;

  return (
    <div className="stack">
      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Version</th>
                <th>Statut</th>
                <th>Créée le</th>
                <th>Publiée</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <td>
                    <strong>v{v.version}</strong>
                    {v.version === r.version && <span className="small muted"> (courante)</span>}
                  </td>
                  <td>
                    <StatusBadge status={v.status} lastRunAt={v.lastRunAt} />
                    {v.candidate && <div className="small muted">candidate</div>}
                  </td>
                  <td className="small">{fmtDateTime(v.createdAt)}</td>
                  <td className="small">
                    {fmtDateTime(v.submittedAt)}
                    <div className="muted">{v.submittedByName}</div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                      <button type="button" className="btn btn-sm" onClick={() => setShown(shown?.version === v.version ? null : v)} aria-expanded={shown?.version === v.version}>
                        {shown?.version === v.version ? 'Masquer' : 'Voir le SQL'}
                      </button>
                      {v.version !== r.version &&
                        (confirming === v.version ? (
                          <>
                            <button type="button" className="btn btn-sm btn-primary" disabled={restoring} onClick={() => restore(v)}>
                              {restoring && <span className="spinner" aria-hidden="true" />}
                              Confirmer
                            </button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(null)}>
                              Annuler
                            </button>
                          </>
                        ) : (
                          <button type="button" className="btn btn-sm" onClick={() => setConfirming(v.version)} title={`Repartir de la v${v.version}`}>
                            Restaurer
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirming !== null && (
        <Alert kind="info" title={`Restaurer la v${confirming} ?`}>
          {r.myDraftId
            ? `Le contenu de la v${confirming} remplace celui de votre brouillon en cours.`
            : r.canWithdraw
              ? `Votre publication de la v${r.version}, qui ne s'est jamais exécutée, redevient votre brouillon, avec le contenu de la v${confirming}.`
              : `Un brouillon personnel est créé avec le contenu de la v${confirming}. La v${r.version} reste en place jusqu'à sa publication.`}{' '}
          Il faudra ensuite le tester et le publier.
        </Alert>
      )}
      {restoreError && <Alert kind="error" title={restoreError} />}
      {shown && (
        <section className="card">
          <div className="card-head">
            <h3>Requête de la v{shown.version}</h3>
          </div>
          <div className="card-pad">
            <SqlEditor value={shown.sqlQuery} readOnly ariaLabel={`Requête de la version ${shown.version}`} />
          </div>
        </section>
      )}

      {versions.length > 1 ? (
        <section className="card">
          <div className="card-head">
            <h3>Comparer deux versions</h3>
            <div className="row">
              <label htmlFor="va" className="small muted">
                De
              </label>
              <select id="va" value={a} onChange={(e) => setA(Number(e.target.value))} style={{ width: 'auto' }}>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
              <label htmlFor="vb" className="small muted">
                à
              </label>
              <select id="vb" value={b} onChange={(e) => setB(Number(e.target.value))} style={{ width: 'auto' }}>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="card-pad stack">
            <DiffView before={va.sqlQuery} after={vb.sqlQuery} />
          </div>
        </section>
      ) : (
        <p className="small muted">Une seule version : rien à comparer.</p>
      )}
    </div>
  );
}

function RuleAudit({ ruleId }: { ruleId: string }) {
  const events = useAsync(() => api.listAudit({ ruleId }), [ruleId]);
  if (!events.data) return <Spinner />;
  return (
    <div className="card">
      <AuditTable events={events.data} showRule={false} />
    </div>
  );
}

/**
 * Décision de l'analyste après observation : envoyer la version au prestataire, suspendre l'envoi, ou
 * l'écarter. La plateforme met à jour rules_registry ; le DAG en tient compte au run suivant.
 */
function DecisionPanel({ r, onChange }: { r: RuleDetail; onChange: (d: RuleDetail) => void }) {
  const [confirming, setConfirming] = useState<DecisionAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const decide = async (action: DecisionAction) => {
    setBusy(true);
    setErr(undefined);
    try {
      onChange(await api.decide(r.ruleId, action));
      setConfirming(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const prod = r.candidate ? r.productionVersion : undefined;
  const CONFIRM: Record<DecisionAction, { title: string; text: string; label: string; danger?: boolean }> = {
    send: prod
      ? {
          title: `Mettre la v${r.version} en production à la place de la v${prod} ?`,
          text: `Dès la prochaine exécution, ses commandes seront transmises au prestataire et la v${prod} s'arrêtera.`,
          label: 'Mettre en production',
        }
      : {
          title: `Envoyer la v${r.version} au prestataire ?`,
          text: 'Ses commandes lui seront transmises dès la prochaine exécution.',
          label: "Confirmer l'envoi",
        },
    suspend: {
      title: `Suspendre l'envoi de la v${prod ?? r.version} ?`,
      text: prod
        ? `Ses commandes ne seront plus transmises au prestataire. La v${r.version}, candidate, tournera alors seule, en observation, à la place de la v${prod}.`
        : "Elle continue de s'exécuter, mais ses commandes ne sont plus transmises au prestataire.",
      label: 'Suspendre',
      danger: true,
    },
    discard: {
      title: `Écarter la v${r.version} ?`,
      text: prod
        ? `Elle ne s'exécutera plus ; la v${prod} reste en production.`
        : r.versionCount > 1
          ? "Elle ne s'exécutera plus ; la version précédente reprend sa place (et son envoi au prestataire, si elle était envoyée)."
          : "Elle ne s'exécutera plus. Vous pourrez toujours en créer une nouvelle version.",
      label: 'Écarter',
      danger: true,
    },
  };

  let panel: ReactNode = null;
  if (r.status === 'OBSERVATION' && prod) {
    panel = (
      <div className="decision-card observing">
        <div>
          <strong>
            Candidate en observation{r.firstRunAt ? ` depuis ${idleFor(r.firstRunAt)}` : ''}
            <InfoTip align="start">
              La v{r.version} s'exécute à côté de la v{prod}, qui reste en production et continue d'être envoyée. Comparez-les sur la même
              période dans l'onglet Performance, puis décidez.
            </InfoTip>
          </strong>
        </div>
        <div className="decision-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming('suspend')} disabled={busy}>
            Suspendre l'envoi de la v{prod}
          </button>
          <button type="button" className="btn" onClick={() => setConfirming('discard')} disabled={busy}>
            Écarter
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setConfirming('send')} disabled={busy}>
            Mettre en production
          </button>
        </div>
      </div>
    );
  } else if (r.status === 'OBSERVATION') {
    panel = (
      <div className="decision-card observing">
        <div>
          <strong>
            En observation{r.firstRunAt ? ` depuis ${idleFor(r.firstRunAt)}` : ''}
            <InfoTip align="start">
              La v{r.version} s'exécute, mais ses commandes ne sont pas envoyées au prestataire. Consultez l'onglet Performance, puis décidez.
            </InfoTip>
          </strong>
        </div>
        <div className="decision-actions">
          <button type="button" className="btn" onClick={() => setConfirming('discard')} disabled={busy}>
            Écarter
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setConfirming('send')} disabled={busy}>
            Envoyer au prestataire
          </button>
        </div>
      </div>
    );
  } else if (r.decision === 'SENT' && (r.status === 'IN_PRODUCTION' || r.status === 'INACTIVE')) {
    panel = (
      <div className="decision-card sent">
        <span>
          ✓ Envoyée au prestataire
          {r.decidedAt && ` depuis le ${fmtDateTime(r.decidedAt)}`}
          {r.decidedByName && ` (décision de ${r.decidedByName})`}
        </span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming('suspend')} disabled={busy}>
          Suspendre l'envoi
        </button>
      </div>
    );
  } else if (r.status === 'DISCARDED') {
    panel = (
      <div className="decision-card">
        <span>
          Écartée{r.decidedAt && ` le ${fmtDateTime(r.decidedAt)}`}
          {r.decidedByName && ` par ${r.decidedByName}`} : elle ne s'exécute plus.
        </span>
      </div>
    );
  }
  if (!panel) return null;
  const c = confirming ? CONFIRM[confirming] : null;
  return (
    <>
      {panel}
      {c && confirming && (
        <Alert kind={c.danger ? 'warn' : 'info'} title={c.title}>
          {c.text}
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className={`btn btn-sm ${c.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => decide(confirming)} disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {c.label}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(null)} disabled={busy}>
              Annuler
            </button>
          </div>
        </Alert>
      )}
      {err && <Alert kind="error" title={err} />}
    </>
  );
}

/** Mode démo uniquement : simule ce qu'Airflow écrit dans rule_runs. */
function DemoPanel({ r, onChange }: { r: RuleDetail; onChange: (d: RuleDetail) => void }) {
  const [err, setErr] = useState<string>();
  const waiting = r.versions.some((v) => v.status === 'SUBMITTED');
  const running = r.versions.find((v) => v.status === 'IN_PRODUCTION' || v.status === 'OBSERVATION');
  const act = async (fn: (id: string) => Promise<RuleDetail>) => {
    setErr(undefined);
    try {
      onChange(await fn(r.ruleId));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="demo-panel stack" style={{ marginTop: 24, gap: 8 }}>
      <div>
        <strong>Simulation des exécutions</strong> <span className="small muted">— mode démo uniquement</span>
        <InfoTip>
          En réel, la plateforme constate les exécutions automatiques : une version qui s'exécute passe « En observation » (puis « En
          production » une fois envoyée), une version qui ne s'exécute plus depuis 3 échéances passe « Inactive ».
        </InfoTip>
      </div>
      <div className="row">
        {waiting && (
          <button type="button" className="btn btn-sm" onClick={() => act(api.demo!.simulateRuns)}>
            Simuler les premières exécutions
          </button>
        )}
        {running && (
          <button type="button" className="btn btn-sm btn-danger" onClick={() => act(api.demo!.simulateStop)}>
            Simuler l'arrêt des exécutions
          </button>
        )}
        {!waiting && !running && <span className="small muted">Aucune simulation possible dans cet état.</span>}
      </div>
      {err && <span className="error-text">{err}</span>}
    </div>
  );
}
