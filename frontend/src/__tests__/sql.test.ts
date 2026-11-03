import { describe, expect, it } from 'vitest';
import { checkParams, findParams, maskSql, queryHash } from '../lib/sql';
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
  it('refuse tout paramètre, @run_date compris', () => {
    expect(checkParams('SELECT order_id WHERE x > @seuil AND d = @run_date').map((i) => i.code)).toEqual(['PARAM_NOT_ALLOWED', 'PARAM_NOT_ALLOWED']);
    expect(checkParams('SELECT order_id FROM t WHERE d = CURRENT_DATE()')).toEqual([]);
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
  it("signale l'absence de fenêtre relative au jour d'exécution sans bloquer", () => {
    const sans = simulateDryRun('SELECT order_id FROM `sales.orders` -- CURRENT_DATE()', G, 't');
    expect(sans.issues.find((i) => i.code === 'NO_DATE_WINDOW')?.severity).toBe('warning');
    expect(sans.ok).toBe(true);
    const avec = simulateDryRun('SELECT order_id FROM `sales.orders` WHERE order_date >= current_date()', G, 't');
    expect(avec.issues.some((i) => i.code === 'NO_DATE_WINDOW')).toBe(false);
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
