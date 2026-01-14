import { watch, FSWatcher } from 'chokidar';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';
import type { 
  RawAccountsFile, 
  RawAccountData, 
  LocalAccount, 
  AccountStatus,
  RateLimitInfo,
  DashboardStats,
  AccountDiff,
  SubscriptionTier,
  ModelQuotaDisplay,
  AddAccountPayload,
  BestAccountRecommendation,
  RotationStrategy,
  RotationConfig,
  RotationResult,
  RotationStats
} from '../types';
import { DEFAULT_ROTATION_CONFIG } from '../types';

const ACCOUNTS_FILE_PATH = join(homedir(), '.config', 'opencode', 'antigravity-accounts.json');
const CONFIG_FILE_PATH = join(homedir(), '.config', 'opencode', 'antigravity.json');

export class AccountsFileService extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private lastData: RawAccountsFile | null = null;
  private processedAccounts: LocalAccount[] = [];
  private updateInterval: NodeJS.Timeout | null = null;
  private rotationConfig: RotationConfig = { ...DEFAULT_ROTATION_CONFIG };
  private roundRobinIndex: Map<string, number> = new Map();
  private rotationStats: RotationStats = {
    totalRotations: 0,
    rotationsByStrategy: {
      round_robin: 0,
      least_recently_used: 0,
      highest_quota: 0,
      random: 0,
      weighted: 0,
      sticky: 0,
    },
    lastRotation: null,
  };
  private quotaCache: Map<string, { claudePercent: number; geminiPercent: number }> = new Map();

  constructor() {
    super();
  }

  start(): void {
    this.loadAccountsFile();
    this.setupFileWatcher();
    this.startRateLimitUpdater();
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private setupFileWatcher(): void {
    if (!existsSync(ACCOUNTS_FILE_PATH)) {
      console.warn(`Accounts file not found: ${ACCOUNTS_FILE_PATH}`);
      return;
    }

    this.watcher = watch(ACCOUNTS_FILE_PATH, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    this.watcher.on('change', () => {
      console.log('[AccountsFileService] File changed, reloading...');
      this.loadAccountsFile();
    });

    this.watcher.on('error', (error) => {
      console.error('[AccountsFileService] Watcher error:', error);
    });
  }

  private startRateLimitUpdater(): void {
    this.updateInterval = setInterval(() => {
      const updated = this.updateRateLimitTimers();
      if (updated) {
        this.emit('rate_limits_updated', this.processedAccounts);
      }
    }, 15000);
  }

  private updateRateLimitTimers(): boolean {
    let hasChanges = false;
    const now = Date.now();

    for (const account of this.processedAccounts) {
      if (account.rateLimits.claude) {
        const newTimeUntilReset = Math.max(0, account.rateLimits.claude.resetTime - now);
        const wasExpired = account.rateLimits.claude.isExpired;
        account.rateLimits.claude.timeUntilReset = newTimeUntilReset;
        account.rateLimits.claude.isExpired = newTimeUntilReset === 0;
        
        if (!wasExpired && account.rateLimits.claude.isExpired) {
          hasChanges = true;
          this.emit('rate_limit_cleared', { email: account.email, family: 'claude' });
        }
      }
      
      if (account.rateLimits.gemini) {
        const newTimeUntilReset = Math.max(0, account.rateLimits.gemini.resetTime - now);
        const wasExpired = account.rateLimits.gemini.isExpired;
        account.rateLimits.gemini.timeUntilReset = newTimeUntilReset;
        account.rateLimits.gemini.isExpired = newTimeUntilReset === 0;
        
        if (!wasExpired && account.rateLimits.gemini.isExpired) {
          hasChanges = true;
          this.emit('rate_limit_cleared', { email: account.email, family: 'gemini' });
        }
      }

      const newStatus = this.calculateAccountStatus(account);
      if (newStatus !== account.status) {
        account.status = newStatus;
        hasChanges = true;
      }
    }

    return hasChanges;
  }

  private loadAccountsFile(): void {
    try {
      if (!existsSync(ACCOUNTS_FILE_PATH)) {
        console.warn('[AccountsFileService] Accounts file does not exist');
        this.processedAccounts = [];
        this.lastData = null;
        this.emit('accounts_loaded', []);
        return;
      }

      const content = readFileSync(ACCOUNTS_FILE_PATH, 'utf-8');
      const data: RawAccountsFile = JSON.parse(content);
      
      // Validate accounts array exists and is an array
      if (!Array.isArray(data.accounts)) {
        console.warn('[AccountsFileService] Malformed accounts file: accounts is not an array');
        this.processedAccounts = [];
        this.lastData = { ...data, accounts: [] };
        this.emit('accounts_loaded', []);
        return;
      }
      
      const previousAccounts = [...this.processedAccounts];
      this.processedAccounts = this.processAccounts(data);
      this.lastData = data;

      const diffs = this.calculateDiffs(previousAccounts, this.processedAccounts);
      
      if (diffs.length > 0) {
        this.emit('accounts_changed', diffs);
      }
      
      this.emit('accounts_loaded', this.processedAccounts);
      console.log(`[AccountsFileService] Loaded ${this.processedAccounts.length} accounts`);
    } catch (error) {
      console.error('[AccountsFileService] Error loading accounts file:', error);
      this.processedAccounts = [];
      this.lastData = null;
      this.emit('accounts_loaded', []);
      this.emit('error', error);
    }
  }

  private processAccounts(data: RawAccountsFile): LocalAccount[] {
    const now = Date.now();
    
    return data.accounts.map((raw, index) => {
      const claudeResetTime = raw.rateLimitResetTimes?.claude;
      const geminiResetTime = raw.rateLimitResetTimes?.gemini;
      
      const claudeRateLimit: RateLimitInfo | undefined = claudeResetTime ? {
        resetTime: claudeResetTime,
        timeUntilReset: Math.max(0, claudeResetTime - now),
        isExpired: claudeResetTime <= now
      } : undefined;
      
      const geminiRateLimit: RateLimitInfo | undefined = geminiResetTime ? {
        resetTime: geminiResetTime,
        timeUntilReset: Math.max(0, geminiResetTime - now),
        isExpired: geminiResetTime <= now
      } : undefined;

      const account: LocalAccount = {
        email: raw.email,
        projectId: raw.projectId,
        managedProjectId: raw.managedProjectId,
        addedAt: raw.addedAt,
        lastUsed: raw.lastUsed,
        isActive: index === data.activeIndex,
        activeForClaude: index === (data.activeIndexByFamily?.claude ?? data.activeIndex),
        activeForGemini: index === (data.activeIndexByFamily?.gemini ?? data.activeIndex),
        status: 'available',
        rateLimits: {
          claude: claudeRateLimit,
          gemini: geminiRateLimit
        }
      };

      account.status = this.calculateAccountStatus(account);
      return account;
    });
  }

  private calculateAccountStatus(account: LocalAccount): AccountStatus {
    const claudeLimited = account.rateLimits.claude && !account.rateLimits.claude.isExpired;
    const geminiLimited = account.rateLimits.gemini && !account.rateLimits.gemini.isExpired;
    
    if (claudeLimited && geminiLimited) return 'rate_limited_all';
    if (claudeLimited) return 'rate_limited_claude';
    if (geminiLimited) return 'rate_limited_gemini';
    return 'available';
  }

  private calculateDiffs(previous: LocalAccount[], current: LocalAccount[]): AccountDiff[] {
    const diffs: AccountDiff[] = [];
    const prevMap = new Map(previous.map(a => [a.email, a]));
    const currMap = new Map(current.map(a => [a.email, a]));

    for (const [email, account] of currMap) {
      const prev = prevMap.get(email);
      if (!prev) {
        diffs.push({ op: 'add', email, account });
      } else if (JSON.stringify(prev) !== JSON.stringify(account)) {
        diffs.push({ op: 'update', email, changes: account });
      }
    }

    for (const email of prevMap.keys()) {
      if (!currMap.has(email)) {
        diffs.push({ op: 'remove', email });
      }
    }

    return diffs;
  }

  getAccounts(): LocalAccount[] {
    return this.processedAccounts;
  }

  getActiveAccount(): LocalAccount | null {
    return this.processedAccounts.find(a => a.isActive) || null;
  }

  getActiveAccountForFamily(family: 'claude' | 'gemini'): LocalAccount | null {
    if (family === 'claude') {
      return this.processedAccounts.find(a => a.activeForClaude) || null;
    }
    return this.processedAccounts.find(a => a.activeForGemini) || null;
  }

  getRateLimitedAccounts(): LocalAccount[] {
    return this.processedAccounts.filter(a => a.status !== 'available');
  }

  getAvailableAccounts(): LocalAccount[] {
    return this.processedAccounts.filter(a => a.status === 'available');
  }

  markAccountRateLimited(email: string, family: 'claude' | 'gemini', resetTime?: number): void {
    const account = this.processedAccounts.find(a => a.email === email);
    if (!account) return;

    const now = Date.now();
    const actualResetTime = resetTime || (now + 5 * 60 * 60 * 1000);
    
    const rateLimitInfo: RateLimitInfo = {
      resetTime: actualResetTime,
      timeUntilReset: Math.max(0, actualResetTime - now),
      isExpired: actualResetTime <= now
    };

    if (family === 'claude') {
      account.rateLimits.claude = rateLimitInfo;
    } else {
      account.rateLimits.gemini = rateLimitInfo;
    }

    account.status = this.calculateAccountStatus(account);
    this.emit('accounts_changed', [{ type: 'update', account }]);
    console.log(`[AccountsFileService] Marked ${email} as rate-limited for ${family} until ${new Date(actualResetTime).toISOString()}`);
  }

  getStats(): DashboardStats {
    const active = this.getActiveAccount();
    return {
      totalAccounts: this.processedAccounts.length,
      availableAccounts: this.getAvailableAccounts().length,
      rateLimitedAccounts: this.getRateLimitedAccounts().length,
      activeAccount: active?.email || null,
      lastUpdate: Date.now()
    };
  }

  getFilePath(): string {
    return ACCOUNTS_FILE_PATH;
  }

  fileExists(): boolean {
    return existsSync(ACCOUNTS_FILE_PATH);
  }

  // ==================== CRUD Operations ====================

  /**
   * Add a new account to the file
   */
  async addAccount(payload: AddAccountPayload): Promise<LocalAccount> {
    const { email, refreshToken, projectId } = payload;
    
    // Check if account already exists
    const existing = this.processedAccounts.find(a => a.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      throw new Error(`Account ${email} already exists`);
    }

    // Load current data or create new structure
    let data: RawAccountsFile;
    if (this.lastData) {
      data = { ...this.lastData };
    } else {
      data = {
        version: 1,
        accounts: [],
        activeIndex: 0,
      };
    }

    // Create new raw account
    const newRawAccount: RawAccountData = {
      email,
      refreshToken,
      projectId,
      addedAt: Date.now(),
      lastUsed: Date.now(),
    };

    // Add to accounts array
    data.accounts.push(newRawAccount);

    // Save the file
    await this.saveAccountsFile(data);

    // Reload to get processed account
    this.loadAccountsFile();
    
    const newAccount = this.processedAccounts.find(a => a.email === email);
    if (!newAccount) {
      throw new Error('Failed to add account');
    }

    this.emit('account_added', newAccount);
    return newAccount;
  }

  /**
   * Remove an account by email
   */
  async removeAccount(email: string): Promise<void> {
    if (!this.lastData) {
      throw new Error('No accounts data loaded');
    }

    const index = this.lastData.accounts.findIndex(
      a => a.email.toLowerCase() === email.toLowerCase()
    );

    if (index === -1) {
      throw new Error(`Account ${email} not found`);
    }

    const data = { ...this.lastData };
    data.accounts.splice(index, 1);

    // Adjust active indices if needed
    if (data.activeIndex >= data.accounts.length) {
      data.activeIndex = Math.max(0, data.accounts.length - 1);
    }
    if (data.activeIndexByFamily) {
      if ((data.activeIndexByFamily.claude ?? 0) >= data.accounts.length) {
        data.activeIndexByFamily.claude = Math.max(0, data.accounts.length - 1);
      }
      if ((data.activeIndexByFamily.gemini ?? 0) >= data.accounts.length) {
        data.activeIndexByFamily.gemini = Math.max(0, data.accounts.length - 1);
      }
    }

    await this.saveAccountsFile(data);
    this.loadAccountsFile();
    this.emit('account_removed', email);
  }

  /**
   * Remove multiple accounts
   */
  async removeAccounts(emails: string[]): Promise<void> {
    if (!this.lastData) {
      throw new Error('No accounts data loaded');
    }

    const emailsLower = emails.map(e => e.toLowerCase());
    const data = { ...this.lastData };
    
    data.accounts = data.accounts.filter(
      a => !emailsLower.includes(a.email.toLowerCase())
    );

    // Adjust active indices
    if (data.activeIndex >= data.accounts.length) {
      data.activeIndex = Math.max(0, data.accounts.length - 1);
    }
    if (data.activeIndexByFamily) {
      if ((data.activeIndexByFamily.claude ?? 0) >= data.accounts.length) {
        data.activeIndexByFamily.claude = Math.max(0, data.accounts.length - 1);
      }
      if ((data.activeIndexByFamily.gemini ?? 0) >= data.accounts.length) {
        data.activeIndexByFamily.gemini = Math.max(0, data.accounts.length - 1);
      }
    }

    await this.saveAccountsFile(data);
    this.loadAccountsFile();
    this.emit('accounts_removed', emails);
  }

  /**
   * Set an account as active (for both families)
   */
  async setActiveAccount(email: string): Promise<void> {
    if (!this.lastData) {
      throw new Error('No accounts data loaded');
    }

    const index = this.lastData.accounts.findIndex(
      a => a.email.toLowerCase() === email.toLowerCase()
    );

    if (index === -1) {
      throw new Error(`Account ${email} not found`);
    }

    const data = { ...this.lastData };
    data.activeIndex = index;
    
    // Also update per-family indices
    if (!data.activeIndexByFamily) {
      data.activeIndexByFamily = {};
    }
    data.activeIndexByFamily.claude = index;
    data.activeIndexByFamily.gemini = index;

    // Update lastUsed
    data.accounts[index].lastUsed = Date.now();

    await this.saveAccountsFile(data);
    this.loadAccountsFile();
    this.emit('active_account_changed', email);
  }

  /**
   * Update account's lastUsed timestamp
   */
  async touchAccount(email: string): Promise<void> {
    if (!this.lastData) return;

    const index = this.lastData.accounts.findIndex(
      a => a.email.toLowerCase() === email.toLowerCase()
    );

    if (index === -1) return;

    const data = { ...this.lastData };
    data.accounts[index].lastUsed = Date.now();

    await this.saveAccountsFile(data);
  }

  /**
   * Get the best accounts for Gemini and Claude based on quota
   */
  getBestAccounts(quotaMap: Map<string, { claudePercent: number; geminiPercent: number }>): BestAccountRecommendation {
    let bestGemini: { email: string; percentage: number } | null = null;
    let bestClaude: { email: string; percentage: number } | null = null;

    for (const account of this.processedAccounts) {
      const quota = quotaMap.get(account.email);
      if (!quota) continue;

      // Check for best Gemini
      if (quota.geminiPercent > (bestGemini?.percentage ?? 0)) {
        bestGemini = { email: account.email, percentage: quota.geminiPercent };
      }

      // Check for best Claude
      if (quota.claudePercent > (bestClaude?.percentage ?? 0)) {
        bestClaude = { email: account.email, percentage: quota.claudePercent };
      }
    }

    return { forGemini: bestGemini, forClaude: bestClaude };
  }

  /**
   * Save accounts file
   */
  private async saveAccountsFile(data: RawAccountsFile): Promise<void> {
    const dir = dirname(ACCOUNTS_FILE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(ACCOUNTS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    console.log('[AccountsFileService] Saved accounts file');
  }

  /**
   * Get raw data (for export)
   */
  getRawData(): RawAccountsFile | null {
    return this.lastData;
  }

  /**
   * Export accounts as JSON (without sensitive tokens if specified)
   */
  exportAccounts(includeTokens: boolean = false): any[] {
    if (!this.lastData) return [];

    return this.lastData.accounts.map(acc => ({
      email: acc.email,
      projectId: acc.projectId,
      addedAt: acc.addedAt,
      lastUsed: acc.lastUsed,
      ...(includeTokens ? { refreshToken: acc.refreshToken } : {})
    }));
  }

  // ==================== Rotation Strategy Methods ====================

  setRotationConfig(config: Partial<RotationConfig>): void {
    this.rotationConfig = { ...this.rotationConfig, ...config };
    console.log(`[AccountsFileService] Rotation config updated: ${this.rotationConfig.strategy}`);
  }

  getRotationConfig(): RotationConfig {
    return { ...this.rotationConfig };
  }

  updateQuotaCache(quotaMap: Map<string, { claudePercent: number; geminiPercent: number }>): void {
    this.quotaCache = new Map(quotaMap);
  }

  getRotationStats(): RotationStats {
    return { ...this.rotationStats };
  }

  selectAccountForFamily(family: 'claude' | 'gemini'): RotationResult | null {
    const availableAccounts = this.getAvailableAccountsForFamily(family);
    if (availableAccounts.length === 0) {
      return null;
    }

    if (availableAccounts.length === 1) {
      return {
        email: availableAccounts[0].email,
        reason: 'Only available account',
        quotaPercent: this.getQuotaForAccount(availableAccounts[0].email, family),
        strategy: this.rotationConfig.strategy,
      };
    }

    const result = this.applyStrategy(family, availableAccounts);
    this.recordRotation(family, result);
    return result;
  }

  private getAvailableAccountsForFamily(family: 'claude' | 'gemini'): LocalAccount[] {
    return this.processedAccounts.filter(acc => {
      if (family === 'claude') {
        return acc.status === 'available' || acc.status === 'rate_limited_gemini';
      }
      return acc.status === 'available' || acc.status === 'rate_limited_claude';
    });
  }

  private getQuotaForAccount(email: string, family: 'claude' | 'gemini'): number {
    const quota = this.quotaCache.get(email);
    if (!quota) return 0;
    return family === 'claude' ? quota.claudePercent : quota.geminiPercent;
  }

  private applyStrategy(family: 'claude' | 'gemini', accounts: LocalAccount[]): RotationResult {
    const strategy = this.rotationConfig.strategy;

    switch (strategy) {
      case 'round_robin':
        return this.roundRobinSelect(family, accounts);
      case 'least_recently_used':
        return this.lruSelect(accounts);
      case 'highest_quota':
        return this.highestQuotaSelect(family, accounts);
      case 'random':
        return this.randomSelect(accounts);
      case 'weighted':
        return this.weightedSelect(family, accounts);
      case 'sticky':
        return this.stickySelect(family, accounts);
      default:
        return this.highestQuotaSelect(family, accounts);
    }
  }

  private roundRobinSelect(family: 'claude' | 'gemini', accounts: LocalAccount[]): RotationResult {
    const key = family;
    const currentIndex = this.roundRobinIndex.get(key) ?? 0;
    const nextIndex = (currentIndex + 1) % accounts.length;
    this.roundRobinIndex.set(key, nextIndex);

    const selected = accounts[nextIndex];
    return {
      email: selected.email,
      reason: `Round robin: position ${nextIndex + 1}/${accounts.length}`,
      quotaPercent: this.getQuotaForAccount(selected.email, family),
      strategy: 'round_robin',
    };
  }

  private lruSelect(accounts: LocalAccount[]): RotationResult {
    const sorted = [...accounts].sort((a, b) => a.lastUsed - b.lastUsed);
    const selected = sorted[0];
    const idleTime = Date.now() - selected.lastUsed;
    const idleMinutes = Math.floor(idleTime / 60000);

    return {
      email: selected.email,
      reason: `Least recently used: idle for ${idleMinutes}m`,
      strategy: 'least_recently_used',
    };
  }

  private highestQuotaSelect(family: 'claude' | 'gemini', accounts: LocalAccount[]): RotationResult {
    let best: LocalAccount = accounts[0];
    let bestQuota = 0;

    for (const acc of accounts) {
      const quota = this.getQuotaForAccount(acc.email, family);
      if (quota > bestQuota) {
        bestQuota = quota;
        best = acc;
      }
    }

    return {
      email: best.email,
      reason: `Highest quota: ${bestQuota.toFixed(1)}%`,
      quotaPercent: bestQuota,
      strategy: 'highest_quota',
    };
  }

  private randomSelect(accounts: LocalAccount[]): RotationResult {
    const index = Math.floor(Math.random() * accounts.length);
    const selected = accounts[index];

    return {
      email: selected.email,
      reason: `Random selection from ${accounts.length} accounts`,
      strategy: 'random',
    };
  }

  private weightedSelect(family: 'claude' | 'gemini', accounts: LocalAccount[]): RotationResult {
    const exponent = this.rotationConfig.weightExponent ?? 2;
    const weights: { account: LocalAccount; weight: number; quota: number }[] = [];
    let totalWeight = 0;

    for (const acc of accounts) {
      const quota = this.getQuotaForAccount(acc.email, family);
      const weight = Math.pow(quota, exponent);
      weights.push({ account: acc, weight, quota });
      totalWeight += weight;
    }

    if (totalWeight === 0) {
      return this.randomSelect(accounts);
    }

    let random = Math.random() * totalWeight;
    for (const { account, weight, quota } of weights) {
      random -= weight;
      if (random <= 0) {
        return {
          email: account.email,
          reason: `Weighted selection: ${quota.toFixed(1)}% quota, weight=${weight.toFixed(1)}`,
          quotaPercent: quota,
          strategy: 'weighted',
        };
      }
    }

    const last = weights[weights.length - 1];
    return {
      email: last.account.email,
      reason: `Weighted fallback: ${last.quota.toFixed(1)}%`,
      quotaPercent: last.quota,
      strategy: 'weighted',
    };
  }

  private stickySelect(family: 'claude' | 'gemini', accounts: LocalAccount[]): RotationResult {
    const currentActive = family === 'claude' 
      ? this.processedAccounts.find(a => a.activeForClaude)
      : this.processedAccounts.find(a => a.activeForGemini);

    const threshold = this.rotationConfig.stickyUntilPercent ?? 10;

    if (currentActive && accounts.some(a => a.email === currentActive.email)) {
      const currentQuota = this.getQuotaForAccount(currentActive.email, family);
      
      if (currentQuota >= threshold) {
        return {
          email: currentActive.email,
          reason: `Sticky: staying with current (${currentQuota.toFixed(1)}% >= ${threshold}% threshold)`,
          quotaPercent: currentQuota,
          strategy: 'sticky',
        };
      }
    }

    const best = this.highestQuotaSelect(family, accounts);
    return {
      ...best,
      reason: `Sticky switch: previous below ${threshold}% threshold -> ${best.email}`,
      strategy: 'sticky',
    };
  }

  private recordRotation(family: 'claude' | 'gemini', result: RotationResult): void {
    const currentActive = family === 'claude'
      ? this.processedAccounts.find(a => a.activeForClaude)?.email
      : this.processedAccounts.find(a => a.activeForGemini)?.email;

    if (currentActive && currentActive !== result.email) {
      this.rotationStats.totalRotations++;
      this.rotationStats.rotationsByStrategy[result.strategy]++;
      this.rotationStats.lastRotation = {
        timestamp: Date.now(),
        fromEmail: currentActive,
        toEmail: result.email,
        family,
        reason: result.reason,
      };
      this.emit('rotation', { family, ...result, from: currentActive });
    }
  }

  async rotateAndSetActive(family: 'claude' | 'gemini'): Promise<RotationResult | null> {
    const result = this.selectAccountForFamily(family);
    if (!result) return null;

    await this.setActiveAccountForFamily(result.email, family);
    return result;
  }

  private async setActiveAccountForFamily(email: string, family: 'claude' | 'gemini'): Promise<void> {
    if (!this.lastData) return;

    const index = this.lastData.accounts.findIndex(
      a => a.email.toLowerCase() === email.toLowerCase()
    );
    if (index === -1) return;

    const data = { ...this.lastData };
    if (!data.activeIndexByFamily) {
      data.activeIndexByFamily = {};
    }
    data.activeIndexByFamily[family] = index;
    data.accounts[index].lastUsed = Date.now();

    await this.saveAccountsFile(data);
    this.loadAccountsFile();
    this.emit('active_account_changed', { email, family });
  }
}

let serviceInstance: AccountsFileService | null = null;

export function getAccountsService(): AccountsFileService {
  if (!serviceInstance) {
    serviceInstance = new AccountsFileService();
    serviceInstance.start();
  }
  return serviceInstance;
}
