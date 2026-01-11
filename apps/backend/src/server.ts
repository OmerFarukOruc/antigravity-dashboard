import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env from project root (2 levels up from apps/backend)
dotenv.config({ path: resolve(__dirname, '../../..', '.env') });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { getMonitor } from './monitor';
import { getAccountsService } from './services/accountsFile';
import { getWebSocketManager } from './services/websocket';
import { getQuotaService } from './services/quotaService';
import { getLanguageServerService } from './services/languageServer';
import { getQuotaStrategyManager } from './services/quotaStrategy';
import { getFileLogger } from './services/fileLogger';
import { detectSubscriptionTierFromModels, createModelQuotaDisplays } from './services/tierDetection';
import { setWsManager } from './interceptor';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AddAccountPayload } from './types';
import { proxyApiRouter, proxyManagementRouter, initializeProxyRoutes } from './routes/proxy';
import type { ProxyRequestLog, ProxyLogger, RateLimitNotifier } from './services/apiProxy/index.js';
import { requireAuth, isAuthEnabled, getBindHost, validateWebSocketAuth } from './utils/authMiddleware';
import crypto from 'crypto';
import { URL, URLSearchParams } from 'url';

const ACCOUNTS_FILE_PATH = join(homedir(), '.config', 'opencode', 'antigravity-accounts.json');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3456;
const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:8080';

// Security: Default to localhost-only CORS if not configured
const defaultCorsOrigins = isAuthEnabled()
  ? ['http://localhost:3456', 'http://localhost:5173']
  : ['http://localhost:3456', 'http://127.0.0.1:3456', 'http://localhost:5173'];
const corsOrigins = process.env.CORS_ORIGINS?.split(',') || defaultCorsOrigins;

app.use(cors({
  origin: corsOrigins,
  credentials: true
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.API_RATE_LIMIT || '100', 10),
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({ limit: '50mb' }));

const monitor = getMonitor();
const accountsService = getAccountsService();
const wsManager = getWebSocketManager();
const quotaService = getQuotaService(120000);
const languageServerService = getLanguageServerService(90000);
const quotaStrategyManager = getQuotaStrategyManager();
const fileLogger = getFileLogger(7); // 7 days retention

const proxyLogger: ProxyLogger = {
  logProxyRequest: (log: ProxyRequestLog) => {
    monitor.logApiCall({
      timestamp: log.timestamp,
      account_email: log.account_email,
      model: log.model,
      endpoint: log.endpoint,
      request_tokens: log.request_tokens,
      response_tokens: log.response_tokens,
      total_tokens: log.total_tokens,
      duration_ms: log.duration_ms,
      status: log.status,
      error_message: log.error_message,
      http_status: log.http_status,
      source: 'proxy',
      stream: log.stream,
      client_ip: log.client_ip,
    });
  },
};

const rateLimitNotifier: RateLimitNotifier = {
  onRateLimited: (email: string, model: string, resetTime?: Date) => {
    console.log(`[Proxy] Rate limit detected for ${email} on ${model}`);
    wsManager.broadcastNow({
      type: 'rate_limit_change',
      data: {
        email,
        model,
        isRateLimited: true,
        resetTime: resetTime?.getTime() || null,
        source: 'proxy',
      },
      timestamp: Date.now(),
    });

    const family = model.toLowerCase().includes('claude') ? 'claude' : 'gemini';
    accountsService.markAccountRateLimited(email, family, resetTime?.getTime());
  },
};

// Log sync from manager
let lastSyncTimestamp = 0;

setWsManager(wsManager);

function getRawAccountsForQuota(): Array<{ email: string; refreshToken: string; projectId?: string }> {
  try {
    if (!existsSync(ACCOUNTS_FILE_PATH)) return [];
    const content = readFileSync(ACCOUNTS_FILE_PATH, 'utf-8');
    const data = JSON.parse(content);
    if (!Array.isArray(data.accounts)) return [];
    return data.accounts.map((acc: any) => ({
      email: acc.email,
      refreshToken: acc.refreshToken,
      projectId: acc.projectId || acc.managedProjectId,
    }));
  } catch {
    return [];
  }
}

initializeProxyRoutes(
  async (refreshToken: string) => {
    const cached = quotaService['tokenCache'].get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.accessToken;
    }
    return quotaService['refreshAccessToken'](refreshToken);
  },
  () => {
    const raw = getRawAccountsForQuota();
    return raw.map(acc => ({
      email: acc.email,
      refreshToken: acc.refreshToken,
      projectId: acc.projectId || '',
    }));
  },
  () => {
    const accounts = getRawAccountsForQuota();
    return accounts.length > 0 ? {
      email: accounts[0].email,
      refreshToken: accounts[0].refreshToken,
      projectId: accounts[0].projectId || '',
    } : null;
  },
  (family?: 'claude' | 'gemini') => {
    const allAccounts = getRawAccountsForQuota();
    const accountsService = getAccountsService();
    const rateLimitedEmails = new Set(
      accountsService.getRateLimitedAccounts().map(a => a.email)
    );

    const availableAccounts = allAccounts.filter(a => !rateLimitedEmails.has(a.email));
    const accountsToUse = availableAccounts.length > 0 ? availableAccounts : allAccounts;

    if (accountsToUse.length === 0) return null;

    const quotaCache = quotaService.getCache();
    const accountsWithQuota = accountsToUse.map(acc => {
      const quota = quotaCache.accounts.get(acc.email);
      const quotaPercent = family === 'gemini'
        ? (quota?.geminiQuotaPercent ?? 100)
        : (quota?.claudeQuotaPercent ?? 100);
      return { ...acc, quotaPercent };
    });

    accountsWithQuota.sort((a, b) => b.quotaPercent - a.quotaPercent);

    const best = accountsWithQuota[0];
    return {
      email: best.email,
      refreshToken: best.refreshToken,
      projectId: best.projectId || '',
    };
  },
  {
    apiKey: process.env.PROXY_API_KEY,
    enabled: process.env.PROXY_ENABLED !== 'false',
  },
  proxyLogger,
  rateLimitNotifier
);
app.use(proxyApiRouter);
app.use(proxyManagementRouter);
app.use(express.static(path.join(__dirname, '../../web/dist')));

