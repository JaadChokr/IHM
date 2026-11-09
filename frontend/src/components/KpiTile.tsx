import type { ReactNode } from 'react';
import { InfoTip } from './ui';

interface Props {
  label: string;
  value: string;
  sub?: ReactNode;
  /** Variation vs période précédente, déjà formatée ; null = non calculable. */
  delta?: { text: string; direction: 'up' | 'down' | 'flat' } | null;
  /** Explication en infobulle, à côté du libellé. */
  info?: ReactNode;
  /** Chiffre clé mis en avant (fond anthracite). */
  featured?: boolean;
}

/** Tuile d'indicateur : le chiffre, sa variation (libellée, pas seulement colorée). */
export function KpiTile({ label, value, sub, delta, info, featured }: Props) {
  return (
    <div className={`card kpi${featured ? ' kpi-featured' : ''}`}>
      <span className="kpi-label">
        {label}
        {info && <InfoTip label={`À propos : ${label}`}>{info}</InfoTip>}
      </span>
      <span className="kpi-value">{value}</span>
      {delta !== undefined && (
        <span className="kpi-delta">
          {delta === null ? (
            <span className="muted">— pas de période de comparaison</span>
          ) : (
            <>
              <span className={`kpi-pill ${delta.direction}`}>
                <span aria-hidden="true">{delta.direction === 'up' ? '↗' : delta.direction === 'down' ? '↘' : '→'}</span> {delta.text}
              </span>
              <span className="muted">vs période précédente</span>
            </>
          )}
        </span>
      )}
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}
