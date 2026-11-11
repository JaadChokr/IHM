import type {
  AlertFilters,
  AlertPage,
  AuditEvent,
  Draft,
  ConsolidatedRow,
  DecisionAction,
  DryRunResult,
  ExecutionResult,
  Guardrails,
  PerformanceResponse,
  RuleRun,
  RuleDetail,
  RuleFilters,
  RuleInput,
  RuleSummary,
  TestTarget,
  User,
} from './types';
import { ApiError } from './types';
import { createMockApi } from './mock/mockApi';

/**
 * Contrat de l'API FastAPI. Le front ne parle qu'à cette interface (PRD §8.1) ;
 * deux implémentations : HTTP (production) et mock en mémoire (démo / dev).
 */
export interface Api {
  // F8 — identification
  login(matricule: string): Promise<{ user: User | null; needsProfile: boolean }>;
  completeProfile(firstName: string, lastName: string): Promise<User>;
  me(): Promise<User | null>;
  logout(): Promise<void>;
  updateProfile(firstName: string, lastName: string): Promise<User>;
  listUsers(): Promise<User[]>;

  // F1 / F5
  listRules(filters: RuleFilters): Promise<RuleSummary[]>;
  getRule(ruleId: string): Promise<RuleDetail>;
  /** Après le test : envoyer au prestataire, suspendre l'envoi, ou écarter la dernière version. */
  decide(ruleId: string, action: DecisionAction): Promise<RuleDetail>;
  checkNameAvailable(name: string, excludeRuleId?: string): Promise<boolean>;

  // Brouillons personnels (visibles de leur seul auteur)
  listDrafts(): Promise<Draft[]>;
  getDraft(draftId: string): Promise<Draft>;
  /**
   * Nouvelle règle, ou nouvelle version de `ruleId`. Si l'utilisateur a soumis la dernière version
   * et qu'Airflow ne l'a jamais exécutée, elle est retirée et redevient son brouillon.
   */
  createDraft(input: RuleInput & { ruleId?: string }): Promise<Draft>;
  updateDraft(draftId: string, input: RuleInput): Promise<Draft>;
  deleteDraft(draftId: string): Promise<void>;

  // F3
  getGuardrails(): Promise<Guardrails>;
  dryRun(sql: string, target?: TestTarget): Promise<DryRunResult>;
  execute(sql: string, target?: TestTarget): Promise<ExecutionResult>;

  // F4 : le brouillon devient une version de la règle (créée dans le référentiel si besoin).
  submitDraft(draftId: string): Promise<RuleDetail>;

  // F6 / F7
  getPerformance(ruleId: string, from: string, to: string): Promise<PerformanceResponse>;
  /** Historique des exécutions automatiques de la règle sur `days` jours, la plus récente d'abord. */
  getRuns(ruleId: string, days?: number): Promise<RuleRun[]>;
  getConsolidated(): Promise<ConsolidatedRow[]>;

  // Audit
  listAudit(filters: { ruleId?: string; matricule?: string }): Promise<AuditEvent[]>;

  // Alertes remontées ; qualification d'une commande en test (fraude, pas fraude, ou null : retirée).
  listAlerts(filters: AlertFilters): Promise<AlertPage>;
  reviewAlert(body: { orderId: string; ruleId: string; ruleVersion: number; isFraud: boolean | null }): Promise<void>;

  /** Présent uniquement en mode démo : simule les actions de l'équipe data en base. */
  demo?: {
    /** Simule les runs Airflow de la dernière version soumise (premier run aujourd'hui). */
    simulateRuns(ruleId: string): Promise<RuleDetail>;
    /** Simule l'arrêt du DAG : dernier run juste au-delà du seuil d'inactivité. */
    simulateStop(ruleId: string): Promise<RuleDetail>;
    reset(): Promise<void>;
  };
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include', // session = cookie HttpOnly posé par l'API
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.detail ?? res.statusText, data.code);
  return data as T;
}

function qs(params: Record<string, string | undefined>): string {
  const s = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  return s ? `?${s}` : '';
}

export function createHttpApi(): Api {
  return {
    login: (matricule) => http('POST', '/session', { matricule }),
    completeProfile: (firstName, lastName) => http('POST', '/me/profile', { firstName, lastName }),
    me: async () => {
      try {
        return await http<User>('GET', '/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    logout: () => http('DELETE', '/session'),
    updateProfile: (firstName, lastName) => http('PATCH', '/me', { firstName, lastName }),
    listUsers: () => http('GET', '/users'),
    listRules: (f) => http('GET', `/rules${qs({ ...f })}`),
    getRule: (id) => http('GET', `/rules/${id}`),
    decide: (id, action) => http('POST', `/rules/${id}/decision`, { action }),
    checkNameAvailable: async (name, excludeRuleId) =>
      (await http<{ available: boolean }>('GET', `/rules/name-available${qs({ name, exclude: excludeRuleId })}`)).available,
    listDrafts: () => http('GET', '/drafts'),
    getDraft: (id) => http('GET', `/drafts/${id}`),
    createDraft: (input) => http('POST', '/drafts', input),
    updateDraft: (id, input) => http('PUT', `/drafts/${id}`, input),
    deleteDraft: (id) => http('DELETE', `/drafts/${id}`),
    getGuardrails: () => http('GET', '/config/guardrails'),
    dryRun: (sql, target) => http('POST', '/query/dry-run', { sql, ...target }),
    execute: (sql, target) => http('POST', '/query/execute', { sql, ...target }),
    submitDraft: (id) => http('POST', `/drafts/${id}/submit`),
    getPerformance: (id, from, to) => http('GET', `/rules/${id}/performance${qs({ from, to })}`),
    getRuns: (id, days = 90) => http('GET', `/rules/${id}/runs${qs({ days: String(days) })}`),
    getConsolidated: () => http('GET', '/performance/production'),
    listAudit: (f) => http('GET', `/audit${qs(f)}`),
    listAlerts: (f) => http('GET', `/alerts${qs(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === undefined ? undefined : String(v)])))}`),
    reviewAlert: (body) => http('POST', '/alerts/review', body),
  };
}

export const API_MODE: 'mock' | 'http' = import.meta.env.VITE_API_MODE === 'http' ? 'http' : 'mock';

export const api: Api = API_MODE === 'http' ? createHttpApi() : createMockApi();
