import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtDate, fmtInt, fmtPct } from '../lib/format';

/** Les chiffres d'une version, jour par jour (alignés sur les dates du graphique). */
export interface VersionBars {
  version: number;
  /** Commandes remontées ; null : la version n'a pas tourné ce jour-là (pas de barre). */
  flagged: (number | null)[];
  /** Commandes vérifiées par le prestataire, et parmi elles confirmées frauduleuses (en production seulement). */
  processed: (number | null)[];
  confirmed: (number | null)[];
  /** La version était en observation ce jour-là (barre hachurée, pas de fraudes confirmées mesurées). */
  observed: boolean[];
}

export type BarMeasure = 'flagged' | 'confirmed';

interface Props {
  label: string;
  dates: string[];
  series: VersionBars[];
  /** Mesures affichées : remontées (barre entière), fraudes confirmées (partie pleine), ou les deux. */
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

const M = { top: 14, right: 12, bottom: 26, left: 52 };

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

/**
 * Histogramme journalier, une barre par version et par jour (versions parallèles côte à côte), sur une seule
 * échelle en nombre de commandes. La barre entière : les commandes remontées (teinte claire ; hachurée en
 * observation). Superposée en bas, en couleur franche : celles confirmées frauduleuses par le prestataire
 * (versions en production). On voit ainsi, barre par barre, combien de remontées sont de vraies fraudes.
 * Survol et clavier (flèches) : infobulle du jour, avec la précision.
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
  const n = dates.length;
  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;
  const band = n ? iw / n : iw;
  const xBand = (i: number) => M.left + i * band;
  const base = M.top + ih;

  const shown = series.filter((s) => s.flagged.some((v) => v !== null));
  const anyObserved = shown.some((s) => s.flagged.some((v, i) => v !== null && s.observed[i]));
  const anyProduction = shown.some((s) => s.flagged.some((v, i) => v !== null && !s.observed[i]));
  const anyConfirmed = shown.some((s) => s.confirmed.some((v) => v !== null));

  if (n === 0 || shown.length === 0) return <div className="empty">Aucune donnée sur la période.</div>;

  const top = Math.max(
    0,
    ...shown.flatMap((s) => (showFlagged ? s.flagged : s.confirmed).map((v) => v ?? 0)),
  );
  const max = niceMax(top);
  const y = (v: number) => (Math.min(v, max) / max) * ih;
  // Graduations entières : 5, 4 ou 2 intervalles selon ce qui tombe juste (50 → 0, 10, 20…).
  const steps = [5, 4, 2].find((k) => Number.isInteger(max / k)) ?? 1;
  const ticks = Array.from({ length: steps + 1 }, (_, k) => (k * max) / steps);
  const xTicks = (() => {
    const count = Math.min(n, Math.max(2, Math.floor(iw / 90)));
    return Array.from({ length: count }, (_, k) => Math.round((k / (count - 1 || 1)) * (n - 1)));
  })();

  function onMove(e: PointerEvent<SVGRectElement>) {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - rect.left - M.left) / band))));
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  }

  const noConfirmed = showConfirmed && !showFlagged && !anyConfirmed;

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
            dont fraudes confirmées
          </li>
        )}
        {showFlagged && anyObserved && (
          <li className="legend-style">
            <span className="legend-swatch legend-hatched" aria-hidden="true" />
            en observation{anyProduction ? '' : " (rien n'est envoyé)"}
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
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'baseline' : 'gridline'} x1={M.left} x2={M.left + iw} y1={base - y(t)} y2={base - y(t)} />
              <text x={M.left - 8} y={base - y(t) + 4} textAnchor="end">
                {fmtInt(Math.round(t))}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={xBand(i) + band / 2} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(dates[i] + 'T00:00:00'))}
            </text>
          ))}
        </g>

        {dates.map((_, i) => {
          const present = shown.filter((s) => s.flagged[i] !== null);
          if (!present.length) return null;
          const group = band * 0.82;
          const gap = band > 8 ? 2 : 0; // 2 px entre barres voisines quand la place le permet
          const bw = Math.max(1, (group - gap * (present.length - 1)) / present.length);
          const x0 = xBand(i) + (band - group) / 2;
          return present.map((s, k) => {
            const x = x0 + k * (bw + gap);
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
          });
        })}

        {noConfirmed && (
          <text className="panel-empty" x={M.left + iw / 2} y={M.top + ih / 2} textAnchor="middle">
            Aucune fraude confirmée mesurée sur la période (les versions en observation ne sont pas vérifiées).
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

        <rect x={M.left} y={0} width={iw} height={height} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
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
              const processed = s.processed[hover];
              return (
                <div key={s.version}>
                  <span className="tt-key" aria-hidden="true" style={{ background: versionColor(s.version) }} />
                  v{s.version} · <strong>{fmtInt(flagged)}</strong> remontées
                  {confirmed !== null && (
                    <>
                      {' '}
                      · <strong>{fmtInt(confirmed)}</strong> fraudes confirmées
                    </>
                  )}{' '}
                  <span className="muted">{s.observed[hover] ? '(observation)' : '(production)'}</span>
                  {confirmed !== null && processed ? (
                    <div className="muted">
                      Précision {fmtPct(confirmed / processed)} · {fmtInt(processed)} vérifiées sur {fmtInt(flagged)}
                    </div>
                  ) : (
                    !s.observed[hover] && <div className="muted">Aucune commande encore vérifiée</div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
