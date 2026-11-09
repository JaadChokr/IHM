import { describe, expect, it } from 'vitest';
import { checkDateWindow, checkParams, findParams, maskSql, queryHash } from '../lib/sql';
import { lastPeriod } from '../lib/period';
import { diffLines } from '../lib/diff';
import { totals } from '../lib/metrics';
import { simulateDryRun } from '../api/mock/bigquery';
import type { Guardrails } from '../api/types';

const G: Guardrails = { maxBytesBilled: 50e9, jobTimeoutMs: 60000, maxResults: 100 };

describe('paramètres nommés', () => {
  it('ignore les @ dans les chaînes et commentaires', () => {
    const sql = "SELECT order_id FROM t -- @nope\nWHERE a = '@str' AND d = @run_date AND x > @seuil";
    expect(findParams(sql).map((x) => x.name)).toEqual(['run_date', 'seuil']);
  });
  it('ignore les variables système @@', () => {
    expect(findParams('SELECT @@project_id, @a')).toHaveLength(1);
  });
  it('admet seulement @period_start / @period_end', () => {
    expect(checkParams('SELECT order_id WHERE x > @seuil AND d = @run_date').map((i) => i.code)).toEqual(['PARAM_NOT_ALLOWED', 'PARAM_NOT_ALLOWED']);
    expect(checkParams('SELECT order_id FROM t WHERE d >= @period_start AND d < @period_end')).toEqual([]);
  });
  it('accepte CURRENT_DATE(), alerte sur une requête sans fenêtre de dates', () => {
    expect(checkDateWindow('SELECT order_id FROM t\nWHERE d >= current_date()')).toEqual([]);
    expect(checkDateWindow('SELECT CURRENT_TIMESTAMP() AS t')).toEqual([]);
    expect(checkDateWindow('SELECT `current_date` FROM t').map((i) => i.code)).toEqual(['NO_DATE_WINDOW']);
    expect(checkDateWindow('SELECT order_id FROM t -- CURRENT_DATE()').map((i) => i.code)).toEqual(['NO_DATE_WINDOW']);
    expect(checkDateWindow("SELECT order_id FROM t WHERE d = DATE(@period_end, 'Europe/Paris')")).toEqual([]);
  });
  it('masque en conservant les positions', () => {
    const sql = "a /* x */ 'yy' b";
    expect(maskSql(sql)).toHaveLength(sql.length);
  });
  it('empreinte insensible aux espaces, sensible au contenu', () => {
    expect(queryHash('SELECT  1')).toBe(queryHash('SELECT 1\n'));
    expect(queryHash('SELECT 1')).not.toBe(queryHash('SELECT 2'));
  });
});

describe('dry-run simulé', () => {
  const ok = 'SELECT o.order_id FROM `sales.orders` o WHERE o.order_date = CURRENT_DATE()';
  it('accepte une requête conforme', () => {
    const r = simulateDryRun(ok, G, 't');
    expect(r.ok).toBe(true);
    expect(r.statementType).toBe('SELECT');
    expect(r.outputSchema?.map((c) => c.name)).toContain('order_id');
  });
  it('rejette le DML', () => {
    const r = simulateDryRun('DELETE FROM `sales.orders` WHERE true', G, 't');
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe('NOT_SELECT');
  });
  it('exige order_id en sortie', () => {
    const r = simulateDryRun('SELECT o.customer_id FROM `sales.orders` o WHERE o.order_date = CURRENT_DATE()', G, 't');
    expect(r.issues.map((i) => i.code)).toContain('NO_ORDER_ID');
  });
  it('signale une table inconnue avec sa position', () => {
    const r = simulateDryRun('SELECT order_id\nFROM `sales.nope` WHERE d = CURRENT_DATE()', G, 't');
    const i = r.issues.find((x) => x.code === 'NOT_FOUND')!;
    expect(i.line).toBe(2);
    expect(i.column).toBe(6);
  });
  it('signale les dates en dur sans bloquer le test', () => {
    const r = simulateDryRun("SELECT order_id FROM `sales.orders` WHERE order_date = DATE '2026-01-01' AND x = 1", G, 't');
    expect(r.issues.find((i) => i.code === 'HARDCODED_DATE')?.severity).toBe('warning');
    expect(r.ok).toBe(true);
  });
  it("signale l'absence de fenêtre de dates sans bloquer", () => {
    const sans = simulateDryRun('SELECT order_id FROM `sales.orders` -- CURRENT_DATE()', G, 't');
    expect(sans.issues.find((i) => i.code === 'NO_DATE_WINDOW')?.severity).toBe('warning');
    expect(sans.ok).toBe(true);
    const avec = simulateDryRun('SELECT order_id FROM `sales.orders` WHERE created_at >= @period_start AND created_at < @period_end', G, 't');
    expect(avec.issues).toEqual([]);
  });
  it('signale un dépassement du plafond de volume', () => {
    const r = simulateDryRun('SELECT order_id FROM `tracking.web_events_raw` WHERE d = CURRENT_DATE()', G, 't');
    expect(r.ok).toBe(true);
    expect(r.exceedsBytesLimit).toBe(true);
  });
});

describe('diff et indicateurs', () => {
  it('diff ligne à ligne', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc');
    expect(d.map((l) => l.kind)).toEqual(['same', 'del', 'add', 'same']);
  });
  it('précision calculée sur les traitées, échantillon faible signalé', () => {
    const t = totals([{ date: '2026-01-01', ordersFlagged: 100, ordersProcessed: 10, ordersConfirmedFraud: 5 }]);
    expect(t.precision).toBe(0.5);
    expect(t.processingRate).toBe(0.1);
    expect(t.lowSample).toBe(true);
  });
});

describe('période testée (@period_start / @period_end)', () => {
  const at = (iso: string) => new Date(iso);
  it('quotidienne : de 3 h à 3 h, heure de Paris', () => {
    // 4 nov. 2026, 2 h 30 à Paris (UTC+1) : le run de 3 h n'a pas encore eu lieu.
    expect(lastPeriod('DAILY', at('2026-11-04T01:30:00Z'))).toEqual({ start: '2026-11-02T02:00:00.000Z', end: '2026-11-03T02:00:00.000Z' });
  });
  it('horaire : de h+5 à h+5', () => {
    expect(lastPeriod('HOURLY', at('2026-11-04T13:02:00Z'))).toEqual({ start: '2026-11-04T11:05:00.000Z', end: '2026-11-04T12:05:00.000Z' });
  });
  it('hebdomadaire : du lundi 4 h au lundi 4 h', () => {
    expect(lastPeriod('WEEKLY', at('2026-11-04T08:00:00Z'))).toEqual({ start: '2026-10-26T03:00:00.000Z', end: '2026-11-02T03:00:00.000Z' });
  });
  it("passage à l'heure d'hiver : une journée de 25 h", () => {
    const p = lastPeriod('DAILY', at('2026-10-25T11:00:00Z'));
    expect(p).toEqual({ start: '2026-10-24T01:00:00.000Z', end: '2026-10-25T02:00:00.000Z' });
  });
});