async function proxyToManager(endpoint: string, options?: RequestInit): Promise<any> {
  try {
    const response = await fetch(`${MANAGER_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers
      }
    });

    if (!response.ok) {
      throw new Error(`Manager returned ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error: any) {
    console.error(`Error proxying to manager:`, error.message);
    return null;
  }
}

async function isManagerAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${MANAGER_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function syncLogsFromManager() {
  const managerAvailable = await isManagerAvailable();
  if (!managerAvailable) return;

  try {
    const response = await fetch(`${MANAGER_URL}/api/logs/recent?since=${lastSyncTimestamp}`);
    if (!response.ok) return;

    const data = await response.json() as { success: boolean; data?: any[] };
    const logs = data.data;
    if (data.success && logs && logs.length > 0) {
      const apiCalls = logs.filter((l: any) => l.type === 'api_call');
      const events = logs.filter((l: any) => l.type === 'session_event');

      monitor.storeApiCalls(apiCalls);
      monitor.storeSessionEvents(events);

      lastSyncTimestamp = Math.max(...logs.map((l: any) => l.timestamp));

      console.log(`[Server] Synced ${logs.length} logs from manager`);
    }
  } catch (error) {
    console.error('[Server] Failed to sync logs from manager:', error);
  }
}

// Apply rate limiting to all API routes
app.use('/api', apiLimiter);

// Apply authentication to sensitive API endpoints (when DASHBOARD_SECRET is set)
app.use('/api', requireAuth);

app.get('/api/accounts/local', (req, res) => {
  try {
    const accounts = accountsService.getAccounts();
    const stats = monitor.getAccountStats();

    // Merge burn rate into local accounts
    const merged = accounts.map(acc => {
      const stat = stats.find(s => s.email === acc.email);
      return {
        ...acc,
        burnRate1h: stat?.burn_rate_1h || 0
      };
    });

    res.json({ success: true, data: merged });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/accounts/active', (req, res) => {
  try {
    const active = accountsService.getActiveAccount();
    const activeForClaude = accountsService.getActiveAccountForFamily('claude');
    const activeForGemini = accountsService.getActiveAccountForFamily('gemini');
    res.json({
      success: true,
      data: {
        active,
        activeForClaude,
        activeForGemini
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/accounts/rate-limits', (req, res) => {
  try {
    const rateLimited = accountsService.getRateLimitedAccounts();
    res.json({ success: true, data: rateLimited });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/accounts/stats', (req, res) => {
  try {
    const stats = accountsService.getStats();
    res.json({ success: true, data: stats });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/accounts/quota', async (req, res) => {
  try {
    let quotas = quotaService.getCachedQuotas();

    if (quotas.length === 0 || quotaService.isCacheStale()) {
      const accounts = getRawAccountsForQuota();
      if (accounts.length > 0) {
        quotas = await quotaService.fetchAllQuotas(accounts);
      }
    }

    res.json({
      success: true,
      data: {
        quotas,
        cacheAge: quotaService.getCacheAge(),
        isStale: quotaService.isCacheStale()
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/accounts/quota/refresh', async (req, res) => {
  try {
    const accounts = getRawAccountsForQuota();
    if (accounts.length === 0) {
      res.status(400).json({ success: false, error: 'No accounts found' });
      return;
    }

    const quotas = await quotaService.forceRefresh(accounts);
    res.json({ success: true, data: quotas });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear token and quota caches, then refresh
app.post('/api/accounts/quota/clear-cache', async (req, res) => {
  try {
    quotaService.clearTokenCache();
    quotaService.clearQuotaCache();

    const accounts = getRawAccountsForQuota();
    if (accounts.length > 0) {
      const quotas = await quotaService.forceRefresh(accounts);
      res.json({
        success: true,
        message: 'Token and quota caches cleared and refreshed',
        data: quotas
      });
    } else {
      res.json({
        success: true,
        message: 'Token and quota caches cleared (no accounts to refresh)'
      });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Google OAuth Flow ====================

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const OAUTH_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "openid"
];

// PKCE Helpers
function base64URLEncode(str: Buffer): string {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function sha256(buffer: Buffer): Buffer {
  return crypto.createHash('sha256').update(buffer).digest();
}

let activeAuthServer: ReturnType<typeof createServer> | null = null;
let currentVerifier: string | null = null;

app.get('/api/auth/google/url', (req, res) => {
  try {
    const verifier = base64URLEncode(crypto.randomBytes(32));
    const challenge = base64URLEncode(sha256(Buffer.from(verifier)));
    currentVerifier = verifier;

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.append('client_id', CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', OAUTH_REDIRECT_URI);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', OAUTH_SCOPES.join(' '));
    authUrl.searchParams.append('access_type', 'offline');
    authUrl.searchParams.append('prompt', 'consent');
    authUrl.searchParams.append('code_challenge', challenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');

    // Start temporary server if not running
    if (!activeAuthServer) {
      activeAuthServer = createServer(async (req, res) => {
        const parsedUrl = new URL(req.url || '', `http://${req.headers.host}`);

        if (parsedUrl.pathname === '/oauth-callback') {
          const code = parsedUrl.searchParams.get('code');
          try {
            if (!code) throw new Error('No code received');

            // Exchange code
            const tokenUrl = 'https://oauth2.googleapis.com/token';
            const params = new URLSearchParams();
            params.append('client_id', CLIENT_ID);
            params.append('client_secret', CLIENT_SECRET);
            params.append('code', code);
            params.append('grant_type', 'authorization_code');
            params.append('redirect_uri', OAUTH_REDIRECT_URI);
            params.append('code_verifier', currentVerifier || '');

            const response = await fetch(tokenUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params
            });

            const tokens = await response.json() as any;
            if (!response.ok) {
              throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
            }

            // Save account
            // Extract email from ID token
            let email = 'unknown_user';
            if (tokens.id_token) {
              const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString());
              if (payload.email) email = payload.email;
            }

            // Add to accounts service
            await accountsService.addAccount({
              email,
              refreshToken: tokens.refresh_token,
              projectId: '' // Optional, can be updated later
            });

            // Broadcast update
            wsManager.broadcast({
              type: 'accounts_update',
              data: { op: 'add', email, account: { email, refreshToken: '***', projectId: '', addedAt: Date.now(), lastUsed: Date.now() } },
              timestamp: Date.now()
            });

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                            <!DOCTYPE html><html><head><title>Success</title><style>body{font-family:sans-serif;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh}</style></head>
                            <body><div style="text-align:center"><h1>Authentication Successful</h1><p>Account ${email} added.</p><script>setTimeout(() => window.close(), 2000)</script></div></body></html>
                        `);

            // Close server after short delay
            setTimeout(() => {
              if (activeAuthServer) {
                activeAuthServer.close();
                activeAuthServer = null;
              }
            }, 5000);

          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`
                            <!DOCTYPE html><html><head><title>Error</title><style>body{font-family:sans-serif;background:#0f172a;color:#f87171;display:flex;justify-content:center;align-items:center;height:100vh}</style></head>
                            <body><div style="text-align:center"><h1>Authentication Failed</h1><p>${e.message}</p></div></body></html>
                        `);
          }
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      activeAuthServer.listen(51121, () => {
        console.log('Temporary auth server listening on port 51121');
      });

      activeAuthServer.on('error', (err: any) => {
        console.error('Auth server error:', err);
        // If address in use, we just assume another instance (or the script) is running and user might use that? 
        // But best to reset
        try { activeAuthServer?.close(); } catch { }
        activeAuthServer = null;
      });
    }

    res.json({ success: true, url: authUrl.toString() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Account Management CRUD ====================

// Add a new account
app.post('/api/accounts', async (req, res) => {
  try {
    const payload: AddAccountPayload = req.body;

    if (!payload.email || !payload.refreshToken) {
      res.status(400).json({ success: false, error: 'Email and refreshToken are required' });
      return;
    }

    const account = await accountsService.addAccount(payload);

    // Broadcast update via WebSocket
    wsManager.broadcast({
      type: 'accounts_update',
      data: { op: 'add', email: account.email, account },
      timestamp: Date.now()
    });

    res.json({ success: true, data: account });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Delete a single account
app.delete('/api/accounts/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    await accountsService.removeAccount(email);

    // Broadcast update via WebSocket
    wsManager.broadcast({
      type: 'accounts_update',
      data: { op: 'remove', email },
      timestamp: Date.now()
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Bulk delete accounts
app.delete('/api/accounts', async (req, res) => {
  try {
    const { emails } = req.body;

    if (!Array.isArray(emails) || emails.length === 0) {
      res.status(400).json({ success: false, error: 'Array of emails required' });
      return;
    }

    await accountsService.removeAccounts(emails);

    // Broadcast update via WebSocket
    wsManager.broadcast({
      type: 'accounts_update',
      data: { op: 'bulk_remove', emails },
      timestamp: Date.now()
    });

    res.json({ success: true, deleted: emails.length });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Switch active account
app.post('/api/accounts/switch/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    await accountsService.setActiveAccount(email);

    // Broadcast update via WebSocket
    wsManager.broadcast({
      type: 'accounts_update',
      data: { op: 'active_changed', email },
      timestamp: Date.now()
    });

    res.json({ success: true, activeAccount: email });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get best accounts for each model family
app.get('/api/accounts/best', (req, res) => {
  try {
    const quotas = quotaService.getCachedQuotas();

    // Build quota map
    const quotaMap = new Map<string, { claudePercent: number; geminiPercent: number }>();
    for (const q of quotas) {
      quotaMap.set(q.email, {
        claudePercent: q.claudeQuotaPercent ?? 0,
        geminiPercent: q.geminiQuotaPercent ?? 0
      });
    }

    const best = accountsService.getBestAccounts(quotaMap);
    res.json({ success: true, data: best });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get dashboard summary stats
app.get('/api/accounts/summary', (req, res) => {
  try {
    const accounts = accountsService.getAccounts();
    const quotas = quotaService.getCachedQuotas();

    let geminiTotal = 0, geminiCount = 0;
    let geminiImageTotal = 0, geminiImageCount = 0;
    let claudeTotal = 0, claudeCount = 0;
    let lowQuotaCount = 0;
    let rateLimitedCount = 0;
    let exhaustedCount = 0;

    let geminiMin = 100, claudeMin = 100, geminiImageMin = 100;

    for (const quota of quotas) {
      const account = accounts.find(a => a.email === quota.email);

      const isClaudeRateLimited = account?.rateLimits?.claude && !account.rateLimits.claude.isExpired;
      const isGeminiRateLimited = account?.rateLimits?.gemini && !account.rateLimits.gemini.isExpired;

      if (quota.geminiQuotaPercent !== null) {
        const effectiveGemini = isGeminiRateLimited ? 0 : quota.geminiQuotaPercent;
        geminiTotal += effectiveGemini;
        geminiCount++;
        geminiMin = Math.min(geminiMin, effectiveGemini);
      }

      if (quota.claudeQuotaPercent !== null) {
        const effectiveClaude = isClaudeRateLimited ? 0 : quota.claudeQuotaPercent;
        claudeTotal += effectiveClaude;
        claudeCount++;
        claudeMin = Math.min(claudeMin, effectiveClaude);
      }

      const imageModel = quota.models.find(m =>
        m.modelName.toLowerCase().includes('image')
      );
      if (imageModel) {
        geminiImageTotal += imageModel.remainingPercent;
        geminiImageCount++;
        geminiImageMin = Math.min(geminiImageMin, imageModel.remainingPercent);
      }

      if (isClaudeRateLimited || isGeminiRateLimited) {
        rateLimitedCount++;
      }

      const isClaudeExhausted = !isClaudeRateLimited && quota.claudeQuotaPercent !== null && quota.claudeQuotaPercent === 0;
      const isGeminiExhausted = !isGeminiRateLimited && quota.geminiQuotaPercent !== null && quota.geminiQuotaPercent === 0;

      if (isClaudeExhausted || isGeminiExhausted) {
        exhaustedCount++;
      }

      const hasLowQuota =
        (!isClaudeRateLimited && quota.claudeQuotaPercent !== null && quota.claudeQuotaPercent < 20 && quota.claudeQuotaPercent > 0) ||
        (!isGeminiRateLimited && quota.geminiQuotaPercent !== null && quota.geminiQuotaPercent < 20 && quota.geminiQuotaPercent > 0);
      if (hasLowQuota) lowQuotaCount++;
    }

    res.json({
      success: true,
      data: {
        totalAccounts: accounts.length,
        avgGeminiQuota: geminiCount > 0 ? Math.round(geminiTotal / geminiCount) : null,
        avgGeminiImageQuota: geminiImageCount > 0 ? Math.round(geminiImageTotal / geminiImageCount) : null,
        avgClaudeQuota: claudeCount > 0 ? Math.round(claudeTotal / claudeCount) : null,
        minGeminiQuota: geminiCount > 0 ? geminiMin : null,
        minGeminiImageQuota: geminiImageCount > 0 ? geminiImageMin : null,
        minClaudeQuota: claudeCount > 0 ? claudeMin : null,
        lowQuotaCount,
        rateLimitedCount,
        exhaustedCount
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get accounts with tier and model quotas
app.get('/api/accounts/enriched', (req, res) => {
  try {
    const accounts = accountsService.getAccounts();
    const quotas = quotaService.getCachedQuotas();
    const stats = monitor.getAccountStats();

    const enriched = accounts.map(acc => {
      const quota = quotas.find(q => q.email === acc.email);
      const stat = stats.find(s => s.email === acc.email);

      // Detect tier from models
      const tier = quota?.models
        ? detectSubscriptionTierFromModels(quota.models)
        : 'FREE';

      // Create model quota displays
      let modelQuotas = quota?.models
        ? createModelQuotaDisplays(quota.models)
        : [];

      // Override quota percentages for rate-limited accounts
      // When an account is rate-limited, show 0% instead of the Cloud Code API's remainingPercent
      if (acc.rateLimits) {
        const claudeResetTime = acc.rateLimits.claude?.resetTime;
        const geminiResetTime = acc.rateLimits.gemini?.resetTime;

        if (acc.rateLimits.claude && !acc.rateLimits.claude.isExpired) {
          // Account is rate-limited for Claude models - set to 0%
          modelQuotas = modelQuotas.map(mq =>
            mq.id === 'claude' ? { ...mq, percentage: 0, resetTime: claudeResetTime ?? null } : mq
          );
        }
        if (acc.rateLimits.gemini && !acc.rateLimits.gemini.isExpired) {
          // Account is rate-limited for Gemini models - set to 0%
          modelQuotas = modelQuotas.map(mq =>
            mq.id.startsWith('gemini-') ? { ...mq, percentage: 0, resetTime: geminiResetTime ?? null } : mq
          );
        }
      }

      return {
        ...acc,
        burnRate1h: stat?.burn_rate_1h || 0,
        subscriptionTier: tier,
        modelQuotas
      };
    });

    res.json({ success: true, data: enriched });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export accounts (tokens are never exported for security)
app.get('/api/accounts/export', (req, res) => {
  try {
    const exportData = accountsService.exportAccounts(false);
    res.json({ success: true, data: exportData });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Account limits endpoint - fetch quota/limits for all accounts x all models
 * Returns detailed model-by-model quota info for each account
 * Use ?format=table for ASCII table output, default is JSON
 */
app.get('/api/accounts/limits', async (req, res) => {
  try {
    const quotas = quotaService.getCachedQuotas();
    const accounts = accountsService.getAccounts();
    const format = req.query.format as string || 'json';

    // Build account limits with rate limit info from accounts service
    const accountLimits = quotas.map(quota => {
      const account = accounts.find(a => a.email === quota.email);

      return {
        email: quota.email,
        status: quota.fetchError ? 'error' : 'ok',
        error: quota.fetchError || null,
        lastFetched: quota.lastFetched,
        rateLimits: account?.rateLimits || {},
        models: quota.models.reduce((acc, model) => {
          acc[model.modelName] = {
            remaining: `${model.remainingPercent}%`,
            remainingFraction: model.remainingFraction,
            resetTime: model.resetTime
          };
          return acc;
        }, {} as Record<string, { remaining: string; remainingFraction: number; resetTime: string | null }>)
      };
    });

    // Collect all unique model IDs
    const allModelIds = new Set<string>();
    for (const account of accountLimits) {
      for (const modelId of Object.keys(account.models || {})) {
        allModelIds.add(modelId);
      }
    }
    const sortedModels = Array.from(allModelIds).sort();

    // Return ASCII table format
    if (format === 'table') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');

      const lines: string[] = [];
      const timestamp = new Date().toLocaleString();
      lines.push(`Account Limits (${timestamp})`);
      lines.push(`Total: ${accounts.length} accounts, ${sortedModels.length} models`);
      lines.push('');

      // Calculate column widths
      const modelColWidth = Math.max(25, ...sortedModels.map(m => m.length)) + 2;
      const accountColWidth = 28;

      // Header row
      let header = 'Model'.padEnd(modelColWidth);
      for (const acc of accountLimits) {
        const shortEmail = acc.email.split('@')[0].slice(0, 24);
        header += shortEmail.padEnd(accountColWidth);
      }
      lines.push(header);
      lines.push('-'.repeat(modelColWidth + accountLimits.length * accountColWidth));

      // Data rows
      for (const modelId of sortedModels) {
        let row = modelId.padEnd(modelColWidth);
        for (const acc of accountLimits) {
          const quota = acc.models?.[modelId];
          let cell: string;
          if (acc.status !== 'ok') {
            cell = `[${acc.status}]`;
          } else if (!quota) {
            cell = '-';
          } else if (quota.remainingFraction === 0 || quota.remainingFraction === null) {
            if (quota.resetTime) {
              const resetMs = new Date(quota.resetTime).getTime() - Date.now();
              if (resetMs > 0) {
                const h = Math.floor(resetMs / 3600000);
                const m = Math.floor((resetMs % 3600000) / 60000);
                cell = `0% (${h}h${m}m)`;
              } else {
                cell = '0% (resetting)';
              }
            } else {
              cell = '0% (exhausted)';
            }
          } else {
            cell = `${Math.round(quota.remainingFraction * 100)}%`;
          }
          row += cell.padEnd(accountColWidth);
        }
        lines.push(row);
      }

      return res.send(lines.join('\n'));
    }

    // Default: JSON format
    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        totalAccounts: accounts.length,
        models: sortedModels,
        accounts: accountLimits
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get aggregated quota windows across all accounts
app.get('/api/accounts/quota-windows', (req, res) => {
  try {
    const quotas = quotaService.getCachedQuotas();
    const accounts = accountsService.getAccounts();

    // Aggregate quotas by model type
    const modelAggregates: Record<string, {
      percentages: number[];
      resetTimes: number[];
      accountCount: number;
    }> = {};

    // Model definitions - ORDER MATTERS: more specific patterns first
    const modelDefs = [
      { id: 'gemini-3-image', displayName: 'Gemini 3 Image', icon: 'gemini-image', patterns: ['gemini-3-pro-image', 'gemini-image'], family: 'gemini' as const },
      { id: 'gemini-3-pro', displayName: 'Gemini 3 Pro', icon: 'gemini-pro', patterns: ['gemini-3-pro-high', 'gemini-3-pro-low', 'gemini-3-pro'], family: 'gemini' as const },
      { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', icon: 'gemini-flash', patterns: ['gemini-3-flash'], family: 'gemini' as const },
      { id: 'claude', displayName: 'Claude 4.5', icon: 'claude', patterns: ['claude-sonnet-4-5', 'claude-opus'], family: 'claude' as const },
    ];

    // Initialize aggregates
    for (const def of modelDefs) {
      modelAggregates[def.id] = { percentages: [], resetTimes: [], accountCount: 0 };
    }

    // Aggregate data from all accounts
    for (const quota of quotas) {
      // Get the account's rate limit status
      const account = accounts.find(a => a.email === quota.email);
      const rateLimits = account?.rateLimits;

      for (const model of quota.models) {
        const modelLower = model.modelName.toLowerCase();

        for (const def of modelDefs) {
          const matches = def.patterns.some(p => modelLower.includes(p.toLowerCase()));
          if (matches) {
            const agg = modelAggregates[def.id];

            // Check if account is rate-limited for this model family
            let effectivePercent = model.remainingPercent;
            let effectiveResetTime = model.resetTimeMs;

            if (rateLimits) {
              const familyLimit = def.family === 'claude' ? rateLimits.claude : rateLimits.gemini;
              if (familyLimit && !familyLimit.isExpired) {
                // Account is rate-limited - use 0% and rate limit reset time
                effectivePercent = 0;
                effectiveResetTime = familyLimit.resetTime;
              }
            }

            agg.percentages.push(effectivePercent);
            if (effectiveResetTime) {
              agg.resetTimes.push(effectiveResetTime);
            }
            agg.accountCount++;
            break; // Only count once per model type per account
          }
        }
      }
    }

    // Build response
    const models = modelDefs.map(def => {
      const agg = modelAggregates[def.id];
      const avgPercentage = agg.percentages.length > 0
        ? Math.round(agg.percentages.reduce((a, b) => a + b, 0) / agg.percentages.length)
        : 0;
      const earliestReset = agg.resetTimes.length > 0
        ? Math.min(...agg.resetTimes)
        : null;

      return {
        id: def.id,
        displayName: def.displayName,
        icon: def.icon,
        percentage: avgPercentage,
        resetTime: earliestReset,
        accountCount: Math.floor(agg.accountCount / def.patterns.length), // Approximate unique accounts
      };
    }).filter(m => m.accountCount > 0 || m.percentage > 0);

    // Calculate overall average
    const allPercentages = models.map(m => m.percentage).filter(p => p > 0);
    const averageQuota = allPercentages.length > 0
      ? Math.round(allPercentages.reduce((a, b) => a + b, 0) / allPercentages.length)
      : 0;

    // Find next reset time
    const allResetTimes = models.map(m => m.resetTime).filter((t): t is number => t !== null);
    const nextReset = allResetTimes.length > 0 ? Math.min(...allResetTimes) : null;

    res.json({
      success: true,
      data: {
        models,
        averageQuota,
        nextReset,
        totalAccounts: accounts.length,
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get 5-hour quota window status with timeline visualization data
app.get('/api/accounts/quota-window-status', (req, res) => {
  try {
    const quotas = quotaService.getCachedQuotas();
    const now = Date.now();
    const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

    // Helper to calculate window info for a model family
    const calculateWindowInfo = (
      family: 'claude' | 'gemini',
      familyQuotas: Array<{ percent: number; resetTime: number | null; email: string }>
    ): import('./types').QuotaWindowInfo | null => {
      const validQuotas = familyQuotas.filter(q => q.resetTime !== null && q.resetTime > now);

      if (validQuotas.length === 0) return null;

      // Use earliest reset time across all accounts
      const resetTimes = validQuotas.map(q => q.resetTime!).filter(t => t > now);
      if (resetTimes.length === 0) return null;

      const windowEnd = Math.min(...resetTimes);
      const windowStart = windowEnd - FIVE_HOURS_MS;

      // Calculate progress through the window
      const elapsed = now - windowStart;
      const progressPercent = Math.max(0, Math.min(100, (elapsed / FIVE_HOURS_MS) * 100));
      const remainingMs = Math.max(0, windowEnd - now);

      // Average quota across accounts
      const avgQuota = validQuotas.length > 0
        ? Math.round(validQuotas.reduce((sum, q) => sum + q.percent, 0) / validQuotas.length)
        : 0;

      // Calculate burn rate from quota snapshots (will be enhanced in Phase 4)
      const burnRate = monitor.calculateBurnRateFromSnapshots(family);

      // Estimate exhaustion time
      let estimatedExhaustion: string | null = null;
      if (burnRate !== null && burnRate > 0 && avgQuota > 0) {
        const hoursToExhaustion = avgQuota / burnRate;
        if (hoursToExhaustion < 1) {
          estimatedExhaustion = `~${Math.round(hoursToExhaustion * 60)}m`;
        } else if (hoursToExhaustion < 24) {
          estimatedExhaustion = `~${Math.round(hoursToExhaustion)}h`;
        } else if (hoursToExhaustion < 168) {
          estimatedExhaustion = `~${Math.round(hoursToExhaustion / 24)}d`;
        } else {
          estimatedExhaustion = null; // Stable
        }
      }

      return {
        family,
        windowStart,
        windowEnd,
        currentTime: now,
        progressPercent: Math.round(progressPercent * 10) / 10,
        remainingMs,
        quotaPercent: avgQuota,
        accountCount: validQuotas.length,
        burnRate,
        estimatedExhaustion,
      };
    };

    // Gather Claude and Gemini quotas
    const claudeQuotas: Array<{ percent: number; resetTime: number | null; email: string }> = [];
    const geminiQuotas: Array<{ percent: number; resetTime: number | null; email: string }> = [];

    for (const quota of quotas) {
      if (quota.claudeQuotaPercent !== null) {
        claudeQuotas.push({
          percent: quota.claudeQuotaPercent,
          resetTime: quota.claudeResetTime,
          email: quota.email,
        });
      }
      if (quota.geminiQuotaPercent !== null) {
        geminiQuotas.push({
          percent: quota.geminiQuotaPercent,
          resetTime: quota.geminiResetTime,
          email: quota.email,
        });
      }
    }

    const claudeWindow = calculateWindowInfo('claude', claudeQuotas);
    const geminiWindow = calculateWindowInfo('gemini', geminiQuotas);

    res.json({
      success: true,
      data: {
        claude: claudeWindow,
        gemini: geminiWindow,
        timestamp: now,
      } as import('./types').QuotaWindowStatus
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Refresh single account quota
app.post('/api/accounts/:email/refresh', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const rawAccounts = getRawAccountsForQuota();
    const account = rawAccounts.find(a => a.email.toLowerCase() === email.toLowerCase());

    if (!account) {
      res.status(404).json({ success: false, error: 'Account not found' });
      return;
    }

    // Force refresh quota for this specific account
    const quotas = await quotaService.fetchAllQuotas([account]);
    const quota = quotas.find(q => q.email.toLowerCase() === email.toLowerCase());

    res.json({ success: true, data: quota });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/accounts/burn-rate', (req, res) => {
  try {
    const accounts = accountsService.getAccounts();
    const quotas = quotaService.getCachedQuotas();

    const burnRates = accounts.map(acc => {
      const stats = monitor.getAccountBurnRateDetailed(acc.email);
      const quota = quotas.find(q => q.email === acc.email);

      const claudeTotal = (quota?.claudeQuotaPercent && quota?.claudeQuotaPercent > 0)
        ? (stats.claudeTokens1h / (1 - quota.claudeQuotaPercent / 100)) // Very rough estimate if we don't know max
        : 1000000; // Fallback to 1M tokens if unknown

      // Better way: use remainingFraction from API if we had it directly here
      // But for now, let's just return the raw tokens and let frontend handle % if it has quota info

      return {
        email: acc.email,
        claudeTokens1h: stats.claudeTokens1h || 0,
        geminiTokens1h: stats.geminiTokens1h || 0,
        claudeQuotaPercent: quota?.claudeQuotaPercent,
        geminiQuotaPercent: quota?.geminiQuotaPercent,
        claudeResetTime: quota?.claudeResetTime,
        geminiResetTime: quota?.geminiResetTime
      };
    });

    res.json({ success: true, data: burnRates });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Accurate burn rate using quota snapshots
app.get('/api/accounts/burn-rate-accurate', (req, res) => {
  try {
    const quotas = quotaService.getCachedQuotas();

    // Calculate average quota percent for each family
    const claudeQuotas = quotas.filter(q => q.claudeQuotaPercent !== null);
    const geminiQuotas = quotas.filter(q => q.geminiQuotaPercent !== null);

    const avgClaudePercent = claudeQuotas.length > 0
      ? claudeQuotas.reduce((sum, q) => sum + (q.claudeQuotaPercent || 0), 0) / claudeQuotas.length
      : null;

    const avgGeminiPercent = geminiQuotas.length > 0
      ? geminiQuotas.reduce((sum, q) => sum + (q.geminiQuotaPercent || 0), 0) / geminiQuotas.length
      : null;

    const claudeBurnRate = avgClaudePercent !== null
      ? monitor.getAccurateBurnRate('claude', avgClaudePercent)
      : null;

    const geminiBurnRate = avgGeminiPercent !== null
      ? monitor.getAccurateBurnRate('gemini', avgGeminiPercent)
      : null;

    res.json({
      success: true,
      data: {
        claude: claudeBurnRate ? { ...claudeBurnRate, family: 'claude' } : null,
        gemini: geminiBurnRate ? { ...geminiBurnRate, family: 'gemini' } : null,
        timestamp: Date.now(),
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/accounts/timeline', (req, res) => {
  try {
    const email = req.query.email as string;
    const hours = parseInt(req.query.hours as string) || 24;
    const timeline = monitor.getHourlyUsageTimeline(email, hours);
    res.json({ success: true, data: timeline });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/logs/combined', (req, res) => {
  try {
    const filters = {
      accountEmail: req.query.accountEmail as string,
      model: req.query.model as string,
      status: req.query.status as string,
      type: req.query.type as any,
      startDate: req.query.startDate ? parseInt(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? parseInt(req.query.endDate as string) : undefined,
      search: req.query.search as string,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 100,
      offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
    };

    const logs = monitor.getCombinedLogs(filters);

    // Get total count for pagination (without limit/offset)
    const countFilters = { ...filters, limit: undefined, offset: undefined };
    const totalLogs = monitor.getCombinedLogs({ ...countFilters, limit: 10000, offset: 0 });

    res.json({ success: true, data: logs, total: totalLogs.length });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// File-based logs endpoints
app.get('/api/logs/files', (req, res) => {
  try {
    const files = fileLogger.getLogFiles();
    res.json({ success: true, data: files });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/logs/file/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    const tail = req.query.tail ? parseInt(req.query.tail as string) : undefined;
    const search = req.query.search as string | undefined;
    const level = req.query.level as import('./types').LogLevel | undefined;
    const category = req.query.category as import('./types').LogCategory | undefined;

    // Validate filename to prevent directory traversal
    if (!filename.match(/^\d{4}-\d{2}-\d{2}\.log$/)) {
      res.status(400).json({ success: false, error: 'Invalid filename format' });
      return;
    }

    const entries = fileLogger.readLogFile(filename, { tail, search, level, category });
    res.json({ success: true, data: entries });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual log import endpoint
app.post('/api/logs/import', async (req, res) => {
  try {
    const { logs } = req.body;
    if (!Array.isArray(logs)) {
      return res.status(400).json({ success: false, error: 'logs must be an array' });
    }

    const apiCalls = logs.filter((l: any) => l.type === 'api_call');
    const events = logs.filter((l: any) => l.type === 'session_event');

    monitor.storeApiCalls(apiCalls);
    monitor.storeSessionEvents(events);

    // Update last sync timestamp
    if (logs.length > 0) {
      lastSyncTimestamp = Math.max(lastSyncTimestamp, ...logs.map((l: any) => l.timestamp));
    }

    res.json({ success: true, imported: logs.length });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test endpoint to generate sample log data (development only)
if (process.env.NODE_ENV === 'development' || process.env.DEV_MODE === 'true') {
  app.post('/api/logs/test-data', (req, res) => {
    try {
      const accounts = accountsService.getAccounts();
      if (accounts.length === 0) {
        return res.status(400).json({ success: false, error: 'No accounts available' });
      }

      const now = Date.now();
      const models = ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'gemini-2.5-flash', 'gemini-2.5-pro'];
      const statuses = ['success', 'success', 'success', 'error', 'rate_limited'];

      const apiCalls: any[] = [];
      for (let i = 0; i < 50; i++) {
        const account = accounts[Math.floor(Math.random() * accounts.length)];
        const status = statuses[Math.floor(Math.random() * statuses.length)];
        const timestamp = now - (i * 60000);

        apiCalls.push({
          id: 10000 + i,
          timestamp,
          account_email: account.email,
          model: models[Math.floor(Math.random() * models.length)],
          endpoint: '/v1/messages',
          request_tokens: Math.floor(Math.random() * 5000) + 1000,
          response_tokens: Math.floor(Math.random() * 3000) + 500,
          total_tokens: Math.floor(Math.random() * 8000) + 1500,
          duration_ms: Math.floor(Math.random() * 5000) + 500,
          status,
          error_message: status === 'error' ? 'Test error message' : null,
          http_status: status === 'rate_limited' ? 429 : status === 'error' ? 500 : 200
        });
      }

      const sessionEvents: any[] = [];
      for (let i = 0; i < 10; i++) {
        const account = accounts[Math.floor(Math.random() * accounts.length)];
        const timestamp = now - (i * 300000);

        sessionEvents.push({
          id: 5000 + i,
          timestamp,
          event_type: i % 3 === 0 ? 'account_rotation' : i % 3 === 1 ? 'session_recovery' : 'quota_warning',
          account_email: account.email,
          details: i % 3 === 0
            ? JSON.stringify({ from: accounts[0].email, reason: 'rate_limited' })
            : i % 3 === 1
              ? JSON.stringify({ recovered: true })
              : JSON.stringify({ percent: 10 })
        });
      }

      monitor.storeApiCalls(apiCalls);
      monitor.storeSessionEvents(sessionEvents);

      res.json({
        success: true,
        message: `Generated ${apiCalls.length} API calls and ${sessionEvents.length} session events`
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

app.get('/api/stats', (req, res) => {
  try {
    const accounts = monitor.getAccountStats();
    const models = monitor.getModelStats();
    const hourlyStats = monitor.getHourlyStats(24);
    const localAccounts = accountsService.getAccounts();
    const accountsStats = accountsService.getStats();

    res.json({
      success: true,
      data: {
        accounts,
        models,
        hourlyStats,
        localAccounts,
        accountsStats
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/accounts', (req, res) => {
  try {
    const accounts = monitor.getAccountStats();
    res.json({ success: true, data: accounts });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/models', (req, res) => {
  try {
    const models = monitor.getModelStats();
    res.json({ success: true, data: models });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/recent-calls', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const calls = monitor.getRecentCalls(limit);
    res.json({ success: true, data: calls });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/hourly-stats', (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const stats = monitor.getHourlyStats(hours);
    res.json({ success: true, data: stats });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/session-events', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const events = monitor.getSessionEvents(limit);
    res.json({ success: true, data: events });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/export', (req, res) => {
  try {
    const data = monitor.exportData();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/export/csv', (req, res) => {
  try {
    const calls = monitor.getRecentCalls(10000);

    const headers = [
      'Timestamp', 'Account', 'Model', 'Endpoint', 'Status',
      'Duration (ms)', 'Request Tokens', 'Response Tokens',
      'Total Tokens', 'Error'
    ];

    const rows = calls.map(call => [
      new Date(call.timestamp).toISOString(),
      call.account_email, call.model, call.endpoint, call.status,
      call.duration_ms, call.request_tokens || '', call.response_tokens || '',
      call.total_tokens || '', call.error_message || ''
    ]);

    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(escapeCSVCell).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="antigravity-usage-${Date.now()}.csv"`);
    res.send(csv);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/cleanup', (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const result = monitor.clearOldData(days);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function escapeCSVCell(value: unknown): string {
  const str = String(value ?? '');
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: Date.now(),
      dbPath: monitor.getDatabasePath(),
      accountsFilePath: accountsService.getFilePath(),
      accountsFileExists: accountsService.fileExists(),
      wsClients: wsManager.getClientCount(),
      managerUrl: MANAGER_URL,
      languageServer: languageServerService.getStatus()
    }
  });
});

// ==================== Language Server API ====================

app.get('/api/language-server/status', async (req, res) => {
  try {
    const status = languageServerService.getStatus();
    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/language-server/detect', async (req, res) => {
  try {
    const verbose = req.query.verbose === 'true';
    const connected = await languageServerService.connect(verbose);
    const status = languageServerService.getStatus();
    res.json({
      success: connected,
      data: status,
      message: connected ? 'Language Server detected' : 'Language Server not found'
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/language-server/credits', async (req, res) => {
  try {
    const snapshot = languageServerService.getCachedSnapshot();

    if (!snapshot) {
      // Try to fetch fresh data
      const freshSnapshot = await languageServerService.fetchQuota();
      if (freshSnapshot) {
        res.json({
          success: true,
          data: {
            tokenUsage: freshSnapshot.tokenUsage,
            promptCredits: freshSnapshot.promptCredits,
            flowCredits: freshSnapshot.flowCredits,
            timestamp: freshSnapshot.timestamp
          }
        });
        return;
      }

      res.json({
        success: false,
        error: 'Language Server not connected',
        data: null
      });
      return;
    }

    res.json({
      success: true,
      data: {
        tokenUsage: snapshot.tokenUsage,
        promptCredits: snapshot.promptCredits,
        flowCredits: snapshot.flowCredits,
        timestamp: snapshot.timestamp
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/language-server/user', async (req, res) => {
  try {
    const userInfo = languageServerService.getUserInfo();

    if (!userInfo) {
      // Try to fetch fresh data
      const snapshot = await languageServerService.fetchQuota();
      if (snapshot?.userInfo) {
        res.json({ success: true, data: snapshot.userInfo });
        return;
      }

      res.json({
        success: false,
        error: 'Language Server not connected or no user info available',
        data: null
      });
      return;
    }

    res.json({ success: true, data: userInfo });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/language-server/snapshot', async (req, res) => {
  try {
    let snapshot = languageServerService.getCachedSnapshot();

    if (!snapshot) {
      snapshot = await languageServerService.fetchQuota();
    }

    if (!snapshot) {
      res.json({
        success: false,
        error: 'Language Server not connected',
        data: null
      });
      return;
    }

    res.json({ success: true, data: snapshot });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/language-server/refresh', async (req, res) => {
  try {
    const snapshot = await languageServerService.forceRefresh();

    if (!snapshot) {
      res.json({
        success: false,
        error: 'Failed to connect to Language Server',
        data: null
      });
      return;
    }

    res.json({ success: true, data: snapshot });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/manager/status', async (req, res) => {
  const available = await isManagerAvailable();
  res.json({
    success: true,
    data: {
      available,
      url: MANAGER_URL
    }
  });
});

app.get('/api/manager/accounts', async (req, res) => {
  const data = await proxyToManager('/accounts');
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(503).json({ success: false, error: 'Manager unavailable' });
  }
});

app.get('/api/manager/proxy/status', async (req, res) => {
  const data = await proxyToManager('/proxy/status');
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(503).json({ success: false, error: 'Manager unavailable' });
  }
});

app.get('/api/manager/proxy/stats', async (req, res) => {
  const data = await proxyToManager('/proxy/stats');
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(503).json({ success: false, error: 'Manager unavailable' });
  }
});

app.get('/api/manager/proxy/logs', async (req, res) => {
  const limit = req.query.limit || 100;
  const data = await proxyToManager(`/proxy/logs?limit=${limit}`);
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(503).json({ success: false, error: 'Manager unavailable' });
  }
});

app.post('/api/manager/proxy/start', async (req, res) => {
  const data = await proxyToManager('/proxy/start', { method: 'POST' });
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(503).json({ success: false, error: 'Manager unavailable' });
  }
});

app.post('/api/manager/proxy/stop', async (req, res) => {
  const data = await proxyToManager('/proxy/stop', { method: 'POST' });
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(503).json({ success: false, error: 'Manager unavailable' });
  }
});

app.post('/api/manager/accounts/refresh', async (req, res) => {
  const data = await proxyToManager('/accounts/refresh', { method: 'POST' });
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(503).json({ success: false, error: 'Manager unavailable' });
  }
});

app.get('/api/manager/models', async (req, res) => {
  const data = await proxyToManager('/v1/models');
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(503).json({ success: false, error: 'Manager unavailable' });
  }
});

app.get('/api/manager/config', async (req, res) => {
  const data = await proxyToManager('/config');
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(503).json({ success: false, error: 'Manager unavailable' });
  }
});

app.get('/api/analytics/overview', async (req, res) => {
  try {
    const managerAvailable = await isManagerAvailable();
    let managerData = null;

    if (managerAvailable) {
      const [accounts, proxyStatus, proxyStats] = await Promise.all([
        proxyToManager('/accounts'),
        proxyToManager('/proxy/status'),
        proxyToManager('/proxy/stats')
      ]);
      managerData = { accounts, proxyStatus, proxyStats };
    }

    const localStats = {
      accounts: monitor.getAccountStats(),
      models: monitor.getModelStats(),
      hourlyStats: monitor.getHourlyStats(24),
      recentCalls: monitor.getRecentCalls(50),
      localAccounts: accountsService.getAccounts(),
      accountsStats: accountsService.getStats()
    };

    res.json({
      success: true,
      data: {
        managerAvailable,
        managerData,
        localStats
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/analytics/performance', (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const startTime = Date.now() - hours * 60 * 60 * 1000;
    const calls = monitor.getCallsInRange(startTime, Date.now());

    const successfulCalls = calls.filter(c => c.status === 'success');
    const failedCalls = calls.filter(c => c.status === 'error');
    const rateLimitedCalls = calls.filter(c => c.status === 'rate_limited');

    const avgDuration = successfulCalls.length > 0
      ? successfulCalls.reduce((sum, c) => sum + c.duration_ms, 0) / successfulCalls.length
      : 0;

    const totalTokens = successfulCalls.reduce((sum, c) => sum + (c.total_tokens || 0), 0);
    const totalInputTokens = successfulCalls.reduce((sum, c) => sum + (c.request_tokens || 0), 0);
    const totalOutputTokens = successfulCalls.reduce((sum, c) => sum + (c.response_tokens || 0), 0);

    const durations = successfulCalls.map(c => c.duration_ms).sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
    const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
    const p99 = durations[Math.floor(durations.length * 0.99)] || 0;

    const errorBreakdown: Record<string, number> = {};
    failedCalls.forEach(call => {
      const error = call.error_message || 'unknown';
      errorBreakdown[error] = (errorBreakdown[error] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        summary: {
          totalRequests: calls.length,
          successfulRequests: successfulCalls.length,
          failedRequests: failedCalls.length,
          rateLimitedRequests: rateLimitedCalls.length,
          successRate: calls.length > 0 ? (successfulCalls.length / calls.length * 100).toFixed(2) : 0
        },
        performance: {
          avgDurationMs: Math.round(avgDuration),
          minDurationMs: durations[0] || 0,
          maxDurationMs: durations[durations.length - 1] || 0,
          p50,
          p95,
          p99
        },
        tokens: {
          total: totalTokens,
          input: totalInputTokens,
          output: totalOutputTokens,
          avgPerRequest: successfulCalls.length > 0 ? Math.round(totalTokens / successfulCalls.length) : 0
        },
        errorBreakdown,
        requestsPerHour: calls.length / hours
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/analytics/errors', (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const startTime = Date.now() - hours * 60 * 60 * 1000;
    const calls = monitor.getCallsInRange(startTime, Date.now());

    const errorCalls = calls.filter(c => c.status !== 'success');

    const errorsByType: Record<string, any> = {};
    errorCalls.forEach(call => {
      const key = `${call.http_status || 'unknown'}_${call.status}`;
      if (!errorsByType[key]) {
        errorsByType[key] = {
          httpStatus: call.http_status,
          status: call.status,
          count: 0,
          messages: [],
          accounts: new Set(),
          models: new Set()
        };
      }
      errorsByType[key].count++;
      if (call.error_message) {
        errorsByType[key].messages.push(call.error_message);
      }
      errorsByType[key].accounts.add(call.account_email);
      errorsByType[key].models.add(call.model);
    });

    const formattedErrors = Object.values(errorsByType).map((e: any) => ({
      httpStatus: e.httpStatus,
      status: e.status,
      count: e.count,
      affectedAccounts: Array.from(e.accounts),
      affectedModels: Array.from(e.models),
      sampleMessages: [...new Set(e.messages)].slice(0, 5)
    })).sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      data: {
        totalErrors: errorCalls.length,
        errorsByType: formattedErrors
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/analytics/trends', (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const hourlyData = monitor.getHourlyStats(days * 24);

    const dailyData: Record<string, any> = {};
    hourlyData.forEach((row: any) => {
      const date = new Date(row.hour).toISOString().split('T')[0];
      if (!dailyData[date]) {
        dailyData[date] = {
          date,
          calls: 0,
          tokens: 0,
          successful: 0,
          errors: 0,
          rateLimited: 0
        };
      }
      dailyData[date].calls += row.calls;
      dailyData[date].tokens += row.tokens;
      dailyData[date].successful += row.successful;
      dailyData[date].errors += row.errors;
      dailyData[date].rateLimited += row.rate_limited;
    });

    res.json({
      success: true,
      data: Object.values(dailyData)
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Quota Strategy API ====================

app.get('/api/quota-groups', (req, res) => {
  try {
    const groups = quotaStrategyManager.getGroups();
    res.json({ success: true, data: groups });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/quota-groups/:modelId', (req, res) => {
  try {
    const { modelId } = req.params;
    const label = req.query.label as string | undefined;
    const group = quotaStrategyManager.getGroupForModel(modelId, label);
    const displayName = quotaStrategyManager.getModelDisplayName(modelId, label);
    res.json({
      success: true,
      data: {
        group,
        displayName,
        family: quotaStrategyManager.getFamily(modelId)
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});



// ==================== Runway Prediction API ====================

app.get('/api/analytics/prediction', (req, res) => {
  try {
    const email = req.query.email as string | undefined;

    // Get quota data for the account(s)
    const quotas = quotaService.getCachedQuotas();

    if (email) {
      // Single account prediction
      const quota = quotas.find(q => q.email === email);
      const predictions = monitor.getAllRunwayPredictions(
        quota?.claudeQuotaPercent ?? null,
        quota?.geminiQuotaPercent ?? null
      );

      res.json({
        success: true,
        data: {
          email,
          ...predictions
        }
      });
    } else {
      // Aggregate prediction across all accounts
      // Use the minimum quota percentages as the bottleneck
      const claudeQuotas = quotas
        .map(q => q.claudeQuotaPercent)
        .filter((p): p is number => p !== null);
      const geminiQuotas = quotas
        .map(q => q.geminiQuotaPercent)
        .filter((p): p is number => p !== null);

      const minClaude = claudeQuotas.length > 0 ? Math.min(...claudeQuotas) : null;
      const minGemini = geminiQuotas.length > 0 ? Math.min(...geminiQuotas) : null;

      const predictions = monitor.getAllRunwayPredictions(minClaude, minGemini);

      res.json({
        success: true,
        data: {
          accountCount: quotas.length,
          minClaudeQuota: minClaude,
          minGeminiQuota: minGemini,
          ...predictions
        }
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ success: false, error: message });
  }
});

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Server] Unhandled error:', err);
  fileLogger.error('system', 'Unhandled API error', {
    path: req.path,
    method: req.method,
    error: err.message
  });
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../web/dist/index.html'));
});

const server = createServer(app);

wsManager.initialize(server, '/ws');

accountsService.on('accounts_loaded', (accounts) => {
  wsManager.broadcastNow({
    type: 'initial',
    data: { accounts, stats: accountsService.getStats() },
    timestamp: Date.now()
  });
});

accountsService.on('accounts_changed', (diffs) => {
  wsManager.broadcastAccountsUpdate(diffs);
});

accountsService.on('rate_limits_updated', () => {
  wsManager.broadcastStatsUpdate(accountsService.getStats());
});

accountsService.on('rate_limit_cleared', ({ email, family }) => {
  wsManager.broadcastRateLimitChange(email, family, true);
});

quotaService.on('quotas_updated', (quotas: Array<import('./services/quotaService').AccountQuota>) => {
  // Record quota snapshots for accurate burn rate calculation
  for (const quota of quotas) {
    if (quota.claudeQuotaPercent !== null) {
      monitor.recordQuotaSnapshot(quota.email, 'claude', quota.claudeQuotaPercent, quota.claudeResetTime);
    }
    if (quota.geminiQuotaPercent !== null) {
      monitor.recordQuotaSnapshot(quota.email, 'gemini', quota.geminiQuotaPercent, quota.geminiResetTime);
    }
  }

  // Log quota update
  const claudeQuotas = quotas.filter(q => q.claudeQuotaPercent !== null);
  const geminiQuotas = quotas.filter(q => q.geminiQuotaPercent !== null);
  fileLogger.info('quota', 'Quotas updated', {
    accountCount: quotas.length,
    claudeAvg: claudeQuotas.length > 0 ? Math.round(claudeQuotas.reduce((sum, q) => sum + (q.claudeQuotaPercent || 0), 0) / claudeQuotas.length) : null,
    geminiAvg: geminiQuotas.length > 0 ? Math.round(geminiQuotas.reduce((sum, q) => sum + (q.geminiQuotaPercent || 0), 0) / geminiQuotas.length) : null,
  });

  // Cleanup old snapshots (keep last 24h)
  monitor.cleanupOldSnapshots(24);

  wsManager.broadcastNow({
    type: 'config_update',
    data: { quotas },
    timestamp: Date.now()
  });
});

// Language Server events
languageServerService.on('connected', (info) => {
  console.log('[Server] Language Server connected on port', info.port);
  wsManager.broadcastNow({
    type: 'config_update',
    data: { languageServer: { connected: true, ...info } },
    timestamp: Date.now()
  });
});

languageServerService.on('disconnected', (reason) => {
  console.log('[Server] Language Server disconnected:', reason);
  wsManager.broadcastNow({
    type: 'config_update',
    data: { languageServer: { connected: false, error: reason } },
    timestamp: Date.now()
  });
});

languageServerService.on('quota_update', (snapshot) => {
  wsManager.broadcastNow({
    type: 'config_update',
    data: {
      languageServerSnapshot: snapshot,
      credits: snapshot.tokenUsage,
      userInfo: snapshot.userInfo
    },
    timestamp: Date.now()
  });
});

// Start Language Server connection (non-blocking)
languageServerService.connect(true).then((connected) => {
  if (connected) {
    languageServerService.startPolling();
  } else {
    console.log('[Server] Language Server not available - credits tracking disabled');
  }
});

quotaService.startPolling(getRawAccountsForQuota);

const logSyncInterval = setInterval(syncLogsFromManager, 30000);
syncLogsFromManager();

const bindHost = getBindHost();
server.listen(Number(PORT), bindHost, () => {
  const authStatus = isAuthEnabled() ? 'ENABLED (network access)' : 'DISABLED (localhost only)';
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🚀 Antigravity Usage Dashboard                          ║
║                                                            ║
║   Dashboard: http://${bindHost}:${PORT}                       ║
║   API:       http://${bindHost}:${PORT}/api/stats             ║
║   Claude:    http://${bindHost}:${PORT}/v1/messages           ║
║   OpenAI:    http://${bindHost}:${PORT}/v1/chat/completions   ║
║   Database:  ${monitor.getDatabasePath()}                 ║
║   Accounts:  ${accountsService.getFilePath()}             ║
║   Auth:      ${authStatus}                ║
║                                                            ║
║   For Claude Code CLI, set:                               ║
║   ANTHROPIC_BASE_URL=http://localhost:${PORT}            ║
║   ANTHROPIC_API_KEY=<get from /api/proxy/api-key>        ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  clearInterval(logSyncInterval);
  accountsService.stop();
  quotaService.stopPolling();
  languageServerService.stopPolling();
  languageServerService.disconnect();
  wsManager.shutdown();
  monitor.close();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught exception:', error);
  fileLogger.error('system', 'Uncaught exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
  fileLogger.error('system', 'Unhandled rejection', { reason: String(reason) });
});

export { app, server, monitor, accountsService, wsManager };
