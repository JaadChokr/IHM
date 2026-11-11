import { NavLink, Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { API_MODE } from '../api/client';
import { usePref } from '../prefs/prefs';
import { Initials } from './ui';
import { IconAlert, IconAudit, IconChart, IconDraft, IconHome, IconPlus, IconRules, IconSearch } from './icons';

function NavItem({ to, end, icon, label }: { to: string; end?: boolean; icon: ReactNode; label: string }) {
  return (
    <NavLink to={to} end={end} title={label}>
      {({ isActive }) => (
        <>
          {/* Pastille de l'élément actif : glisse d'un élément à l'autre. */}
          {isActive && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          {icon}
          <span className="nav-label">{label}</span>
        </>
      )}
    </NavLink>
  );
}

/** Recherche de règles depuis n'importe quelle page : ouvre la liste des règles filtrée. */
function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    navigate('/rules', { state: { q: q.trim() } });
    setQ('');
  }
  return (
    <form className="topbar-search" role="search" onSubmit={submit}>
      <IconSearch />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Rechercher une règle (nom, description, SQL)…"
        aria-label="Rechercher une règle"
      />
    </form>
  );
}

export function Layout() {
  const { user } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = usePref('sidebarCollapsed', false);
  const name = user ? `${user.firstName} ${user.lastName}` : '';
  return (
    <div className={`app${collapsed ? ' collapsed' : ''}`}>
      <a className="skip-link" href="#main">
        Aller au contenu
      </a>
      <aside className="sidebar">
        <div className="sidebar-head">
          <Link to="/" className="brand" title="Fraud Rules">
            <span className="brand-mark" aria-hidden="true">F</span>
            <span className="nav-label">Fraud Rules</span>
          </Link>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Déplier la barre latérale' : 'Replier la barre latérale'}
          aria-expanded={!collapsed}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={collapsed ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} />
          </svg>
        </button>
        <nav className="nav" aria-label="Navigation principale">
          <span className="nav-section">Pilotage</span>
          <NavItem to="/" end icon={<IconHome />} label="Vue d'ensemble" />
          <NavItem to="/alerts" icon={<IconAlert />} label="Alertes" />
          <NavItem to="/production" icon={<IconChart />} label="Production" />
          <span className="nav-section">Règles</span>
          {/* Sans `end` : reste active sur la fiche, la modification et la création d'une règle. */}
          <NavItem to="/rules" icon={<IconRules />} label="Toutes les règles" />
          <NavItem to="/drafts" icon={<IconDraft />} label="Mes brouillons" />
          <span className="nav-section">Suivi</span>
          <NavItem to="/audit" icon={<IconAudit />} label="Journal d'audit" />
        </nav>
        {API_MODE === 'mock' && (
          <div className="sidebar-demo nav-label" role="note">
            <strong>Mode démo</strong>
            <span>Données simulées : rien n'est lu ni écrit dans BigQuery.</span>
          </div>
        )}
      </aside>
      <div className="content">
        <header className="topbar">
          <GlobalSearch />
          <span className="spacer" />
          <Link to="/rules/new" className="btn btn-ink">
            <IconPlus />
            Nouvelle règle
          </Link>
          {user && (
            <Link to="/profile" className="userchip" title="Profil et préférences">
              <Initials name={name} />
              <span className="user-meta">
                <span className="user-name">{name}</span>
                <span className="mono small">{user.matricule}</span>
              </span>
            </Link>
          )}
        </header>
        <main id="main">
          {/* Apparition de chaque page (pas au changement d'onglet ou de filtre : clé = chemin). */}
          <motion.div key={location.pathname} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }}>
            <Outlet />
          </motion.div>
        </main>
      </div>
    </div>
  );
}
