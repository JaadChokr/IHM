import { useNavigate, useParams } from 'react-router-dom';
import { AlertsPanel } from '../components/AlertsPanel';
import { usePageTitle } from '../nav/history';

/** Toutes les alertes remontées par les règles ; qualification des commandes des règles en test. */
export function AlertsPage() {
  usePageTitle('Alertes');
  // /alerts/<commande> : la fiche de la commande, ouverte par-dessus la liste (lien partageable, « retour »
  // du navigateur pour la fermer).
  const { orderId } = useParams();
  const navigate = useNavigate();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alertes</h1>
          <p>Commandes remontées par les règles. Qualifiez celles des règles en test : fraude avérée, commande risquée ou RAS.</p>
        </div>
      </div>
      <AlertsPanel order={orderId} onOrderChange={(id) => navigate(id ? `/alerts/${encodeURIComponent(id)}` : '/alerts')} />
    </>
  );
}
