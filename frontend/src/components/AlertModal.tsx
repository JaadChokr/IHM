import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Alert, AlertDetail, OrderHolder, ReviewVerdict } from '../api/types';
import { fmtDate, fmtDateTime, fmtInt } from '../lib/format';
import { VerdictCell } from './Verdict';
import { Alert as Notice, Spinner } from './ui';

/** Une valeur de la fiche, ou un tiret si la table source ne la renseigne pas. */
const show = (v: string | null | undefined): ReactNode => (v ? v : <span className="muted">—</span>);

/** IBAN lisible : groupes de 4 caractères (s'il n'est pas déjà espacé). */
const fmtIban = (iban: string) => (/\s/.test(iban) ? iban : iban.replace(/(.{4})(?=.)/g, '$1 '));

/** Âge révolu à une date de naissance « AAAA-MM-JJ ». */
function age(birth: string): number {
  const b = new Date(birth + 'T00:00:00');
  const now = new Date();
  const had = now.getMonth() > b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() >= b.getDate());
  return now.getFullYear() - b.getFullYear() - (had ? 0 : 1);
}

function initials(h: OrderHolder | null | undefined): string {
  const i = [h?.titulaireFirstName, h?.titulaireLastName].map((s) => s?.trim()[0] ?? '').join('');
  return i.toUpperCase() || '?';
}

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </>
  );
}

/** Autres colonnes renvoyées par la règle pour cette commande (rule_alerts.details), sur une ligne. */
const detailsText = (d: Alert['details']) =>
  Object.entries(d ?? {})
    .map(([k, v]) => `${k} : ${typeof v === 'number' ? fmtInt(v) : String(v)}`)
    .join(' · ');

interface Props {
  orderId: string;
  onClose: () => void;
  /** Un verdict a été donné depuis la fiche : la liste d'où elle a été ouverte se met à jour. */
  onChanged?: () => void;
}

/**
 * Fiche client d'une commande remontée, en fenêtre modale : emplacement de la photo ou de la pièce
 * d'identité, identité et coordonnées du titulaire, paiement, évaluation e-risk, puis les remontées de la
 * commande avec leur verdict (à donner ici pour une commande en test). Les informations du titulaire sont des
 * données personnelles, lues à la demande dans BigQuery et jamais conservées par la plateforme.
 */
export function AlertModal({ orderId, onClose, onChanged }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<AlertDetail>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setError(undefined);
    api.getAlert(orderId).then(
      (d) => !cancelled && setData(d),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  async function review(a: Alert, next: ReviewVerdict | null) {
    if ((a.review?.verdict ?? null) === next) return;
    setBusy(a.ruleId + a.ruleVersion);
    setError(undefined);
    try {
      await api.reviewAlert({ orderId: a.orderId, ruleId: a.ruleId, ruleVersion: a.ruleVersion, verdict: next });
      setData(await api.getAlert(orderId));
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const h = data?.holder;
  const name = [h?.titulaireFirstName, h?.titulaireLastName].filter(Boolean).join(' ');
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="client-card-title"
      onClose={onClose}
      // Un clic sur le fond (hors de la fiche) la ferme.
      onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
    >
      <div className="modal-head">
        <div>
          <span className="small muted">Commande</span>
          <h2 id="client-card-title" className="mono m-0">
            {orderId}
          </h2>
        </div>
        <button type="button" className="modal-close" onClick={() => dialog.current?.close()} aria-label="Fermer la fiche">
          ×
        </button>
      </div>

      <div className="modal-body stack">
        {error && <Notice kind="error" title={error} />}
        {!data && !error && <Spinner />}
        {data && (
          <>
            <section className="client-id" aria-label="Titulaire">
              <figure className="id-photo">
                <span className="id-initials" aria-hidden="true">
                  {initials(h)}
                </span>
                <figcaption>Photo ou pièce d'identité non disponible</figcaption>
              </figure>
              <div className="stack gap-2">
                <div>
                  <h3 className="client-name m-0">{name || 'Titulaire inconnu'}</h3>
                  {h?.titulaireBirthDate && (
                    <p className="muted m-0">
                      Né(e) le {fmtDate(h.titulaireBirthDate)} · {age(h.titulaireBirthDate)} ans
                    </p>
                  )}
                </div>
                {h ? (
                  <>
                    <dl className="kv">
                      <Row label="Téléphone">{show(h.titulairePhoneNumber)}</Row>
                      <Row label="Adresse">
                        {h.titulaireAddress || h.titulaireZipCode ? [h.titulaireAddress, h.titulaireZipCode].filter(Boolean).join(' · ') : show(null)}
                      </Row>
                      <Row label="Pièce d'identité">{show([h.identityType, h.identityOriginCountry].filter(Boolean).join(' · '))}</Row>
                      <Row label="Clé d'identité" mono>
                        {show(h.identityKey)}
                      </Row>
                    </dl>
                  </>
                ) : (
                  <Notice
                    kind="info"
                    title={
                      data.holderMissing === 'NOT_FOUND'
                        ? 'Cette commande est absente de la table des informations de commande.'
                        : "La table des informations de commande n'est pas configurée (RM_BQ_ORDER_DETAILS_TABLE) : seules les remontées sont affichées."
                    }
                  />
                )}
              </div>
            </section>

            {h && (
              <div className="grid-2">
                <section className="client-section">
                  <h3>Paiement</h3>
                  <dl className="kv">
                    <Row label="IBAN" mono>
                      {h.iban ? fmtIban(h.iban) : show(null)}
                    </Row>
                  </dl>
                </section>
                <section className="client-section">
                  <h3>Évaluation e-risk</h3>
                  <dl className="kv">
                    <Row label="Libellé">{show(h.eriskLabel)}</Row>
                    <Row label="État de traitement">{show(h.processingState)}</Row>
                  </dl>
                </section>
              </div>
            )}

            <section className="client-section">
              <h3>
                Remontées <span className="small muted">· {data.alerts.length > 1 ? `${data.alerts.length} règles ou versions` : 'une règle'}</span>
              </h3>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Détectée le</th>
                      <th>Règle</th>
                      <th>Statut</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.alerts.map((a) => (
                      <tr key={a.ruleId + a.ruleVersion}>
                        <td className="small nowrap">{fmtDateTime(a.detectedAt)}</td>
                        <td>
                          <Link to={`/rules/${a.ruleId}`} className="rule-link">
                            {a.ruleName}
                          </Link>{' '}
                          <span className="small muted">v{a.ruleVersion}</span>
                          {a.details && <div className="small muted">{detailsText(a.details)}</div>}
                        </td>
                        <td className="small nowrap">{a.phase === 'TEST' ? 'En test' : 'En production'}</td>
                        <td>
                          <VerdictCell alert={a} busy={busy === a.ruleId + a.ruleVersion} onReview={review} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="small muted m-0">
              Données personnelles : lues à la demande dans BigQuery pour consulter cette commande, jamais conservées par la plateforme.
            </p>
          </>
        )}
      </div>
    </dialog>
  );
}
