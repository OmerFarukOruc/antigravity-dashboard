import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { ApiCall, AccountStats, ModelStats, CombinedLogEntry, LogFilters, AccountBurnRate, TimelineSlice } from './types';

export class UsageMonitor {

  private db: Database.Database;
  private dbPath: string;

  constructor(customDbPath?: string) {
    const configDir = join(homedir(), '.config', 'opencode', 'antigravity-dashboard');
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    this.dbPath = customDbPath || join(configDir, 'usage.db');
    this.db = new Database(this.dbPath);
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account_email TEXT NOT NULL,
        model TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        request_tokens INTEGER,
        response_tokens INTEGER,
        total_tokens INTEGER,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        http_status INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON api_calls(timestamp);
      CREATE INDEX IF NOT EXISTS idx_account_email ON api_calls(account_email);
      CREATE INDEX IF NOT EXISTS idx_model ON api_calls(model);
      CREATE INDEX IF NOT EXISTS idx_status ON api_calls(status);

      CREATE TABLE IF NOT EXISTS account_status (
        email TEXT PRIMARY KEY,
        is_rate_limited BOOLEAN NOT NULL DEFAULT 0,
        rate_limit_reset INTEGER,
        last_error TEXT,
        last_updated INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        account_email TEXT,
        details TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_session_timestamp ON session_events(timestamp);

      -- Quota snapshots for accurate burn rate calculation
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account_email TEXT NOT NULL,
        model_family TEXT NOT NULL,
        quota_percent REAL NOT NULL,
        reset_time INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_qs_family_time ON quota_snapshots(model_family, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_qs_email ON quota_snapshots(account_email);
    `);
    
    this.migrateSchema();
  }

  private migrateSchema() {
    const hasSourceColumn = this.db.prepare(
      `SELECT COUNT(*) as count FROM pragma_table_info('api_calls') WHERE name='source'`
    ).get() as { count: number };
    
    if (hasSourceColumn.count === 0) {
      this.db.exec(`
        ALTER TABLE api_calls ADD COLUMN source TEXT DEFAULT 'internal';
        ALTER TABLE api_calls ADD COLUMN stream INTEGER DEFAULT 0;
        ALTER TABLE api_calls ADD COLUMN client_ip TEXT;
        CREATE INDEX IF NOT EXISTS idx_source ON api_calls(source);
      `);
    }
  }

  logApiCall(call: ApiCall): number {
    const stmt = this.db.prepare(`
      INSERT INTO api_calls (
        timestamp, account_email, model, endpoint,
        request_tokens, response_tokens, total_tokens,
        duration_ms, status, error_message, http_status,
        source, stream, client_ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      call.timestamp, call.account_email, call.model, call.endpoint,
      call.request_tokens || null, call.response_tokens || null,
      call.total_tokens || null, call.duration_ms, call.status,
      call.error_message || null, call.http_status || null,
      call.source || 'internal', call.stream ? 1 : 0, call.client_ip || null
    );

    return info.lastInsertRowid as number;
  }

  updateAccountStatus(email: string, isRateLimited: boolean, rateLimitReset?: number, lastError?: string) {
    const stmt = this.db.prepare(`
      INSERT INTO account_status (email, is_rate_limited, rate_limit_reset, last_error, last_updated)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        is_rate_limited = excluded.is_rate_limited,
        rate_limit_reset = excluded.rate_limit_reset,
        last_error = excluded.last_error,
        last_updated = excluded.last_updated
    `);

    stmt.run(email, isRateLimited ? 1 : 0, rateLimitReset || null, lastError || null, Date.now());
  }

  logSessionEvent(eventType: string, accountEmail?: string, details?: any) {
    const stmt = this.db.prepare(`
      INSERT INTO session_events (timestamp, event_type, account_email, details)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(Date.now(), eventType, accountEmail || null, details ? JSON.stringify(details) : null);
  }

  getAccountStats(burnWindowMs: number = 3600000): AccountStats[] {
    const burnStartTime = Date.now() - burnWindowMs;

    const stmt = this.db.prepare(`
      SELECT 
        ac.account_email as email,
        COUNT(*) as total_calls,
        SUM(CASE WHEN ac.status = 'success' THEN 1 ELSE 0 END) as successful_calls,
        SUM(CASE WHEN ac.status = 'error' THEN 1 ELSE 0 END) as failed_calls,
        SUM(CASE WHEN ac.status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_calls,
        COALESCE(SUM(ac.total_tokens), 0) as total_tokens,
        MAX(ac.timestamp) as last_used,
        COALESCE(ast.is_rate_limited, 0) as is_rate_limited,
        ast.rate_limit_reset,
        COALESCE(SUM(CASE WHEN ac.timestamp >= ? THEN ac.total_tokens ELSE 0 END), 0) as burn_rate_1h
      FROM api_calls ac
      LEFT JOIN account_status ast ON ac.account_email = ast.email
      GROUP BY ac.account_email
      ORDER BY total_calls DESC
    `);

    return stmt.all(burnStartTime) as AccountStats[];
  }

  getModelStats(): ModelStats[] {
    const stmt = this.db.prepare(`
      SELECT 
        model,
        COUNT(*) as total_calls,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        AVG(duration_ms) as avg_duration_ms
      FROM api_calls
      WHERE status = 'success'
      GROUP BY model
      ORDER BY total_calls DESC
    `);

    return stmt.all() as ModelStats[];
  }

  getRecentCalls(limit: number = 100): ApiCall[] {
    const stmt = this.db.prepare(`
      SELECT * FROM api_calls
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(limit) as ApiCall[];
  }

  getProxyCalls(limit: number = 100): ApiCall[] {
    const stmt = this.db.prepare(`
      SELECT * FROM api_calls
      WHERE source = 'proxy'
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(limit) as ApiCall[];
  }

  getProxyStats(): { total: number; successful: number; failed: number; byModel: Record<string, number>; byAccount: Record<string, number> } {
    const statsStmt = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failed
      FROM api_calls WHERE source = 'proxy'
    `);
    const stats = statsStmt.get() as { total: number; successful: number; failed: number };

    const modelStmt = this.db.prepare(`
      SELECT model, COUNT(*) as count FROM api_calls WHERE source = 'proxy' GROUP BY model
    `);
    const modelRows = modelStmt.all() as { model: string; count: number }[];
    const byModel: Record<string, number> = {};
    for (const row of modelRows) {
      byModel[row.model] = row.count;
    }

    const accountStmt = this.db.prepare(`
      SELECT account_email, COUNT(*) as count FROM api_calls WHERE source = 'proxy' GROUP BY account_email
    `);
    const accountRows = accountStmt.all() as { account_email: string; count: number }[];
    const byAccount: Record<string, number> = {};
    for (const row of accountRows) {
      byAccount[row.account_email] = row.count;
    }

    return { ...stats, byModel, byAccount };
  }

  getCallsInRange(startTime: number, endTime: number): ApiCall[] {
    const stmt = this.db.prepare(`
      SELECT * FROM api_calls
      WHERE timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `);

    return stmt.all(startTime, endTime) as ApiCall[];
  }

  getHourlyStats(hours: number = 24) {
    const startTime = Date.now() - hours * 60 * 60 * 1000;

    const stmt = this.db.prepare(`
      SELECT 
        (timestamp / 3600000) * 3600000 as hour,
        COUNT(*) as calls,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
        SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM api_calls
      WHERE timestamp >= ?
      GROUP BY hour
      ORDER BY hour ASC
    `);

    return stmt.all(startTime);
  }

  getSessionEvents(limit: number = 100) {
    const stmt = this.db.prepare(`
      SELECT * FROM session_events
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  clearOldData(daysToKeep: number = 30) {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const stmtCalls = this.db.prepare('DELETE FROM api_calls WHERE timestamp < ?');
    const stmtEvents = this.db.prepare('DELETE FROM session_events WHERE timestamp < ?');

    const callsDeleted = stmtCalls.run(cutoffTime).changes;
    const eventsDeleted = stmtEvents.run(cutoffTime).changes;

    return { callsDeleted, eventsDeleted };
  }

  exportData() {
    return {
      accounts: this.getAccountStats(),
      models: this.getModelStats(),
      recentCalls: this.getRecentCalls(1000),
      sessionEvents: this.getSessionEvents(1000),
      hourlyStats: this.getHourlyStats(168)
    };
  }

  getCombinedLogs(filters: LogFilters): CombinedLogEntry[] {
    let query = `
      SELECT * FROM (
        SELECT id, timestamp, 'api_call' as type, account_email, model, NULL as event_type, status, total_tokens, duration_ms, NULL as details, error_message
        FROM api_calls
        UNION ALL
        SELECT id, timestamp, 'session_event' as type, account_email, NULL as model, event_type, NULL as status, NULL as total_tokens, NULL as duration_ms, details, NULL as error_message
        FROM session_events
      ) logs
      WHERE 1=1
    `;

    const params: any[] = [];

    if (filters.accountEmail) {
      query += ` AND account_email = ?`;
      params.push(filters.accountEmail);
    }

    if (filters.model) {
      query += ` AND model = ?`;
      params.push(filters.model);
    }

    if (filters.type && filters.type !== 'all') {
      query += ` AND type = ?`;
      params.push(filters.type);
    }

    if (filters.status) {
      query += ` AND status = ?`;
      params.push(filters.status);
    }

    if (filters.startDate) {
      query += ` AND timestamp >= ?`;
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      query += ` AND timestamp <= ?`;
      params.push(filters.endDate);
    }

    if (filters.search) {
      query += ` AND (account_email LIKE ? OR model LIKE ? OR error_message LIKE ? OR details LIKE ? OR event_type LIKE ?)`;
      const searchPattern = `%${filters.search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }

    query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    params.push(filters.limit || 100, filters.offset || 0);

    return this.db.prepare(query).all(...params) as CombinedLogEntry[];
  }

  /**
   * Store multiple API calls in the database (for log sync from manager)
   */
  storeApiCalls(calls: any[]) {
    if (!calls.length) return;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO api_calls
      (id, timestamp, account_email, model, endpoint, request_tokens, response_tokens, total_tokens, duration_ms, status, error_message, http_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((calls: any[]) => {
      for (const call of calls) {
        insert.run(
          call.id,
          call.timestamp,
          call.account_email,
          call.model,
          call.endpoint,
          call.request_tokens || null,
          call.response_tokens || null,
          call.total_tokens || null,
          call.duration_ms,
          call.status,
          call.error_message || null,
          call.http_status || null
        );
      }
    });

    transaction(calls);
  }

  /**
   * Store multiple session events in the database (for log sync from manager)
   */
  storeSessionEvents(events: any[]) {
    if (!events.length) return;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO session_events
      (id, timestamp, event_type, account_email, details)
      VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((events: any[]) => {
      for (const event of events) {
        insert.run(
          event.id,
          event.timestamp,
          event.event_type,
          event.account_email || null,
          event.details || null
        );
      }
    });

    transaction(events);
  }

  getAccountBurnRateDetailed(email: string): { claudeTokens1h: number; geminiTokens1h: number } | null {
    const oneHourAgo = Date.now() - 3600000;
    
    const query = `
      SELECT 
        SUM(CASE WHEN (model LIKE '%claude%' OR model LIKE '%anthropic%') AND timestamp >= ? THEN total_tokens ELSE 0 END) as claudeTokens1h,
        SUM(CASE WHEN model LIKE '%gemini%' AND timestamp >= ? THEN total_tokens ELSE 0 END) as geminiTokens1h
      FROM api_calls
      WHERE account_email = ? AND status = 'success'
    `;
    
    const result = this.db.prepare(query).get(oneHourAgo, oneHourAgo, email) as { claudeTokens1h: number; geminiTokens1h: number } | undefined;
    return result ?? null;
  }

  getHourlyUsageTimeline(email?: string, hours: number = 24): TimelineSlice[] {
    const now = Date.now();
    const sliceDurationMs = 4.8 * 60 * 60 * 1000; // 5 slices in 24h
    const startTime = now - hours * 60 * 60 * 1000;
    
    // We want 5 slices of 4.8 hours each for the last 24h
    const slices: TimelineSlice[] = [];
    
    for (let i = 0; i < 5; i++) {
      const sliceStartTime = startTime + (i * sliceDurationMs);
      const sliceEndTime = sliceStartTime + sliceDurationMs;
      
      let query = `
        SELECT 
          SUM(CASE WHEN model LIKE '%claude%' OR model LIKE '%anthropic%' THEN total_tokens ELSE 0 END) as claudeTokens,
          SUM(CASE WHEN model LIKE '%gemini%' THEN total_tokens ELSE 0 END) as geminiTokens
        FROM api_calls
        WHERE timestamp >= ? AND timestamp < ? AND status = 'success'
      `;
      
      const params: any[] = [sliceStartTime, sliceEndTime];
      if (email) {
        query += ` AND account_email = ?`;
        params.push(email);
      }
      
      const stats = this.db.prepare(query).get(...params) as { claudeTokens: number | null; geminiTokens: number | null } | undefined;
      
      slices.push({
        startTime: sliceStartTime,
        endTime: sliceEndTime,
        claudeTokens: stats?.claudeTokens || 0,
        geminiTokens: stats?.geminiTokens || 0,
        claudePercentUsed: 0, // Calculated on frontend with quota info
        geminiPercentUsed: 0, // Calculated on frontend with quota info
        currentSlice: now >= sliceStartTime && now < sliceEndTime
      });
    }
    
    return slices;
  }

  /**
   * Calculate runway prediction based on recent usage patterns
   * @param quotaPercent Current remaining quota percentage
   * @param family Model family ('claude' or 'gemini')
   */
  calculateRunwayPrediction(quotaPercent: number, family: 'claude' | 'gemini'): {
    usageRate: number;  // % per hour
    runway: string;     // Human-readable runway estimate
    hoursRemaining: number | null;
  } {
    // Get usage from multiple time windows to calculate rate
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const threeHoursAgo = now - 3 * 3600000;
    
    const familyPattern = family === 'claude' 
      ? "(model LIKE '%claude%' OR model LIKE '%anthropic%')" 
      : "model LIKE '%gemini%'";
    
    // Get token usage over different time windows
    const query1h = `
      SELECT SUM(total_tokens) as tokens
      FROM api_calls
      WHERE ${familyPattern} AND status = 'success' AND timestamp >= ?
    `;
    
    const query3h = `
      SELECT SUM(total_tokens) as tokens
      FROM api_calls
      WHERE ${familyPattern} AND status = 'success' AND timestamp >= ?
    `;
    
    const usage1h = this.db.prepare(query1h).get(oneHourAgo) as { tokens: number } | undefined;
    const usage3h = this.db.prepare(query3h).get(threeHoursAgo) as { tokens: number } | undefined;
    
    const tokens1h = usage1h?.tokens || 0;
    const tokens3h = usage3h?.tokens || 0;
    
    // Calculate average hourly token usage (weighted toward recent)
    const avgTokensPerHour = tokens3h > 0 
      ? (tokens1h * 0.6 + (tokens3h / 3) * 0.4)  // Weight recent usage more
      : tokens1h;
    
    // If no usage, return stable prediction
    if (avgTokensPerHour === 0) {
      return {
        usageRate: 0,
        runway: 'Stable',
        hoursRemaining: null
      };
    }
    
    // Estimate quota depletion rate
    // Assumption: Google's free tier is roughly 1M tokens per 5-hour window
    // This is a rough estimate - actual quota varies by tier
    const estimatedMaxTokens = 1000000;
    const percentPerHour = (avgTokensPerHour / estimatedMaxTokens) * 100;
    
    // Calculate hours until quota is exhausted
    const hoursRemaining = quotaPercent / percentPerHour;
    
    // Format runway string
    let runway: string;
    if (hoursRemaining <= 0 || quotaPercent <= 0) {
      runway = 'Exhausted';
    } else if (hoursRemaining < 1) {
      runway = `~${Math.round(hoursRemaining * 60)}m`;
    } else if (hoursRemaining < 24) {
      runway = `~${Math.round(hoursRemaining)}h`;
    } else if (hoursRemaining < 168) {  // 7 days
      runway = `~${Math.round(hoursRemaining / 24)}d`;
    } else {
      runway = '>7d';
    }
    
    return {
      usageRate: Math.round(percentPerHour * 10) / 10,  // Round to 1 decimal
      runway,
      hoursRemaining: hoursRemaining > 0 ? hoursRemaining : null
    };
  }

  /**
   * Get runway predictions for all families
   */
  getAllRunwayPredictions(claudeQuotaPercent: number | null, geminiQuotaPercent: number | null): {
    claude: { usageRate: number; runway: string; hoursRemaining: number | null } | null;
    gemini: { usageRate: number; runway: string; hoursRemaining: number | null } | null;
    overall: { usageRate: number; runway: string } | null;
  } {
    const claudePrediction = claudeQuotaPercent !== null 
      ? this.calculateRunwayPrediction(claudeQuotaPercent, 'claude')
      : null;
    
    const geminiPrediction = geminiQuotaPercent !== null
      ? this.calculateRunwayPrediction(geminiQuotaPercent, 'gemini')
      : null;
    
    // Calculate overall (average of both)
    let overall: { usageRate: number; runway: string } | null = null;
    if (claudePrediction || geminiPrediction) {
      const rates = [
        claudePrediction?.usageRate ?? 0,
        geminiPrediction?.usageRate ?? 0
      ].filter(r => r > 0);
      
      if (rates.length > 0) {
        const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
        
        // Find the shortest runway
        const hours = [
          claudePrediction?.hoursRemaining,
          geminiPrediction?.hoursRemaining
        ].filter((h): h is number => h !== null);
        
        const minHours = hours.length > 0 ? Math.min(...hours) : null;
        
        let runway: string;
        if (minHours === null) {
          runway = 'Stable';
        } else if (minHours < 1) {
          runway = `~${Math.round(minHours * 60)}m`;
        } else if (minHours < 24) {
          runway = `~${Math.round(minHours)}h`;
        } else if (minHours < 168) {
          runway = `~${Math.round(minHours / 24)}d`;
        } else {
          runway = '>7d';
        }
        
        overall = {
          usageRate: Math.round(avgRate * 10) / 10,
          runway
        };
      }
    }
    
    return { claude: claudePrediction, gemini: geminiPrediction, overall };
  }

  // ==================== Quota Snapshots for Accurate Burn Rate ====================

  /**
   * Record a quota snapshot for burn rate calculation
   */
  recordQuotaSnapshot(
    accountEmail: string,
    modelFamily: 'claude' | 'gemini',
    quotaPercent: number,
    resetTime: number | null
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO quota_snapshots (timestamp, account_email, model_family, quota_percent, reset_time)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(Date.now(), accountEmail, modelFamily, quotaPercent, resetTime);
  }

  /**
   * Get quota snapshots for a model family within a time range
   */
  getQuotaSnapshots(
    modelFamily: 'claude' | 'gemini',
    since: number
  ): Array<{ timestamp: number; avgPercent: number; count: number }> {
    // Get snapshots aggregated by 5-minute intervals
    const stmt = this.db.prepare(`
      SELECT 
        (timestamp / 300000) * 300000 as interval_ts,
        AVG(quota_percent) as avg_percent,
        COUNT(*) as count
      FROM quota_snapshots
      WHERE model_family = ? AND timestamp >= ?
      GROUP BY interval_ts
      ORDER BY interval_ts ASC
    `);
    
    const rows = stmt.all(modelFamily, since) as Array<{ interval_ts: number; avg_percent: number; count: number }>;
    return rows.map(r => ({
      timestamp: r.interval_ts,
      avgPercent: r.avg_percent,
      count: r.count,
    }));
  }

  /**
   * Calculate burn rate from quota snapshots (% per hour)
   * Returns null if insufficient data
   */
  calculateBurnRateFromSnapshots(modelFamily: 'claude' | 'gemini'): number | null {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const snapshots = this.getQuotaSnapshots(modelFamily, twoHoursAgo);
    
    if (snapshots.length < 2) {
      return null; // Need at least 2 data points
    }
    
    const oldest = snapshots[0];
    const newest = snapshots[snapshots.length - 1];
    
    const deltaPercent = oldest.avgPercent - newest.avgPercent;
    const deltaHours = (newest.timestamp - oldest.timestamp) / (60 * 60 * 1000);
    
    if (deltaHours < 0.1) {
      return null; // Not enough time elapsed
    }
    
    const burnRate = deltaPercent / deltaHours;
    
    // If quota went UP (reset happened), we can't calculate burn rate
    if (burnRate < 0) {
      return null;
    }
    
    return Math.round(burnRate * 10) / 10; // Round to 1 decimal
  }

  /**
   * Get accurate burn rate info for a model family
   */
  getAccurateBurnRate(
    modelFamily: 'claude' | 'gemini',
    currentQuotaPercent: number
  ): { burnRatePerHour: number; hoursRemaining: number | null; runway: string; dataPoints: number; confidence: 'high' | 'medium' | 'low' } {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const snapshots = this.getQuotaSnapshots(modelFamily, twoHoursAgo);
    
    const burnRate = this.calculateBurnRateFromSnapshots(modelFamily);
    
    // Determine confidence based on data points
    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (snapshots.length >= 10) {
      confidence = 'high';
    } else if (snapshots.length >= 4) {
      confidence = 'medium';
    }
    
    if (burnRate === null || burnRate <= 0) {
      return {
        burnRatePerHour: 0,
        hoursRemaining: null,
        runway: 'Stable',
        dataPoints: snapshots.length,
        confidence,
      };
    }
    
    const hoursRemaining = currentQuotaPercent / burnRate;
    
    let runway: string;
    if (hoursRemaining < 1) {
      runway = `~${Math.round(hoursRemaining * 60)}m`;
    } else if (hoursRemaining < 24) {
      runway = `~${Math.round(hoursRemaining)}h`;
    } else if (hoursRemaining < 168) {
      runway = `~${Math.round(hoursRemaining / 24)}d`;
    } else {
      runway = '>7d';
    }
    
    return {
      burnRatePerHour: burnRate,
      hoursRemaining,
      runway,
      dataPoints: snapshots.length,
      confidence,
    };
  }

  /**
   * Cleanup old quota snapshots (keep last 24 hours)
   */
  cleanupOldSnapshots(hoursToKeep: number = 24): number {
    const cutoff = Date.now() - hoursToKeep * 60 * 60 * 1000;
    const stmt = this.db.prepare('DELETE FROM quota_snapshots WHERE timestamp < ?');
    return stmt.run(cutoff).changes;
  }

  close() {
    this.db.close();
  }

  getDatabasePath(): string {
    return this.dbPath;
  }
}

let monitorInstance: UsageMonitor | null = null;

export function getMonitor(): UsageMonitor {
  if (!monitorInstance) {
    monitorInstance = new UsageMonitor();
  }
  return monitorInstance;
}
