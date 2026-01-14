// Shared types for Antigravity Dashboard

// Subscription tier based on quota patterns
export type SubscriptionTier = 'FREE' | 'PRO' | 'ULTRA';

// Per-model quota display
export interface ModelQuotaDisplay {
  id: string;           // 'gemini-3-pro', 'gemini-3-flash', 'gemini-3-image', 'claude'
  displayName: string;  // 'G3 Pro', 'G3 Flash', 'G3 Image', 'Claude'
  percentage: number;
  resetTime: number | null;
  resetTimeFormatted?: string;
}

// Structure from antigravity-accounts.json
export interface RawAccountData {
  email: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  rateLimitResetTimes?: {
    claude?: number;
    gemini?: number;
  };
}

export interface RawAccountsFile {
  version: number;
  accounts: RawAccountData[];
  activeIndex: number;
  activeIndexByFamily?: {
    claude?: number;
    gemini?: number;
  };
}

// Processed account data for frontend
export interface LocalAccount {
  email: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  isActive: boolean;
  activeForClaude: boolean;
  activeForGemini: boolean;
  status: AccountStatus;
  rateLimits: {
    claude?: RateLimitInfo;
    gemini?: RateLimitInfo;
  };
  subscriptionTier?: SubscriptionTier;
  modelQuotas?: ModelQuotaDisplay[];
}

export type AccountStatus = 
  | 'available'
  | 'rate_limited_claude'
  | 'rate_limited_gemini'
  | 'rate_limited_all';

export interface RateLimitInfo {
  resetTime: number;
  timeUntilReset: number;
  isExpired: boolean;
}

// WebSocket message types
export type WSMessageType = 
  | 'initial'
  | 'accounts_update'
  | 'rate_limit_change'
  | 'stats_update'
  | 'new_call'
  | 'heartbeat'
  | 'config_update';

export interface WSMessage {
  type: WSMessageType;
  data: any;
  timestamp: number;
  seq?: number;
}

export interface AccountDiff {
  op: 'add' | 'update' | 'remove';
  email: string;
  changes?: Partial<LocalAccount>;
  account?: LocalAccount;
}

// Dashboard statistics
export interface DashboardStats {
  totalAccounts: number;
  availableAccounts: number;
  rateLimitedAccounts: number;
  activeAccount: string | null;
  lastUpdate: number;
}

export interface AccountStats {
  email: string;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  rate_limited_calls: number;
  total_tokens: number;
  last_used: number;
  is_rate_limited: boolean;
  rate_limit_reset?: number;
  burn_rate_1h?: number;
}

export interface ModelStats {
  model: string;
  total_calls: number;
  total_tokens: number;
  avg_duration_ms: number;
}

export type ApiCallSource = 'internal' | 'proxy' | 'manager';

export interface ApiCall {
  id?: number;
  timestamp: number;
  account_email: string;
  model: string;
  endpoint: string;
  request_tokens?: number;
  response_tokens?: number;
  total_tokens?: number;
  duration_ms: number;
  status: 'success' | 'error' | 'rate_limited';
  error_message?: string;
  http_status?: number;
  source?: ApiCallSource;
  stream?: boolean;
  client_ip?: string;
}

// Session event log
export interface SessionEvent {
  id?: number;
  timestamp: number;
  event_type: string;
  account_email?: string;
  details?: string;
}

// Combined log entry
export interface CombinedLogEntry {
  id: number;
  timestamp: number;
  type: 'api_call' | 'session_event';
  account_email?: string;
  model?: string;
  event_type?: string;
  status?: string;
  total_tokens?: number;
  duration_ms?: number;
  details?: string;
  error_message?: string;
}

// Log filtering options
export interface LogFilters {
  accountEmail?: string;
  model?: string;
  status?: string;
  type?: 'api_call' | 'session_event' | 'all';
  startDate?: number;
  endDate?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

// Burn rate and projection types
export interface FamilyBurnRate {
  tokensUsed: number;
  percentPerHour: number;
  estimatedTotalQuota: number;
  timeToExhaustion: number | null; // ms until 0% or null if > 24h
  resetTime: number | null;
}

export interface AccountBurnRate {
  email: string;
  claudeTokens1h: number;
  geminiTokens1h: number;
  claudeQuotaPercent?: number;
  geminiQuotaPercent?: number;
  claudeResetTime?: number;
  geminiResetTime?: number;
}

// Timeline visualization types
export interface TimelineSlice {
  startTime: number;
  endTime: number;
  claudeTokens: number;
  geminiTokens: number;
  claudePercentUsed: number;
  geminiPercentUsed: number;
  currentSlice: boolean;
}

export interface AccountTimeline {
  email: string;
  slices: TimelineSlice[];
  claudeResetTime: number | null;
  geminiResetTime: number | null;
}

// User preferences (stored in localStorage)
export interface UserPreferences {
  activeTab: string;
  accountsSortBy: string;
  accountsSortOrder: 'asc' | 'desc';
  accountsFilter: string;
  notificationsEnabled: boolean;
  notifyOnRateLimit: boolean;
  notifyOnRateLimitClear: boolean;
  theme: 'dark' | 'light' | 'system';
  refreshInterval: number;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  activeTab: 'overview',
  accountsSortBy: 'lastUsed',
  accountsSortOrder: 'desc',
  accountsFilter: 'all',
  notificationsEnabled: true,
  notifyOnRateLimit: true,
  notifyOnRateLimitClear: true,
  theme: 'dark',
  refreshInterval: 15000,
};

// Notification types
export interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
}

