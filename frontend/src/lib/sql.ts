import type { SqlIssue } from '../api/types';
import { PERIOD_PARAMS } from './period';

/**
 * Remplace commentaires et littéraux par des espaces, en conservant les
 * positions, pour que les recherches ne matchent pas à l'intérieur.
 * `keepStrings` laisse les littéraux chaîne intacts.
 */
export function maskSql(sql: string, keepStrings = false): string {
  let out = '';
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if ((c === '-' && next === '-') || c === '#') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== c) j += sql[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, sql.length);
      const chunk = sql.slice(i, stop);
      // Les identifiants entre backticks restent visibles : ce sont des noms de tables.
      out += c === '`' || keepStrings ? chunk : c + blank(chunk.slice(1, -1)) + (stop > i + 1 ? c : '');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function offsetToLineCol(sql: string, offset: number): { line: number; column: number } {
  const before = sql.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return { line, column };
}

export function lineColToOffset(sql: string, line: number, column: number): number {
  const lines = sql.split('\n');
  let offset = 0;
  for (let l = 0; l < line - 1 && l < lines.length; l++) offset += lines[l].length + 1;
  return offset + column - 1;
}

export interface ParamOccurrence {
  name: string;
  offset: number;
}

/** Paramètres nommés BigQuery (`@nom`) présents dans la requête. */
export function findParams(sql: string): ParamOccurrence[] {
  const masked = maskSql(sql);
  const out: ParamOccurrence[] = [];
  const re = /(^|[^@\w])@([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    out.push({ name: m[2], offset: m.index + m[1].length });
  }
  return out;
}

const ALLOWED: readonly string[] = PERIOD_PARAMS;

/**
 * Paramètres de la requête : seuls @period_start / @period_end, facultatifs, bornes de la période du run
 * (fournies par Airflow, et par la plateforme au test). Les seuils s'écrivent directement dans le SQL ;
 * CURRENT_DATE() est libre.
 * Contrôle d'ergonomie côté front ; le back refait la vérification.
 */
export function checkParams(sql: string): SqlIssue[] {
  const issues: SqlIssue[] = [];
  const used = findParams(sql);
  const reported = new Set<string>();
  for (const p of used) {
    if (ALLOWED.includes(p.name) || reported.has(p.name)) continue;
    reported.add(p.name);
    const { line, column } = offsetToLineCol(sql, p.offset);
    issues.push({
      severity: 'error',
      code: 'PARAM_NOT_ALLOWED',
      message: `@${p.name} : seuls @period_start et @period_end sont fournis (bornes de la période du run). Écrivez les autres valeurs dans la requête (ex. amount_eur > 500).`,
      line,
      column,
      length: p.name.length + 1,
    });
  }
  return issues;
}

/**
 * Alerte si la requête n'a aucune fenêtre de dates (ni CURRENT_DATE() et consorts, ni @period_start /
 * @period_end) : chaque run relit toute la table et le premier run remonte tout l'historique. Miroir de
 * check_date_window côté back. CURRENT_DATE() est libre.
 */
export function checkDateWindow(sql: string): SqlIssue[] {
  if (!sql.trim()) return [];
  // Hors chaînes et commentaires, et hors identifiants entre backticks (une colonne `current_date`).
  const masked = maskSql(sql).replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));
  if (/\bCURRENT_(?:DATE|DATETIME|TIMESTAMP)\b/i.test(masked) || findParams(sql).some((p) => ALLOWED.includes(p.name))) return [];
  return [
    {
      severity: 'warning',
      code: 'NO_DATE_WINDOW',
      message:
        "Pas de fenêtre de dates : chaque run relira toute la table, un volume inutilement grand, et le premier run remontera tout l'historique (pic dans le comparatif des versions). Bornez la lecture, par exemple order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) pour la veille.",
    },
  ];
}

/** Empreinte stable de la requête, pour lier un test à une version. */
export function queryHash(sql: string): string {
  const s = sql.trim().replace(/\s+/g, ' ');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
