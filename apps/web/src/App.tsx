import { useEffect, useState } from 'react';
import { useDashboardStore } from './stores/useDashboardStore';
import { useWebSocket } from './hooks/useWebSocket';
import { useQuota } from './hooks/useQuota';
import { useBurnRate } from './hooks/useBurnRate';
import { useAuth } from './hooks/useAuth';
import { RefreshCw, Activity, Zap, LayoutDashboard, Users, Settings, Moon, Sun, FileText } from 'lucide-react';
import { DashboardPage } from './components/DashboardPage';
import { AccountsPage } from './components/AccountsPage';
import { LogsPage } from './components/LogsPage';
import { SettingsPage } from './components/SettingsPage';
import { AuthPrompt } from './components/AuthPrompt';
import { LastRefreshIndicator } from './components/LastRefreshIndicator';
import type { PageType } from './types';

function App() {
  const { 
    localAccounts,
    wsConnected,
    setLocalAccounts,
    currentPage,
    setCurrentPage,
    preferences,
    updatePreferences,
  } = useDashboardStore();

  const { token, setToken, authRequired, authError, isAuthenticated } = useAuth();
  const { refresh: refreshQuotas, lastRefresh: quotaLastRefresh } = useQuota(120000) as { refresh: () => Promise<void>; lastRefresh: number | null };
  const { refresh: refreshBurnRates, lastRefresh: burnLastRefresh } = useBurnRate(60000);
  
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  
  useWebSocket({ autoConnect: isAuthenticated, token: token || undefined });

  useEffect(() => {
    const theme = preferences.theme;
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [preferences.theme]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchAccounts();
    }
  }, [isAuthenticated, token]);

  const fetchAccounts = async () => {
    try {
      const headers: HeadersInit = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const response = await fetch('/api/accounts/local', { headers });
      
      if (response.status === 401) {
        setInitialLoading(false);
        return;
      }
      
      const data = await response.json();
      if (data.success && data.data) {
        setLocalAccounts(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
    } finally {
      setInitialLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchAccounts(), refreshQuotas(), refreshBurnRates()]);
    setRefreshing(false);
  };

  const toggleTheme = () => {
    const newTheme = preferences.theme === 'dark' ? 'light' : 'dark';
    updatePreferences({ theme: newTheme });
  };

  if (authRequired && !token) {
    return <AuthPrompt onLogin={setToken} error={authError} />;
  }

  if (initialLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center">
          <div className="animate-pulse">
            <Activity className="w-12 h-12 text-accent-blue mx-auto mb-4" />
          </div>
          <div className="text-xl font-bold text-text-primary mb-2">Initializing Dashboard</div>
          <div className="text-text-muted text-sm">Waiting for backend connection...</div>
        </div>
      </div>
    );
  }

  const navItems: { key: PageType; label: string; icon: typeof LayoutDashboard }[] = [
    { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { key: 'accounts', label: 'Accounts', icon: Users },
    { key: 'logs', label: 'Logs', icon: FileText },
    { key: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen pb-12">
      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl border-b border-cyan-500/10 bg-black/40">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
               <div className="w-8 h-8 flex items-center justify-center border border-cyan-500/50 bg-cyan-500/10 shadow-[0_0_10px_rgba(6,182,212,0.3)]">
                  <Zap size={18} className="text-cyan-400" />
               </div>
               <div>
                 <h1 className="text-xl font-bold text-white tracking-widest leading-none uppercase font-mono">
                   Antigravity
                 </h1>
                 <p className="text-[10px] font-bold text-cyan-400 tracking-[0.2em] uppercase mt-0.5">System Monitor</p>
               </div>
            </div>
            
            <div className="flex items-center gap-6">
              <div className="hidden md:flex flex-col items-end gap-1">
                <LastRefreshIndicator timestamp={quotaLastRefresh || Date.now()} label="Quota" />
                <LastRefreshIndicator timestamp={burnLastRefresh || Date.now()} label="Usage" />
              </div>

              <div className="h-8 w-px bg-cyan-500/20 hidden md:block" />

              <div className="flex items-center gap-4">
                <div className={`flex items-center gap-2 px-3 py-1 border ${wsConnected ? 'bg-green-500/5 border-green-500/30 text-green-400' : 'bg-red-500/5 border-red-500/30 text-red-400'}`}>
                  <div className={`w-1.5 h-1.5 ${wsConnected ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)]' : 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]'}`} />
                  <span className="text-xs font-bold uppercase tracking-widest font-mono">{wsConnected ? 'Online' : 'Offline'}</span>
                </div>
                
                <button
                  onClick={toggleTheme}
                  className="btn-icon rounded-none"
                  title="Toggle Theme"
                >
                  {preferences.theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                </button>
                
                <button 
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="btn-icon rounded-none"
                  title="Refresh All Data"
                >
                  <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex items-center gap-1 border-t border-cyan-500/10 pt-4">
            {navItems.map(item => (
              <button 
                key={item.key}
                onClick={() => setCurrentPage(item.key)}
                className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-widest transition-all font-mono border border-transparent ${
                  currentPage === item.key 
                    ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30 shadow-[0_0_10px_rgba(6,182,212,0.1)]' 
                    : 'text-text-secondary hover:text-white hover:bg-white/5 hover:border-white/10'
                }`}
              >
                <item.icon size={14} />
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {currentPage === 'dashboard' && <DashboardPage />}
        {currentPage === 'accounts' && <AccountsPage />}
        {currentPage === 'logs' && <LogsPage />}
        {currentPage === 'settings' && <SettingsPage />}
      </main>
      
      <div className="fixed bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-bg-primary to-transparent pointer-events-none -z-10" />
    </div>
  );
}

export default App;
