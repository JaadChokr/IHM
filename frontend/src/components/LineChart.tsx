import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtDate } from '../lib/format';

/** Une courbe : une version de la règle, ses valeurs alignées sur les dates du graphique. */
export interface Series {
  version: number;
  /** null : pas de donnée ce jour-là (trou dans la courbe). */
  values: (number | null)[];
  /** Par jour : la version était en observation (trait pointillé) plutôt qu'en production (trait plein). */
  observed: boolean[];
  /** Ligne secondaire de l'infobulle, par jour. */
  details?: (string | undefined)[];
}

interface Props {
  label: string;
  dates: string[];
  series: Series[];
  format: (v: number) => string;
  /** Borne haute fixe (ex. 1 pour un taux). */
  yMax?: number;
  /** Repères verticaux, ex. la date à laquelle une nouvelle version a commencé à tourner. */
  markers?: { date: string; label: string }[];
  height?: number;
}

const M = { top: 14, right: 56, bottom: 26, left: 48 };

/**
 * Couleur d'une version : rouge de la marque, bleu, vert d'eau, violet (palette validée daltonisme et
 * contraste, clair et sombre). Au-delà de 4 versions les couleurs reviennent ; le repère « vN » et la
 * légende portent toujours le numéro.
 */
export function versionColor(version: number | undefined): string {
  return version === undefined ? 'var(--series-1)' : `var(--version-${((version - 1) % 4) + 1})`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/**
 * Courbes journalières, une par version, sur un axe Y unique (PRD F6 : jamais de double axe). Trait plein
 * quand la version est en production, pointillé quand elle est en observation : deux versions qui tournent
 * en même temps (production et candidate) se comparent sur les mêmes jours. Réticule + infobulle au survol
 * et au clavier (flèches gauche/droite).
 */
export function LineChart({ label, dates, series, format, yMax, markers = [], height = 200 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;
  const n = dates.length;
  const max = yMax ?? niceMax(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const x = (i: number) => M.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => M.top + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  // Segments continus par version (une valeur nulle = trou). Au passage de l'observation à la production,
  // le nouveau segment repart du dernier point pour que la courbe reste continue.
  const paths = useMemo(() => {
    const out: { version: number; observed: boolean; d: string }[] = [];
    for (const s of series) {
      let cur: { version: number; observed: boolean; d: string } | null = null;
      let last: { i: number; v: number } | null = null;
      s.values.forEach((v, i) => {
        if (v === null) {
          cur = null;
          last = null;
          return;
        }
        const pt = `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        const observed = !!s.observed[i];
        if (!cur || cur.observed !== observed) {
          const prev: { i: number; v: number } | null = last;
          cur = { version: s.version, observed, d: prev ? `M${x(prev.i).toFixed(1)},${y(prev.v).toFixed(1)}L${pt}` : `M${pt}` };
          out.push(cur);
        } else {
          cur.d += `L${pt}`;
        }
        last = { i, v };
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, width, max, n]);

  // Aplat dégradé sous chaque courbe (une ou deux versions ; au-delà, il brouillerait la lecture).
  const areas = useMemo(() => {
    const out: { version: number; d: string }[] = [];
    for (const s of series) {
      let run: number[] = [];
      const flush = () => {
        if (run.length > 1) {
          const top = run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.values[i]!).toFixed(1)}`).join('');
          const base = y(0).toFixed(1);
          out.push({ version: s.version, d: `${top}L${x(run[run.length - 1]).toFixed(1)},${base}L${x(run[0]).toFixed(1)},${base}Z` });
        }
        run = [];
      };
      s.values.forEach((v, i) => (v === null ? flush() : run.push(i)));
      flush();
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, width, max, n]);

  const shown = series.filter((s) => s.values.some((v) => v !== null));
  const hasObserved = shown.some((s) => s.values.some((v, i) => v !== null && s.observed[i]));
  const hasProduction = shown.some((s) => s.values.some((v, i) => v !== null && !s.observed[i]));

  const xTicks = useMemo(() => {
    if (n === 0) return [];
    const count = Math.min(n, Math.max(2, Math.floor(iw / 90)));
    return Array.from({ length: count }, (_, k) => Math.round((k / (count - 1 || 1)) * (n - 1)));
  }, [n, iw]);

  // Dernier point de chaque version, étiqueté s'il n'y a pas plus de deux versions (au-delà, l'infobulle).
  const ends = shown.map((s) => {
    let i = s.values.length - 1;
    while (i >= 0 && s.values[i] === null) i--;
    return { s, i };
  });

  function onMove(e: PointerEvent<SVGRectElement>) {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - M.left) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }
  function onKey(e: KeyboardEvent) {
    if (!n) return;
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  }

  if (n === 0 || shown.length === 0) return <div className="empty">Aucune donnée sur la période.</div>;
  const hovered = hover !== null ? shown.filter((s) => s.values[hover] !== null) : [];
  const topValue = hovered.length ? Math.max(...hovered.map((s) => s.values[hover!]!)) : null;

  return (
    <div className="chart" ref={wrap}>
      {(shown.length > 1 || hasObserved) && (
        <ul className="chart-legend" aria-label="Versions">
          {shown.map((s) => (
            <li key={s.version}>
              <span className="legend-key" style={{ background: versionColor(s.version) }} aria-hidden="true" />v{s.version}
            </li>
          ))}
          {hasProduction && hasObserved && (
            <li className="legend-style">
              <svg width="22" height="8" aria-hidden="true">
                <line x1="0" x2="22" y1="4" y2="4" className="legend-line" />
              </svg>
              en production
            </li>
          )}
          {hasObserved && (
            <li className="legend-style">
              <svg width="22" height="8" aria-hidden="true">
                <line x1="0" x2="22" y1="4" y2="4" className="legend-line observed" />
              </svg>
              en observation{hasProduction ? '' : ' (rien n\'est envoyé)'}
            </li>
          )}
        </ul>
      )}
      <svg
        height={height}
        role="img"
        aria-label={`${label}, du ${fmtDate(dates[0])} au ${fmtDate(dates[n - 1])}, ${shown.length} version${shown.length > 1 ? 's' : ''}. Utilisez les flèches pour parcourir les valeurs.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <defs>
          {shown.map((s) => (
            <linearGradient key={s.version} id={`${gid}-v${s.version}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={versionColor(s.version)} stopOpacity={0.2} />
              <stop offset="100%" stopColor={versionColor(s.version)} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <g className="axis">
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'baseline' : 'gridline'} x1={M.left} x2={M.left + iw} y1={y(t)} y2={y(t)} />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(dates[i] + 'T00:00:00'))}
            </text>
          ))}
        </g>
        {markers.map((m) => {
          const i = dates.indexOf(m.date);
          if (i < 0) return null;
          return (
            <g key={m.date + m.label} className="marker">
              <line x1={x(i)} x2={x(i)} y1={M.top} y2={M.top + ih} />
              <text x={x(i) + 5} y={M.top + 11}>
                {m.label}
              </text>
            </g>
          );
        })}
        {shown.length <= 2 && areas.map((a, k) => <path key={`a${k}`} className="area" d={a.d} fill={`url(#${gid}-v${a.version})`} />)}
        {paths.map((p, k) => (
          <path key={k} className={`line${p.observed ? ' observed' : ''}`} d={p.d} style={{ stroke: versionColor(p.version) }} />
        ))}
        {ends.map(({ s, i }) =>
          i < 0 ? null : (
            <g key={s.version}>
              <circle className="dot" cx={x(i)} cy={y(s.values[i]!)} r={4} style={{ fill: versionColor(s.version) }} />
              {shown.length <= 2 && (
                <text className="end-label" x={x(i) + 8} y={y(s.values[i]!) + 4}>
                  {format(s.values[i]!)}
                </text>
              )}
            </g>
          ),
        )}
        {hover !== null && (
          <g>
            <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ih} />
            {hovered.map((s) => (
              <circle key={s.version} className="dot" cx={x(hover)} cy={y(s.values[hover]!)} r={5} style={{ fill: versionColor(s.version) }} />
            ))}
          </g>
        )}
        <rect x={M.left - 6} y={0} width={iw + 12} height={height} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div
          className="tooltip"
          style={{ left: Math.min(Math.max(x(hover), 80), width - 80), top: topValue !== null ? y(topValue) - 10 : M.top + ih / 2 }}
          aria-live="polite"
        >
          <div className="muted">{fmtDate(dates[hover])}</div>
          {hovered.length === 0 && <strong>n/d</strong>}
          {hovered.map((s) => (
            <div key={s.version}>
              <span className="tt-key" aria-hidden="true" style={{ background: versionColor(s.version) }} />
              v{s.version} · <strong>{format(s.values[hover]!)}</strong>{' '}
              <span className="muted">{s.observed[hover] ? '(observation)' : '(production)'}</span>
              {s.details?.[hover] && <div className="muted">{s.details[hover]}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
