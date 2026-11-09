import { useMemo } from 'react';
import { diffLines } from '../lib/diff';

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const added = lines.filter((l) => l.kind === 'add').length;
  const removed = lines.filter((l) => l.kind === 'del').length;
  return (
    <div className="stack gap-2">
      <p className="small muted m-0">
        <span className="text-good">+{added} ligne{added > 1 ? 's' : ''}</span> ·{' '}
        <span className="text-bad">−{removed} ligne{removed > 1 ? 's' : ''}</span>
      </p>
      <div className="diff" role="table" aria-label="Différences SQL">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.kind}`} role="row">
            <span className="ln" role="cell">{l.kind !== 'add' ? l.a : ''}</span>
            <span className="ln" role="cell">{l.kind !== 'del' ? l.b : ''}</span>
            <span role="cell" aria-label={l.kind === 'add' ? 'ajoutée' : l.kind === 'del' ? 'supprimée' : undefined}>
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
            </span>
            <span role="cell">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
