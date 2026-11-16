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

/** Mesures affichables : remontées (barre entière), fraudes avérées (partie pleine), pertinence (ligne, en %). */
export type BarMeasure = 'flagged' | 'confirmed' | 'relevance';

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

/**
 * Couleur d'une version : rouge de la marque, bleu, vert d'eau, violet (palette validée daltonisme et
 * contraste, clair et sombre). Au-delà de 4 versions les couleurs reviennent ; la légende et l'infobulle
 * portent toujours le numéro.
 */
export function versionColor(version: number | undefined): string {
  return version === undefined ? 'var(--series-1)' : `var(--version-${((version - 1) % 4) + 1})`;
}

const M = { top: 14, bottom: 26, left: 52 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  // Paliers serrés (56 → 60 et non 100) : les barres occupent la hauteur du graphique.
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((k) => n <= k) ?? 10) * p;
}

/** Barre aux coins supérieurs arrondis, posée sur la ligne de base. */
function barPath(x: number, w: number, y0: number, h: number): string {
  const r = Math.max(0, Math.min(3, w / 2, h));
  const top = y0 - h;
  return `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${y0}Z`;
}

/** Pertinence d'une version un jour donné (null : rien de vérifié ce jour-là, pas de point). */
const relevanceAt = (s: VersionBars, i: number) => (s.flagged[i] === null ? null : relevanceOf(s.relevant[i] ?? 0, s.processed[i] ?? 0));

