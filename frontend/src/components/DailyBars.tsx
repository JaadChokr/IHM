import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtDate, fmtInt, fmtPct } from '../lib/format';
import { relevanceOf } from '../lib/metrics';

/** Les chiffres d'une version, jour par jour (alignés sur les dates du graphique). */
export interface VersionBars {
  version: number;
  /** Commandes remontées ; null : la version n'a pas tourné ce jour-là (pas de barre). */
  flagged: (number | null)[];
  /**
   * Commandes vérifiées (par le prestataire en production, qualifiées par un analyste en test), et parmi
   * elles les fraudes avérées et les pertinentes (fraudes avérées et commandes risquées).
   */
  processed: (number | null)[];
  confirmed: (number | null)[];
  relevant: (number | null)[];
  /** La version était en test ce jour-là (barre hachurée : rien n'est transmis au prestataire). */
  observed: boolean[];
}

/** Parts d'une barre, de bas en haut, et ligne de pertinence. */
export type BarMeasure = 'fraud' | 'risky' | 'ras' | 'pending' | 'relevance';
type Segment = Exclude<BarMeasure, 'relevance'>;

/**
 * Les couleurs de la qualification, pour que le graphique se lise sans légende : rouge = fraude avérée,
 * orange = commande risquée, vert = RAS, gris = pas encore vérifiée (à qualifier en test, en attente du
 * prestataire en production). La pertinence est une ligne sombre, neutre. Classes `.m-<mesure>` (ui.css).
 */
export const MEASURES: { key: BarMeasure; label: string }[] = [
  { key: 'fraud', label: 'Fraudes avérées' },
  { key: 'risky', label: 'Risquées' },
  { key: 'ras', label: 'RAS' },
  { key: 'pending', label: 'Non vérifiées' },
  { key: 'relevance', label: 'Pertinence' },
];
const SEGMENTS: Segment[] = ['fraud', 'risky', 'ras', 'pending'];
const COLOR: Record<BarMeasure, string> = {
  fraud: 'var(--chart-fraud)',
  risky: 'var(--chart-risky)',
  ras: 'var(--chart-ras)',
  pending: 'var(--chart-pending)',
  relevance: 'var(--chart-relevance)',
};
/** Trait de la ligne de pertinence de la k-ième version affichée : plein, tirets, points, mixte. */
const DASHES = [undefined, '6 4', '2 3', '8 3 2 3'];
const dashOf = (k: number) => DASHES[k % DASHES.length];

interface Props {
  label: string;
  dates: string[];
  series: VersionBars[];
  /** Mesures affichées, au moins une. */
  show: BarMeasure[];
  /** Repères verticaux, ex. la date à laquelle une nouvelle version a commencé à tourner. */
  markers?: { date: string; label: string }[];
  height?: number;
}

const M = { top: 14, bottom: 26, left: 52 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  // Paliers serrés (56 → 60 et non 100) : les barres occupent la hauteur du graphique.
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((k) => n <= k) ?? 10) * p;
}

/** Barre aux coins supérieurs arrondis (ou rectangle, pour une part intermédiaire), posée en y0. */
function barPath(x: number, w: number, y0: number, h: number, rounded = true): string {
  const r = rounded ? Math.max(0, Math.min(3, w / 2, h)) : 0;
  const top = y0 - h;
  return `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${y0}Z`;
}

/** Les parts d'une barre un jour donné : fraudes avérées, risquées, RAS, non vérifiées (null : pas de run). */
function partsAt(s: VersionBars, i: number): Record<Segment, number> | null {
  const flagged = s.flagged[i];
  if (flagged === null) return null;
  const processed = Math.min(flagged, s.processed[i] ?? 0);
  const relevant = Math.min(processed, s.relevant[i] ?? 0);
  const fraud = Math.min(relevant, s.confirmed[i] ?? 0);
  return { fraud, risky: relevant - fraud, ras: processed - relevant, pending: flagged - processed };
}

/** Pertinence d'une version un jour donné (null : rien de vérifié ce jour-là, pas de point). */
const relevanceAt = (s: VersionBars, i: number) => (s.flagged[i] === null ? null : relevanceOf(s.relevant[i] ?? 0, s.processed[i] ?? 0));

/**
 * Histogramme journalier, une barre par version et par jour (versions parallèles côte à côte, la plus
 * ancienne à gauche), en nombre de commandes. Chaque barre est l'ensemble des commandes remontées, découpé
 * par verdict avec les couleurs de la qualification (fraude avérée, risquée, RAS, non vérifiée) ; hachurée
 * quand la version est en test. Chaque part s'affiche ou se masque. En option, la pertinence du jour (fraudes
 * avérées et commandes risquées, sur les vérifiées) : une ligne par version, lue sur l'axe de droite.
 * Survol et clavier (flèches) : infobulle du jour.
 */
