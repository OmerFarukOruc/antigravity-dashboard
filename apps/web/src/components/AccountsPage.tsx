import { useEffect, useState, useMemo } from 'react';
import { useDashboardStore } from '../stores/useDashboardStore';
import {
  Search, Trash2, RefreshCw, Download, Plus, Check, X,
  Mail, Clock
} from 'lucide-react';
import { SubscriptionBadge, CurrentBadge } from './SubscriptionBadge';
import { QuotaBadge } from './QuotaPill';
import { formatTimeUntilReset } from '../hooks/useQuotaWindow';
import type { LocalAccount, AccountFilterType } from '../types';

interface FilterCounts {
  all: number;
  PRO: number;
  ULTRA: number;
  FREE: number;
  low_quota: number;
}

function FilterTabs({
  current,
  onChange,
  counts
}: {
  current: AccountFilterType;
  onChange: (f: AccountFilterType) => void;
  counts: FilterCounts;
}) {
  const tabs: { key: AccountFilterType; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'PRO', label: 'PRO', count: counts.PRO },
    { key: 'ULTRA', label: 'ULTRA', count: counts.ULTRA },
    { key: 'FREE', label: 'FREE', count: counts.FREE },
    { key: 'low_quota', label: 'Low Quota', count: counts.low_quota },
  ];

  return (
    <div className="flex gap-1 flex-wrap">
      {tabs.map(tab => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`filter-tab ${current === tab.key ? 'active' : ''}`}
        >
          {tab.label}
          <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-white/10">
            {tab.count}
          </span>
        </button>
      ))}
    </div>
  );
}

// Countdown component for rate limit reset time
function ResetCountdown({ account }: { account: LocalAccount }) {
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    const update = () => {
      const claudeReset = account.rateLimits?.claude?.resetTime;
      const geminiReset = account.rateLimits?.gemini?.resetTime;

      if (!claudeReset && !geminiReset) {
        setCountdown('—');
        return;
      }

      const now = Date.now();
      const resets = [
        claudeReset ? claudeReset - now : Infinity,
        geminiReset ? geminiReset - now : Infinity
      ].filter(t => t > 0);

      if (resets.length === 0) {
        setCountdown('Now');
        return;
      }

      const nextReset = Math.min(...resets);
      setCountdown(formatTimeUntilReset(nextReset));
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [account.rateLimits]);

  return (
    <div className="flex items-center gap-1.5 text-text-muted">
      <Clock className="w-3 h-3" />
      <span className="text-xs font-mono">{countdown}</span>
    </div>
  );
}

interface AccountRowProps {
  account: LocalAccount;
  selected: boolean;
  onSelect: () => void;
  onSetActive: () => void;
  onRefresh: () => void;
  onDelete: () => void;
  loading?: boolean;
}

