import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Alert, OrderHolder, ReviewVerdict } from '../api/types';
import { VerdictCell } from '../components/AlertsPanel';
import { Breadcrumb } from '../components/Breadcrumb';
import { Alert as Notice, Card, Spinner } from '../components/ui';
import { fmtDate, fmtDateTime, fmtInt } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { usePageTitle } from '../nav/history';

/** Une valeur de la fiche, ou un tiret si la table source ne la renseigne pas. */
const show = (v: string | null | undefined): ReactNode => (v ? v : <span className="muted">—</span>);

/** IBAN lisible : groupes de 4 caractères (s'il n'est pas déjà espacé). */
const fmtIban = (iban: string) => (/\s/.test(iban) ? iban : iban.replace(/(.{4})(?=.)/g, '$1 '));

/** Autres colonnes renvoyées par la règle pour cette commande (rule_alerts.details). */
function Details({ details }: { details: Alert['details'] }) {
  const entries = Object.entries(details ?? {});
  if (!entries.length) return <span className="muted">—</span>;
  return (
    <dl className="kv">
      {entries.map(([k, v]) => (
        <Row key={k} label={k} mono>
          {typeof v === 'number' ? fmtInt(v) : String(v)}
        </Row>
      ))}
    </dl>
  );
}

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </>
  );
}

function HolderCards({ h }: { h: OrderHolder }) {
  return (
    <>
      <div className="grid-2">
        <Card title="Titulaire" padded>
          <dl className="kv">
            <Row label="Prénom">{show(h.titulaireFirstName)}</Row>
            <Row label="Nom">{show(h.titulaireLastName)}</Row>
            <Row label="Téléphone">{show(h.titulairePhoneNumber)}</Row>
            <Row label="Date de naissance">{h.titulaireBirthDate ? fmtDate(h.titulaireBirthDate) : show(null)}</Row>
            <Row label="Adresse">{show(h.titulaireAddress)}</Row>
            <Row label="Code postal">{show(h.titulaireZipCode)}</Row>
          </dl>
        </Card>
        <Card title="Paiement et identité" padded>
          <dl className="kv">
            <Row label="IBAN" mono>
              {h.iban ? fmtIban(h.iban) : show(null)}
            </Row>
            <Row label="Clé d'identité" mono>
              {show(h.identityKey)}
            </Row>
            <Row label="Type de pièce">{show(h.identityType)}</Row>
            <Row label="Pays d'émission">{show(h.identityOriginCountry)}</Row>
          </dl>
        </Card>
      </div>
      <Card title="Évaluation e-risk" padded>
        <dl className="kv">
          <Row label="Libellé e-risk">{show(h.eriskLabel)}</Row>
          <Row label="État de traitement">{show(h.processingState)}</Row>
        </dl>
      </Card>
    </>
  );
}

/**
 * Fiche d'une commande remontée : les règles qui l'ont remontée (avec leur verdict, à donner ici pour une
 * commande en test), puis le titulaire, le paiement, l'identité et l'évaluation e-risk. Ces dernières sont
 * des données personnelles, lues à la demande dans BigQuery et jamais conservées par la plateforme.
 */
export function AlertDetailPage() {
  const { orderId = '' } = useParams();
  usePageTitle(`Commande ${orderId}`);
  const detail = useAsync(() => api.getAlert(orderId), [orderId]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function review(a: Alert, next: ReviewVerdict | null) {
    if ((a.review?.verdict ?? null) === next) return;
    setBusy(a.ruleId + a.ruleVersion);
    setError(undefined);
    try {
      await api.reviewAlert({ orderId: a.orderId, ruleId: a.ruleId, ruleVersion: a.ruleVersion, verdict: next });
      detail.setData(await api.getAlert(orderId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const d = detail.data;
  return (
    <>
      <div className="page-head">
        <div>
          <Breadcrumb items={[{ label: 'Alertes', to: '/alerts' }, { label: orderId }]} />
          <h1 className="mono">{orderId}</h1>
          <p>
            {d
              ? `Remontée ${d.alerts.length > 1 ? `${d.alerts.length} fois` : 'une fois'} · dernière détection le ${fmtDateTime(d.alerts[0].detectedAt)}`
              : 'Fiche de la commande'}
          </p>
        </div>
      </div>
      {detail.error && <Notice kind="error" title={detail.error.message} />}
      {!d && !detail.error && <Spinner />}
      {d && (
        <div className="stack">
          {error && <Notice kind="error" title={error} />}
          <Card title="Remontées" subtitle="Les règles qui ont remonté cette commande, la plus récente d'abord. Le verdict vaut pour la commande, toutes règles confondues.">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Détectée le</th>
                    <th>Règle</th>
                    <th>Statut</th>
                    <th>Détails</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {d.alerts.map((a) => (
                    <tr key={a.ruleId + a.ruleVersion}>
                      <td className="small nowrap">{fmtDateTime(a.detectedAt)}</td>
                      <td>
                        <Link to={`/rules/${a.ruleId}`} className="rule-link">
                          {a.ruleName}
                        </Link>{' '}
                        <span className="small muted">v{a.ruleVersion}</span>
                      </td>
                      <td className="small nowrap">{a.phase === 'TEST' ? 'En test' : 'En production'}</td>
                      <td className="small">
                        <Details details={a.details} />
                      </td>
                      <td>
                        <VerdictCell alert={a} busy={busy === a.ruleId + a.ruleVersion} onReview={review} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {d.holder ? (
            <HolderCards h={d.holder} />
          ) : (
            <Notice
              kind="info"
              title={
                d.holderMissing === 'NOT_FOUND'
                  ? 'Cette commande est absente de la table des informations de commande.'
                  : "La table des informations de commande n'est pas configurée : seules les remontées sont affichées."
              }
            >
              {d.holderMissing !== 'NOT_FOUND' && (
                <>
                  Elle se règle côté API avec <span className="mono">RM_BQ_ORDER_DETAILS_TABLE</span> (dataset.table, jointe sur order_id).
                </>
              )}
            </Notice>
          )}
          <p className="small muted m-0">
            Données personnelles : lues à la demande dans BigQuery pour consulter cette commande, jamais conservées par la plateforme.
          </p>
        </div>
      )}
    </>
  );
}
