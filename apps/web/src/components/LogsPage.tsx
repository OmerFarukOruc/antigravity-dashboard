import { useState, useEffect, useCallback } from 'react';
import { 
  Search, RefreshCw, FileText, Activity, AlertCircle, CheckCircle, 
  Download, ChevronLeft, ChevronRight, X, Calendar
} from 'lucide-react';
import { format } from 'date-fns';
import { useDashboardStore } from '../stores/useDashboardStore';
import type { CombinedLogEntry } from '../types';

// Date range presets
const DATE_PRESETS = [
  { label: 'Last 1h', value: 1 },
  { label: 'Last 6h', value: 6 },
  { label: 'Last 24h', value: 24 },
  { label: 'Last 7d', value: 168 },
  { label: 'All Time', value: 0 },
];

// Status options
const STATUS_OPTIONS = [
  { label: 'Success', value: 'success', color: 'bg-emerald-500', textColor: 'text-emerald-400' },
  { label: 'Rate Limited', value: 'rate_limited', color: 'bg-amber-500', textColor: 'text-amber-400' },
  { label: 'Error', value: 'error', color: 'bg-rose-500', textColor: 'text-rose-400' },
];

// Type options
const TYPE_OPTIONS = [
  { label: 'All', value: 'all' },
  { label: 'API Calls', value: 'api_call' },
  { label: 'Events', value: 'session_event' },
] as const;

type LogTypeValue = typeof TYPE_OPTIONS[number]['value'];

const isLogType = (v: string): v is LogTypeValue =>
  v === 'api_call' || v === 'session_event' || v === 'all';

interface LogsResponse {
  success: boolean;
  data?: CombinedLogEntry[];
  total?: number;
  error?: string;
}

