import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { CRITICALITIES, EVERY, type Draft, type Schedule, type RuleDetail, type RuleInput, type SqlIssue } from '../api/types';
import { SqlEditor, type SqlEditorHandle } from '../components/SqlEditor';
import { TestActions, TestResults, useQueryTest } from '../components/TestPanel';
import { Breadcrumb } from '../components/Breadcrumb';
import { usePageTitle } from '../nav/history';
import { Alert, InfoTip, Spinner, StatusBadge } from '../components/ui';
import { CRITICALITY_LABEL, FRAUD_TYPOLOGIES, SCHEDULE_UNIT, STATUS_LABEL, fmtDateTime, scheduleWhen } from '../lib/format';
import { fmtRun, nextRun } from '../lib/period';
import { checkParams, queryHash } from '../lib/sql';
import { readPref, writePref } from '../prefs/prefs';

const EMPTY: RuleInput = {
  name: '',
  description: '',
  fraudTypology: '',
  criticality: 'MEDIUM',
  schedule: 'DAILY',
  scheduleEvery: 1,
  sqlQuery: `SELECT
  o.order_id
FROM \`sales.orders\` o
WHERE o.order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)  -- la veille
`,
};

const toInput = (r: RuleInput): RuleInput => ({
  name: r.name,
  description: r.description,
  fraudTypology: r.fraudTypology,
  criticality: r.criticality,
  schedule: r.schedule,
  scheduleEvery: r.scheduleEvery ?? 1, // saisie locale antérieure au pas : 1
  sqlQuery: r.sqlQuery,
});

/** Unités dans l'ordre du sélecteur de fréquence. */
const UNITS: Schedule[] = ['HOURLY', 'DAILY', 'WEEKLY'];
const UNIT_LABEL: Record<Schedule, string> = { HOURLY: 'Heures', DAILY: 'Jours', WEEKLY: 'Semaines' };
/** « Toutes les heures », « Toutes les 2 heures », « Tous les 3 jours »… */
function everyLabel(u: Schedule, n: number): string {
  const many = SCHEDULE_UNIT[u][1];
  const det = u === 'DAILY' ? 'Tous les' : 'Toutes les';
  return n === 1 ? `${det} ${many}` : `${det} ${n} ${many}`;
}

const same = (a: RuleInput, b: RuleInput) => JSON.stringify(a) === JSON.stringify(b);

interface StoredDraft {
  form: RuleInput;
  savedAt: string;
}

/**
 * Éditeur = espace de travail du brouillon personnel (visible de son seul auteur).
 *  - /rules/new             nouvelle règle (le brouillon est créé au premier enregistrement) ;
 *  - /rules/:ruleId/edit    nouvelle version d'une règle, ou reprise d'une publication jamais exécutée ;
 *  - /drafts/:draftId       brouillon existant : enregistrer, tester, publier ou supprimer.
 */