function AccountRow({
  account,
  selected,
  onSelect,
  onSetActive,
  onRefresh,
  onDelete,
  loading
}: AccountRowProps) {
  const modelQuotas = account.modelQuotas || [];
  const geminiPro = modelQuotas.find(m => m.id === 'gemini-3-pro');
  const geminiFlash = modelQuotas.find(m => m.id === 'gemini-3-flash');
  const geminiImage = modelQuotas.find(m => m.id === 'gemini-3-image');
  const claude = modelQuotas.find(m => m.id === 'claude');

  return (
    <tr className={`border-b border-white/5 hover:bg-white/5 transition-colors ${selected ? 'bg-white/5' : ''}`}>
      {/* Checkbox */}
      <td className="py-3 px-3 w-10">
        <label className="checkbox-custom">
          <input
            type="checkbox"
            checked={selected}
            onChange={onSelect}
          />
          <span className="checkmark"></span>
        </label>
      </td>

      {/* Account Info */}
      <td className="py-3 px-3">
        <div className="flex items-center gap-2">
          <Mail className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
          <span className="text-sm font-medium text-text-primary truncate max-w-[200px]">
            {account.email}
          </span>
          {account.isActive && <CurrentBadge />}
          {account.subscriptionTier && (
            <SubscriptionBadge tier={account.subscriptionTier} />
          )}
        </div>
        {account.projectId && (
          <div className="text-[10px] text-text-muted mt-0.5 ml-5">
            {account.projectId}
          </div>
        )}
      </td>

      {/* Quotas */}
      <td className="py-3 px-3">
        <div className="flex flex-wrap gap-1.5">
          {geminiPro && (
            <QuotaBadge
              label="Pro"
              percentage={geminiPro.percentage}
              size="sm"
            />
          )}
          {geminiFlash && (
            <QuotaBadge
              label="Flash"
              percentage={geminiFlash.percentage}
              size="sm"
            />
          )}
          {geminiImage && (
            <QuotaBadge
              label="Image"
              percentage={geminiImage.percentage}
              size="sm"
            />
          )}
          {claude && (
            <QuotaBadge
              label="Claude"
              percentage={claude.percentage}
              size="sm"
            />
          )}
          {modelQuotas.length === 0 && (
            <span className="text-xs text-text-muted">No quota data</span>
          )}
        </div>
      </td>

      {/* Last Used */}
      <td className="py-3 px-3 hidden md:table-cell">
        <div className="flex items-center gap-1.5 text-text-muted">
          <Clock className="w-3 h-3" />
          <span className="text-xs">
            {account.lastUsed > 0
              ? new Date(account.lastUsed).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })
              : 'Never'
            }
          </span>
        </div>
      </td>

      {/* Reset Time */}
      <td className="py-3 px-3 hidden lg:table-cell">
        <ResetCountdown account={account} />
      </td>

      {/* Actions */}
      <td className="py-3 px-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {!account.isActive && (
            <button
              onClick={onSetActive}
              className="p-1.5 text-text-muted hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
              title="Set as Active"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onRefresh}
            disabled={loading}
            className="p-1.5 text-text-muted hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors disabled:opacity-50"
            title="Refresh Quota"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
            title="Delete Account"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