export function LogsPage() {
  const { localAccounts } = useDashboardStore();
  const [logs, setLogs] = useState<CombinedLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  
  // Filter states
  const [search, setSearch] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [selectedType, setSelectedType] = useState<'all' | 'api_call' | 'session_event'>('all');
  const [datePreset, setDatePreset] = useState(24); // Default: Last 24h
  
  // Pagination
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  
  // Available models (extracted from logs)
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      
      if (search) params.append('search', search);
      if (selectedAccount) params.append('accountEmail', selectedAccount);
      if (selectedModel) params.append('model', selectedModel);
      if (selectedStatus) params.append('status', selectedStatus);
      if (selectedType !== 'all') params.append('type', selectedType);
      
      if (datePreset > 0) {
        const startDate = Date.now() - datePreset * 60 * 60 * 1000;
        params.append('startDate', startDate.toString());
      }
      
      params.append('limit', limit.toString());
      params.append('offset', ((page - 1) * limit).toString());

      const response = await fetch(`/api/logs/combined?${params.toString()}`);
      const data: LogsResponse = await response.json();
      
      if (data.success && data.data) {
        setLogs(data.data);
        setTotalCount(data.total || data.data.length);
        
        // Extract unique models
        const models = new Set<string>();
        data.data.forEach(log => {
          if (log.model) models.add(log.model);
        });
        setAvailableModels(Array.from(models).sort());
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    } finally {
      setLoading(false);
    }
  }, [search, selectedAccount, selectedModel, selectedStatus, selectedType, datePreset, page, limit]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 10000);
    return () => clearInterval(interval);
  }, [fetchLogs, autoRefresh]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [search, selectedAccount, selectedModel, selectedStatus, selectedType, datePreset]);

  const handleExport = async (format: 'json' | 'csv') => {
    try {
      const params = new URLSearchParams();
      if (selectedAccount) params.append('accountEmail', selectedAccount);
      if (datePreset > 0) {
        const startDate = Date.now() - datePreset * 60 * 60 * 1000;
        params.append('startDate', startDate.toString());
      }
      params.append('limit', '10000'); // Export up to 10k logs
      
      const response = await fetch(`/api/logs/combined?${params.toString()}`);
      const data: LogsResponse = await response.json();
      
      if (data.success && data.data) {
        let content: string;
        let filename: string;
        let mimeType: string;
        
        if (format === 'json') {
          content = JSON.stringify(data.data, null, 2);
          filename = `logs-${new Date().toISOString().split('T')[0]}.json`;
          mimeType = 'application/json';
        } else {
          // CSV export
          const headers = ['timestamp', 'type', 'account_email', 'model', 'status', 'total_tokens', 'duration_ms', 'error_message'];
          const rows = data.data.map(log => [
            new Date(log.timestamp).toISOString(),
            log.type,
            log.account_email || '',
            log.model || '',
            log.status || '',
            log.total_tokens?.toString() || '',
            log.duration_ms?.toString() || '',
            log.error_message || ''
          ]);
          content = [headers.join(','), ...rows.map(r => r.map(c => `"${c}"`).join(','))].join('\n');
          filename = `logs-${new Date().toISOString().split('T')[0]}.csv`;
          mimeType = 'text/csv';
        }
        
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  const clearFilters = () => {
    setSearch('');
    setSelectedAccount('');
    setSelectedModel('');
    setSelectedStatus('');
    setSelectedType('all');
    setDatePreset(24);
    setPage(1);
  };

  const hasActiveFilters = search || selectedAccount || selectedModel || selectedStatus || selectedType !== 'all' || datePreset !== 24;

  const getStatusIcon = (status?: string) => {
    if (status === 'success') return <CheckCircle size={14} className="text-emerald-400" />;
    if (status === 'rate_limited') return <AlertCircle size={14} className="text-amber-400" />;
    if (status === 'error') return <AlertCircle size={14} className="text-rose-400" />;
    return null;
  };

  const totalPages = Math.ceil(totalCount / limit);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Logs</h1>
          <p className="text-sm text-text-muted mt-1">
            {totalCount.toLocaleString()} entries {datePreset > 0 ? `in last ${datePreset}h` : 'total'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleExport('csv')}
            className="btn-secondary flex items-center gap-1.5"
            title="Export as CSV"
          >
            <Download size={14} />
            CSV
          </button>
          <button
            onClick={() => handleExport('json')}
            className="btn-secondary flex items-center gap-1.5"
            title="Export as JSON"
          >
            <Download size={14} />
            JSON
          </button>
        </div>
      </div>

      {/* Filters Card */}
      <div className="glass-card p-4 space-y-4">
        {/* Row 1: Search, Account, Model */}
        <div className="flex flex-wrap gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
            <input 
              type="text"
              placeholder="Search logs..."
              className="w-full bg-white/5 border border-white/10 rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-blue-500/50 transition-colors"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Account Filter */}
          <select 
            className="bg-white/5 border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:border-blue-500/50 min-w-[180px]"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
          >
            <option value="">All Accounts</option>
            {localAccounts.map(acc => (
              <option key={acc.email} value={acc.email}>{acc.email}</option>
            ))}
          </select>

          {/* Model Filter */}
          <select 
            className="bg-white/5 border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:border-blue-500/50 min-w-[150px]"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            <option value="">All Models</option>
            {availableModels.map(model => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>

          {/* Type Filter */}
          <select 
            className="bg-white/5 border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:border-blue-500/50 min-w-[120px]"
            value={selectedType}
            onChange={(e) => {
              const v = e.target.value;
              if (isLogType(v)) setSelectedType(v);
            }}
          >
            {TYPE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Row 2: Date Presets, Status Pills, Actions */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Date Presets */}
          <div className="flex items-center gap-1 px-2 py-1 bg-white/5 rounded-lg border border-white/10">
            <Calendar size={14} className="text-text-muted mr-1" />
            {DATE_PRESETS.map(preset => (
              <button
                key={preset.value}
                onClick={() => setDatePreset(preset.value)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  datePreset === preset.value
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Status Pills */}
          <div className="flex items-center gap-1">
            {STATUS_OPTIONS.map(status => (
              <button
                key={status.value}
                onClick={() => setSelectedStatus(selectedStatus === status.value ? '' : status.value)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  selectedStatus === status.value
                    ? `${status.color}/20 ${status.textColor} border border-current`
                    : 'bg-white/5 text-text-secondary hover:text-text-primary border border-transparent hover:border-white/10'
                }`}
              >
                <div className={`w-2 h-2 rounded-full ${status.color}`} />
                {status.label}
              </button>
            ))}
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Clear Filters */}
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-text-muted hover:text-text-primary hover:bg-white/5 transition-colors"
            >
              <X size={14} />
              Clear Filters
            </button>
          )}

          {/* Auto Refresh Toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input 
              type="checkbox" 
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-4 h-4 rounded border-white/10 bg-white/5 text-blue-500 focus:ring-blue-500/50"
            />
            <span className="text-xs font-medium text-text-secondary">Auto Refresh</span>
          </label>

          {/* Manual Refresh */}
          <button 
            onClick={() => { setLoading(true); fetchLogs(); }}
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
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary">Model / Event</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary">Status</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary text-right">Tokens</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary text-right">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-text-muted text-sm italic">
                    {loading ? 'Fetching logs...' : 'No logs found matching your filters'}
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={`${log.type}-${log.id}`} className="hover:bg-white/[0.02] transition-colors group">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-[11px] font-mono text-text-secondary">
                        {format(log.timestamp, 'HH:mm:ss')}
                      </div>
                      <div className="text-[9px] text-text-muted">
                        {format(log.timestamp, 'MMM d')}
                      </div>
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
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-text-secondary group-hover:text-text-primary transition-colors max-w-[200px] truncate">
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
                        {log.total_tokens ? log.total_tokens.toLocaleString() : '-'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="text-[11px] font-mono text-text-muted">
                        {log.duration_ms ? `${log.duration_ms}ms` : '-'}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-white/5 flex items-center justify-between">
            <div className="text-xs text-text-muted">
              Showing {((page - 1) * limit) + 1} - {Math.min(page * limit, totalCount)} of {totalCount.toLocaleString()}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-xs text-text-secondary px-2">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
