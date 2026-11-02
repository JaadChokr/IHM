// Implémentation en mémoire de l'API, pour la démo et le développement front
// sans back-end. Elle joue le rôle du serveur : l'état est persisté dans le
// localStorage *uniquement* pour que la démo survive à un rechargement.

import type { Api } from '../client';
import {
  ApiError,
  type AuditEvent,
  type DailyPerformance,
  type Draft,
  type Guardrails,
  type RuleDetail,
  type RuleInput,
  type RuleRun,
  type RuleSummary,
  type RuleVersion,
  type TestRecord,
  type TestTarget,
  type User,
  type VersionPerformance,
} from '../types';
import { buildSeed, SCHEMA_VERSION, type MockDb, type MockDraft, type MockRule } from './seed';
import { simulateDryRun, simulateExecution } from './bigquery';
import { queryHash } from '../../lib/sql';
import { addDays, isoDate } from '../../lib/format';

const DB_KEY = 'rm.mock.db';
const SESSION_KEY = 'rm.mock.session';
const SESSION_TTL_MS = 8 * 3600 * 1000; // 8 h glissantes (PRD F8)
const LATENCY_DAYS = 7;

const GUARDRAILS: Guardrails = {
  maxBytesBilled: 50e9,
  jobTimeoutMs: 60_000,
  maxResults: 100,
};

interface Session {
  matricule: string;
  lastSeen: number;
  pendingProfile?: boolean;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : la démo fonctionne en mémoire */
  }
}

