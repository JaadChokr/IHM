import type { Schedule } from '../api/types';

/**
 * Période d'exécution d'une règle : valeurs de @period_start / @period_end.
 *
 * En production, Airflow passe les bornes de la période du run, calées sur le cron du DAG de la
 * fréquence (heure de Paris). Au test, c'est la dernière période complète de ce calendrier. Miroir de
 * backend/app/periods.py (qui fait foi : la période renvoyée par le test est celle du serveur).
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

/** Dernière période complète à `now` pour cette fréquence. */
export function lastPeriod(schedule: Schedule, now: Date = new Date()): Period {
  const w = wall(now.getTime());
  const day = Math.floor(w / D) * D;
  let end: number;
  let start: number;
  if (schedule === 'HOURLY') {
    // cron « 5 * * * * »
    end = Math.floor(w / H) * H + 5 * 60_000;
    if (end > w) end -= H;
    start = end - H;
  } else if (schedule === 'WEEKLY') {
    // cron « 0 4 * * 1 » : le lundi à 4 h
    end = day + 4 * H - ((new Date(day).getUTCDay() + 6) % 7) * D;
    if (end > w) end -= 7 * D;
    start = end - 7 * D;
  } else {
    // cron « 0 3 * * * »
    end = day + 3 * H;
    if (end > w) end -= D;
    start = end - D;
  }
  return { start: new Date(fromWall(start)).toISOString(), end: new Date(fromWall(end)).toISOString() };
}

const pf = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** « du lun. 2 nov., 03:00 au mar. 3 nov., 03:00 » (heure de Paris). */
export function fmtPeriod(p: Period): string {
  return `du ${pf.format(new Date(p.start))} au ${pf.format(new Date(p.end))}`;
}
