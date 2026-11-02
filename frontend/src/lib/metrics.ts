import type { ConsolidatedRow, DailyPerformance } from '../api/types';
import { fmtDate, fmtPct } from './format';

/** Seuils de fiabilité du taux de précision (PRD F6, point d'attention). */
export const MIN_PROCESSING_RATE = 0.5;
export const MIN_PROCESSED_ORDERS = 20;

export interface Totals {
  flagged: number;
  processed: number;
  confirmed: number;
  processingRate: number | null;
  precision: number | null;
  /** Précision assise sur un échantillon trop faible. */
  lowSample: boolean;
}

export function totals(rows: DailyPerformance[]): Totals {
  const flagged = rows.reduce((s, r) => s + r.ordersFlagged, 0);
  const processed = rows.reduce((s, r) => s + r.ordersProcessed, 0);
  const confirmed = rows.reduce((s, r) => s + r.ordersConfirmedFraud, 0);
  const processingRate = flagged > 0 ? processed / flagged : null;
  const precision = processed > 0 ? confirmed / processed : null;
  return {
    flagged,
    processed,
    confirmed,
    processingRate,
    precision,
    lowSample: processingRate === null || processingRate < MIN_PROCESSING_RATE || processed < MIN_PROCESSED_ORDERS,
  };
}

/** Variation relative (comptages) ou absolue en points (taux). */
export function delta(cur: number | null, prev: number | null, kind: 'relative' | 'points'): number | null {
  if (cur === null || prev === null) return null;
  if (kind === 'points') return cur - prev;
  return prev === 0 ? null : (cur - prev) / prev;
}

/** Seuil de précision « à surveiller » par défaut, réglable dans la vue production (PRD F7). */
export const DEFAULT_WATCH_THRESHOLD = 0.15;

export interface ProductionHealth extends ConsolidatedRow {
  processingRate: number | null;
  precision: number | null;
  lowSample: boolean;
  /** Raisons de surveiller la règle ; vide si tout va bien. */
  reasons: string[];
}

/** Indicateurs sur 30 jours d'une règle en production et motifs de surveillance (PRD F7). */
export function productionHealth(r: ConsolidatedRow, threshold: number): ProductionHealth {
  const processingRate = r.ordersFlagged30d ? r.ordersProcessed30d / r.ordersFlagged30d : null;
  const precision = r.ordersProcessed30d ? r.ordersConfirmed30d / r.ordersProcessed30d : null;
  const lowSample =
    processingRate === null || processingRate < MIN_PROCESSING_RATE || r.ordersProcessed30d < MIN_PROCESSED_ORDERS;
  const reasons: string[] = [];
  if (r.status === 'INACTIVE')
    reasons.push(`Plus exécutée par Airflow${r.lastRunAt ? ` depuis le ${fmtDate(r.lastRunAt)}` : ''} — DAG arrêté ou en panne`);
  if (r.ordersFlagged30d === 0) reasons.push('Aucune remontée sur 30 jours — règle probablement cassée');
  // En observation, rien n'est envoyé au prestataire : la précision n'est pas significative.
  if (r.status !== 'OBSERVATION' && precision !== null && precision < threshold)
    reasons.push(`Précision sous le seuil de ${fmtPct(threshold)}`);
  return { ...r, processingRate, precision, lowSample, reasons };
}
