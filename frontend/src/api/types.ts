/**
 * Types du contrat front ↔ API.
 *
 * Les formats échangés avec l'API sont GÉNÉRÉS depuis son contrat OpenAPI (schema.gen.ts, tiré de
 * openapi.json) : ce fichier ne fait que leur donner leur nom côté front. Ne pas les réécrire à la main :
 * après une modification d'une route ou d'un schéma du back,
 *   cd backend && python -m app.openapi_export     (régénère src/api/openapi.json)
 *   cd frontend && npm run api:types              (régénère src/api/schema.gen.ts)
 * Un test du back échoue si openapi.json est périmé, la CI si schema.gen.ts l'est.
 *
 * Restent écrits ici : les listes de valeurs utilisées par l'interface (vérifiées à la compilation contre le
 * contrat), et les types propres au front (filtres, cible d'un test, statut affiché, erreur d'API).
 */
import type { components } from './schema.gen';

type Schemas = components['schemas'];

// ---------- formats de l'API (générés) ----------
export type User = Schemas['UserOut'];
/** Contenu éditable d'une règle (formulaire F1 + F2). */
export type RuleInput = Schemas['RuleInput'];
export type RuleVersion = Schemas['RuleVersionOut'];
/** Ligne de la liste des règles : version courante (= la plus récente). */
export type RuleSummary = Schemas['RuleSummary'];
export type RuleDetail = Schemas['RuleDetail'];
/** Brouillon personnel : visible de son seul auteur, il devient une version de règle à la soumission. */
export type Draft = Schemas['DraftOut'];
/** Valeurs de @period_start / @period_end au test : la dernière période complète de la fréquence. */
export type TestPeriod = Schemas['TestPeriod'];
export type Guardrails = Schemas['Guardrails'];
export type SqlIssue = Schemas['SqlIssue'];
export type DryRunResult = Schemas['DryRunResult'];
export type ExecutionResult = Schemas['ExecutionResult'];
/** Métadonnées d'un test, seules données conservées (PRD F3). */
export type TestRecord = Schemas['TestRecord'];
export type DailyPerformance = Schemas['DailyPerformance'];
/** Chiffres d'une règle sur une période, en commandes distinctes. */
export type PeriodTotals = Schemas['PeriodTotals'];
/** Commandes d'une version un jour donné, en production (toSend) ou en test. */
export type VersionDaily = Schemas['VersionDaily'];
export type VersionPerformance = Schemas['VersionPerformance'];
/** Une exécution automatique d'une version : sa dernière tentative. */
export type RuleRun = Schemas['RuleRun'];
export type PerformanceResponse = Schemas['PerformanceResponse'];
export type ConsolidatedRow = Schemas['ConsolidatedRow'];
export type AuditEvent = Schemas['AuditEventOut'];
export type AuditAction = AuditEvent['action'];
export type Alert = Schemas['AlertOut'];
export type AlertReview = Schemas['AlertReviewOut'];
export type AlertPage = Schemas['AlertPage'];
/** Qualification d'une commande en test : sa dernière version (None : la retirer). */
export type AlertReviewIn = Schemas['AlertReviewIn'];
/** Phase de la version qui a remonté la commande : en test (non transmise) ou en production (transmise). */
export type AlertPhase = Alert['phase'];
/**
 * Verdict effectif d'une alerte : celui du prestataire s'il l'a vérifiée (FRAUD, NOT_FRAUD) ; sinon, en test,
 * la qualification de l'analyste (TO_REVIEW tant qu'il n'y en a pas) ; en production, en attente du
 * prestataire (PENDING).
 */
export type AlertVerdict = Alert['verdict'];
/** Qualification d'une commande en test : fraude avérée, commande risquée ou RAS. */
export type ReviewVerdict = AlertReview['verdict'];
/** Action de l'analyste sur la dernière version d'une règle. */
export type DecisionAction = Schemas['DecisionIn']['action'];

// ---------- listes de valeurs de l'interface (vérifiées contre le contrat) ----------
/**
 * Statuts d'une version de règle : publiée → en test (Airflow l'exécute, ses commandes ne partent pas chez
 * le prestataire) → en production (l'analyste a décidé de l'envoyer). Inactive, remplacée ou écartée sinon.
 */
export const RULE_STATUSES = ['SUBMITTED', 'OBSERVATION', 'IN_PRODUCTION', 'INACTIVE', 'REPLACED', 'DISCARDED'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
/** Statut affiché : celui d'une version, ou « brouillon » pour le travail en cours d'un analyste. */
export type DisplayStatus = RuleStatus | 'DRAFT';

export const CRITICALITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const SCHEDULES = ['DAILY', 'HOURLY', 'WEEKLY'] as const;
export type Schedule = (typeof SCHEDULES)[number];
/** Pas autorisés par unité (miroir de backend/app/core/periods.py). Heures : diviseurs de 24. */
export const EVERY: Record<Schedule, readonly number[]> = {
  HOURLY: [1, 2, 3, 4, 6, 8, 12],
  DAILY: Array.from({ length: 30 }, (_, i) => i + 1),
  WEEKLY: Array.from({ length: 12 }, (_, i) => i + 1),
};

/** Égalité stricte de deux types (pour les vérifications ci-dessous). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Check<T extends true> = T;
/** Échoue à la compilation si une liste de l'interface diverge des valeurs du contrat. */
export type ContractChecks = [
  Check<Same<RuleStatus, RuleVersion['status']>>,
  Check<Same<Criticality, RuleInput['criticality']>>,
  Check<Same<Schedule, RuleInput['schedule']>>,
];

// ---------- types propres au front ----------
/** Ce sur quoi porte un test : un brouillon, la dernière version d'une règle, ou rien (requête libre). */
export interface TestTarget {
  ruleId?: string;
  draftId?: string;
  /** Test non rattaché d'une nouvelle version : ses propres remontées ne comptent pas comme « déjà remontées ». */
  excludeRuleId?: string;
  /** Fréquence saisie : fixe la période testée (@period_start / @period_end). */
  schedule?: Schedule;
  scheduleEvery?: number;
}

export interface RuleFilters {
  q?: string;
  status?: RuleStatus | '';
  typology?: string;
  owner?: string;
  criticality?: Criticality | '';
  sort?: 'updated_desc' | 'updated_asc';
}

export interface AlertFilters {
  from?: string;
  to?: string;
  ruleId?: string;
  phase?: AlertPhase;
  verdict?: AlertVerdict;
  q?: string;
  limit?: number;
  offset?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
