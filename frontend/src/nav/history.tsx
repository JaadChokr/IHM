import { useEffect } from 'react';

/** Nom de la page courante dans l'onglet du navigateur. */
export function usePageTitle(label: string | undefined) {
  useEffect(() => {
    if (label) document.title = `${label} · Fraud Rules`;
  }, [label]);
}
