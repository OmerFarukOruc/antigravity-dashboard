import { useLogs } from '../hooks/useLogs';
import { Search, RefreshCw, FileText, Activity, AlertCircle, CheckCircle } from 'lucide-react';
import { format } from 'date-fns';
import { useDashboardStore } from '../stores/useDashboardStore';

const isLogType = (v: string): v is 'api_call' | 'session_event' | 'all' =>
  v === 'api_call' || v === 'session_event' || v === 'all';

export function LogsDashboard() {
  const { localAccounts } = useDashboardStore();
  const { 
    logs, 
    loading, 
    filters, 
    updateFilters, 
    autoRefresh, 
    setAutoRefresh, 
    refresh 
  } = useLogs({ limit: 50 });

  const getStatusIcon = (status?: string) => {
    if (status === 'success') return <CheckCircle size={14} className="text-green-400" />;
    if (status === 'rate_limited') return <AlertCircle size={14} className="text-yellow-400" />;
    if (status === 'error') return <AlertCircle size={14} className="text-red-400" />;
    return null;
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="glass-card p-4 flex flex-wrap gap-4 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
          <input 
            type="text"
            placeholder="Search logs..."
            className="w-full bg-white/5 border border-white/10 rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-blue-500/50 transition-colors"
            value={filters.search || ''}
            onChange={(e) => updateFilters({ search: e.target.value })}
          />
        </div>

        <select 
          className="bg-white/5 border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:border-blue-500/50"
          value={filters.accountEmail || ''}
          onChange={(e) => updateFilters({ accountEmail: e.target.value || undefined })}
        >
          <option value="">All Accounts</option>
          {localAccounts.map(acc => (
            <option key={acc.email} value={acc.email}>{acc.email}</option>
          ))}
        </select>

        <select 
          className="bg-white/5 border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:border-blue-500/50"
          value={filters.type || 'all'}
          onChange={(e) => {
            const v = e.target.value;
            if (isLogType(v)) updateFilters({ type: v });
          }}
        >
          <option value="all">All Types</option>
          <option value="api_call">API Calls</option>
          <option value="session_event">Session Events</option>
        </select>

        <div className="flex items-center gap-4 ml-auto">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input 
              type="checkbox" 
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-4 h-4 rounded border-white/10 bg-white/5 text-blue-500 focus:ring-blue-500/50"
            />
            <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">Auto Refresh</span>
          </label>
          <button 
            onClick={refresh}
            className="p-2 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
            title="Refresh Logs"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Logs Table */}
      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-white/5">
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary">Time</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary">Type</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary">Account</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary">Details / Model</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary">Status</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary text-right">Tokens / Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-text-muted text-sm italic">
                    {loading ? 'Fetching logs...' : 'No logs found match your filters'}
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={`${log.type}-${log.id}`} className="hover:bg-white/[0.02] transition-colors group">
                    <td className="px-4 py-3 whitespace-nowrap text-[11px] font-mono text-text-secondary">
                      {format(log.timestamp, 'HH:mm:ss')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {log.type === 'api_call' ? (
                          <Activity size={12} className="text-blue-400" />
                        ) : (
                          <FileText size={12} className="text-purple-400" />
                        )}
                        <span className="text-[10px] font-bold uppercase tracking-wider text-text-primary">
                          {log.type === 'api_call' ? 'API' : 'EVENT'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary group-hover:text-text-primary transition-colors">
                      {log.account_email || '-'}
                    </td>
                    <td className="px-4 py-3 max-w-md">
                      <div className="text-xs font-medium text-text-primary truncate">
                        {log.type === 'api_call' ? log.model : log.event_type}
                      </div>
                      {(log.error_message || log.details) && (
                        <div className="text-[10px] text-text-muted truncate mt-0.5">
                          {log.error_message || log.details}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(log.status)}
                        <span className="text-[10px] font-bold uppercase tracking-wider text-text-secondary">
                          {log.status || '-'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="text-[11px] font-mono text-text-primary">
                        {log.total_tokens ? `${(log.total_tokens / 1000).toFixed(1)}k` : '-'}
                      </div>
                      {log.duration_ms && (
                        <div className="text-[9px] text-text-muted mt-0.5">
                          {log.duration_ms}ms
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
