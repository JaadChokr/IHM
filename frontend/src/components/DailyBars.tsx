import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtDate } from '../lib/format';

/** Une série : une version de la règle, ses valeurs alignées sur les jours du graphique. */
export interface Series {
  version: number;
  /** null : pas de donnée ce jour-là (pas de barre). */
  values: (number | null)[];
  /** Par jour : la version était en observation (barre hachurée) plutôt qu'en production (barre pleine). */
  observed: boolean[];
  /** Ligne secondaire de l'infobulle, par jour. */
  details?: (string | undefined)[];
}

/** Un étage du graphique : une mesure, avec sa propre échelle verticale. */
export interface Panel {
  key: string;
  label: string;
  series: Series[];
  format: (v: number) => string;
  /** Borne haute fixe (ex. 1 pour un taux). */
  yMax?: number;
  /** Message affiché dans l'étage quand il n'a aucune valeur sur la période. */
  emptyText?: string;
}

interface Props {
  label: string;
  dates: string[];
  panels: Panel[];
  /** Repères verticaux, ex. la date à laquelle une nouvelle version a commencé à tourner. */
  markers?: { date: string; label: string }[];
  panelHeight?: number;
}

/**
 * Couleur d'une version : rouge de la marque, bleu, vert d'eau, violet (palette validée daltonisme et
 * contraste, clair et sombre). Au-delà de 4 versions les couleurs reviennent ; la légende et l'infobulle
 * portent toujours le numéro.
 */
export function versionColor(version: number | undefined): string {
  return version === undefined ? 'var(--series-1)' : `var(--version-${((version - 1) % 4) + 1})`;
}

const M = { top: 8, right: 12, bottom: 26, left: 52 };
const LABEL_H = 30; // titre de l'étage
const PANEL_GAP = 18;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Barre aux coins supérieurs arrondis, posée sur la ligne de base. */
function barPath(x: number, w: number, y0: number, h: number): string {
  const r = Math.max(0, Math.min(3, w / 2, h));
  const top = y0 - h;
  return `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${y0}Z`;
}

/**
 * Barres journalières, une par version et par jour, sur un ou deux étages alignés (même axe des jours,
 * chaque mesure avec sa propre échelle : jamais deux échelles sur un même étage). Barre pleine : version
 * en production ; hachurée : en observation. Survol et clavier (flèches) : infobulle du jour, toutes
 * mesures affichées.
 */
