import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { useTheme } from './prefs/prefs';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { RulesListPage } from './pages/RulesListPage';
import { RuleEditorPage } from './pages/RuleEditorPage';
import { RuleDetailPage } from './pages/RuleDetailPage';
import { ProductionPage } from './pages/ProductionPage';
import { AuditPage } from './pages/AuditPage';
import { AlertsPage } from './pages/AlertsPage';
import { ProfilePage } from './pages/ProfilePage';
import { OverviewPage } from './pages/OverviewPage';
import { DraftsPage } from './pages/DraftsPage';

function RequireUser({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading)
    return (
      <div className="login-wrap">
        <Spinner />
      </div>
    );
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

// Hébergement sans réécriture d'URL (page de démo autonome) : navigation en mémoire.
const Router = import.meta.env.VITE_ROUTER === 'memory' ? MemoryRouter : BrowserRouter;

function ThemeRoot({ children }: { children: ReactNode }) {
  useTheme();
  return <>{children}</>;
}

export function App() {
  return (
    <ThemeRoot>
      <AuthProvider>
        <Router>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireUser>
                  <Layout />
                </RequireUser>
              }
            >
              <Route path="/" element={<OverviewPage />} />
              <Route path="/rules" element={<RulesListPage />} />
              <Route path="/rules/new" element={<RuleEditorPage />} />
              <Route path="/rules/:ruleId" element={<RuleDetailPage />} />
              <Route path="/rules/:ruleId/edit" element={<RuleEditorPage />} />
              <Route path="/drafts" element={<DraftsPage />} />
              <Route path="/drafts/:draftId" element={<RuleEditorPage />} />
              <Route path="/production" element={<ProductionPage />} />
              <Route path="/alerts" element={<AlertsPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="*" element={<div className="empty">Page introuvable.</div>} />
            </Route>
          </Routes>
        </Router>
      </AuthProvider>
    </ThemeRoot>
  );
}
