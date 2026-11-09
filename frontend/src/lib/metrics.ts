import type { ConsolidatedRow, DailyPerformance } from '../api/types';
import { fmtDate, fmtPct } from './format';

/** Le prestataire vérifie toutes les commandes qu'il reçoit ; la précision porte sur les commandes vérifiées. */
export interface Totals {
  flagged: number;
  /** Vérifiées : présentes dans la table de retour du prestataire. */
  processed: number;
  /** En attente de vérification : remontées mais pas encore dans la table de retour. */
  pending: number;
  confirmed: number;
  precision: number | null;
}

export function totals(rows: DailyPerformance[]): Totals {
  const flagged = rows.reduce((s, r) => s + r.ordersFlagged, 0);
  const processed = rows.reduce((s, r) => s + r.ordersProcessed, 0);
  const confirmed = rows.reduce((s, r) => s + r.ordersConfirmedFraud, 0);
  const precision = processed > 0 ? confirmed / processed : null;
  return { flagged, processed, pending: Math.max(0, flagged - processed), confirmed, precision };
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
  /** Remontées sur 30 jours en attente de vérification (pas encore dans la table de retour). */
  pending: number;
  precision: number | null;
  /** Raisons de surveiller la règle ; vide si tout va bien. */
  reasons: string[];
}

/** Indicateurs sur 30 jours d'une règle en production et motifs de surveillance (PRD F7). */
export function productionHealth(r: ConsolidatedRow, threshold: number): ProductionHealth {
  const pending = Math.max(0, r.ordersFlagged30d - r.ordersProcessed30d);
  const precision = r.ordersProcessed30d ? r.ordersConfirmed30d / r.ordersProcessed30d : null;
  const reasons: string[] = [];
  if (r.status === 'INACTIVE')
    reasons.push(`Plus exécutée par Airflow${r.lastRunAt ? ` depuis le ${fmtDate(r.lastRunAt)}` : ''} — DAG arrêté ou en panne`);
  if (r.ordersFlagged30d === 0) reasons.push('Aucune remontée sur 30 jours — règle probablement cassée');
  // En observation, rien n'est envoyé au prestataire : la précision n'est pas significative.
  if (r.status !== 'OBSERVATION' && precision !== null && precision < threshold)
    reasons.push(`Précision sous le seuil de ${fmtPct(threshold)}`);
  return { ...r, pending, precision, reasons };
}
