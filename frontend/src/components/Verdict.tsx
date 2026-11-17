import type { Alert, AlertVerdict, ReviewVerdict } from '../api/types';
import { fmtDateTime } from '../lib/format';

export const VERDICT_LABEL: Record<AlertVerdict, string> = {
  FRAUD: 'Fraude avérée',
  RISKY: 'Commande risquée',
  NOT_FRAUD: 'RAS',
  TO_REVIEW: 'À vérifier',
  PENDING: 'En attente de vérification',
};
/** Les trois qualifications possibles d'une commande en test, dans l'ordre de la liste. */
const REVIEW_CHOICES: ReviewVerdict[] = ['FRAUD', 'RISKY', 'NOT_FRAUD'];

/**
 * Verdict d'une alerte : pour une commande en test que le prestataire n'a pas vérifiée, la liste de choix des
 * analystes (fraude avérée, risquée, RAS ; « À vérifier » retire le verdict) ; sinon le verdict affiché.
 */
export function VerdictCell({ alert: a, busy, onReview }: { alert: Alert; busy: boolean; onReview: (a: Alert, next: ReviewVerdict | null) => void }) {
  const testing = a.phase === 'TEST';
  // Une commande en test déjà vérifiée par le prestataire (transmise par une autre règle) : son verdict prime.
  const byProvider = a.providerIsFraud !== null && a.providerIsFraud !== undefined;
  if (!testing || byProvider) {
    return (
      <>
        <span className={`badge verdict verdict-${a.verdict}`}>{VERDICT_LABEL[a.verdict]}</span>
        {testing && <div className="small muted">Déjà vérifiée par le prestataire</div>}
      </>
    );
  }
  return (
    <>
      <select
        className={`select-sm verdict-select verdict-${a.review?.verdict ?? 'TO_REVIEW'}`}
        value={a.review?.verdict ?? ''}
        disabled={busy}
        onChange={(e) => onReview(a, (e.target.value || null) as ReviewVerdict | null)}
        aria-label={`Qualifier la commande ${a.orderId}`}
      >
        <option value="">{VERDICT_LABEL.TO_REVIEW}</option>
        {REVIEW_CHOICES.map((v) => (
          <option key={v} value={v}>
            {VERDICT_LABEL[v]}
          </option>
        ))}
      </select>
      {a.review && (
        <div className="small muted">
          {a.review.byName}, {fmtDateTime(a.review.at)}
        </div>
      )}
    </>
  );
}