export function DailyBars({ label, dates, series, show, markers = [], height = 260 }: Props) {
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

  const visible = SEGMENTS.filter((k) => show.includes(k));
  const showRelevance = show.includes('relevance');
  const showCounts = visible.length > 0;
  const right = showRelevance ? 44 : 12;
  const left = showCounts ? M.left : 12;
  const n = dates.length;
  const iw = width - left - right;
  const ih = height - M.top - M.bottom;
  const band = n ? iw / n : iw;
  const xBand = (i: number) => left + i * band;
  const base = M.top + ih;

  const shown = series.filter((s) => s.flagged.some((v) => v !== null));
  const anyObserved = shown.some((s) => s.flagged.some((v, i) => v !== null && s.observed[i]));
  const anyRelevance = shown.some((s) => dates.some((_, i) => relevanceAt(s, i) !== null));
  /** Hauteur d'une barre : la somme de ses parts affichées. */
  const stackAt = (s: VersionBars, i: number) => {
    const p = partsAt(s, i);
    return p ? visible.reduce((t, k) => t + p[k], 0) : 0;
  };

  if (n === 0 || shown.length === 0) return <div className="empty">Aucune donnée sur la période.</div>;

  const top = Math.max(0, ...shown.flatMap((s) => dates.map((_, i) => stackAt(s, i))));
  const max = niceMax(top);
  const y = (v: number) => (Math.min(v, max) / max) * ih;
  // Graduations entières : 5, 4 ou 2 intervalles selon ce qui tombe juste (50 → 0, 10, 20…). L'axe de la
  // pertinence suit les mêmes lignes (5 intervalles : 0, 20, 40… 100 %).
  const steps = showCounts ? ([5, 4, 2].find((k) => Number.isInteger(max / k)) ?? 1) : 5;
  const ticks = Array.from({ length: steps + 1 }, (_, k) => k / steps);
  const xTicks = (() => {
    const count = Math.min(n, Math.max(2, Math.floor(iw / 90)));
    return Array.from({ length: count }, (_, k) => Math.round((k / (count - 1 || 1)) * (n - 1)));
  })();

  /** Position des barres d'un jour : les versions qui ont tourné ce jour-là, côte à côte. */
  function slots(i: number) {
    const present = shown.filter((s) => s.flagged[i] !== null);
    const group = band * 0.82;
    const gap = band > 8 ? 2 : 0; // 2 px entre barres voisines quand la place le permet
    const bw = Math.max(1, (group - gap * (present.length - 1)) / Math.max(1, present.length));
    const x0 = xBand(i) + (band - group) / 2;
    return present.map((s, k) => ({ s, x: x0 + k * (bw + gap), bw }));
  }

  /** Ligne de pertinence d'une version : interrompue les jours sans commande vérifiée. */
  function relevancePath(s: VersionBars): { d: string; points: { x: number; y: number }[] } {
    let d = '';
    let pen = false;
    const points: { x: number; y: number }[] = [];
    dates.forEach((_, i) => {
      const r = relevanceAt(s, i);
      const slot = r === null ? undefined : slots(i).find((x) => x.s.version === s.version);
      if (r === null || !slot) {
        pen = false;
        return;
      }
      const px = slot.x + slot.bw / 2;
      const py = base - r * ih;
      d += `${pen ? 'L' : 'M'}${px},${py}`;
      pen = true;
      points.push({ x: px, y: py });
    });
    return { d, points };
  }

  function onMove(e: PointerEvent<SVGRectElement>) {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - rect.left - left) / band))));
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  }

  const empty =
    showCounts && top === 0 && !(showRelevance && anyRelevance)
      ? 'Aucune commande de ce type sur la période (en test : qualifiez les alertes pour en mesurer).'
      : !showCounts && !anyRelevance
        ? 'Aucune commande vérifiée sur la période : pertinence non mesurable (en test : qualifiez les alertes).'
        : null;

  return (
    <div className="chart" ref={wrap}>
      {(anyObserved || shown.length > 1) && (
        <ul className="chart-legend" aria-label="Légende">
          {showCounts && anyObserved && (
            <li className="legend-style">
              <span className="legend-swatch legend-hatched" aria-hidden="true" />
              hachuré : version en test (rien n'est envoyé au prestataire)
            </li>
          )}
          {showCounts && shown.length > 1 && (
            <li className="legend-style">versions côte à côte, de gauche à droite : {shown.map((s) => `v${s.version}`).join(', ')}</li>
          )}
          {showRelevance &&
            anyRelevance &&
            shown.length > 1 &&
            shown.map((s, k) => (
              <li key={`rel-${s.version}`} className="legend-style">
                <svg className="legend-line" width="18" height="6" aria-hidden="true">
                  <line x1="0" y1="3" x2="18" y2="3" stroke={COLOR.relevance} strokeWidth="2" strokeDasharray={dashOf(k)} />
                </svg>
                pertinence v{s.version}
              </li>
            ))}
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
          {/* Hachures claires posées sur toute la barre d'une version en test, quelle que soit sa couleur. */}
          <pattern id={`${uid}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="hatch-line" strokeWidth="2.5" />
          </pattern>
        </defs>

        {hover !== null && <rect className="bar-hover" x={xBand(hover)} y={M.top} width={band} height={ih} />}

        <g className="axis">
          {ticks.map((f) => (
            <g key={f}>
              <line className={f === 0 ? 'baseline' : 'gridline'} x1={left} x2={left + iw} y1={base - f * ih} y2={base - f * ih} />
              {showCounts && (
                <text x={left - 8} y={base - f * ih + 4} textAnchor="end">
                  {fmtInt(Math.round(f * max))}
                </text>
              )}
              {showRelevance && (
                <text x={left + iw + 8} y={base - f * ih + 4} textAnchor="start">
                  {Math.round(f * 100)} %
                </text>
              )}
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={xBand(i) + band / 2} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(dates[i] + 'T00:00:00'))}
            </text>
          ))}
        </g>

        {showCounts &&
          dates.map((_, i) =>
            slots(i).map(({ s, x, bw }) => {
              const parts = partsAt(s, i)!;
              const total = stackAt(s, i);
              if (total <= 0) return null;
              // Les parts s'empilent de bas en haut ; seule la dernière a les coins arrondis.
              const drawn = visible.filter((k) => parts[k] > 0);
              let from = 0;
              return (
                <g key={`${s.version}-${i}`}>
                  {drawn.map((k, j) => {
                    const y0 = base - y(from);
                    const h = Math.max(1, y(from + parts[k]) - y(from));
                    from += parts[k];
                    return <path key={k} className="bar" d={barPath(x, bw, y0, h, j === drawn.length - 1)} fill={COLOR[k]} />;
                  })}
                  {s.observed[i] && <path className="bar" d={barPath(x, bw, base, Math.max(1, y(total)))} fill={`url(#${uid}-hatch)`} />}
                </g>
              );
            }),
          )}

        {showRelevance &&
          shown.map((s, k) => {
            const { d, points } = relevancePath(s);
            if (!points.length) return null;
            return (
              <g key={`rel-${s.version}`} className="relevance">
                <path className="relevance-halo" d={d} />
                <path className="relevance-line" d={d} stroke={COLOR.relevance} strokeDasharray={dashOf(k)} />
                {points.map((p, j) => (
                  <circle key={j} className="relevance-dot" cx={p.x} cy={p.y} r={points.length > 60 ? 1.5 : 2.5} stroke={COLOR.relevance} />
                ))}
              </g>
            );
          })}

        {empty && (
          <text className="panel-empty" x={left + iw / 2} y={M.top + ih / 2} textAnchor="middle">
            {empty}
          </text>
        )}

        {markers.map((m) => {
          const i = dates.indexOf(m.date);
          if (i < 0) return null;
          return (
            <g key={m.date + m.label} className="marker">
              <line x1={xBand(i)} x2={xBand(i)} y1={M.top} y2={base} />
              <text x={xBand(i) + 5} y={M.top + 11}>
                {m.label}
              </text>
            </g>
          );
        })}

        <rect x={left} y={0} width={iw} height={height} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: Math.min(Math.max(xBand(hover) + band / 2, 140), width - 140), top: M.top }} aria-live="polite">
          <div className="muted">{fmtDate(dates[hover])}</div>
          {shown.every((s) => s.flagged[hover] === null) && <strong>Pas d'exécution</strong>}
          {shown
            .filter((s) => s.flagged[hover] !== null)
            .map((s) => {
              const p = partsAt(s, hover)!;
              const processed = s.processed[hover] ?? 0;
              const relevant = s.relevant[hover] ?? 0;
              const test = s.observed[hover];
              const plural = (k: Segment, one: string, many: string) => (p[k] > 1 ? many : one);
              const lines: [Segment, string][] = [
                ['fraud', plural('fraud', 'fraude avérée', 'fraudes avérées')],
                ['risky', plural('risky', 'risquée', 'risquées')],
                ['ras', 'RAS'],
                ['pending', test ? 'à qualifier' : 'en attente de vérification'],
              ];
              return (
                <div key={s.version} className="tt-version">
                  <div>
                    v{s.version} · <strong>{fmtInt(s.flagged[hover] ?? 0)}</strong> remontées{' '}
                    <span className="muted">{test ? '(en test)' : '(production)'}</span>
                  </div>
                  <ul className="tt-parts">
                    {lines
                      .filter(([k]) => p[k] > 0)
                      .map(([k, name]) => (
                        <li key={k}>
                          <span className={`tt-dot m-${k}`} aria-hidden="true" />
                          <strong>{fmtInt(p[k])}</strong> {name}
                        </li>
                      ))}
                  </ul>
                  <div className="muted">
                    {processed
                      ? `Pertinence ${fmtPct(relevant / processed)} · ${fmtInt(relevant)} pertinentes sur ${fmtInt(processed)} ${test ? 'qualifiées' : 'vérifiées'}`
                      : test
                        ? 'Aucune commande encore qualifiée'
                        : 'Aucune commande encore vérifiée'}
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
