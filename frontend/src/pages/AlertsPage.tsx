import { AlertsPanel } from '../components/AlertsPanel';
import { usePageTitle } from '../nav/history';

/** Toutes les alertes remontées par les règles ; qualification des commandes des règles en test. */
export function AlertsPage() {
  usePageTitle('Alertes');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alertes</h1>
          <p>Commandes remontées par les règles. Qualifiez celles des règles en test : fraude ou pas.</p>
        </div>
      </div>
      <AlertsPanel />
    </>
  );
}