export function DailyBars({ label, dates, panels, markers = [], panelHeight = 170 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = dates.length;
  const iw = width - M.left - M.right;
  const band = n ? iw / n : iw;
  const xBand = (i: number) => M.left + i * band;
  const height = M.top + panels.length * (LABEL_H + panelHeight) + (panels.length - 1) * PANEL_GAP + M.bottom;
  const panelTop = (p: number) => M.top + p * (LABEL_H + panelHeight + PANEL_GAP) + LABEL_H;
  const plotBottom = panelTop(panels.length - 1) + panelHeight;

  // Versions présentes (toutes mesures confondues), dans l'ordre : légende et motifs de hachures.
  const versions = [...new Set(panels.flatMap((p) => p.series.filter((s) => s.values.some((v) => v !== null)).map((s) => s.version)))].sort(
    (a, b) => a - b,
  );
  const anyObserved = panels.some((p) => p.series.some((s) => s.values.some((v, i) => v !== null && s.observed[i])));
  const anyProduction = panels.some((p) => p.series.some((s) => s.values.some((v, i) => v !== null && !s.observed[i])));

  if (n === 0 || versions.length === 0) return <div className="empty">Aucune donnée sur la période.</div>;

  const xTicks = (() => {
    const count = Math.min(n, Math.max(2, Math.floor(iw / 90)));
    return Array.from({ length: count }, (_, k) => Math.round((k / (count - 1 || 1)) * (n - 1)));
  })();

  function onMove(e: PointerEvent<SVGRectElement>) {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - M.left) / band);
    setHover(Math.max(0, Math.min(n - 1, i)));
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  }

  const fillFor = (version: number, observed: boolean) => (observed ? `url(#${uid}-hatch-${version})` : versionColor(version));

  return (
    <div className="chart" ref={wrap}>
      {(versions.length > 1 || anyObserved) && (
        <ul className="chart-legend" aria-label="Versions">
          {versions.map((v) => (
            <li key={v}>
              <span className="legend-swatch" style={{ background: versionColor(v) }} aria-hidden="true" />v{v}
            </li>
          ))}
          {anyProduction && anyObserved && (
            <li className="legend-style">
              <span className="legend-swatch legend-solid" aria-hidden="true" />
              en production
            </li>
          )}
          {anyObserved && (
            <li className="legend-style">
              <span className="legend-swatch legend-hatched" aria-hidden="true" />
              en observation{anyProduction ? '' : " (rien n'est envoyé)"}
            </li>
          )}
        </ul>
      )}
      <svg
        height={height}
        role="img"
        aria-label={`${label}, du ${fmtDate(dates[0])} au ${fmtDate(dates[n - 1])}. Utilisez les flèches pour parcourir les jours.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <defs>
          {versions.map((v) => (
            <pattern key={v} id={`${uid}-hatch-${v}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill={versionColor(v)} opacity="0.22" />
              <line x1="0" y1="0" x2="0" y2="5" stroke={versionColor(v)} strokeWidth="2.5" />
            </pattern>
          ))}
        </defs>

        {hover !== null && (
          <rect className="bar-hover" x={xBand(hover)} y={panelTop(0) - LABEL_H + 4} width={band} height={plotBottom - panelTop(0) + LABEL_H - 4} />
        )}

        {panels.map((p, pi) => {
          const top = panelTop(pi);
          const base = top + panelHeight;
          const max = p.yMax ?? niceMax(Math.max(0, ...p.series.flatMap((s) => s.values.map((v) => v ?? 0))));
          const y = (v: number) => (v / max) * panelHeight;
          const ticks = [0, 0.5, 1].map((t) => t * max);
          return (
            <g key={p.key}>
              <text className="panel-label" x={M.left} y={top - 14}>
                {p.label}
              </text>
              {p.emptyText && !p.series.some((s) => s.values.some((v) => v !== null)) && (
                <text className="panel-empty" x={M.left + iw / 2} y={top + panelHeight / 2} textAnchor="middle">
                  {p.emptyText}
                </text>
              )}
              <g className="axis">
                {ticks.map((t) => (
                  <g key={t}>
                    <line className={t === 0 ? 'baseline' : 'gridline'} x1={M.left} x2={M.left + iw} y1={base - y(t)} y2={base - y(t)} />
                    <text x={M.left - 8} y={base - y(t) + 4} textAnchor="end">
                      {p.format(t)}
                    </text>
                  </g>
                ))}
              </g>
              {dates.map((_, i) => {
                const present = p.series.filter((s) => s.values[i] !== null && s.values[i] !== undefined);
                if (!present.length) return null;
                const group = band * 0.82;
                const gap = band > 8 ? 2 : 0; // 2 px entre barres voisines quand la place le permet
                const bw = Math.max(1, (group - gap * (present.length - 1)) / present.length);
                const x0 = xBand(i) + (band - group) / 2;
                return present.map((s, k) => {
                  const v = s.values[i]!;
                  return (
                    <path
                      key={`${s.version}-${i}`}
                      className="bar"
                      d={barPath(x0 + k * (bw + gap), bw, base, Math.max(v > 0 ? 1 : 0, y(Math.min(v, max))))}
                      fill={fillFor(s.version, !!s.observed[i])}
                    />
                  );
                });
              })}
            </g>
          );
        })}

        <g className="axis">
          {xTicks.map((i) => (
            <text key={i} x={xBand(i) + band / 2} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(dates[i] + 'T00:00:00'))}
            </text>
          ))}
        </g>

        {markers.map((m) => {
          const i = dates.indexOf(m.date);
          if (i < 0) return null;
          return (
            <g key={m.date + m.label} className="marker">
              <line x1={xBand(i)} x2={xBand(i)} y1={panelTop(0) - 4} y2={plotBottom} />
              <text x={xBand(i) + 5} y={panelTop(0) + 8}>
                {m.label}
              </text>
            </g>
          );
        })}

        <rect x={M.left} y={0} width={iw} height={height} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div
          className="tooltip"
          style={{ left: Math.min(Math.max(xBand(hover) + band / 2, 110), width - 110), top: panelTop(0) + 4 }}
          aria-live="polite"
        >
          <div className="muted">{fmtDate(dates[hover])}</div>
          {versions.map((v) => {
            const cells = panels
              .map((p) => ({ p, s: p.series.find((s) => s.version === v) }))
              .filter(({ s }) => s && s.values[hover] !== null && s.values[hover] !== undefined);
            if (!cells.length) return null;
            const observed = cells.some(({ s }) => s!.observed[hover]);
            const details = cells.map(({ s }) => s!.details?.[hover]).filter(Boolean);
            return (
              <div key={v}>
                <span className="tt-key" aria-hidden="true" style={{ background: versionColor(v) }} />
                v{v} ·{' '}
                {cells.map(({ p, s }, k) => (
                  <span key={p.key}>
                    {k > 0 && ' · '}
                    <strong>{p.format(s!.values[hover]!)}</strong> <span className="muted">{p.key === 'volume' ? 'remontées' : 'précision'}</span>
                  </span>
                ))}{' '}
                <span className="muted">{observed ? '(observation)' : '(production)'}</span>
                {details.map((d) => (
                  <div key={d} className="muted">
                    {d}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