// ==================== Account Management Types ====================

/**
 * Payload for adding a new account
 */
export interface AddAccountPayload {
  email: string;
  refreshToken: string;
  projectId?: string;
}

/**
 * Best account recommendation
 */
export interface BestAccountRecommendation {
  forGemini: { email: string; percentage: number } | null;
  forClaude: { email: string; percentage: number } | null;
}

/**
 * Dashboard summary for stats cards
 */
export interface DashboardSummary {
  totalAccounts: number;
  avgGeminiQuota: number | null;
  avgGeminiImageQuota: number | null;
  avgClaudeQuota: number | null;
  minGeminiQuota: number | null;
  minGeminiImageQuota: number | null;
  minClaudeQuota: number | null;
  lowQuotaCount: number;
  rateLimitedCount: number;
  exhaustedCount: number;
}

// ==================== Quota Window Types ====================

/**
 * Information about a 5-hour quota window for a model family
 */
export interface QuotaWindowInfo {
  family: 'claude' | 'gemini';
  windowStart: number;      // resetTime - 5h (ms timestamp)
  windowEnd: number;        // resetTime (ms timestamp)
  currentTime: number;      // now (ms timestamp)
  progressPercent: number;  // % through window (0-100)
  remainingMs: number;      // ms until reset
  quotaPercent: number;     // remaining quota % (average across accounts)
  accountCount: number;     // number of accounts with this quota
  burnRate: number | null;  // %/hour consumption rate (null if insufficient data)
  estimatedExhaustion: string | null; // "~2h 15m" or null if stable
}

/**
 * Combined quota window status for both families
 */
export interface QuotaWindowStatus {
  claude: QuotaWindowInfo | null;
  gemini: QuotaWindowInfo | null;
  timestamp: number;
}

// ==================== File Logger Types ====================

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogCategory = 'quota' | 'api' | 'auth' | 'system' | 'websocket' | 'accounts';

/**
 * A single log entry in the file log
 */
export interface FileLogEntry {
  ts: number;
  level: LogLevel;
  cat: LogCategory;
  msg: string;
  data?: Record<string, any>;
}

/**
 * Log file metadata
 */
export interface LogFileInfo {
  filename: string;
  date: string;
  size: number;
  entries: number;
}

// ==================== Quota Snapshot Types ====================

/**
 * A snapshot of quota percentage at a point in time
 */
export interface QuotaSnapshot {
  id?: number;
  timestamp: number;
  accountEmail: string;
  modelFamily: 'claude' | 'gemini';
  quotaPercent: number;
  resetTime: number | null;
}

/**
 * Accurate burn rate calculated from quota snapshots
 */
export interface AccurateBurnRate {
  family: 'claude' | 'gemini';
  burnRatePerHour: number;    // % per hour
  hoursRemaining: number | null;
  runway: string;             // "~2h", "~3d", ">7d", "Stable"
  dataPoints: number;         // number of snapshots used
  confidence: 'high' | 'medium' | 'low';
}

// ==================== Token Rotation Strategy Types ====================

/**
 * Available rotation strategies for account selection
 */
export type RotationStrategy = 
  | 'round_robin'      // Rotate through accounts sequentially
  | 'least_recently_used'  // Pick account unused for longest time
  | 'highest_quota'    // Pick account with most remaining quota
  | 'random'           // Random account selection
  | 'weighted'         // Weighted by quota percentages
  | 'sticky';          // Stay with current until rate limited

/**
 * Configuration for rotation strategies
 */
export interface RotationConfig {
  strategy: RotationStrategy;
  perFamily: boolean;  // Apply strategy per model family or globally
  stickyUntilPercent?: number;  // For 'sticky': switch when quota drops below this %
  weightExponent?: number;  // For 'weighted': higher = more bias toward high-quota accounts
}

/**
 * Default rotation configuration
 */
export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  strategy: 'highest_quota',
  perFamily: true,
  stickyUntilPercent: 10,
  weightExponent: 2,
};

/**
 * Result of account selection
 */
export interface RotationResult {
  email: string;
  reason: string;  // Human-readable explanation
  quotaPercent?: number;
  strategy: RotationStrategy;
}

/**
 * Rotation statistics for monitoring
 */
export interface RotationStats {
  totalRotations: number;
  rotationsByStrategy: Record<RotationStrategy, number>;
  lastRotation: {
    timestamp: number;
    fromEmail: string;
    toEmail: string;
    family: 'claude' | 'gemini';
    reason: string;
  } | null;
}
