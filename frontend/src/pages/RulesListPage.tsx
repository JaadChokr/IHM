import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { CRITICALITIES, RULE_STATUSES, type RuleFilters } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { CriticalityBadge, StatusBadge, Spinner, Alert } from '../components/ui';
import { CRITICALITY_LABEL, FRAUD_TYPOLOGIES, SCHEDULE_LABEL, STATUS_LABEL, fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { usePref } from '../prefs/prefs';
import { usePageTitle } from '../nav/history';

const DEFAULT_FILTERS: RuleFilters = { q: '', status: '', typology: '', owner: '', criticality: '', sort: 'updated_desc' };

export function RulesListPage() {
  usePageTitle('Règles');
  const { user } = useAuth();
  const [filters, setFilters] = usePref<RuleFilters>('rulesFilters', DEFAULT_FILTERS);
  const [q, setQ] = useState(filters.q ?? '');
  const users = useAsync(() => api.listUsers(), []);
  const rules = useAsync(() => api.listRules(filters), [JSON.stringify(filters)]);

  // Recherche plein texte : débounce de la saisie.
  useEffect(() => {
    const t = setTimeout(() => q !== filters.q && setFilters({ ...filters, q }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const set = (patch: Partial<RuleFilters>) => setFilters({ ...filters, ...patch });
  const active = Object.entries(filters).some(([k, v]) => k !== 'sort' && v);
  const mine = filters.owner === user?.matricule;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Règles de détection</h1>
          <p>Référentiel de toutes les règles, quel que soit leur statut.</p>
        </div>
        <Link to="/rules/new" className="btn btn-primary">
          + Nouvelle règle
        </Link>
      </div>

      <div className="card rules-card">
        <div className="card-pad stack" style={{ gap: 10, borderBottom: '1px solid var(--border)' }}>
          <div className="row">
            <div className="field" style={{ flex: '1 1 280px' }}>
              <label htmlFor="q" className="sr-only">
                Rechercher
              </label>
              <input
                id="q"
                type="search"
                placeholder="Rechercher dans le nom, la description ou le SQL…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="seg" role="group" aria-label="Propriétaire">
              <button type="button" aria-pressed={!mine} onClick={() => set({ owner: '' })}>
                Toutes
              </button>
              <button type="button" aria-pressed={mine} onClick={() => set({ owner: user?.matricule ?? '' })}>
                Mes règles
              </button>
            </div>
          </div>
          <div className="row">
            <FilterSelect label="Statut" value={filters.status ?? ''} onChange={(v) => set({ status: v as RuleFilters['status'] })}
              options={RULE_STATUSES.map((s) => [s, STATUS_LABEL[s]])} />
            <FilterSelect label="Typologie" value={filters.typology ?? ''} onChange={(v) => set({ typology: v })}
              options={FRAUD_TYPOLOGIES.map((t) => [t, t])} />
            <FilterSelect label="Criticité" value={filters.criticality ?? ''} onChange={(v) => set({ criticality: v as RuleFilters['criticality'] })}
              options={CRITICALITIES.map((c) => [c, CRITICALITY_LABEL[c]])} />
            <FilterSelect label="Propriétaire" value={filters.owner ?? ''} onChange={(v) => set({ owner: v })}
              options={(users.data ?? []).map((u) => [u.matricule, `${u.firstName} ${u.lastName}`])} />
            {active && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setFilters(DEFAULT_FILTERS); }}>
                Réinitialiser les filtres
              </button>
            )}
            <span className="spacer" />
            <span className="small muted" aria-live="polite">
              {rules.data ? `${rules.data.length} règle${rules.data.length > 1 ? 's' : ''}` : ''}
            </span>
          </div>
        </div>

        {rules.error && <div className="card-pad"><Alert kind="error" title={rules.error.message} /></div>}
        {rules.loading && !rules.data ? (
          <div className="card-pad"><Spinner /></div>
        ) : rules.data && rules.data.length === 0 ? (
          <div className="empty">
            Aucune règle ne correspond à ces critères.
            {active && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="linkish" onClick={() => { setQ(''); setFilters(DEFAULT_FILTERS); }}>
                  Réinitialiser les filtres
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Règle</th>
                  <th>Statut</th>
                  <th className="col-c">Typologie</th>
                  <th className="col-e">Criticité</th>
                  <th className="col-a">Fréquence</th>
                  <th className="col-b">Propriétaire</th>
                  <th className="num col-a">Version</th>
                  <th aria-sort={filters.sort === 'updated_asc' ? 'ascending' : 'descending'}>
                    <button type="button" className="th-sort" onClick={() => set({ sort: filters.sort === 'updated_asc' ? 'updated_desc' : 'updated_asc' })}>
                      Modifiée le <span aria-hidden="true">{filters.sort === 'updated_asc' ? '↑' : '↓'}</span>
                    </button>
                  </th>
                  <th className="col-d">Dernier test</th>
                </tr>
              </thead>
              <tbody>
                {rules.data?.map((r) => (
                  <tr key={r.ruleId}>
                    <td style={{ maxWidth: 300 }}>
                      <Link to={`/rules/${r.ruleId}`} className="rule-link">
                        {r.name}
                      </Link>
                      <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.description}
                      </div>
                    </td>
                    <td>
                      <div className="stack" style={{ gap: 2 }}>
                        <StatusBadge status={r.status} lastRunAt={r.lastRunAt} />
                        {r.productionVersion && <span className="small muted">v{r.productionVersion} en production</span>}
                      </div>
                    </td>
                    <td className="col-c"><span className="tag">{r.fraudTypology}</span></td>
                    <td className="col-e"><CriticalityBadge value={r.criticality} /></td>
                    <td className="small col-a">{SCHEDULE_LABEL[r.schedule]}</td>
                    <td className="small col-b">{r.ownerName}</td>
                    <td className="num col-a">v{r.version}</td>
                    <td className="small">{fmtDateTime(r.updatedAt)}</td>
                    <td className="small nowrap col-d">
                      {!r.lastTest ? (
                        <span className="muted">Jamais testée</span>
                      ) : r.lastTest.success ? (
                        <span style={{ color: 'var(--good)' }}>✓ {r.lastTest.phase === 'EXECUTION' ? 'Testée' : 'Syntaxe'}</span>
                      ) : (
                        <span style={{ color: 'var(--bad)' }}>✕ Échec</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  const id = `f-${label}`;
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <label htmlFor={id} className="small muted">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto', minHeight: 30, padding: '3px 8px' }}>
        <option value="">Tous</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