const delay = (min = 120, max = 320) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const now = () => new Date().toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const normalize = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function rnd(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export function createMockApi(): Api {
  let db: MockDb = (() => {
    const stored = read<MockDb>(DB_KEY);
    return stored && stored.schema === SCHEMA_VERSION ? stored : buildSeed();
  })();
  let session: Session | null = read<Session>(SESSION_KEY);
  const save = () => write(DB_KEY, db);
  const saveSession = () => write(SESSION_KEY, session);

  // ---------- identité : un seul point de résolution (PRD §5.4, règle 2) ----------
  function currentUser(): User {
    if (!session || session.pendingProfile || Date.now() - session.lastSeen > SESSION_TTL_MS) {
      throw new ApiError(401, 'Session expirée ou absente.');
    }
    const user = db.users.find((u) => u.matricule === session!.matricule);
    if (!user) throw new ApiError(401, 'Utilisateur inconnu.');
    session.lastSeen = Date.now();
    saveSession();
    return user;
  }
  const fullName = (u: User) => `${u.firstName} ${u.lastName}`;

  function audit(u: User, action: AuditEvent['action'], r?: RuleVersion, details?: string) {
    db.audit.unshift({
      id: uid(),
      at: now(),
      matricule: u.matricule,
      userName: fullName(u),
      action,
      ruleId: r?.ruleId,
      ruleName: r?.name,
      version: r?.version,
      details,
    });
  }

  // ---------- règles ----------
  const findRule = (id: string): MockRule => {
    const r = db.rules.find((x) => x.ruleId === id);
    if (!r) throw new ApiError(404, 'Règle introuvable.');
    return r;
  };
  const current = (r: MockRule) => r.versions[r.versions.length - 1];

  function lastTestFor(ruleId: string, version: number): TestRecord | undefined {
    return db.tests.filter((t) => t.ruleId === ruleId && t.version === version).sort((a, b) => b.at.localeCompare(a.at))[0];
  }

  // ---------- statuts déduits des runs Airflow (même logique que backend/app/rules.py) ----------
  const PERIOD_DAYS = { HOURLY: 1 / 24, DAILY: 1, WEEKLY: 7 } as const;
  const INACTIVE_AFTER_PERIODS = 3;

  function withRuns(r: MockRule, v: RuleVersion): RuleVersion {
    const since = r.productionSince[v.version];
    if (since === undefined) return clone(v);
    // Sans date d'arrêt, la version tourne toujours : son dernier run vient d'avoir lieu.
    const until = r.productionUntil[v.version];
    const lastRunAt = until ? `${until}T03:00:00.000Z` : new Date(Date.now() - 20 * 60000).toISOString();
    return { ...clone(v), firstRunAt: `${since}T03:00:00.000Z`, lastRunAt };
  }

  function deriveStatus(r: MockRule, v: RuleVersion): RuleVersion['status'] {
    if (v.decision === 'DISCARDED') return 'DISCARDED';
    // Une version écartée ne remplace rien : la précédente reprend sa place dans rules_registry.
    const newer = r.versions.filter((w) => w.version > v.version && w.decision !== 'DISCARDED');
    if (newer.some((w) => r.productionSince[w.version] !== undefined)) return 'REPLACED';
    const run = withRuns(r, v);
    if (run.lastRunAt) {
      const idleDays = (Date.now() - new Date(run.lastRunAt).getTime()) / 86400000;
      if (idleDays > PERIOD_DAYS[v.schedule] * INACTIVE_AFTER_PERIODS) return 'INACTIVE';
      return v.decision === 'SENT' ? 'IN_PRODUCTION' : 'OBSERVATION';
    }
    if (newer.length) return 'REPLACED'; // une version plus récente a été soumise avant que celle-ci ne tourne
    return 'SUBMITTED';
  }

  const view = (r: MockRule, v: RuleVersion): RuleVersion => ({ ...withRuns(r, v), status: deriveStatus(r, v) });
  const RUNNING: RuleVersion['status'][] = ['OBSERVATION', 'IN_PRODUCTION', 'INACTIVE'];
  const running = (r: MockRule) => r.versions.find((v) => RUNNING.includes(deriveStatus(r, v)));

  function summary(r: MockRule): RuleSummary {
    const cur = current(r);
    const prod = running(r);
    return {
      ...view(r, cur),
      versionCount: r.versions.length,
      productionVersion: prod && prod.version !== cur.version ? prod.version : undefined,
      lastTest: lastTestFor(r.ruleId, cur.version),
    };
  }

  /** L'utilisateur a soumis la dernière version et Airflow ne l'a jamais exécutée : il peut la reprendre. */
  const withdrawable = (r: MockRule, u: User) =>
    current(r).submittedBy === u.matricule && r.productionSince[current(r).version] === undefined;
  const myDraftFor = (ruleId: string, u: User) => db.drafts.find((d) => d.ruleId === ruleId && d.matricule === u.matricule);

  function detail(r: MockRule, u: User): RuleDetail {
    const mine = myDraftFor(r.ruleId, u);
    return {
      ...summary(r),
      versions: r.versions.map((v) => view(r, v)).reverse(),
      tests: db.tests.filter((t) => t.ruleId === r.ruleId).sort((a, b) => b.at.localeCompare(a.at)),
      myDraftId: mine?.id,
      canWithdraw: !mine && withdrawable(r, u),
    };
  }

  // ---------- brouillons personnels (même logique que backend/app/drafts.py) ----------
  const draftTests = (id: string) => db.tests.filter((t) => t.draftId === id).sort((a, b) => b.at.localeCompare(a.at));

  function draftOut(d: MockDraft, withdrawn = false): Draft {
    const r = db.rules.find((x) => x.ruleId === d.ruleId);
    const tests = draftTests(d.id);
    const { matricule: _m, ...rest } = d;
    void _m;
    return { ...clone(rest), newRule: !r, latestVersion: r ? current(r).version : undefined, withdrawn, lastTest: tests[0], tests };
  }

  function findDraft(id: string, u: User): MockDraft {
    const d = db.drafts.find((x) => x.id === id);
    // Le brouillon d'un collègue n'existe pas pour vous.
    if (!d || d.matricule !== u.matricule) throw new ApiError(404, 'Brouillon introuvable.');
    return d;
  }

  const CONTENT = ['name', 'description', 'fraudTypology', 'criticality', 'schedule', 'sqlQuery'] as const;
  function applyContent(target: RuleInput, input: RuleInput) {
    for (const k of CONTENT) (target as unknown as Record<string, string>)[k] = input[k];
    target.name = target.name.trim();
  }

  function validateInput(input: RuleInput, excludeRuleId?: string) {
    const missing = (
      [
        ['name', 'Nom'],
        ['description', 'Description métier'],
        ['fraudTypology', 'Typologie de fraude'],
        ['criticality', 'Criticité'],
        ['schedule', "Fréquence d'exécution"],
        ['sqlQuery', 'Requête SQL'],
      ] as const
    ).filter(([k]) => !String(input[k] ?? '').trim());
    if (missing.length) throw new ApiError(422, `Champs obligatoires manquants : ${missing.map((m) => m[1]).join(', ')}.`);
    if (!nameAvailable(input.name, excludeRuleId)) throw new ApiError(409, `Une règle nommée « ${input.name.trim()} » existe déjà.`, 'NAME_TAKEN');
    // DML/DDL rejetés dès l'enregistrement ; les autres contraintes bloquent la soumission.
    const dry = simulateDryRun(input.sqlQuery, GUARDRAILS, 'check');
    if (dry.statementType && dry.statementType !== 'SELECT') {
      throw new ApiError(422, `Instruction ${dry.statementType} refusée : seule une instruction SELECT est autorisée.`, 'NOT_SELECT');
    }
  }

  function nameAvailable(name: string, excludeRuleId?: string) {
    const n = normalize(name.trim());
    return !db.rules.some((r) => r.ruleId !== excludeRuleId && normalize(current(r).name.trim()) === n);
  }

  // ---------- indicateurs simulés ----------
  function versionAt(r: MockRule, date: string): number | undefined {
    for (const [v, since] of Object.entries(r.productionSince)) {
      const until = r.productionUntil[Number(v)];
      if (since <= date && (!until || date <= until)) return Number(v);
    }
    return undefined;
  }

  function versionTotals(r: MockRule): VersionPerformance[] {
    const start = Object.values(r.productionSince).sort()[0];
    if (!start) return [];
    const by = new Map<number, DailyPerformance[]>();
    for (const d of daily(r, start, isoDate(new Date()))) by.set(d.ruleVersion!, [...(by.get(d.ruleVersion!) ?? []), d]);
    return [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([version, ds]) => ({
        version,
        firstDate: ds[0].date,
        lastDate: ds[ds.length - 1].date,
        days: ds.length,
        ordersFlagged: ds.reduce((s, x) => s + x.ordersFlagged, 0),
        ordersProcessed: ds.reduce((s, x) => s + x.ordersProcessed, 0),
        ordersConfirmedFraud: ds.reduce((s, x) => s + x.ordersConfirmedFraud, 0),
      }));
  }

  function daily(r: MockRule, from: string, to: string): DailyPerformance[] {
    const out: DailyPerformance[] = [];
    const today = isoDate(new Date());
    for (let d = from; d <= to && d <= today; d = addDays(d, 1)) {
      const version = versionAt(r, d);
      if (!r.profile || version === undefined) continue;
      const p = { ...r.profile, ...r.versionProfiles?.[version] };
      const age = Math.round((new Date(today).getTime() - new Date(d).getTime()) / 86400000);
      const broken = p.brokenSinceDays !== undefined && age < p.brokenSinceDays;
      const s = r.ruleId + d;
      const dow = new Date(d + 'T00:00:00').getDay();
      const weekly = dow === 0 || dow === 6 ? 1.3 : 1;
      const flagged = broken ? 0 : Math.round(p.dailyVolume * weekly * (0.55 + rnd(s + 'f') * 0.9));
      const latency = Math.min(1, age / LATENCY_DAYS);
      // En observation, rien n'est envoyé au prestataire : seules les commandes aussi remontées par une
      // règle envoyée sont traitées (environ un tiers).
      const sent = r.versions.find((v) => v.version === version)?.decision === 'SENT';
      const rate = p.processingRate * (sent ? 1 : 0.3);
      const processed = Math.min(flagged, Math.round(flagged * rate * latency * (0.85 + rnd(s + 'p') * 0.3)));
      const confirmed = Math.min(processed, Math.round(processed * p.precision * (0.6 + rnd(s + 'c') * 0.8)));
      out.push({ date: d, ruleVersion: version, ordersFlagged: flagged, ordersProcessed: processed, ordersConfirmedFraud: confirmed });
    }
    return out;
  }

  function runs(r: MockRule, from: string, to: string): RuleRun[] {
    const out: RuleRun[] = [];
    for (const d of daily(r, from, to).reverse().slice(0, 20)) {
      const failed = rnd(r.ruleId + d.date + 'run') < 0.05;
      const start = new Date(d.date + 'T03:00:00');
      start.setMinutes(Math.floor(rnd(d.date + 'm') * 50));
      out.push({
        runId: `run_${d.date.replace(/-/g, '')}_${r.ruleId.slice(-4)}`,
        ruleVersion: versionAt(r, d.date)!,
        runDate: d.date,
        startedAt: start.toISOString(),
        finishedAt: new Date(start.getTime() + (40 + rnd(d.date) * 200) * 1000).toISOString(),
        status: failed ? 'FAILED' : 'SUCCESS',
        rowsReturned: failed ? undefined : d.ordersFlagged,
        errorMessage: failed ? 'Quota exceeded: Your project exceeded quota for concurrent queries.' : undefined,
      });
    }
    return out;
  }

  function recordTest(u: User, target: TestTarget | undefined, sql: string, t: Partial<TestRecord> & Pick<TestRecord, 'phase' | 'success'>): TestRecord {
    const draft = target?.draftId ? findDraft(target.draftId, u) : undefined;
    const cur = !draft && target?.ruleId ? current(findRule(target.ruleId)) : undefined;
    const rec: TestRecord = {
      id: uid(),
      ruleId: cur?.ruleId,
      version: cur?.version,
      draftId: draft?.id,
      queryHash: queryHash(sql),
      at: now(),
      byMatricule: u.matricule,
      byName: fullName(u),
      ...t,
    };
    db.tests.push(rec);
    // Un brouillon est privé : le journal garde le test (volume scanné) sans nommer la règle.
    const outcome = `${t.phase === 'EXECUTION' ? 'Exécution échantillonnée' : 'Dry-run'} ${t.success ? 'réussi' : `en échec : ${t.error ?? ''}`}`;
    audit(u, 'RULE_TEST', cur, draft ? `${outcome} (brouillon)` : outcome);
    save();
    return rec;
  }

  const api: Api = {
    async login(matricule) {
      await delay();
      if (!/^\d{6}$/.test(matricule)) throw new ApiError(422, 'Le matricule doit comporter exactement 6 chiffres.');
      const user = db.users.find((u) => u.matricule === matricule) ?? null;
      session = { matricule, lastSeen: Date.now(), pendingProfile: !user };
      saveSession();
      if (user) {
        audit(user, 'LOGIN');
        save();
      }
      return { user, needsProfile: !user };
    },
    async completeProfile(firstName, lastName) {
      await delay();
      if (!session?.pendingProfile) throw new ApiError(400, 'Aucune première connexion en cours.');
      if (!firstName.trim() || !lastName.trim()) throw new ApiError(422, 'Nom et prénom sont obligatoires.');
      const user: User = { matricule: session.matricule, firstName: firstName.trim(), lastName: lastName.trim() };
      db.users.push(user);
      session = { matricule: user.matricule, lastSeen: Date.now() };
      saveSession();
      audit(user, 'LOGIN', undefined, 'Première connexion');
      save();
      return user;
    },
    async me() {
      await delay(60, 120);
      try {
        return currentUser();
      } catch {
        return null;
      }
    },
    async logout() {
      await delay(50, 100);
      session = null;
      saveSession();
    },
    async updateProfile(firstName, lastName) {
      await delay();
      const u = currentUser();
      if (!firstName.trim() || !lastName.trim()) throw new ApiError(422, 'Nom et prénom sont obligatoires.');
      u.firstName = firstName.trim();
      u.lastName = lastName.trim();
      audit(u, 'PROFILE_UPDATE');
      save();
      return { ...u };
    },
    async listUsers() {
      await delay(40, 80);
      currentUser();
      return clone(db.users);
    },

    async listRules(f) {
      await delay();
      currentUser();
      const q = f.q ? normalize(f.q.trim()) : '';
      const list = db.rules
        .map(summary)
        .filter(
          (r) =>
            (!q || normalize(`${r.name}\n${r.description}\n${r.sqlQuery}`).includes(q)) &&
            (!f.status || r.status === f.status) &&
            (!f.typology || r.fraudTypology === f.typology) &&
            (!f.owner || r.ownerMatricule === f.owner) &&
            (!f.criticality || r.criticality === f.criticality),
        );
      list.sort((a, b) => (f.sort === 'updated_asc' ? 1 : -1) * a.updatedAt.localeCompare(b.updatedAt));
      return list;
    },
    async getRule(id) {
      await delay();
      return detail(findRule(id), currentUser());
    },

    async decide(id, action) {
      await delay();
      const u = currentUser();
      const r = findRule(id);
      const cur = current(r);
      const status = deriveStatus(r, cur);
      const allowed: Record<typeof action, RuleVersion['status'][]> = {
        send: ['OBSERVATION'],
        suspend: ['IN_PRODUCTION', 'INACTIVE'],
        discard: ['SUBMITTED', 'OBSERVATION', 'INACTIVE'],
      };
      if (!allowed[action].includes(status) || (action === 'discard' && cur.decision === 'SENT')) {
        throw new ApiError(409, `Action impossible : la v${cur.version} est « ${status} ».`, 'BAD_STATUS');
      }
      cur.decision = action === 'send' ? 'SENT' : action === 'discard' ? 'DISCARDED' : undefined;
      cur.decidedAt = now();
      cur.decidedByName = fullName(u);
      if (action === 'discard' && r.productionSince[cur.version] !== undefined && !r.productionUntil[cur.version]) {
        // Airflow ne l'exécute plus (la ligne de rules_registry revient à la version précédente).
        r.productionUntil[cur.version] = isoDate(new Date());
      }
      const label = {
        send: 'Envoi au prestataire décidé',
        suspend: 'Envoi au prestataire suspendu : retour en observation',
        discard: "Version écartée : Airflow ne l'exécute plus",
      }[action];
      audit(u, action === 'send' ? 'RULE_SEND_TO_PROVIDER' : action === 'discard' ? 'RULE_DISCARD' : 'RULE_SUSPEND_SENDING', cur, label);
      save();
      return detail(r, u);
    },

    async listDrafts() {
      await delay();
      const u = currentUser();
      return db.drafts
        .filter((d) => d.matricule === u.matricule)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((d) => draftOut(d));
    },
    async getDraft(id) {
      await delay();
      return draftOut(findDraft(id, currentUser()));
    },
    async createDraft(input) {
      await delay();
      const u = currentUser();
      validateInput(input, input.ruleId);
      const t = now();
      const d: MockDraft = { ...clone(input), id: uid(), matricule: u.matricule, ruleId: input.ruleId ?? uid(), createdAt: t, updatedAt: t };
      applyContent(d, input);
      let withdrawn = false;
      if (input.ruleId) {
        const r = findRule(input.ruleId);
        if (myDraftFor(r.ruleId, u)) throw new ApiError(409, 'Vous avez déjà un brouillon pour cette règle.', 'DRAFT_EXISTS');
        const cur = current(r);
        if (withdrawable(r, u)) {
          // Soumise mais jamais exécutée : elle redevient un brouillon ; la ligne rules_registry revient à la version précédente.
          withdrawn = true;
          d.baseVersion = r.versions.length > 1 ? r.versions[r.versions.length - 2].version : undefined;
          d.createdAt = cur.createdAt;
          audit(u, 'RULE_WITHDRAW', cur, 'Soumission retirée pour modification (équipe data prévenue)');
          for (const test of db.tests) {
            if (test.ruleId === r.ruleId && test.version === cur.version) {
              test.draftId = d.id;
              delete test.ruleId;
              delete test.version;
            }
          }
          r.versions.pop();
          if (!r.versions.length) db.rules = db.rules.filter((x) => x !== r);
        } else {
          d.baseVersion = cur.version;
        }
      }
      // Les tests lancés avant le premier enregistrement sont rattachés au brouillon.
      const h = queryHash(d.sqlQuery);
      for (const test of db.tests) {
        if (!test.ruleId && !test.draftId && test.byMatricule === u.matricule && test.queryHash === h && Date.now() - new Date(test.at).getTime() < 3600_000) {
          test.draftId = d.id;
        }
      }
      db.drafts.push(d);
      save();
      return draftOut(d, withdrawn);
    },
    async updateDraft(id, input) {
      await delay();
      const u = currentUser();
      const d = findDraft(id, u);
      validateInput(input, d.ruleId);
      applyContent(d, input);
      d.updatedAt = now();
      save();
      return draftOut(d);
    },
    async deleteDraft(id) {
      await delay();
      const d = findDraft(id, currentUser());
      // Les tests restent (historique), simplement détachés.
      for (const t of db.tests) if (t.draftId === d.id) delete t.draftId;
      db.drafts = db.drafts.filter((x) => x !== d);
      save();
    },
    async checkNameAvailable(name, excludeRuleId) {
      await delay(40, 90);
      return nameAvailable(name, excludeRuleId);
    },

    async getGuardrails() {
      await delay(30, 60);
      return { ...GUARDRAILS };
    },
    async dryRun(sql, target) {
      await delay(400, 900);
      const u = currentUser();
      if (target?.draftId) findDraft(target.draftId, u);
      const testId = uid();
      const res = simulateDryRun(sql, GUARDRAILS, testId);
      const firstError = res.issues.find((i) => i.severity === 'error');
      const rec = recordTest(u, target, sql, {
        phase: 'DRY_RUN',
        success: res.ok,
        bytesProcessed: res.bytesProcessed,
        error: firstError?.message,
      });
      return { ...res, testId: rec.id };
    },
    async execute(sql, target) {
      const u = currentUser();
      if (target?.draftId) findDraft(target.draftId, u);
      const dry = simulateDryRun(sql, GUARDRAILS, 'pre');
      if (!dry.ok) throw new ApiError(422, 'Le dry-run doit réussir avant toute exécution.');
      if (dry.exceedsBytesLimit) {
        throw new ApiError(
          422,
          `Exécution refusée : volume estimé ${(dry.bytesProcessed! / 1e9).toFixed(1)} Go, plafond ${GUARDRAILS.maxBytesBilled / 1e9} Go (maximumBytesBilled).`,
          'BYTES_LIMIT',
        );
      }
      await delay(900, 1800);
      const res = simulateExecution(sql, GUARDRAILS, dry, 'exec');
      // Commandes déjà remontées par les autres règles en production (simulé, stable pour une même requête).
      const own = target?.draftId ? findDraft(target.draftId, u).ruleId : (target?.ruleId ?? target?.excludeRuleId);
      const h = queryHash(sql);
      const shared = db.rules
        .filter((r) => r.ruleId !== own && running(r))
        .reduce((s, r) => s + Math.round(res.ordersFlagged * rnd(h + r.ruleId) * 0.14), 0);
      // Une même commande peut être remontée par plusieurs règles : le total est inférieur à la somme.
      res.ordersAlreadyFlagged = Math.min(res.ordersFlagged, Math.round(shared * 0.85));
      // Seules les métadonnées sont conservées, jamais les lignes (PRD §10).
      const rec = recordTest(u, target, sql, {
        phase: 'EXECUTION',
        success: true,
        bytesProcessed: res.bytesProcessed,
        durationMs: res.durationMs,
        totalRows: res.totalRows,
      });
      return { ...res, testId: rec.id };
    },

    async submitDraft(id) {
      await delay();
      const u = currentUser();
      const d = findDraft(id, u);
      const last = draftTests(d.id)[0];
      if (!last || !last.success || last.phase !== 'EXECUTION' || last.queryHash !== queryHash(d.sqlQuery)) {
        throw new ApiError(409, 'Le dernier test doit être une exécution réussie portant sur la version actuelle de la requête.', 'TEST_REQUIRED');
      }
      if (!nameAvailable(d.name, d.ruleId)) throw new ApiError(409, `Une règle nommée « ${d.name} » existe déjà.`, 'NAME_TAKEN');
      let r = db.rules.find((x) => x.ruleId === d.ruleId);
      if (!r) {
        r = { ruleId: d.ruleId, versions: [], productionSince: {}, productionUntil: {} };
        db.rules.push(r);
      }
      const owner = r.versions[0] ?? { ownerMatricule: u.matricule, ownerName: fullName(u) };
      const t = now();
      const v: RuleVersion = {
        ...clone({ name: d.name, description: d.description, fraudTypology: d.fraudTypology, criticality: d.criticality, schedule: d.schedule, sqlQuery: d.sqlQuery }),
        ruleId: d.ruleId,
        version: r.versions.length ? current(r).version + 1 : 1,
        status: 'SUBMITTED',
        ownerMatricule: owner.ownerMatricule,
        ownerName: owner.ownerName,
        submittedBy: u.matricule,
        submittedByName: fullName(u),
        createdAt: d.createdAt,
        updatedAt: t,
        submittedAt: t,
      };
      r.versions.push(v);
      for (const test of db.tests) {
        if (test.draftId === d.id) {
          test.ruleId = v.ruleId;
          test.version = v.version;
          delete test.draftId;
        }
      }
      db.drafts = db.drafts.filter((x) => x !== d);
      const origin = v.version === 1 ? 'Nouvelle règle' : `Nouvelle version (préparée à partir de la v${d.baseVersion})`;
      audit(u, 'RULE_SUBMIT', v, `${origin} — notification envoyée à l'équipe data (canal à arbitrer, PRD Q6)`);
      save();
      return detail(r, u);
    },

    async getPerformance(id, from, to) {
      await delay(200, 450);
      currentUser();
      const r = findRule(id);
      const len = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
      return {
        ruleId: id,
        from,
        to,
        daily: daily(r, from, to),
        previous: daily(r, addDays(from, -len), addDays(from, -1)),
        runs: runs(r, from, to),
        versions: versionTotals(r),
        latencyDays: LATENCY_DAYS,
      };
    },
    async getConsolidated() {
      await delay(200, 400);
      currentUser();
      const to = isoDate(new Date());
      const from = addDays(to, -29);
      return db.rules
        .filter((r) => running(r))
        .map((r) => {
          const v = view(r, running(r)!);
          const d = daily(r, from, to);
          return {
            ruleId: r.ruleId,
            name: v.name,
            version: v.version,
            fraudTypology: v.fraudTypology,
            criticality: v.criticality,
            ownerName: v.ownerName,
            status: v.status,
            lastRunAt: v.lastRunAt,
            ordersFlagged30d: d.reduce((s, x) => s + x.ordersFlagged, 0),
            ordersProcessed30d: d.reduce((s, x) => s + x.ordersProcessed, 0),
            ordersConfirmed30d: d.reduce((s, x) => s + x.ordersConfirmedFraud, 0),
          };
        });
    },

    async listAudit(f) {
      await delay();
      currentUser();
      return db.audit.filter((e) => (!f.ruleId || e.ruleId === f.ruleId) && (!f.matricule || e.matricule === f.matricule));
    },

    demo: {
      async simulateRuns(id) {
        await delay();
        const u = currentUser();
        const r = findRule(id);
        const target = [...r.versions].reverse().find((v) => r.productionSince[v.version] === undefined && v.decision !== 'DISCARDED');
        if (!target) throw new ApiError(409, 'Aucune version soumise en attente de mise en production.');
        const today = isoDate(new Date());
        // La version qui tournait s'arrête : Airflow exécute désormais la dernière version soumise.
        const prev = running(r);
        if (prev && prev.version !== target.version) r.productionUntil[prev.version] = addDays(today, -1);
        r.productionSince[target.version] = today;
        target.airflowDagId = `fraud_rules_${target.schedule.toLowerCase()}`; // un DAG par fréquence
        r.profile ??= { dailyVolume: 10 + Math.round(rnd(id) * 40), processingRate: 0.75, precision: 0.2 + rnd(id + 'p') * 0.4 };
        save();
        return detail(r, u);
      },
      async simulateStop(id) {
        await delay();
        const u = currentUser();
        const r = findRule(id);
        const run = running(r);
        if (!run) throw new ApiError(409, "Aucune version n'est exécutée par Airflow.");
        // Dernier run juste au-delà du seuil d'inactivité (3 périodes selon la fréquence de la règle).
        const until = addDays(isoDate(new Date()), -(Math.ceil(PERIOD_DAYS[run.schedule] * INACTIVE_AFTER_PERIODS) + 1));
        r.productionUntil[run.version] = until;
        // Le premier run doit précéder le dernier.
        if (r.productionSince[run.version] > until) r.productionSince[run.version] = addDays(until, -7);
        save();
        return detail(r, u);
      },
      async reset() {
        db = buildSeed();
        save();
      },
    },
  };
  return api;
}
