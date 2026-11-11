import type { Schedule } from '../api/types';

/**
 * Période d'exécution d'une règle : valeurs de @period_start / @period_end.
 *
 * Fréquence = une unité (le DAG Airflow qui l'exécute, cron calé sur l'heure de Paris) et un pas : la
 * règle ne tourne qu'aux déclenchements où elle est due, et sa période va du déclenchement dû précédent à
 * celui-ci. Au test, c'est la dernière période complète de ce calendrier. Miroir de backend/app/query/periods.py
 * (qui fait foi : la période renvoyée par le test est celle du serveur).
 */
export const TZ = 'Europe/Paris';
export const PERIOD_PARAMS = ['period_start', 'period_end'] as const;

export interface Period {
  start: string; // ISO, inclus
  end: string; // ISO, exclu
}

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Heure murale de Paris d'un instant, codée comme un instant UTC (pour l'arithmétique de calendrier). */
function wall(t: number): number {
  const p = Object.fromEntries(parts.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Instant correspondant à une heure murale de Paris (changements d'heure compris). */
function fromWall(w: number): number {
  let t = w - (wall(w) - w);
  t = w - (wall(t) - t); // second passage : l'écart à Paris peut changer entre les deux estimations
  return t;
}

const H = 3_600_000;
const D = 24 * H;
/** Origine du calage des jours et des semaines : le lundi 5 janvier 2026. */
const ANCHOR_DAY = Date.UTC(2026, 0, 5) / D;

/** La règle (toutes les `every` unités) tourne-t-elle à ce déclenchement du DAG ? */
export function isDue(schedule: Schedule, every: number, t: number): boolean {
  const w = wall(t);
  if (schedule === 'HOURLY') return new Date(w).getUTCHours() % every === 0;
  const days = Math.floor(w / D) - ANCHOR_DAY;
  return (schedule === 'WEEKLY' ? Math.floor(days / 7) : days) % every === 0;
}

/** Déclenchement précédent : une heure réelle avant, ou la même heure de Paris la veille / la semaine d'avant. */
function prevTick(schedule: Schedule, t: number): number {
  if (schedule === 'HOURLY') return t - H;
  return fromWall(wall(t) - (schedule === 'WEEKLY' ? 7 : 1) * D);
}

/** Dernier déclenchement du DAG de l'unité à `now` ou avant (instant). */
function lastTick(schedule: Schedule, now: number): number {
  const w = wall(now);
  const day = Math.floor(w / D) * D;
  let end: number;
  if (schedule === 'HOURLY') {
    // cron « 5 * * * * »
    end = Math.floor(w / H) * H + 5 * 60_000;
    if (end > w) end -= H;
  } else if (schedule === 'WEEKLY') {
    // cron « 0 4 * * 1 » : le lundi à 4 h
    end = day + 4 * H - ((new Date(day).getUTCDay() + 6) % 7) * D;
    if (end > w) end -= 7 * D;
  } else {
    // cron « 0 3 * * * »
    end = day + 3 * H;
    if (end > w) end -= D;
  }
  return fromWall(end);
}

/** Prochain déclenchement où la règle tournera, après `now` (instant ISO). */
export function nextRun(schedule: Schedule, every = 1, now: Date = new Date()): string {
  const step = (t: number) => (schedule === 'HOURLY' ? t + H : fromWall(wall(t) + (schedule === 'WEEKLY' ? 7 : 1) * D));
  let t = step(lastTick(schedule, now.getTime()));
  while (!isDue(schedule, every, t)) t = step(t);
  return new Date(t).toISOString();
}

/** Dernière période complète à `now` pour cette fréquence (pas de `every` unités). */
export function lastPeriod(schedule: Schedule, now: Date = new Date(), every = 1): Period {
  let end = lastTick(schedule, now.getTime());
  while (!isDue(schedule, every, end)) end = prevTick(schedule, end);
  let start = prevTick(schedule, end);
  while (!isDue(schedule, every, start)) start = prevTick(schedule, start);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

const pf = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** « mer. 11 nov., 03:00 » (heure de Paris, comme les heures d'exécution annoncées). */
export function fmtRun(iso: string): string {
  return pf.format(new Date(iso));
}

/** « du lun. 2 nov., 03:00 au mar. 3 nov., 03:00 » (heure de Paris). */
export function fmtPeriod(p: Period): string {
  return `du ${pf.format(new Date(p.start))} au ${pf.format(new Date(p.end))}`;
}
