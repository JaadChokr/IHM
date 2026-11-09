import type { Criticality, DisplayStatus, Schedule } from '../api/types';

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  DRAFT: 'Brouillon',
  SUBMITTED: 'Publiée',
  OBSERVATION: 'En observation',
  IN_PRODUCTION: 'En production',
  INACTIVE: 'Inactive',
  REPLACED: 'Remplacée',
  DISCARDED: 'Écartée',
};

export const STATUS_HELP: Record<DisplayStatus, string> = {
  DRAFT: 'En cours de rédaction, visible de vous seul',
  SUBMITTED: 'Publiée : sera exécutée automatiquement à la prochaine échéance de sa fréquence',
  OBSERVATION: "Exécutée automatiquement, sans envoi au prestataire, en attendant votre décision",
  IN_PRODUCTION: 'Exécutée automatiquement, commandes envoyées au prestataire',
  INACTIVE: "Ne s'exécute plus depuis 3 échéances : à signaler à l'équipe data",
  REPLACED: 'Remplacée par une version plus récente',
  DISCARDED: "Écartée : elle n'est plus exécutée",
};

export const CRITICALITY_LABEL: Record<Criticality, string> = {
  HIGH: 'Haute',
  MEDIUM: 'Moyenne',
  LOW: 'Basse',
};

/** Moment des exécutions automatiques, selon la fréquence (calendrier des traitements de l'équipe data). */
export const SCHEDULE_WHEN: Record<Schedule, string> = {
  DAILY: 'chaque nuit à 3 h',
  HOURLY: 'toutes les heures, à h+5',
  WEEKLY: 'chaque lundi à 4 h',
};

export const SCHEDULE_LABEL: Record<Schedule, string> = {
  DAILY: 'Quotidienne',
  HOURLY: 'Horaire',
  WEEKLY: 'Hebdomadaire',
};

/**
 * Typologies de fraude — liste PROVISOIRE, à remplacer par la liste fermée
 * arrêtée avec le métier (PRD §12, Q4). Idéalement servie par l'API.
 */
export const FRAUD_TYPOLOGIES = [
  'Usurpation d’identité',
  'Prise de contrôle de compte',
  'Fraude au moyen de paiement',
  'Fraude à la livraison',
  'Abus de promotion',
  'Triangulation / revente',
  'Autre',
];

const nf = new Intl.NumberFormat('fr-FR');
const pf = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 });
const dtf = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });
const ldf = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export const fmtInt = (n: number) => nf.format(n);
export const fmtPct = (n: number | null) => (n === null || !isFinite(n) ? '—' : pf.format(n));
export const fmtDateTime = (iso: string) => dtf.format(new Date(iso));
export const fmtDate = (iso: string) => df.format(new Date(iso.length === 10 ? iso + 'T00:00:00' : iso));
export const fmtLongDate = (iso: string) => ldf.format(new Date(iso.length === 10 ? iso + 'T00:00:00' : iso));

export function fmtBytes(b: number): string {
  // Unités décimales, comme la facturation BigQuery.
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = b;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
}

export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to + 'T00:00:00').getTime() - new Date(from + 'T00:00:00').getTime()) / 86400000) + 1;
}
