// Types du contrat front ↔ API. Ils reflètent le schéma `rules_registry`
// (PRD §7.2), à une différence près : l'identité est portée par le matricule
// (PRD §5.4, règle 1), pas par un e-mail.

/** Statuts d'une version de règle : toutes ont été soumises (les brouillons sont personnels, voir Draft). */
/**
 * Soumise → en observation (Airflow l'exécute, ses commandes ne partent pas chez le prestataire) →
 * en production (l'analyste a décidé de l'envoyer au prestataire). Inactive, remplacée ou écartée sinon.
 */
export const RULE_STATUSES = ['SUBMITTED', 'OBSERVATION', 'IN_PRODUCTION', 'INACTIVE', 'REPLACED', 'DISCARDED'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
/** Statut affiché : celui d'une version, ou « brouillon » pour le travail en cours d'un analyste. */
export type DisplayStatus = RuleStatus | 'DRAFT';

export const CRITICALITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const SCHEDULES = ['DAILY', 'HOURLY', 'WEEKLY'] as const;
export type Schedule = (typeof SCHEDULES)[number];

export interface User {
  matricule: string;
  firstName: string;
  lastName: string;
}

/** Contenu éditable d'une règle (formulaire F1 + F2). */
export interface RuleInput {
  name: string;
  description: string;
  fraudTypology: string;
  criticality: Criticality;
  schedule: Schedule;
  sqlQuery: string;
}

export interface RuleVersion extends RuleInput {
  ruleId: string;
  version: number;
  status: RuleStatus;
  ownerMatricule: string;
  ownerName: string;
  submittedBy: string;
  submittedByName: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string;
  /** DAG, premier et dernier run : lus dans rule_runs (écrite par Airflow). */
  airflowDagId?: string;
  firstRunAt?: string;
  lastRunAt?: string;
  /** Tourne en parallèle de la version en production, en observation, jusqu'à la décision. */
  candidate?: boolean;
  /** Décision de l'analyste après observation : envoyée au prestataire, ou écartée. */
  decision?: 'SENT' | 'DISCARDED';
  decidedAt?: string;
  decidedByName?: string;
}

/** Action de l'analyste sur la dernière version d'une règle. */
export type DecisionAction = 'send' | 'suspend' | 'discard';

/** Ligne de la liste des règles : version courante (= la plus récente). */
export interface RuleSummary extends RuleVersion {
  versionCount: number;
  /** Version qui tourne actuellement, si différente de la version courante. */
  productionVersion?: number;
  lastTest?: TestRecord;
}

export interface RuleDetail extends RuleSummary {
  versions: RuleVersion[];
  tests: TestRecord[];
  /** Brouillon de nouvelle version de l'utilisateur connecté, s'il en a un. */
  myDraftId?: string;
  /** L'utilisateur a soumis la dernière version et Airflow ne l'a jamais exécutée : il peut la reprendre. */
  canWithdraw: boolean;
}

/**
 * Brouillon personnel : sauvegarde du travail en cours, visible de son seul auteur et jamais
 * publié dans BigQuery. Il devient une version de règle à la soumission.
 */
export interface Draft extends RuleInput {
  id: string;
  /** Règle visée ; pour une nouvelle règle, identifiant réservé jusqu'à la soumission. */
  ruleId: string;
  /** Version de départ (absente pour une nouvelle règle). */
  baseVersion?: number;
  newRule: boolean;
  /** Dernière version soumise de la règle : si elle dépasse baseVersion, un collègue a soumis entre-temps. */
  latestVersion?: number;
  /** Créé à l'instant en retirant une soumission jamais exécutée. */
  withdrawn: boolean;
  createdAt: string;
  updatedAt: string;
  lastTest?: TestRecord;
  tests: TestRecord[];
}

/** Ce sur quoi porte un test : un brouillon, la dernière version d'une règle, ou rien (requête libre). */
export interface TestTarget {
  ruleId?: string;
  draftId?: string;
  /** Test non rattaché d'une nouvelle version : ses propres remontées ne comptent pas comme « déjà remontées ». */
  excludeRuleId?: string;
  /** Fréquence saisie : fixe la période testée (@period_start / @period_end). */
  schedule?: Schedule;
}

/** Valeurs de @period_start / @period_end au test : la dernière période complète de la fréquence. */
export interface TestPeriod {
  start: string;
  end: string;
}

// ---------- F3 : test de la requête ----------

export interface Guardrails {
  maxBytesBilled: number;
  jobTimeoutMs: number;
  maxResults: number;
}

export interface SqlIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line?: number;
  column?: number;
  /** Longueur du fragment fautif, pour le surlignage. */
  length?: number;
}

