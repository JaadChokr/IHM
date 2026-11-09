import { useEffect, useState } from 'react';
import { usePref } from '../prefs/prefs';
import { fmtInt } from '../lib/format';

const SIZES = [10, 25, 50, 100];

/**
 * Pagination côté navigateur d'une liste déjà chargée. Le nombre de lignes par page est retenu par
 * tableau (préférence locale) ; la page revient à la première quand la liste change (filtre, tri).
 */
export function usePaged<T>(items: T[], key: string) {
  const [size, setSize] = usePref<number>(`pageSize.${key}`, 25);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  useEffect(() => setPage(0), [items.length, size]);
  const current = Math.min(page, pages - 1);
  return {
    rows: items.slice(current * size, (current + 1) * size),
    pager: { page: current, pages, size, total: items.length, onPage: setPage, onSize: setSize },
  };
}

interface Props {
  page: number;
  pages: number;
  size: number;
  total: number;
  onPage: (p: number) => void;
  onSize: (s: number) => void;
}

/** « Lignes par page [25] · 1–25 sur 145 · ‹ › » ; rien si tout tient sur la plus petite page. */
export function Pager({ page, pages, size, total, onPage, onSize }: Props) {
  if (total <= SIZES[0]) return null;
  const from = page * size + 1;
  const to = Math.min(total, (page + 1) * size);
  return (
    <nav className="pager" aria-label="Pagination">
      <label className="pager-size">
        Lignes par page
        <select value={size} onChange={(e) => onSize(Number(e.target.value))}>
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <span className="pager-range" aria-live="polite">
        {fmtInt(from)}–{fmtInt(to)} sur {fmtInt(total)}
      </span>
      <button type="button" className="pager-btn" onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Page précédente">
        ‹
      </button>
      <button type="button" className="pager-btn" onClick={() => onPage(page + 1)} disabled={page >= pages - 1} aria-label="Page suivante">
        ›
      </button>
    </nav>
  );
}
