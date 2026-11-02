import type { ReactNode } from 'react';
import { RULE_STATUSES, type Criticality, type DisplayStatus } from '../api/types';
import { CRITICALITY_LABEL, STATUS_HELP, STATUS_LABEL } from '../lib/format';

/** « depuis 4 j », « depuis 5 h » : durée écoulée depuis le dernier run Airflow. */
export function idleFor(lastRunAt: string): string {
  const hours = Math.max(0, (Date.now() - new Date(lastRunAt).getTime()) / 3600000);
  return hours < 48 ? `${Math.floor(hours)} h` : `${Math.floor(hours / 24)} j`;
}

/** Badge de statut. Pour une règle inactive, `lastRunAt` affiche depuis combien de temps elle ne tourne plus. */
export function StatusBadge({ status, dim, lastRunAt }: { status: DisplayStatus; dim?: boolean; lastRunAt?: string }) {
  const label = status === 'INACTIVE' && lastRunAt ? `Inactive depuis ${idleFor(lastRunAt)}` : STATUS_LABEL[status];
  return (
    <span className={`badge st-${status}${dim ? ' dim' : ''}`} title={STATUS_HELP[status]}>
      <span className="badge-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function CriticalityBadge({ value }: { value: Criticality }) {
  const level = value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : 1;
  return (
    <span className="crit">
      <span className="crit-bars" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= level ? 'on' : ''} style={{ height: 4 + i * 3 }} />
        ))}
      </span>
      {CRITICALITY_LABEL[value]}
    </span>
  );
}

type AlertKind = 'info' | 'warn' | 'error' | 'success';
const ICON: Record<AlertKind, string> = { info: 'i', warn: '!', error: '✕', success: '✓' };

export function Alert({ kind, title, children }: { kind: AlertKind; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="alert-icon" aria-hidden="true">
        {ICON[kind]}
      </span>
      <div>
        {title && <p style={{ fontWeight: 600 }}>{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

/**
 * Cycle de vie avec le statut courant mis en avant. Les deux premières étapes sont des gestes de
 * l'analyste ; la suite se constate dans les exécutions Airflow.
 */
export function Lifecycle({ status, lastRunAt }: { status: DisplayStatus; lastRunAt?: string }) {
  const main: DisplayStatus[] = ['DRAFT', 'SUBMITTED', 'OBSERVATION', 'IN_PRODUCTION'];
  const branch = status === 'INACTIVE' || status === 'REPLACED' || status === 'DISCARDED' ? status : null;
  return (
    <div className="lifecycle" aria-label={`Cycle de vie, statut actuel : ${STATUS_LABEL[status]}`}>
      {main.map((s, i) => (
        <span key={s} className="row" style={{ gap: 4 }}>
          {i > 0 && <span className="arrow" aria-hidden="true">→</span>}
          <StatusBadge status={s} dim={s !== status} />
        </span>
      ))}
      {branch && (
        <>
          <span className="arrow" aria-hidden="true">·</span>
          <StatusBadge status={branch} lastRunAt={lastRunAt} />
        </>
      )}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row muted" role="status">
      <span className="spinner" aria-hidden="true" />
      {label ?? 'Chargement…'}
    </span>
  );
}

export const ALL_STATUSES = RULE_STATUSES;

export function Initials({ name }: { name: string }) {
  const s = name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="avatar" aria-hidden="true">
      {s}
    </span>
  );
}
