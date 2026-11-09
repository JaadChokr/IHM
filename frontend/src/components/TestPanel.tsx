import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { DryRunResult, ExecutionResult, Schedule, SqlIssue, TestTarget } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { fmtBytes, fmtDuration, fmtInt, fmtPct } from '../lib/format';
import { fmtPeriod, lastPeriod } from '../lib/period';
import { queryHash } from '../lib/sql';
import { Alert, InfoTip, Spinner } from './ui';

interface Options {
  sql: string;
  /** Brouillon ou règle testée ; absent : test libre (rattaché au brouillon à son premier enregistrement). */
  target?: TestTarget;
  /** Fréquence de la règle : fixe la période testée (dernière période complète de son DAG). */
  schedule: Schedule;
  onIssues: (issues: SqlIssue[]) => void;
  /** Appelé après chaque test (pour rafraîchir l'historique / l'éligibilité à la soumission). */
  onTested?: () => void;
  /** Appelé après une exécution réussie, avec l'empreinte de la requête testée. */
  onExecuted?: (hash: string) => void;
}

type Phase = 'idle' | 'dry-running' | 'dry-done' | 'executing' | 'exec-done';

/**
 * État du test d'une requête, partagé entre les boutons (sous l'éditeur, `TestActions`) et le bloc de
 * résultat (à part, `TestResults`) : « Valider la syntaxe » (dry-run gratuit) puis « Tester la requête ».
 */
export function useQueryTest({ sql, target: base, schedule, onIssues, onTested, onExecuted }: Options) {
  const target: TestTarget = { ...base, schedule };
  const guard = useAsync(() => api.getGuardrails(), []);
  const [phase, setPhase] = useState<Phase>('idle');
  const [dry, setDry] = useState<DryRunResult>();
  // Résultat d'exécution : uniquement en mémoire, jamais persisté (PRD §10).
  const [exec, setExec] = useState<ExecutionResult>();
  const [error, setError] = useState<string>();
  const [testedHash, setTestedHash] = useState<string>();

  const hash = queryHash(sql);
  const stale = testedHash !== undefined && testedHash !== hash;

  async function runDry() {
    setPhase('dry-running');
    setDry(undefined);
    setExec(undefined);
    setError(undefined);
    try {
      const r = await api.dryRun(sql, target);
      setDry(r);
      setTestedHash(hash);
      onIssues(r.issues);
      setPhase('dry-done');
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    } finally {
      onTested?.();
    }
  }

  async function runExec() {
    setPhase('executing');
    setError(undefined);
    try {
      setExec(await api.execute(sql, target));
      setPhase('exec-done');
      onExecuted?.(hash);
    } catch (e) {
      setError((e as Error).message);
      setPhase('dry-done');
    } finally {
      onTested?.();
    }
  }

  const busy = phase === 'dry-running' || phase === 'executing';
  return {
    sql,
    schedule,
    phase,
    dry,
    exec,
    error,
    stale,
    busy,
    guardrails: guard.data,
    canExec: !!dry?.ok && !dry.exceedsBytesLimit && !stale && !busy,
    runDry,
    runExec,
  };
}

export type QueryTest = ReturnType<typeof useQueryTest>;

