// Simulation de BigQuery pour le mode démo. Le vrai back-end s'appuie sur les
// métadonnées du dry-run (`statementType`, schéma de sortie) ; ici on les
// imite par une analyse grossière du texte, suffisante pour exercer l'IHM.

import type { DryRunResult, ExecutionResult, Guardrails, SqlIssue, TestPeriod } from '../types';
import { checkDateWindow, checkParams, maskSql, offsetToLineCol, queryHash } from '../../lib/sql';
import { lastPeriod } from '../../lib/period';

interface CatalogTable {
  bytes: number;
  columns: { name: string; type: string }[];
}

const GB = 1e9;

export const CATALOG: Record<string, CatalogTable> = {
  'sales.orders': {
    bytes: 9.4 * GB,
    columns: [
      { name: 'order_id', type: 'STRING' },
      { name: 'customer_id', type: 'STRING' },
      { name: 'order_date', type: 'DATE' },
      { name: 'created_at', type: 'TIMESTAMP' },
      { name: 'amount_eur', type: 'FLOAT64' },
      { name: 'item_count', type: 'INT64' },
      { name: 'billing_address_id', type: 'STRING' },
      { name: 'shipping_address_id', type: 'STRING' },
      { name: 'promo_code', type: 'STRING' },
      { name: 'channel', type: 'STRING' },
    ],
  },
  'sales.customers': {
    bytes: 1.8 * GB,
    columns: [
      { name: 'customer_id', type: 'STRING' },
      { name: 'account_created_at', type: 'TIMESTAMP' },
      { name: 'email_domain', type: 'STRING' },
      { name: 'email_changed_at', type: 'TIMESTAMP' },
      { name: 'country', type: 'STRING' },
    ],
  },
  'sales.payments': {
    bytes: 4.6 * GB,
    columns: [
      { name: 'payment_id', type: 'STRING' },
      { name: 'order_id', type: 'STRING' },
      { name: 'card_bin', type: 'STRING' },
      { name: 'card_country', type: 'STRING' },
      { name: 'attempt_count', type: 'INT64' },
      { name: 'status', type: 'STRING' },
    ],
  },
  'sales.deliveries': {
    bytes: 2.2 * GB,
    columns: [
      { name: 'order_id', type: 'STRING' },
      { name: 'delivery_mode', type: 'STRING' },
      { name: 'relay_point_id', type: 'STRING' },
      { name: 'address_id', type: 'STRING' },
      { name: 'country', type: 'STRING' },
    ],
  },
  'sales.addresses': {
    bytes: 0.9 * GB,
    columns: [
      { name: 'address_id', type: 'STRING' },
      { name: 'postal_code', type: 'STRING' },
      { name: 'country', type: 'STRING' },
    ],
  },
  // Table volumineuse, utile pour démontrer le refus au-delà du plafond.
  'tracking.web_events_raw': {
    bytes: 184 * GB,
    columns: [
      { name: 'event_id', type: 'STRING' },
      { name: 'order_id', type: 'STRING' },
      { name: 'session_id', type: 'STRING' },
      { name: 'event_ts', type: 'TIMESTAMP' },
      { name: 'ip', type: 'STRING' },
      { name: 'user_agent', type: 'STRING' },
    ],
  },
};

