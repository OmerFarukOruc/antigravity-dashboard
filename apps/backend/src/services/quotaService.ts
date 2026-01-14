import { EventEmitter } from 'events';

// Read env vars lazily to ensure dotenv has loaded
const getClientId = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID environment variable is required. See README for setup instructions.');
  }
  return clientId;
};
const getClientSecret = () => {
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error('GOOGLE_CLIENT_SECRET environment variable is required. See README for setup instructions.');
  }
  return clientSecret;
};

const ANTIGRAVITY_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const ANTIGRAVITY_HEADERS = {
  "User-Agent": "antigravity/1.11.5 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};

export interface ModelQuotaInfo {
  modelName: string;
  displayName?: string;
  remainingFraction: number;
  remainingPercent: number;
  resetTime: string | null;
  resetTimeMs: number | null;
}

export interface AccountQuota {
  email: string;
  projectId?: string;
  lastFetched: number;
  fetchError?: string;
  models: ModelQuotaInfo[];
  claudeModels: ModelQuotaInfo[];
  geminiModels: ModelQuotaInfo[];
  claudeQuotaPercent: number | null;
  geminiQuotaPercent: number | null;
  claudeResetTime: number | null;
  geminiResetTime: number | null;
}

export interface QuotaCache {
  accounts: Map<string, AccountQuota>;
  lastFullFetch: number;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

interface TokenRefreshResponse {
  access_token: string;
  expires_in?: number;
}

interface FetchModelsResponse {
  models?: Record<string, {
    displayName?: string;
    quotaInfo?: {
      remainingFraction?: number;
      resetTime?: string;
    };
  }>;
}

export class QuotaService extends EventEmitter {
  private cache: QuotaCache = {
    accounts: new Map(),
    lastFullFetch: 0,
  };
  private tokenCache: Map<string, TokenCache> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private pollingMs: number = 120000;
  private retryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    jitterMs: 500,
  };
  private rateLimitState: Map<string, { until: number; retryCount: number }> = new Map();

  constructor(pollingMs?: number) {
    super();
    if (pollingMs) {
      this.pollingMs = pollingMs;
    }
  }

  setRetryConfig(config: Partial<typeof this.retryConfig>): void {
    this.retryConfig = { ...this.retryConfig, ...config };
  }

  private calculateBackoffDelay(retryCount: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) {
      return Math.min(retryAfterMs, this.retryConfig.maxDelayMs);
    }

    const exponentialDelay = this.retryConfig.baseDelayMs * Math.pow(2, retryCount);
    const jitter = Math.random() * this.retryConfig.jitterMs;
    return Math.min(exponentialDelay + jitter, this.retryConfig.maxDelayMs);
  }

  private parseRetryAfter(response: Response): number | null {
    const retryAfter = response.headers.get('Retry-After');
    if (!retryAfter) return null;

    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    const date = Date.parse(retryAfter);
    if (!isNaN(date)) {
      return Math.max(0, date - Date.now());
    }

    return null;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async refreshAccessToken(refreshToken: string): Promise<string | null> {
    const cached = this.tokenCache.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.accessToken;
    }

    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: getClientId(),
          client_secret: getClientSecret(),
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[QuotaService] Token refresh failed:', error);
        return null;
      }

      const data = await response.json() as TokenRefreshResponse;
      const accessToken = data.access_token;
      const expiresIn = data.expires_in || 3600;

      this.tokenCache.set(refreshToken, {
        accessToken,
        expiresAt: Date.now() + (expiresIn * 1000),
      });

      return accessToken;
    } catch (error) {
      console.error('[QuotaService] Error refreshing token:', error);
      return null;
    }
  }

  private async fetchAvailableModels(accessToken: string, projectId?: string): Promise<FetchModelsResponse | null> {
    const body = projectId ? { project: projectId } : {};

    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      let lastError: string = '';
      
      for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
        try {
          const rateLimitKey = endpoint;
          const rateLimitInfo = this.rateLimitState.get(rateLimitKey);
          if (rateLimitInfo && rateLimitInfo.until > Date.now()) {
            const waitTime = rateLimitInfo.until - Date.now();
            console.log(`[QuotaService] Rate limited on ${endpoint}, waiting ${Math.round(waitTime/1000)}s...`);
            await this.sleep(waitTime);
          }

          const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              ...ANTIGRAVITY_HEADERS,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          });

          if (response.status === 429) {
            const retryAfterMs = this.parseRetryAfter(response) || this.calculateBackoffDelay(attempt);
            console.warn(`[QuotaService] 429 on ${endpoint}, attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1}, retry in ${Math.round(retryAfterMs/1000)}s`);
            
            this.rateLimitState.set(rateLimitKey, {
              until: Date.now() + retryAfterMs,
              retryCount: attempt + 1,
            });
            
            if (attempt < this.retryConfig.maxRetries) {
              await this.sleep(retryAfterMs);
              continue;
            }
            
            lastError = `Rate limited after ${attempt + 1} attempts`;
            break;
          }

          if (response.status >= 500 && response.status < 600) {
            const backoffMs = this.calculateBackoffDelay(attempt);
            console.warn(`[QuotaService] ${response.status} on ${endpoint}, attempt ${attempt + 1}, retry in ${Math.round(backoffMs/1000)}s`);
            
            if (attempt < this.retryConfig.maxRetries) {
              await this.sleep(backoffMs);
              continue;
            }
            
            lastError = `Server error ${response.status} after ${attempt + 1} attempts`;
            break;
          }

          if (!response.ok) {
            lastError = `${response.status}: ${await response.text()}`;
            break;
          }

          this.rateLimitState.delete(rateLimitKey);
          const data = await response.json() as FetchModelsResponse;
          return data;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          lastError = message;
          
          if (attempt < this.retryConfig.maxRetries && message.includes('timeout')) {
            const backoffMs = this.calculateBackoffDelay(attempt);
            console.warn(`[QuotaService] Timeout on ${endpoint}, attempt ${attempt + 1}, retry in ${Math.round(backoffMs/1000)}s`);
            await this.sleep(backoffMs);
            continue;
          }
          
          break;
        }
      }
      
      console.warn(`[QuotaService] Endpoint ${endpoint} failed:`, lastError);
    }

    return null;
  }

  private parseQuotaResponse(data: FetchModelsResponse): ModelQuotaInfo[] {
    const models: ModelQuotaInfo[] = [];

    if (!data?.models) {
      return models;
    }

    for (const [modelName, modelData] of Object.entries(data.models)) {
      const quotaInfo = modelData.quotaInfo;
      if (!quotaInfo) continue;

      const remainingFraction = quotaInfo.remainingFraction ?? 1.0;
      const resetTime = quotaInfo.resetTime || null;

      models.push({
        modelName,
        displayName: modelData.displayName || modelName,
        remainingFraction,
        remainingPercent: Math.round(remainingFraction * 100),
        resetTime,
        resetTimeMs: resetTime ? new Date(resetTime).getTime() : null,
      });
    }

    return models;
  }

  async fetchQuotaForAccount(
    email: string,
    refreshToken: string,
    projectId?: string
  ): Promise<AccountQuota> {
    const result: AccountQuota = {
      email,
      projectId,
      lastFetched: Date.now(),
      models: [],
      claudeModels: [],
      geminiModels: [],
      claudeQuotaPercent: null,
      geminiQuotaPercent: null,
      claudeResetTime: null,
      geminiResetTime: null,
    };

    const accessToken = await this.refreshAccessToken(refreshToken);
    if (!accessToken) {
      result.fetchError = 'Failed to refresh access token';
      return result;
    }

    const data = await this.fetchAvailableModels(accessToken, projectId);
    if (!data) {
      result.fetchError = 'Failed to fetch models from API';
      return result;
    }

    result.models = this.parseQuotaResponse(data);

    result.claudeModels = result.models.filter(m => 
      m.modelName.toLowerCase().includes('claude') || 
      m.modelName.toLowerCase().includes('anthropic')
    );
    result.geminiModels = result.models.filter(m => 
      m.modelName.toLowerCase().includes('gemini')
    );

    if (result.claudeModels.length > 0) {
      const minClaude = result.claudeModels.reduce((min, m) => 
        m.remainingPercent < min.remainingPercent ? m : min
      );
      result.claudeQuotaPercent = minClaude.remainingPercent;
      result.claudeResetTime = minClaude.resetTimeMs;
    }

    if (result.geminiModels.length > 0) {
      const minGemini = result.geminiModels.reduce((min, m) => 
        m.remainingPercent < min.remainingPercent ? m : min
      );
      result.geminiQuotaPercent = minGemini.remainingPercent;
      result.geminiResetTime = minGemini.resetTimeMs;
    }

    this.cache.accounts.set(email, result);
    
    return result;
  }

  /**
   * Fetch quotas for all accounts in parallel using Promise.allSettled
   * This is significantly faster than sequential fetching for multiple accounts
   */
  async fetchAllQuotas(accounts: Array<{
    email: string;
    refreshToken: string;
    projectId?: string;
  }>): Promise<AccountQuota[]> {
    console.log(`[QuotaService] Fetching quotas for ${accounts.length} accounts in parallel...`);
    const start = Date.now();
    
    // Fetch all quotas in parallel
    const settledResults = await Promise.allSettled(
      accounts.map(account => 
        this.fetchQuotaForAccount(
          account.email,
          account.refreshToken,
          account.projectId
        )
      )
    );

    // Process results
    const results: AccountQuota[] = settledResults.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        const account = accounts[index];
        const message = result.reason instanceof Error 
          ? result.reason.message 
          : 'Unknown error';
        console.error(`[QuotaService] Error fetching quota for ${account.email}:`, message);
        return {
          email: account.email,
          projectId: account.projectId,
          lastFetched: Date.now(),
          fetchError: message,
          models: [],
          claudeModels: [],
          geminiModels: [],
          claudeQuotaPercent: null,
          geminiQuotaPercent: null,
          claudeResetTime: null,
          geminiResetTime: null,
        };
      }
    });

    this.cache.lastFullFetch = Date.now();
    this.emit('quotas_updated', results);
    
    const elapsed = Date.now() - start;
    const successCount = results.filter(r => !r.fetchError).length;
    console.log(`[QuotaService] Fetched ${successCount}/${results.length} quotas in ${elapsed}ms`);
    return results;
  }

  getCachedQuotas(): AccountQuota[] {
    return Array.from(this.cache.accounts.values());
  }

  getCachedQuota(email: string): AccountQuota | null {
    return this.cache.accounts.get(email) || null;
  }

  getCache(): QuotaCache {
    return this.cache;
  }

  getCacheAge(): number {
    if (this.cache.lastFullFetch === 0) return Infinity;
    return Date.now() - this.cache.lastFullFetch;
  }

  isCacheStale(): boolean {
    return this.getCacheAge() > this.pollingMs;
  }

  startPolling(getAccounts: () => Array<{
    email: string;
    refreshToken: string;
    projectId?: string;
  }>): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.fetchAllQuotas(getAccounts()).catch(err => {
      console.error('[QuotaService] Initial quota fetch failed:', err);
    });

    this.pollingInterval = setInterval(async () => {
      const accounts = getAccounts();
      if (accounts.length > 0) {
        await this.fetchAllQuotas(accounts);
      }
    }, this.pollingMs);

    console.log(`[QuotaService] Started polling every ${this.pollingMs / 1000}s`);
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Clear the token cache to force re-authentication
   * Useful when tokens may have been revoked or need refresh
   */
  clearTokenCache(): void {
    this.tokenCache.clear();
    console.log('[QuotaService] Token cache cleared');
  }

  /**
   * Clear quota cache for specific accounts or all
   */
  clearQuotaCache(emails?: string[]): void {
    if (emails) {
      for (const email of emails) {
        this.cache.accounts.delete(email);
      }
      console.log(`[QuotaService] Cleared quota cache for ${emails.length} accounts`);
    } else {
      this.cache.accounts.clear();
      this.cache.lastFullFetch = 0;
      console.log('[QuotaService] Full quota cache cleared');
    }
  }

  async forceRefresh(accounts: Array<{
    email: string;
    refreshToken: string;
    projectId?: string;
  }>): Promise<AccountQuota[]> {
    return this.fetchAllQuotas(accounts);
  }

  getRateLimitStatus(): Array<{ endpoint: string; until: number; retryCount: number }> {
    const now = Date.now();
    return Array.from(this.rateLimitState.entries())
      .filter(([_, info]) => info.until > now)
      .map(([endpoint, info]) => ({
        endpoint,
        until: info.until,
        retryCount: info.retryCount,
      }));
  }

  clearRateLimitState(): void {
    this.rateLimitState.clear();
    console.log('[QuotaService] Rate limit state cleared');
  }
}

let quotaServiceInstance: QuotaService | null = null;

export function getQuotaService(pollingMs?: number): QuotaService {
  if (!quotaServiceInstance) {
    quotaServiceInstance = new QuotaService(pollingMs);
  }
  return quotaServiceInstance;
}