export function AccountsPage() {
  const {
    selectedAccounts,
    accountFilter,
    accountSearch,
    setAccountFilter,
    setAccountSearch,
    toggleAccountSelection,
    clearSelection,
    setSelectedAccounts
  } = useDashboardStore();

  const [enrichedAccounts, setEnrichedAccounts] = useState<LocalAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshingAccount, setRefreshingAccount] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  useEffect(() => {
    fetchEnrichedAccounts();
  }, []);

  const fetchEnrichedAccounts = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/accounts/enriched');
      const data = await res.json();
      if (data.success) {
        setEnrichedAccounts(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  // Compute filter counts
  const filterCounts = useMemo<FilterCounts>(() => {
    return {
      all: enrichedAccounts.length,
      PRO: enrichedAccounts.filter(a => a.subscriptionTier === 'PRO').length,
      ULTRA: enrichedAccounts.filter(a => a.subscriptionTier === 'ULTRA').length,
      FREE: enrichedAccounts.filter(a => a.subscriptionTier === 'FREE').length,
      low_quota: enrichedAccounts.filter(a => {
        const quotas = a.modelQuotas || [];
        return quotas.some(q => q.percentage < 20);
      }).length,
    };
  }, [enrichedAccounts]);

  // Apply filters and search
  const filteredAccounts = useMemo(() => {
    let accounts = enrichedAccounts;

    // Apply filter
    switch (accountFilter) {
      case 'PRO':
        accounts = accounts.filter(a => a.subscriptionTier === 'PRO');
        break;
      case 'ULTRA':
        accounts = accounts.filter(a => a.subscriptionTier === 'ULTRA');
        break;
      case 'FREE':
        accounts = accounts.filter(a => a.subscriptionTier === 'FREE');
        break;
      case 'low_quota':
        accounts = accounts.filter(a => {
          const quotas = a.modelQuotas || [];
          return quotas.some(q => q.percentage < 20);
        });
        break;
    }

    // Apply search
    if (accountSearch) {
      const search = accountSearch.toLowerCase();
      accounts = accounts.filter(a =>
        a.email.toLowerCase().includes(search)
      );
    }

    return accounts;
  }, [enrichedAccounts, accountFilter, accountSearch]);

  // Sort accounts by quota (lowest first)
  const sortedAccounts = useMemo(() => {
    return [...filteredAccounts].sort((a, b) => {
      // Get minimum quota percentage for each account
      const getMinQuota = (acc: LocalAccount) => {
        const quotas = acc.modelQuotas || [];
        if (quotas.length === 0) return 0;
        return Math.min(...quotas.map(q => q.percentage));
      };

      const aMin = getMinQuota(a);
      const bMin = getMinQuota(b);

      // Sort by lowest quota first (ascending)
      return aMin - bMin;
    });
  }, [filteredAccounts]);

  // Check if all filtered accounts are selected
  const allSelected = sortedAccounts.length > 0 &&
    sortedAccounts.every(a => selectedAccounts.includes(a.email));

  const handleSelectAll = () => {
    if (allSelected) {
      clearSelection();
    } else {
      setSelectedAccounts(sortedAccounts.map(a => a.email));
    }
  };

  const handleSetActive = async (email: string) => {
    try {
      await fetch(`/api/accounts/switch/${encodeURIComponent(email)}`, { method: 'POST' });
      await fetchEnrichedAccounts();
    } catch (error) {
      console.error('Failed to set active account:', error);
    }
  };

  const handleRefreshAccount = async (email: string) => {
    setRefreshingAccount(email);
    try {
      await fetch(`/api/accounts/${encodeURIComponent(email)}/refresh`, { method: 'POST' });
      await fetchEnrichedAccounts();
    } finally {
      setRefreshingAccount(null);
    }
  };

  const handleDeleteAccount = async (email: string) => {
    try {
      await fetch(`/api/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
      setDeleteConfirm(null);
      await fetchEnrichedAccounts();
    } catch (error) {
      console.error('Failed to delete account:', error);
    }
  };

  const handleBulkDelete = async () => {
    try {
      await fetch('/api/accounts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: selectedAccounts })
      });
      clearSelection();
      setBulkDeleteConfirm(false);
      await fetchEnrichedAccounts();
    } catch (error) {
      console.error('Failed to delete accounts:', error);
    }
  };

  const handleBulkRefresh = async () => {
    setLoading(true);
    try {
      await fetch('/api/accounts/quota/refresh', { method: 'POST' });
      await fetchEnrichedAccounts();
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      const res = await fetch('/api/accounts/export');
      const data = await res.json();
      if (data.success) {
        const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `antigravity-accounts-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error('Export failed:', error);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-text-primary">
          Accounts
          <span className="text-text-muted font-normal ml-2 text-sm">
            ({enrichedAccounts.length} total)
          </span>
        </h1>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddDialog(true)}
            className="btn-primary flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Account
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="glass-card p-4">
        <div className="flex flex-col md:flex-row gap-4">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              placeholder="Search by email..."
              value={accountSearch}
              onChange={(e) => setAccountSearch(e.target.value)}
              className="input-field pl-10 w-full"
            />
          </div>

          {/* Filter Tabs */}
          <FilterTabs
            current={accountFilter}
            onChange={setAccountFilter}
            counts={filterCounts}
          />
        </div>
      </div>

      {/* Bulk Actions Bar */}
      {selectedAccounts.length > 0 && (
        <div className="glass-card p-3 flex items-center justify-between bg-blue-500/5 border-blue-500/20">
          <span className="text-sm text-text-primary">
            <strong>{selectedAccounts.length}</strong> account{selectedAccounts.length > 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleBulkRefresh}
              disabled={loading}
              className="btn-secondary flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              onClick={() => setBulkDeleteConfirm(true)}
              className="btn-danger flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
            <button
              onClick={clearSelection}
              className="p-1.5 text-text-muted hover:text-text-primary rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Accounts Table */}
      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-white/5 border-b border-white/10">
              <tr>
                <th className="py-2 px-3 w-10">
                  <label className="checkbox-custom">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={handleSelectAll}
                    />
                    <span className="checkmark"></span>
                  </label>
                </th>
                <th className="py-2 px-3 text-left text-xs font-bold text-text-muted uppercase tracking-wider">
                  Account
                </th>
                <th className="py-2 px-3 text-left text-xs font-bold text-text-muted uppercase tracking-wider">
                  Quotas
                </th>
                <th className="py-2 px-3 text-left text-xs font-bold text-text-muted uppercase tracking-wider hidden md:table-cell">
                  Last Used
                </th>
                <th className="py-2 px-3 text-left text-xs font-bold text-text-muted uppercase tracking-wider hidden lg:table-cell">
                  Reset
                </th>
                <th className="py-2 px-3 text-right text-xs font-bold text-text-muted uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedAccounts.map(account => (
                <AccountRow
                  key={account.email}
                  account={account}
                  selected={selectedAccounts.includes(account.email)}
                  onSelect={() => toggleAccountSelection(account.email)}
                  onSetActive={() => handleSetActive(account.email)}
                  onRefresh={() => handleRefreshAccount(account.email)}
                  onDelete={() => setDeleteConfirm(account.email)}
                  loading={refreshingAccount === account.email}
                />
              ))}
              {filteredAccounts.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-text-muted">
                    {loading ? 'Loading accounts...' : 'No accounts found'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Export Button */}
      <div className="flex justify-end">
        <button
          onClick={handleExport}
          className="btn-secondary flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          Export All
        </button>
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="dialog-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="dialog-content" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-text-primary mb-2">Delete Account</h3>
            <p className="text-sm text-text-secondary mb-4">
              Are you sure you want to delete <strong>{deleteConfirm}</strong>? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteAccount(deleteConfirm)}
                className="btn-danger"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Delete Confirmation Dialog */}
      {bulkDeleteConfirm && (
        <div className="dialog-overlay" onClick={() => setBulkDeleteConfirm(false)}>
          <div className="dialog-content" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-text-primary mb-2">Delete {selectedAccounts.length} Accounts</h3>
            <p className="text-sm text-text-secondary mb-4">
              Are you sure you want to delete <strong>{selectedAccounts.length}</strong> account{selectedAccounts.length > 1 ? 's' : ''}? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBulkDeleteConfirm(false)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                className="btn-danger"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Account Dialog */}
      {showAddDialog && (
        <AddAccountDialog
          onClose={() => setShowAddDialog(false)}
          onSuccess={() => {
            setShowAddDialog(false);
            fetchEnrichedAccounts();
          }}
        />
      )}
    </div>
  );
}

interface AddAccountDialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

function AddAccountDialog({ onClose, onSuccess }: AddAccountDialogProps) {
  const [email, setEmail] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    if (!refreshToken.trim()) {
      setError('Refresh token is required');
      return;
    }
    if (!email.includes('@')) {
      setError('Invalid email address');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          refreshToken: refreshToken.trim(),
          projectId: projectId.trim() || undefined
        })
      });
      const data = await res.json();

      if (data.success) {
        onSuccess();
      } else {
        setError(data.error || 'Failed to add account');
      }
    } catch (err) {
      setError('Failed to add account');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleAuth = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/auth/google/url');
      const data = await res.json();

      if (data.success && data.url) {
        const width = 500;
        const height = 600;
        const left = window.screen.width / 2 - width / 2;
        const top = window.screen.height / 2 - height / 2;

        const popup = window.open(
          data.url,
          'google_auth',
          `width=${width},height=${height},top=${top},left=${left}`
        );

        if (popup) {
          const timer = setInterval(() => {
            if (popup.closed) {
              clearInterval(timer);
              setLoading(false);
              onSuccess();
            }
          }, 500);
        } else {
          setError('Popup blocked. Please allow popups.');
          setLoading(false);
        }
      }
    } catch (e) {
      setError('Failed to start Google Auth');
      setLoading(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-content max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-text-primary mb-4">Add Account</h3>

        <div className="mb-6">
          <button
            type="button"
            onClick={handleGoogleAuth}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-white text-gray-900 border border-gray-200 hover:bg-gray-50 font-medium py-2.5 px-4 rounded-lg transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Sign in with Google
          </button>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/10"></div>
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-[#1e293b] px-2 text-text-muted">Or enter manually</span>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1.5">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field w-full"
              placeholder="account@gmail.com"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1.5">
              Refresh Token
            </label>
            <textarea
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              className="input-field w-full resize-none"
              placeholder="1//0e..."
              rows={3}
            />
            <p className="text-[10px] text-text-muted mt-1">
              OAuth refresh token from antigravity-auth
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1.5">
              Project ID <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="input-field w-full"
              placeholder="my-gcp-project"
            />
          </div>

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary"
            >
              {loading ? 'Adding...' : 'Add Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
