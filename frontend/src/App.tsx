import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Activity, LayoutDashboard, ShieldAlert, PlayCircle, Settings } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Opportunities from './pages/Opportunities';
import Simulation from './pages/Simulation';
import OpportunityDetail from './pages/OpportunityDetail';

const Sidebar = () => {
  const location = useLocation();
  const navItems = [
    { path: '/', label: 'Overview', icon: LayoutDashboard },
    { path: '/opportunities', label: 'Recovery Queue', icon: Activity },
    { path: '/simulation', label: 'Demo Control', icon: PlayCircle },
  ];

  return (
    <div style={{ width: '250px', borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ShieldAlert size={20} color="white" />
        </div>
        <span className="text-h2 text-gradient">REVIVE AI</span>
      </div>
      
      <nav style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
        {navItems.map(item => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path));
          return (
            <Link key={item.path} to={item.path} style={{
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', borderRadius: 'var(--radius-sm)',
              textDecoration: 'none', color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent', transition: 'all 0.2s',
              fontWeight: isActive ? 500 : 400
            }}>
              <Icon size={18} style={{ color: isActive ? 'var(--accent-primary)' : 'inherit' }} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      
      <div style={{ padding: '24px', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--text-muted)' }}>
          <Settings size={18} />
          <span className="text-sm">Agent Settings</span>
        </div>
      </div>
    </div>
  );
};

function App() {
  return (
    <BrowserRouter>
      <div className="flex h-full" style={{ minHeight: '100vh' }}>
        <Sidebar />
        <main style={{ flex: 1, padding: '32px', overflowY: 'auto', background: 'radial-gradient(circle at top right, rgba(59, 130, 246, 0.05), transparent 40%)' }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/opportunities" element={<Opportunities />} />
            <Route path="/opportunities/:id" element={<OpportunityDetail />} />
            <Route path="/simulation" element={<Simulation />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