export interface DryRunResult {
  ok: boolean;
  statementType?: string;
  outputSchema?: { name: string; type: string }[];
  bytesProcessed?: number;
  issues: SqlIssue[];
  /** Dépassement du plafond : l'exécution sera refusée. */
  exceedsBytesLimit: boolean;
  period: TestPeriod;
  testId: string;
}

export interface ExecutionResult {
  ok: boolean;
  error?: string;
  columns: string[];
  /** Lignes d'échantillon. Jamais persistées (PRD §10). */
  rows: Record<string, unknown>[];
  totalRows: number;
  durationMs: number;
  bytesProcessed: number;
  /** Commandes distinctes renvoyées par la requête. */
  ordersFlagged: number;
  /** Dont déjà remontées par une autre règle (table rule_alerts) ; absent si rule_alerts est indisponible. */
  ordersAlreadyFlagged?: number;
  /** Période de recherche dans rule_alerts, en jours. */
  overlapDays: number;
  period: TestPeriod;
  testId: string;
}

/** Métadonnées d'un test, seules données conservées (PRD F3). */
export interface TestRecord {
  id: string;
  ruleId?: string;
  version?: number;
  draftId?: string;
  queryHash: string;
  at: string;
  byMatricule: string;
  byName: string;
  phase: 'DRY_RUN' | 'EXECUTION';
  success: boolean;
  bytesProcessed?: number;
  durationMs?: number;
  totalRows?: number;
  error?: string;
}

// ---------- F6 / F7 : indicateurs ----------

export interface DailyPerformance {
  date: string; // YYYY-MM-DD
  /** Version qui a tourné ce jour-là. */
  ruleVersion?: number;
  ordersFlagged: number;
  /** Dont marquées à transmettre au prestataire (version en production). */
  ordersToSend?: number;
  ordersProcessed: number;
  ordersConfirmedFraud: number;
}

/** Chiffres d'une règle sur une période, en commandes distinctes (exacts même si deux versions ont remonté la même commande). */
export interface PeriodTotals {
  ordersFlagged: number;
  ordersToSend: number;
  ordersProcessed: number;
  ordersConfirmedFraud: number;
  /** Commandes remontées en observation (candidate comprise). */
  ordersObserved?: number;
}

/** Commandes d'une version un jour donné, en production (toSend) ou en observation. */
export interface VersionDaily {
  date: string;
  ruleVersion: number;
  toSend: boolean;
  ordersFlagged: number;
  ordersProcessed: number;
  ordersConfirmedFraud: number;
}

export interface VersionPerformance {
  version: number;
  firstDate: string;
  lastDate: string;
  days: number;
  ordersFlagged: number;
  ordersProcessed: number;
  ordersConfirmedFraud: number;
}

export interface RuleRun {
  runId: string;
  ruleVersion: number;
  runDate: string;
  startedAt: string;
  finishedAt?: string;
  status: 'SUCCESS' | 'FAILED';
  rowsReturned?: number;
  errorMessage?: string;
}

export interface PerformanceResponse {
  ruleId: string;
  from: string;
  to: string;
  daily: DailyPerformance[];
  previous: DailyPerformance[];
  totals?: PeriodTotals;
  previousTotals?: PeriodTotals;
  /** Courbe par version : une ligne par jour, version et état. */
  byVersion?: VersionDaily[];
  runs: RuleRun[];
  /** Indicateurs cumulés de chaque version sur toute sa période d'exécution. */
  versions: VersionPerformance[];
}

export interface ConsolidatedRow {
  ruleId: string;
  name: string;
  version: number;
  fraudTypology: string;
  criticality: Criticality;
  ownerName: string;
  status: RuleStatus;
  lastRunAt?: string;
  ordersFlagged30d: number;
  ordersProcessed30d: number;
  ordersConfirmed30d: number;
  ordersToSend30d?: number;
}

// ---------- F8 : audit ----------

export type AuditAction =
  | 'LOGIN'
  | 'PROFILE_UPDATE'
  | 'RULE_CREATE'
  | 'RULE_UPDATE'
  | 'RULE_NEW_VERSION'
  | 'RULE_TEST'
  | 'RULE_SUBMIT'
  | 'RULE_WITHDRAW'
  | 'RULE_SEND_TO_PROVIDER'
  | 'RULE_SUSPEND_SENDING'
  | 'RULE_DISCARD';

export interface AuditEvent {
  id: string;
  at: string;
  matricule: string;
  userName: string;
  action: AuditAction;
  ruleId?: string;
  ruleName?: string;
  version?: number;
  details?: string;
}

export interface RuleFilters {
  q?: string;
  status?: RuleStatus | '';
  typology?: string;
  owner?: string;
  criticality?: Criticality | '';
  sort?: 'updated_desc' | 'updated_asc';
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