/** Boutons sous l'éditeur, alignés à droite comme ceux d'un formulaire ; l'état de la validation à gauche. */
export function TestActions({ t }: { t: QueryTest }) {
  const { dry, stale, busy, phase } = t;
  return (
    <div className="test-toolbar">
      <span className="small test-hint">
        {stale ? (
          <span className="test-inline warn">⚠ Requête modifiée depuis la validation : validez à nouveau.</span>
        ) : dry && !dry.ok && !busy ? (
          <span className="test-inline bad">
            ✕ Syntaxe invalide · {dry.issues.filter((i) => i.severity === 'error').length} erreur
            {dry.issues.filter((i) => i.severity === 'error').length > 1 ? 's' : ''} (détail ci-dessous)
          </span>
        ) : dry?.ok && !busy ? (
          <span className={`test-inline ${dry.exceedsBytesLimit ? 'bad' : 'good'}`}>
            {dry.exceedsBytesLimit ? '✕' : '✓'} Syntaxe valide · {fmtBytes(dry.bytesProcessed ?? 0)} à lire
          </span>
        ) : (
          <span className="muted">
            Période testée {fmtPeriod(lastPeriod(t.schedule))}
            <InfoTip>
              Si la requête utilise <span className="mono">@period_start</span> / <span className="mono">@period_end</span>, ce sont leurs
              valeurs pendant le test : la dernière période complète de sa fréquence. <span className="mono">CURRENT_DATE()</span> donne la
              date du jour.
            </InfoTip>
          </span>
        )}
      </span>
      <span className="test-buttons">
        <button type="button" className="btn" onClick={t.runDry} disabled={busy || !t.sql.trim()}>
          {phase === 'dry-running' ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">✓</span>} Valider la syntaxe
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={t.runExec}
          disabled={!t.canExec}
          title={t.canExec ? undefined : dry?.ok && dry.exceedsBytesLimit ? 'Volume à lire au-delà du plafond' : "Validez d'abord la syntaxe de la requête actuelle"}
        >
          {phase === 'executing' ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">▶</span>} Tester la requête
        </button>
      </span>
    </div>
  );
}

/** Bloc de résultat, distinct du bloc de la requête ; absent tant que rien n'a été lancé. */
export function TestResults({ t, onGoTo }: { t: QueryTest; onGoTo: (line: number, column?: number) => void }) {
  const { dry, exec, phase, error, stale } = t;
  const g = t.guardrails;
  const errors = dry?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = dry?.issues.filter((i) => i.severity === 'warning') ?? [];

  // Quand un résultat apparaît, la page descend jusqu'à lui (sans animation si l'utilisateur la refuse).
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (dry || exec || error)
      ref.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: exec ? 'start' : 'nearest',
      });
  }, [dry, exec, error]);

  // Une validation réussie s'affiche à côté des boutons : le bloc n'apparaît que s'il a quelque chose à dire.
  const shown = !!error || !!exec || phase === 'executing' || (!!dry && (!dry.ok || dry.exceedsBytesLimit || warnings.length > 0));
  if (!shown) return null;
  return (
    <section className="card test-anchor" ref={ref} aria-labelledby="test-results-title" aria-live="polite">
      <div className="card-head">
        <div>
          <h2 id="test-results-title">Résultat du test</h2>
          {stale && <p>La requête a changé depuis : ce résultat porte sur la version précédente.</p>}
        </div>
      </div>
      <div className="card-pad stack" style={{ gap: 12 }}>
        {error && <Alert kind="error" title={error} />}

        {/* Requête refusée : les erreurs d'abord, cliquables vers la ligne fautive */}
        {dry && !dry.ok && (
          <div className="test-status bad">
            <strong>La requête ne peut pas être exécutée</strong>
            <ul className="issue-list">
              {errors.map((i, k) => (
                <IssueItem key={k} issue={i} onGoTo={onGoTo} />
              ))}
            </ul>
          </div>
        )}
        {dry?.ok && dry.exceedsBytesLimit && (
          <Alert kind="error" title={`Test impossible : ${fmtBytes(dry.bytesProcessed ?? 0)} à lire, au-delà du plafond de ${g ? fmtBytes(g.maxBytesBilled) : '…'}.`}>
            Restreignez la période ou les tables lues.
          </Alert>
        )}
        {phase === 'executing' && <Spinner label="Exécution et recoupement avec les autres règles…" />}

        {exec && <ExecSummary exec={exec} />}

        {dry && warnings.length > 0 && (
          <ul className="issue-list">
            {warnings.map((i, k) => (
              <IssueItem key={k} issue={i} onGoTo={onGoTo} />
            ))}
          </ul>
        )}

        {exec && (
          <p className="small muted test-meta">
            Période testée {fmtPeriod(exec.period)} · {fmtDuration(exec.durationMs)} · {fmtBytes(exec.bytesProcessed)} lus
          </p>
        )}

        {exec && (
          <details className="test-sample" open>
            <summary>
              Aperçu : {fmtInt(exec.rows.length)} ligne{exec.rows.length > 1 ? 's' : ''} sur {fmtInt(exec.totalRows)}, {exec.columns.length} colonne
              {exec.columns.length > 1 ? 's' : ''}
              <span className="small muted"> · non conservé après fermeture de la page</span>
            </summary>
            {exec.rows.length === 0 ? (
              <div className="empty">La requête ne remonte aucune commande.</div>
            ) : (
              <div className="results">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num" style={{ width: 1 }}>#</th>
                      {exec.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {exec.rows.map((r, i) => (
                      <tr key={i}>
                        <td className="num muted">{i + 1}</td>
                        {exec.columns.map((c) => (
                          <td key={c}>{String(r[c] ?? 'NULL')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        )}
      </div>
    </section>
  );
}

/**
 * Les chiffres qui comptent : commandes remontées, dont nouvelles et déjà remontées par une autre règle
 * (table rule_alerts), avec la répartition par règle.
 */
function ExecSummary({ exec }: { exec: ExecutionResult }) {
  const total = exec.ordersFlagged;
  const already = exec.ordersAlreadyFlagged;
  const known = already != null;
  const fresh = known ? total - already : null;
  const share = (n: number) => (total > 0 ? n / total : 0);
  return (
    <section className="test-result" aria-label="Résultat du test">
      <div className="test-kpis">
        <div className="test-kpi">
          <span className="test-kpi-label">Commandes remontées</span>
          <span className="test-kpi-value">{fmtInt(total)}</span>
          <span className="test-kpi-sub">commandes distinctes</span>
        </div>
        <div className="test-kpi">
          <span className="test-kpi-label">
            <span className="legend-key key-new" aria-hidden="true" />
            Nouvelles
          </span>
          <span className="test-kpi-value">{fresh === null ? '—' : fmtInt(fresh)}</span>
          <span className="test-kpi-sub">{fresh === null ? 'recoupement indisponible' : `${fmtPct(share(fresh))} du total`}</span>
        </div>
        <div className="test-kpi">
          <span className="test-kpi-label">
            <span className="legend-key key-known" aria-hidden="true" />
            Déjà remontées ailleurs
          </span>
          <span className="test-kpi-value">{known ? fmtInt(already) : '—'}</span>
          <span className="test-kpi-sub">
            {known ? `${fmtPct(share(already))} · par une autre règle, ${exec.overlapDays} derniers jours` : 'recoupement indisponible'}
          </span>
        </div>
      </div>

      {known && total > 0 && (
        <div className="split-bar" role="img" aria-label={`${fmtInt(fresh!)} nouvelles, ${fmtInt(already)} déjà remontées par une autre règle`}>
          <span className="key-new" style={{ width: `${share(fresh!) * 100}%` }} />
          <span className="key-known" style={{ width: `${share(already) * 100}%` }} />
        </div>
      )}

      {known && total > 0 && already === 0 && <p className="small muted" style={{ margin: 0 }}>Aucune de ces commandes n'est remontée par une autre règle.</p>}
    </section>
  );
}

function IssueItem({ issue, onGoTo }: { issue: SqlIssue; onGoTo: (l: number, c?: number) => void }) {
  return (
    <li>
      <span className={`issue-sev ${issue.severity}`}>{issue.severity === 'error' ? 'Erreur' : 'Alerte'}</span>
      <span style={{ wordBreak: 'break-word' }}>
        {issue.message}{' '}
        {issue.line && (
          <button type="button" className="linkish small" onClick={() => onGoTo(issue.line!, issue.column)}>
            ligne {issue.line}
            {issue.column ? `, col. ${issue.column}` : ''}
          </button>
        )}
      </span>
    </li>
  );
}