function resolveTable(ref: string): string | undefined {
  const parts = ref.replace(/`/g, '').split('.');
  const key = parts.slice(-2).join('.');
  return CATALOG[key] ? key : undefined;
}

function issueAt(sql: string, offset: number, length: number, severity: SqlIssue['severity'], code: string, message: string): SqlIssue {
  const { line, column } = offsetToLineCol(sql, offset);
  return { severity, code, message: `${message} at [${line}:${column}]`, line, column, length };
}

/** Indices des caractères au niveau de parenthèses 0. */
function depthMap(masked: string): number[] {
  const depth: number[] = [];
  let d = 0;
  for (const ch of masked) {
    if (ch === '(') d++;
    depth.push(d);
    if (ch === ')') d--;
  }
  return depth;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let d = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

interface Analysis {
  issues: SqlIssue[];
  statementType?: string;
  tables: string[];
  outputSchema: { name: string; type: string }[];
}

function analyse(sql: string): Analysis {
  const issues: SqlIssue[] = [];
  const masked = maskSql(sql);
  const trimmedStart = masked.search(/\S/);
  if (trimmedStart === -1) {
    return { issues: [{ severity: 'error', code: 'EMPTY', message: 'La requête est vide.' }], tables: [], outputSchema: [] };
  }

  // Une seule instruction
  const semi = masked.indexOf(';');
  if (semi !== -1 && masked.slice(semi + 1).trim()) {
    issues.push(issueAt(sql, semi, 1, 'error', 'MULTI_STATEMENT', 'Une seule instruction est autorisée'));
  }

  // statementType
  const firstWord = (masked.slice(trimmedStart).match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
  const statementType = firstWord === 'WITH' || firstWord === 'SELECT' ? 'SELECT' : firstWord || 'UNKNOWN';
  if (statementType !== 'SELECT') {
    issues.push({
      severity: 'error',
      code: 'NOT_SELECT',
      message: `statementType = ${statementType} : seule une instruction SELECT est autorisée (DML/DDL rejetés).`,
      ...offsetToLineCol(sql, trimmedStart),
      length: firstWord.length,
    });
    return { issues, statementType, tables: [], outputSchema: [] };
  }

  // Parenthèses
  let d = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '(') d++;
    if (masked[i] === ')') d--;
    if (d < 0) {
      issues.push(issueAt(sql, i, 1, 'error', 'SYNTAX', 'Syntax error: Unexpected ")"'));
      break;
    }
  }
  if (d > 0) issues.push(issueAt(sql, masked.trimEnd().length, 1, 'error', 'SYNTAX', 'Syntax error: Expected ")" but got end of script'));

  // Virgule pendante avant FROM
  const dangling = /,\s*(FROM)\b/i.exec(masked);
  if (dangling) {
    const off = dangling.index + dangling[0].length - 4;
    issues.push(issueAt(sql, off, 4, 'error', 'SYNTAX', 'Syntax error: Unexpected keyword FROM'));
  }

  // Tables
  const cteNames = new Set<string>();
  for (const m of masked.matchAll(/(?:\bWITH|,)\s+(\w+)\s+AS\s*\(/gi)) cteNames.add(m[1].toLowerCase());
  const tables: string[] = [];
  for (const m of masked.matchAll(/\b(?:FROM|JOIN)\s+(`[^`]+`|[\w.-]+)/gi)) {
    const ref = m[1];
    if (cteNames.has(ref.replace(/`/g, '').toLowerCase())) continue;
    const key = resolveTable(ref);
    if (key) {
      if (!tables.includes(key)) tables.push(key);
    } else {
      const off = (m.index ?? 0) + m[0].length - ref.length;
      issues.push(issueAt(sql, off, ref.length, 'error', 'NOT_FOUND', `Not found: Table ${ref.replace(/`/g, '')} was not found`));
    }
  }

  // Dates en dur : simple alerte (légitimes comme seuil fixe, pas comme jour traité)
  const withStrings = maskSql(sql, true);
  for (const m of withStrings.matchAll(/(?:\b(?:DATE|TIMESTAMP)\s*)?'\d{4}-\d{2}-\d{2}[^']*'/gi)) {
    issues.push(
      issueAt(
        sql,
        m.index ?? 0,
        m[0].length,
        'warning',
        'HARDCODED_DATE',
        `Date en dur (${m[0]}) : normal pour un seuil fixe. Si elle désigne la période traitée, la règle relira ce même jour à chaque exécution : préférez created_at >= @period_start AND created_at < @period_end.`,
      ),
    );
  }

  // Fenêtre de dates : CURRENT_DATE() (faux en rattrapage) ou aucune fenêtre (pic au premier run)
  issues.push(...checkDateWindow(sql));

  // Paramètres : seuls @period_start / @period_end
  issues.push(...checkParams(sql));

  // Schéma de sortie : la dernière projection SELECT de niveau 0
  const depth = depthMap(masked);
  let selectIdx = -1;
  for (const m of masked.matchAll(/\bSELECT\b/gi)) if (depth[m.index ?? 0] === 0) selectIdx = m.index ?? 0;
  let outputSchema: { name: string; type: string }[] = [];
  if (selectIdx !== -1) {
    let fromIdx = masked.length;
    for (const m of masked.slice(selectIdx).matchAll(/\b(FROM|WHERE|GROUP|ORDER|LIMIT|QUALIFY|HAVING)\b/gi)) {
      const abs = selectIdx + (m.index ?? 0);
      if (depth[abs] === 0) {
        fromIdx = abs;
        break;
      }
    }
    const list = masked.slice(selectIdx + 6, fromIdx).replace(/^\s*(DISTINCT|ALL)\b/i, '');
    const allCols = tables.flatMap((t) => CATALOG[t].columns);
    for (const raw of splitTopLevel(list)) {
      const item = raw.trim();
      if (!item) continue;
      if (/\*\s*$/.test(item)) {
        for (const c of allCols) if (!outputSchema.some((o) => o.name === c.name)) outputSchema.push(c);
        continue;
      }
      const name = item.match(/\bAS\s+(\w+)\s*$/i)?.[1] ?? item.match(/(\w+)\s*$/)?.[1] ?? 'f0_';
      const catalogType = allCols.find((c) => c.name === name)?.type;
      const type = catalogType ?? (/^(COUNT|SUM)\s*\(/i.test(item) ? 'INT64' : /^(AVG|ROUND)\s*\(/i.test(item) ? 'FLOAT64' : 'STRING');
      outputSchema.push({ name, type });
    }
  }
  if (!issues.some((i) => i.severity === 'error' && i.code === 'SYNTAX') && !outputSchema.some((c) => c.name === 'order_id')) {
    issues.push({
      severity: 'error',
      code: 'NO_ORDER_ID',
      message: 'La projection doit exposer la colonne order_id.',
      ...(selectIdx !== -1 ? { ...offsetToLineCol(sql, selectIdx), length: 6 } : {}),
    });
  }

  return { issues, statementType, tables, outputSchema };
}

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `period` : valeurs de @period_start / @period_end (la dernière période complète de la fréquence). */
export function simulateDryRun(sql: string, g: Guardrails, testId: string, period: TestPeriod = lastPeriod('DAILY')): DryRunResult {
  const a = analyse(sql);
  const ok = !a.issues.some((i) => i.severity === 'error');
  if (!ok) return { ok, statementType: a.statementType, issues: a.issues, exceedsBytesLimit: false, period, testId };
  // Filtrer sur la date élague les partitions : on ne scanne qu'une fraction.
  const r = rng(queryHash(sql));
  const bytesProcessed = Math.round(a.tables.reduce((s, t) => s + CATALOG[t].bytes, 0) * (0.55 + r() * 0.5));
  return {
    ok,
    statementType: a.statementType,
    outputSchema: a.outputSchema,
    bytesProcessed,
    issues: a.issues,
    exceedsBytesLimit: bytesProcessed > g.maxBytesBilled,
    period,
    testId,
  };
}

const FIRST = ['A', 'B', 'C', 'D', 'E', 'F'];

export function simulateExecution(sql: string, g: Guardrails, dry: DryRunResult, testId: string): ExecutionResult {
  const r = rng(queryHash(sql) + ':exec');
  // Plus les seuils (« > 500 », « >= 3 ») sont élevés, moins la règle remonte de lignes.
  const numeric = [...maskSql(sql).matchAll(/>=?\s*(\d+(?:\.\d+)?)/g)].reduce((s, m) => s + Number(m[1]), 0);
  const totalRows = Math.max(0, Math.round((400 + r() * 2600) / (1 + numeric / 400)));
  const columns = (dry.outputSchema ?? []).map((c) => c.name);
  const n = Math.min(totalRows, g.maxResults);
  // Dates des lignes simulées : dans la période testée.
  const from = new Date(dry.period.start).getTime();
  const span = new Date(dry.period.end).getTime() - from;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {};
    for (const c of dry.outputSchema ?? []) {
      const v = r();
      switch (c.type) {
        case 'INT64':
          row[c.name] = Math.floor(v * 12) + 1;
          break;
        case 'FLOAT64':
          row[c.name] = Math.round(v * 250000) / 100;
          break;
        case 'DATE':
          row[c.name] = new Date(from + v * span).toISOString().slice(0, 10);
          break;
        case 'TIMESTAMP':
          row[c.name] = new Date(from + v * span).toISOString();
          break;
        case 'BOOL':
          row[c.name] = v > 0.5;
          break;
        default:
          row[c.name] = c.name.endsWith('_id')
            ? `${c.name.slice(0, 3).toUpperCase()}-${FIRST[Math.floor(v * 6)]}${String(Math.floor(r() * 1e7)).padStart(7, '0')}`
            : c.name.includes('country')
              ? ['FR', 'BE', 'ES', 'NG', 'RO', 'GB'][Math.floor(v * 6)]
              : `val_${Math.floor(v * 100)}`;
      }
    }
    rows.push(row);
  }
  return {
    ok: true,
    columns,
    rows,
    totalRows,
    durationMs: Math.round(1500 + r() * 9000),
    bytesProcessed: dry.bytesProcessed ?? 0,
    // Recoupement avec les autres règles : calculé par mockApi, qui connaît les règles en production.
    ordersFlagged: totalRows,
    ordersAlreadyFlagged: 0,
    overlapDays: 90,
    period: dry.period,
    testId,
  };
}