/**
 * Histogramme journalier, une barre par version et par jour (versions parallèles côte à côte), sur une seule
 * échelle en nombre de commandes. La barre entière : les commandes remontées (teinte claire ; hachurée en
 * test). Superposée en bas, en couleur franche : les fraudes avérées. On voit ainsi, barre par barre, combien
 * de remontées sont de vraies fraudes. En option, la pertinence du jour (fraudes avérées et commandes
 * risquées, sur les vérifiées) : une ligne par version, lue sur l'axe de droite en pourcentage.
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

  const showFlagged = show.includes('flagged');
  const showConfirmed = show.includes('confirmed');
  const showRelevance = show.includes('relevance');
  const showCounts = showFlagged || showConfirmed;
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
  const anyProduction = shown.some((s) => s.flagged.some((v, i) => v !== null && !s.observed[i]));
  const anyConfirmed = shown.some((s) => s.confirmed.some((v) => v !== null && v > 0));
  const anyRelevance = shown.some((s) => dates.some((_, i) => relevanceAt(s, i) !== null));

  if (n === 0 || shown.length === 0) return <div className="empty">Aucune donnée sur la période.</div>;

  const top = Math.max(0, ...shown.flatMap((s) => (showFlagged ? s.flagged : s.confirmed).map((v) => v ?? 0)));
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
    !showFlagged && showConfirmed && !anyConfirmed && !(showRelevance && anyRelevance)
      ? 'Aucune fraude avérée sur la période (en test : qualifiez les alertes pour en mesurer).'
      : !showCounts && !anyRelevance
        ? 'Aucune commande vérifiée sur la période : pertinence non mesurable (en test : qualifiez les alertes).'
        : null;

  return (
    <div className="chart" ref={wrap}>
      <ul className="chart-legend" aria-label="Légende">
        {shown.length > 1 &&
          shown.map((s) => (
            <li key={s.version}>
              <span className="legend-swatch" style={{ background: versionColor(s.version) }} aria-hidden="true" />v{s.version}
            </li>
          ))}
        {showFlagged && (
          <li className="legend-style">
            <span className="legend-swatch legend-tint" aria-hidden="true" />
            remontées
          </li>
        )}
        {showConfirmed && anyConfirmed && (
          <li className="legend-style">
            <span className="legend-swatch legend-solid" aria-hidden="true" />
            {showFlagged ? 'dont fraudes avérées' : 'fraudes avérées'}
          </li>
        )}
        {showRelevance && anyRelevance && (
          <li className="legend-style">
            <span className="legend-line" aria-hidden="true" />
            {showCounts ? 'pertinence (axe de droite)' : 'pertinence'}
          </li>
        )}
        {showFlagged && anyObserved && (
          <li className="legend-style">
            <span className="legend-swatch legend-hatched" aria-hidden="true" />
            en test{anyProduction ? '' : " (rien n'est envoyé)"}
          </li>
        )}
      </ul>
      <svg
        height={height}
        role="img"
        aria-label={`${label}, du ${fmtDate(dates[0])} au ${fmtDate(dates[n - 1])}. Utilisez les flèches pour parcourir les jours.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <defs>
          {shown.map((s) => (
            <pattern key={s.version} id={`${uid}-hatch-${s.version}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" className="hatch-bg" fill={versionColor(s.version)} />
              <line x1="0" y1="0" x2="0" y2="5" stroke={versionColor(s.version)} strokeWidth="2.5" />
            </pattern>
          ))}
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
              const flagged = s.flagged[i] ?? 0;
              const confirmed = s.confirmed[i];
              return (
                <g key={`${s.version}-${i}`}>
                  {showFlagged && (
                    <path
                      className={`bar${s.observed[i] ? '' : ' bar-tint'}`}
                      d={barPath(x, bw, base, Math.max(flagged > 0 ? 1 : 0, y(flagged)))}
                      fill={s.observed[i] ? `url(#${uid}-hatch-${s.version})` : versionColor(s.version)}
                    />
                  )}
                  {showConfirmed && confirmed !== null && confirmed > 0 && (
                    <path className="bar" d={barPath(x, bw, base, Math.max(1, y(confirmed)))} fill={versionColor(s.version)} />
                  )}
                </g>
              );
            }),
          )}

        {showRelevance &&
          shown.map((s) => {
            const { d, points } = relevancePath(s);
            if (!points.length) return null;
            return (
              <g key={`rel-${s.version}`} className="relevance">
                <path className="relevance-halo" d={d} />
                <path className="relevance-line" d={d} stroke={versionColor(s.version)} />
                {points.map((p, k) => (
                  <circle key={k} className="relevance-dot" cx={p.x} cy={p.y} r={points.length > 60 ? 1.5 : 2.5} stroke={versionColor(s.version)} />
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
        <div className="tooltip" style={{ left: Math.min(Math.max(xBand(hover) + band / 2, 120), width - 120), top: M.top }} aria-live="polite">
          <div className="muted">{fmtDate(dates[hover])}</div>
          {shown.every((s) => s.flagged[hover] === null) && <strong>Pas d'exécution</strong>}
          {shown
            .filter((s) => s.flagged[hover] !== null)
            .map((s) => {
              const flagged = s.flagged[hover] ?? 0;
              const confirmed = s.confirmed[hover];
              const relevant = s.relevant[hover] ?? 0;
              const processed = s.processed[hover];
              const test = s.observed[hover];
              return (
                <div key={s.version}>
                  <span className="tt-key" aria-hidden="true" style={{ background: versionColor(s.version) }} />
                  v{s.version} · <strong>{fmtInt(flagged)}</strong> remontées
                  {confirmed !== null && (
                    <>
                      {' '}
                      · <strong>{fmtInt(confirmed)}</strong> fraudes avérées
                    </>
                  )}{' '}
                  <span className="muted">{test ? '(en test)' : '(production)'}</span>
                  {processed ? (
                    <div className="muted">
                      Pertinence <strong>{fmtPct(relevant / processed)}</strong> · {fmtInt(relevant)} pertinentes sur {fmtInt(processed)}{' '}
                      {test ? 'qualifiées' : 'vérifiées'}
                    </div>
                  ) : (
                    <div className="muted">{test ? 'Aucune commande encore qualifiée' : 'Aucune commande encore vérifiée'}</div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