export function RuleEditorPage() {
  const { ruleId, draftId } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const flash = (loc.state as { flash?: string } | null)?.flash;
  const draftKey = `editorDraft.${draftId ?? ruleId ?? 'new'}`;

  const [rule, setRule] = useState<RuleDetail>();
  const [draft, setDraft] = useState<Draft>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [base, setBase] = useState<RuleInput>(EMPTY);
  const [form, setForm] = useState<RuleInput>(EMPTY);
  const [restorable, setRestorable] = useState<StoredDraft | null>(null);
  const [dryIssues, setDryIssues] = useState<SqlIssue[]>();
  const [execHash, setExecHash] = useState<string>();
  const [nameTaken, setNameTaken] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState<'save' | 'submit' | 'delete' | null>(null);
  const [error, setError] = useState<string>();
  const editor = useRef<SqlEditorHandle>(null);
  // Le test se pilote sous l'éditeur (boutons) et s'affiche dans un bloc à part (résultat).
  const test = useQueryTest({
    sql: form.sqlQuery,
    target: draft ? { draftId: draft.id } : rule ? { excludeRuleId: rule.ruleId } : undefined,
    schedule: form.schedule,
    scheduleEvery: form.scheduleEvery,
    onIssues: setDryIssues,
    onExecuted: setExecHash,
  });
  const targetRuleId = draft?.ruleId ?? rule?.ruleId;

  // Chargement + proposition de restaurer un brouillon non enregistré (localStorage).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let initial = EMPTY;
      try {
        if (draftId) {
          const d = await api.getDraft(draftId);
          if (cancelled) return;
          setDraft(d);
          initial = toInput(d);
          const t = d.lastTest;
          if (t?.success && t.phase === 'EXECUTION') setExecHash(t.queryHash);
        } else if (ruleId) {
          const r = await api.getRule(ruleId);
          if (cancelled) return;
          // Un brouillon par règle et par personne : on reprend celui qui existe.
          if (r.myDraftId) return nav(`/drafts/${r.myDraftId}`, { replace: true });
          setRule(r);
          initial = toInput(r);
        }
      } catch (e) {
        setLoadError((e as Error).message);
        return;
      }
      setBase(initial);
      setForm(initial);
      const stored = readPref<StoredDraft | null>(draftKey, null);
      if (stored && !same(stored.form, initial)) setRestorable(stored);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleId, draftId, draftKey]);

  const dirty = !same(form, base);

  // Sauvegarde locale du texte non enregistré.
  useEffect(() => {
    if (!dirty || restorable) return;
    const t = setTimeout(() => writePref(draftKey, { form, savedAt: new Date().toISOString() } satisfies StoredDraft), 500);
    return () => clearTimeout(t);
  }, [form, dirty, draftKey, restorable]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // Unicité du nom.
  useEffect(() => {
    const name = form.name.trim();
    if (!name) return setNameTaken(false);
    const t = setTimeout(() => api.checkNameAvailable(name, targetRuleId).then((ok) => setNameTaken(!ok)), 300);
    return () => clearTimeout(t);
  }, [form.name, targetRuleId]);

  const paramIssues = useMemo(() => checkParams(form.sqlQuery), [form.sqlQuery]);
  const hash = queryHash(form.sqlQuery);
  const editorIssues = dryIssues ?? paramIssues;

  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setSql = (v: string) => {
    setDryIssues(undefined); // les positions ne sont plus valides
    set('sqlQuery', v);
  };

  const missing = {
    name: !form.name.trim(),
    description: !form.description.trim(),
    fraudTypology: !form.fraudTypology,
    sqlQuery: !form.sqlQuery.trim(),
  };
  const formValid = !Object.values(missing).some(Boolean) && !nameTaken;
  const withdraws = !!rule?.canWithdraw;
  const heading = draft
    ? `Brouillon — ${draft.name}`
    : rule
      ? withdraws
        ? `Modifier la v${rule.version} — ${rule.name}`
        : `Nouvelle version — ${rule.name}`
      : 'Nouvelle règle';
  usePageTitle(draft || rule || !(ruleId || draftId) ? heading : undefined);
  const canSubmit = formValid && execHash === hash && !paramIssues.some((i) => i.severity === 'error');
  const submitHint = 'Une exécution de test réussie sur la requête actuelle est requise';
  // Un collègue a publié une version depuis que ce brouillon a été commencé.
  const behind = draft && draft.latestVersion !== undefined && draft.latestVersion !== draft.baseVersion;

  async function persist(): Promise<Draft> {
    if (draft && !dirty) return draft;
    const d = draft ? await api.updateDraft(draft.id, form) : await api.createDraft({ ...form, ruleId: rule?.ruleId });
    writePref(draftKey, null);
    setBase(form);
    setDraft(d);
    return d;
  }

  async function save(e?: FormEvent, andSubmit = false) {
    e?.preventDefault();
    setSubmitted(true);
    if (!formValid) return;
    setSaving(andSubmit ? 'submit' : 'save');
    setError(undefined);
    try {
      const d = await persist();
      if (andSubmit) {
        const r = await api.submitDraft(d.id);
        nav(`/rules/${r.ruleId}`, { state: { flash: 'submitted' } });
      } else {
        nav(`/drafts/${d.id}`, { replace: true, state: { flash: d.withdrawn ? 'withdrawn' : 'saved' } });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  async function remove() {
    if (!draft) return;
    setSaving('delete');
    try {
      await api.deleteDraft(draft.id);
      writePref(draftKey, null);
      nav(draft.newRule ? '/drafts' : `/rules/${draft.ruleId}`, { state: { flash: 'draftDeleted' } });
    } catch (err) {
      setError((err as Error).message);
      setSaving(null);
    }
  }

  if (loadError) return <Alert kind="error" title={loadError} />;
  if ((ruleId && !rule) || (draftId && !draft)) return <Spinner />;
  const cancelTo = draft ? (draft.newRule ? '/drafts' : `/rules/${draft.ruleId}`) : rule ? `/rules/${rule.ruleId}` : '/rules';

  const err = (k: keyof typeof missing) => submitted && missing[k];

  return (
    <form onSubmit={save} noValidate>
      <div className="page-head">
        <div>
          <Breadcrumb
            items={
              draft
                ? [{ label: 'Mes brouillons', to: '/drafts' }, { label: draft.name }]
                : rule
                  ? [
                      { label: 'Règles', to: '/rules' },
                      { label: rule.name, to: `/rules/${rule.ruleId}` },
                      { label: withdraws ? 'Modifier' : 'Nouvelle version' },
                    ]
                  : [{ label: 'Règles', to: '/rules' }, { label: 'Nouvelle règle' }]
            }
          />
          <h1>{heading}</h1>
          <p>
            {draft
              ? draft.newRule
                ? 'Nouvelle règle, '
                : `Nouvelle version de la règle (préparée à partir de la v${draft.baseVersion ?? draft.latestVersion}), `
              : 'Décrivez la règle, écrivez la requête, testez-la, puis publiez-la. Brouillon '}
            visible de vous seul jusqu'à sa publication.
          </p>
        </div>
        <div className="row">
          <Link to={cancelTo} className="btn">
            {draft ? 'Fermer' : 'Annuler'}
          </Link>
          <button type="submit" className="btn" disabled={!!saving}>
            {saving === 'save' && <span className="spinner" aria-hidden="true" />}
            Enregistrer le brouillon
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!saving || !canSubmit}
            title={canSubmit ? undefined : submitHint}
            onClick={() => save(undefined, true)}
          >
            {saving === 'submit' && <span className="spinner" aria-hidden="true" />}
            Enregistrer et publier
          </button>
        </div>
      </div>

      <div className="stack">
        {flash === 'saved' && !dirty && (
          <Alert
            kind="success"
            title={
              <>
                Brouillon enregistré.
                <InfoTip align="start">Vous seul le voyez ; reprenez-le quand vous voulez depuis « Mes brouillons ».</InfoTip>
              </>
            }
          />
        )}
        {flash === 'withdrawn' && !dirty && (
          <Alert
            kind="success"
            title={
              <>
                Publication retirée : la version est redevenue votre brouillon. Testez-la puis publiez-la à nouveau.
                <InfoTip align="start">Elle ne s'exécutera pas ; la version précédente, s'il y en a une, reprend sa place.</InfoTip>
              </>
            }
          />
        )}
        {flash?.startsWith('restored:') && !dirty && (
          <Alert kind="success" title={`Contenu de la v${flash.split(':')[1]} repris dans votre brouillon : testez-le puis publiez-le.`} />
        )}
        {behind && (
          <Alert
            kind="warn"
            title={
              <>
                La <Link to={`/rules/${draft.ruleId}`}>v{draft.latestVersion}</Link> a été publiée depuis le début de ce brouillon : vérifiez qu'il
                en tient compte.
                <InfoTip align="start">
                  Vous êtes parti{draft.baseVersion ? ` de la v${draft.baseVersion}` : ' d’une version précédente'}. À la publication, ce
                  brouillon deviendra la v{draft.latestVersion! + 1}.
                </InfoTip>
              </>
            }
          />
        )}
        {restorable && (
          <Alert kind="info" title="Un brouillon non enregistré a été retrouvé sur ce poste.">
            <div className="row" style={{ marginTop: 6 }}>
              <span className="small muted">Dernière saisie : {fmtDateTime(restorable.savedAt)}</span>
              <button type="button" className="btn btn-sm" onClick={() => { setForm(toInput(restorable.form)); setRestorable(null); }}>
                Restaurer
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { writePref(draftKey, null); setRestorable(null); }}>
                Ignorer
              </button>
            </div>
          </Alert>
        )}
        {rule && withdraws && (
          <Alert
            kind="info"
            title={
              <>
                La v{rule.version}, publiée par vous, ne s'est pas encore exécutée : vous pouvez la reprendre.
                <InfoTip align="start">
                  À l'enregistrement, elle redevient votre brouillon et ne s'exécutera pas ; la version précédente reprend sa place. Il faudra la
                  retester puis la publier à nouveau ; elle gardera le numéro v{rule.version}.
                </InfoTip>
              </>
            }
          />
        )}
        {rule && !withdraws && (
          <Alert
            kind="info"
            title={
              <>
                Nouvelle version à partir de la v{rule.version} (« {STATUS_LABEL[rule.status]} »).
                <InfoTip align="start">
                  La v{rule.version} reste inchangée
                  {rule.status === 'IN_PRODUCTION' || rule.status === 'INACTIVE' ? ' et continue de s’exécuter' : ''} jusqu'à la publication de
                  votre brouillon, qui deviendra la v{rule.version + 1}. D'ici là, personne d'autre ne le voit.
                </InfoTip>
              </>
            }
          />
        )}
        {confirmDelete && draft && (
          <Alert kind="warn" title="Supprimer ce brouillon ?">
            Son contenu sera perdu{draft.newRule ? '' : ` ; la règle et ses versions publiées ne changent pas`}.
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-sm btn-danger" onClick={remove} disabled={!!saving}>
                {saving === 'delete' && <span className="spinner" aria-hidden="true" />}
                Supprimer
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(false)}>
                Annuler
              </button>
            </div>
          </Alert>
        )}
        {error && <Alert kind="error" title={error} />}

        <section className="card" aria-labelledby="sec-def">
          <div className="card-head">
            <h2 id="sec-def">Définition</h2>
            <StatusBadge status="DRAFT" />
          </div>
          <div className="card-pad form-grid">
            <div className="field span-2">
              <label htmlFor="name">
                Nom<span className="req" aria-hidden="true">*</span>
              </label>
              <input
                id="name"
                type="text"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                aria-invalid={err('name') || nameTaken}
                aria-describedby="name-msg"
                required
              />
              <span id="name-msg" className={err('name') || nameTaken ? 'error-text' : 'hint'}>
                {nameTaken ? 'Une autre règle porte déjà ce nom.' : err('name') ? 'Le nom est obligatoire.' : 'Unique sur la plateforme.'}
              </span>
            </div>
            <div className="field">
              <label htmlFor="typology">
                Typologie de fraude<span className="req" aria-hidden="true">*</span>
              </label>
              <select id="typology" value={form.fraudTypology} onChange={(e) => set('fraudTypology', e.target.value)} aria-invalid={err('fraudTypology')} required>
                <option value="">— Choisir —</option>
                {FRAUD_TYPOLOGIES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              {err('fraudTypology') && <span className="error-text">La typologie est obligatoire.</span>}
            </div>
            <div className="field span-2">
              <label htmlFor="description">
                Description métier<span className="req" aria-hidden="true">*</span>
              </label>
              <textarea
                id="description"
                rows={3}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                aria-invalid={err('description')}
                aria-describedby="desc-msg"
                required
              />
              <span id="desc-msg" className={err('description') ? 'error-text' : 'hint'}>
                {err('description') ? 'La description est obligatoire.' : 'Le scénario de fraude visé, en quelques phrases.'}
              </span>
            </div>
            <div className="stack" style={{ gap: 14 }}>
              <fieldset className="field" style={{ border: 'none', padding: 0, margin: 0 }}>
                <legend className="label">
                  Criticité<span className="req" aria-hidden="true">*</span>
                </legend>
                <div className="seg seg-fill" style={{ marginTop: 4 }}>
                  {CRITICALITIES.map((c) => (
                    <button type="button" key={c} aria-pressed={form.criticality === c} onClick={() => set('criticality', c)}>
                      {CRITICALITY_LABEL[c]}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="field">
                <label htmlFor="schedule-every" id="schedule-every-label">
                  Fréquence d'exécution souhaitée<span className="req" aria-hidden="true">*</span>
                  <InfoTip>
                    Les heures d'exécution sont fixes : toutes les 2 h = 0 h 05, 2 h 05, 4 h 05… ; chaque jour à 3 h ; chaque lundi à 4 h. La
                    requête porte sur la période écoulée depuis l'exécution précédente (@period_start / @period_end).
                  </InfoTip>
                </label>
                <div className="frequency">
                  <div className="field">
                    <span className="hint" id="schedule-unit-label">Unité</span>
                    <select
                      id="schedule-every"
                      aria-labelledby="schedule-every-label schedule-unit-label"
                      value={form.schedule}
                      onChange={(e) => {
                        const u = e.target.value as Schedule;
                        // Pas impossible dans la nouvelle unité (ex. 5 jours → heures) : retour à 1.
                        setForm((f) => ({ ...f, schedule: u, scheduleEvery: EVERY[u].includes(f.scheduleEvery) ? f.scheduleEvery : 1 }));
                      }}
                    >
                      {UNITS.map((u) => (
                        <option key={u} value={u}>
                          {UNIT_LABEL[u]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <span className="hint" id="schedule-step-label">Pas</span>
                    <select
                      aria-labelledby="schedule-every-label schedule-step-label"
                      value={form.scheduleEvery}
                      onChange={(e) => set('scheduleEvery', Number(e.target.value))}
                    >
                      {EVERY[form.schedule].map((n) => (
                        <option key={n} value={n}>
                          {everyLabel(form.schedule, n)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="small muted">
                  Exécution {scheduleWhen(form.schedule, form.scheduleEvery)} · prochaine le {fmtRun(nextRun(form.schedule, form.scheduleEvery))}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="card" aria-labelledby="sec-sql">
          <div className="card-head">
            <div>
              <h2 id="sec-sql">
                Requête SQL
                <InfoTip>
                  Une seule requête <span className="mono">SELECT</span>, qui renvoie la colonne <span className="mono">order_id</span>. Écrivez
                  les seuils directement (ex. <span className="mono">amount_eur &gt;= 500</span>) ; pour la veille :{' '}
                  <span className="mono">DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)</span>. Facultatif :{' '}
                  <span className="mono">@period_start</span> / <span className="mono">@period_end</span>, début et fin de la période traitée
                  par chaque exécution.
                </InfoTip>
              </h2>
              <p>
                Un <span className="mono">SELECT</span> qui renvoie <span className="mono">order_id</span>.
              </p>
            </div>
          </div>
          <div className="card-pad stack">
            <SqlEditor ref={editor} value={form.sqlQuery} onChange={setSql} issues={editorIssues} ariaLabel="Requête SQL (GoogleSQL)" />
            {err('sqlQuery') && <span className="error-text">La requête est obligatoire.</span>}
            {paramIssues.length > 0 && (
              <ul className="issue-list" aria-label="Contrôles des paramètres">
                {paramIssues.map((i, k) => (
                  <li key={k}>
                    <span className={`issue-sev ${i.severity}`}>{i.severity === 'error' ? 'Erreur' : 'Alerte'}</span>
                    <span>
                      {i.message}{' '}
                      {i.line && (
                        <button type="button" className="linkish small" onClick={() => editor.current?.goTo(i.line!, i.column)}>
                          ligne {i.line}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div id="sec-test">
              <TestActions t={test} />
            </div>
          </div>
        </section>

        <TestResults t={test} onGoTo={(l, c) => editor.current?.goTo(l, c)} />

        <div className="row">
          <span className="small muted">
            {dirty
              ? 'Modifications non enregistrées (conservées localement sur ce poste en attendant).'
              : draft
                ? `Brouillon enregistré le ${fmtDateTime(draft.updatedAt)}.`
                : 'Aucune modification.'}
          </span>
          <span className="spacer" />
          {draft && (
            <button type="button" className="btn btn-ghost" disabled={!!saving} onClick={() => setConfirmDelete(true)}>
              Supprimer le brouillon
            </button>
          )}
          <button type="submit" className="btn" disabled={!!saving}>
            Enregistrer le brouillon
          </button>
          <button type="button" className="btn btn-primary" disabled={!!saving || !canSubmit} onClick={() => save(undefined, true)}>
            Enregistrer et publier
          </button>
        </div>
        {!canSubmit && (
          <p className="small muted" style={{ margin: 0, textAlign: 'right' }}>
            La publication exige tous les champs obligatoires et une exécution de test réussie sur la requête actuelle.
          </p>
        )}
      </div>
    </form>
  );
}
