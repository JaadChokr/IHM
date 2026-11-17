import type { ConsolidatedRow, DailyPerformance } from '../api/types';
import { fmtDate, fmtPct } from './format';

/**
 * Pertinence d'une règle : part des commandes vérifiées qui sont pertinentes, c'est-à-dire fraudes avérées
 * ou commandes risquées. En production, le prestataire ne distingue que fraude ou non : la pertinence y est
 * la part de fraudes. En test, les analystes qualifient en trois niveaux (fraude avérée, risquée, RAS).
 */
export interface Totals {
  flagged: number;
  /** Vérifiées : par le prestataire (table de retour) ou qualifiées par un analyste (en test). */
  processed: number;
  /** En attente : remontées mais pas encore vérifiées ni qualifiées. */
  pending: number;
  /** Fraudes avérées. */
  confirmed: number;
  /** Pertinentes : fraudes avérées et commandes risquées. */
  relevant: number;
  relevance: number | null;
}

export type Counts = Pick<DailyPerformance, 'ordersFlagged' | 'ordersProcessed' | 'ordersConfirmedFraud' | 'ordersRelevant'>;

/** Pertinence d'un nombre de commandes pertinentes sur un nombre de vérifiées (null : aucune vérifiée). */
export const relevanceOf = (relevant: number, processed: number) => (processed > 0 ? relevant / processed : null);

/** Totaux de jours ou de périodes : seuls les quatre compteurs servent. */
export function totals(rows: Counts[]): Totals {
  const sum = (k: keyof Counts) => rows.reduce((s, r) => s + r[k], 0);
  const flagged = sum('ordersFlagged');
  const processed = sum('ordersProcessed');
  const relevant = sum('ordersRelevant');
  return {
    flagged,
    processed,
    pending: Math.max(0, flagged - processed),
    confirmed: sum('ordersConfirmedFraud'),
    relevant,
    relevance: relevanceOf(relevant, processed),
  };
}

/** Variation relative (comptages) ou absolue en points (taux). */
export function delta(cur: number | null, prev: number | null, kind: 'relative' | 'points'): number | null {
  if (cur === null || prev === null) return null;
  if (kind === 'points') return cur - prev;
  return prev === 0 ? null : (cur - prev) / prev;
}

/** Seuil de pertinence « à surveiller » par défaut, réglable dans la page Surveillance (PRD F7). */
export const DEFAULT_WATCH_THRESHOLD = 0.15;

export interface ProductionHealth extends ConsolidatedRow {
  /** Remontées sur 30 jours en attente de vérification (pas encore dans la table de retour). */
  pending: number;
  relevance: number | null;
  /** Raisons de surveiller la règle ; vide si tout va bien. */
  reasons: string[];
}

/** Indicateurs sur 30 jours d'une règle en production et motifs de surveillance (PRD F7). */
export function productionHealth(r: ConsolidatedRow, threshold: number): ProductionHealth {
  const pending = Math.max(0, r.ordersFlagged30d - r.ordersProcessed30d);
  const relevance = relevanceOf(r.ordersRelevant30d, r.ordersProcessed30d);
  const reasons: string[] = [];
  if (r.status === 'INACTIVE')
    reasons.push(`Plus exécutée par Airflow${r.lastRunAt ? ` depuis le ${fmtDate(r.lastRunAt)}` : ''} — DAG arrêté ou en panne`);
  if (r.ordersFlagged30d === 0) reasons.push('Aucune remontée sur 30 jours — règle probablement cassée');
  // En test, rien n'est envoyé au prestataire : la pertinence se mesure, mais ne déclenche pas de surveillance.
  if (r.status !== 'TEST' && relevance !== null && relevance < threshold)
    reasons.push(`Pertinence sous le seuil de ${fmtPct(threshold)}`);
  return { ...r, pending, relevance, reasons };
}
