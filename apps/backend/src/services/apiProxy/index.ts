import { Response } from 'express';
import { randomUUID } from 'crypto';

function safeParseToolArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

import {
  ClaudeRequest,
  ClaudeResponse,
  ClaudeResponseContentBlock,
  OpenAIRequest,
  OpenAIResponse,
  ProxyConfig,
  ProxyStats,
  StreamCallbackData,
} from './types.js';

import {
  generateClaudeRequestBody,
  generateOpenAIRequestBody,
  generateSessionId,
  TokenContext,
  mapModel,
  getOriginalToolName,
} from './converter.js';

import {
  formatClaudeSSE,
  formatOpenAISSE,
  formatOpenAIDone,
  ClaudeStreamEvent,
  OpenAIStreamChunk,
  createHeartbeat,
  setupSSEHeaders,
} from './streaming.js';

import { AntigravityClient, ApiError, GenerationResult } from './client.js';

export type ModelFamily = 'claude' | 'gemini';

export interface Account {
  email: string;
  refreshToken: string;
  projectId: string;
  accessToken?: string;
  accessTokenExpiry?: number;
}

export interface ProxyRequestLog {
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
  source: 'proxy';
  stream: boolean;
  client_ip?: string;
}

export interface ProxyLogger {
  logProxyRequest(log: ProxyRequestLog): void;
}

export interface RateLimitNotifier {
  onRateLimited(email: string, model: string, resetTime?: Date): void;
}

export interface TokenProvider {
  getAccessToken(refreshToken: string): Promise<string | null>;
  getAccounts(): Account[];
  getActiveAccount(): Account | null;
  rotateAccount(family?: ModelFamily): Account | null;
}

/**
 * Determine the model family from a model name
 */
export function getModelFamily(modelName: string): ModelFamily {
  const lower = modelName.toLowerCase();
  if (lower.includes('gemini')) {
    return 'gemini';
  }
  // Default to Claude for claude models or unknown models
  return 'claude';
}

export class ApiProxyService {
  private client: AntigravityClient;
  private tokenProvider: TokenProvider;
  private config: ProxyConfig;
  private stats: ProxyStats;
  private sessionIds: Map<string, string> = new Map();
  private requestCounts: Map<string, number> = new Map();
  private logger?: ProxyLogger;
  private rateLimitNotifier?: RateLimitNotifier;

  constructor(
    tokenProvider: TokenProvider, 
    config: Partial<ProxyConfig> = {}, 
    logger?: ProxyLogger,
    rateLimitNotifier?: RateLimitNotifier
  ) {
    this.tokenProvider = tokenProvider;
    this.logger = logger;
    this.rateLimitNotifier = rateLimitNotifier;
    this.config = {
      apiKey: config.apiKey || randomUUID(),
      enabled: config.enabled ?? true,
      port: config.port || 3456,
      systemInstruction: config.systemInstruction,
      defaultModel: config.defaultModel || 'claude-sonnet-4-5',
      rotationStrategy: config.rotationStrategy || 'round_robin',
      requestCountPerToken: config.requestCountPerToken || 10,
      timeout: config.timeout || 120000,
      maxRetries: config.maxRetries || 3,
      heartbeatInterval: config.heartbeatInterval || 30000,
    };
    this.client = new AntigravityClient({ timeout: this.config.timeout });
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      activeConnections: 0,
      lastRequestTime: null,
      requestsByModel: {},
      requestsByAccount: {},
    };
  }

  getConfig(): ProxyConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<ProxyConfig>): void {
    Object.assign(this.config, updates);
  }

  getStats(): ProxyStats {
    return { ...this.stats };
  }

  validateApiKey(key: string): boolean {
    return key === this.config.apiKey;
  }

  private async getTokenContext(requestedModel?: string): Promise<TokenContext> {
    // Determine model family from requested model
    const family = requestedModel ? getModelFamily(mapModel(requestedModel)) : undefined;
    
    const account = this.selectAccount(family);
    if (!account) {
      throw new ApiError('No accounts available', 503, 'No accounts configured');
    }

    const accessToken = await this.tokenProvider.getAccessToken(account.refreshToken);
    if (!accessToken) {
      throw new ApiError('Failed to get access token', 503, 'Token refresh failed');
    }

    let sessionId = this.sessionIds.get(account.email);
    if (!sessionId) {
      sessionId = generateSessionId();
      this.sessionIds.set(account.email, sessionId);
    }

    return {
      accessToken,
      projectId: account.projectId,
      email: account.email,
      sessionId,
    };
  }

  private selectAccount(family?: ModelFamily): Account | null {
    const accounts = this.tokenProvider.getAccounts();
    if (accounts.length === 0) return null;

    // Passthrough mode: always use the active account set by the plugin
    // Account rotation is handled by opencode-antigravity-auth plugin
    return this.tokenProvider.getActiveAccount() || accounts[0];
  }

  private updateStats(model: string, email: string, success: boolean): void {
    this.stats.totalRequests++;
    this.stats.lastRequestTime = Date.now();
    
    if (success) {
      this.stats.successfulRequests++;
    } else {
      this.stats.failedRequests++;
    }

    this.stats.requestsByModel[model] = (this.stats.requestsByModel[model] || 0) + 1;
    this.stats.requestsByAccount[email] = (this.stats.requestsByAccount[email] || 0) + 1;
  }

  private logRequest(
    model: string,
    email: string,
    endpoint: string,
    startTime: number,
    success: boolean,
    stream: boolean,
    usage?: { input_tokens?: number; output_tokens?: number },
    error?: { message?: string; status?: number },
    clientIp?: string
  ): void {
    this.updateStats(model, email, success);
    
    if (this.logger) {
      this.logger.logProxyRequest({
        timestamp: startTime,
        account_email: email,
        model,
        endpoint,
        request_tokens: usage?.input_tokens,
        response_tokens: usage?.output_tokens,
        total_tokens: usage?.input_tokens && usage?.output_tokens 
          ? usage.input_tokens + usage.output_tokens 
          : undefined,
        duration_ms: Date.now() - startTime,
        status: success ? 'success' : (error?.status === 429 ? 'rate_limited' : 'error'),
        error_message: error?.message,
        http_status: error?.status,
        source: 'proxy',
        stream,
        client_ip: clientIp,
      });
    }
    
    if (error?.status === 429 && this.rateLimitNotifier) {
      this.rateLimitNotifier.onRateLimited(email, model, undefined);
    }
  }

  async handleClaudeRequest(
    request: ClaudeRequest,
    res: Response,
    stream: boolean,
    clientIp?: string
  ): Promise<ClaudeResponse | void> {
    const startTime = Date.now();
    const tokenContext = await this.getTokenContext(request.model);
    const mappedModel = mapModel(request.model);
    
    const requestBody = generateClaudeRequestBody(
      request,
      tokenContext,
      this.config.systemInstruction
    );

    if (stream) {
      return this.handleClaudeStream(requestBody, tokenContext, request.model, res, startTime, clientIp);
    }

    try {
      const result = await this.client.generateNoStream(requestBody, tokenContext.accessToken);
      this.logRequest(
        mappedModel, tokenContext.email, '/v1/messages', startTime, true, false,
        { input_tokens: result.usage?.prompt_tokens, output_tokens: result.usage?.completion_tokens },
        undefined, clientIp
      );
      return this.formatClaudeResponse(result, request.model);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      this.logRequest(
        mappedModel, tokenContext.email, '/v1/messages', startTime, false, false,
        undefined,
        { message: apiError?.message, status: apiError?.status },
        clientIp
      );
      throw error;
    }
  }

  private async handleClaudeStream(
    requestBody: ReturnType<typeof generateClaudeRequestBody>,
    tokenContext: TokenContext,
    originalModel: string,
    res: Response,
    startTime: number,
    clientIp?: string
  ): Promise<void> {
    const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const contentBlocks: ClaudeResponseContentBlock[] = [];
    let currentBlockIndex = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    setupSSEHeaders(res);
    const heartbeat = createHeartbeat(res);

    const sendEvent = (event: ClaudeStreamEvent) => {
      res.write(formatClaudeSSE(event));
    };

    sendEvent({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: originalModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    let hasStartedTextBlock = false;
    let hasStartedThinkingBlock = false;

    try {
      await this.client.generateStream(
        requestBody,
        tokenContext.accessToken,
        (data: StreamCallbackData) => {
          switch (data.type) {
            case 'content':
              if (!hasStartedTextBlock) {
                sendEvent({
                  type: 'content_block_start',
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' },
                });
                hasStartedTextBlock = true;
              }
              if (data.content) {
                sendEvent({
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'text_delta', text: data.content },
                });
              }
              break;

            case 'reasoning':
              if (!hasStartedThinkingBlock) {
                if (hasStartedTextBlock) {
                  sendEvent({ type: 'content_block_stop', index: currentBlockIndex });
                  currentBlockIndex++;
                  hasStartedTextBlock = false;
                }
                sendEvent({
                  type: 'content_block_start',
                  index: currentBlockIndex,
                  content_block: { type: 'thinking' },
                });
                hasStartedThinkingBlock = true;
              }
              if (data.reasoning_content) {
                sendEvent({
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'thinking_delta', thinking: data.reasoning_content },
                });
              }
              if (data.thoughtSignature) {
                sendEvent({
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'signature_delta', signature: data.thoughtSignature },
                });
              }
              break;

            case 'tool_calls':
              if (hasStartedTextBlock || hasStartedThinkingBlock) {
                sendEvent({ type: 'content_block_stop', index: currentBlockIndex });
                currentBlockIndex++;
                hasStartedTextBlock = false;
                hasStartedThinkingBlock = false;
              }
              if (data.tool_calls) {
                for (const tc of data.tool_calls) {
                  const originalName = getOriginalToolName(requestBody.model, tc.function.name) || tc.function.name;
                  sendEvent({
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: tc.id,
                      name: originalName,
                      input: safeParseToolArgs(tc.function.arguments),
                    },
                  });
                  sendEvent({ type: 'content_block_stop', index: currentBlockIndex });
                  contentBlocks.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: originalName,
                    input: safeParseToolArgs(tc.function.arguments),
                  });
                  currentBlockIndex++;
                }
              }
              break;

            case 'usage':
              if (data.usage) {
                inputTokens = data.usage.prompt_tokens;
                outputTokens = data.usage.completion_tokens;
              }
              break;
          }
        }
      );

      if (hasStartedTextBlock || hasStartedThinkingBlock) {
        sendEvent({ type: 'content_block_stop', index: currentBlockIndex });
      }

      sendEvent({
        type: 'message_delta',
        delta: { type: 'message_delta' },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });

      sendEvent({ type: 'message_stop' });
      this.logRequest(
        requestBody.model, tokenContext.email, '/v1/messages', startTime, true, true,
        { input_tokens: inputTokens, output_tokens: outputTokens },
        undefined, clientIp
      );
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      this.logRequest(
        requestBody.model, tokenContext.email, '/v1/messages', startTime, false, true,
        { input_tokens: inputTokens, output_tokens: outputTokens },
        { message: apiError?.message || (error instanceof Error ? error.message : 'Unknown error'), status: apiError?.status },
        clientIp
      );
      sendEvent({
        type: 'error',
        delta: { type: 'error_delta', text: error instanceof Error ? error.message : 'Unknown error' },
      } as unknown as ClaudeStreamEvent);
    } finally {
      heartbeat.stop();
      res.end();
    }
  }

  private formatClaudeResponse(result: GenerationResult, model: string): ClaudeResponse {
    const content: ClaudeResponseContentBlock[] = [];

    if (result.reasoningContent) {
      content.push({
        type: 'thinking',
        thinking: result.reasoningContent,
        signature: result.reasoningSignature || undefined,
      });
    }

    if (result.content) {
      content.push({
        type: 'text',
        text: result.content,
      });
    }

    for (const tc of result.toolCalls) {
      const originalName = getOriginalToolName(model, tc.function.name) || tc.function.name;
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: originalName,
        input: safeParseToolArgs(tc.function.arguments),
      });
    }

    const hasToolUse = result.toolCalls.length > 0;

    return {
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      content,
      model,
      stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: result.usage?.prompt_tokens || 0,
        output_tokens: result.usage?.completion_tokens || 0,
      },
    };
  }

  async handleOpenAIRequest(
    request: OpenAIRequest,
    res: Response,
    stream: boolean,
    clientIp?: string
  ): Promise<OpenAIResponse | void> {
    const startTime = Date.now();
    const tokenContext = await this.getTokenContext(request.model);
    const mappedModel = mapModel(request.model);
    
    const requestBody = generateOpenAIRequestBody(
      request,
      tokenContext,
      this.config.systemInstruction
    );

    if (stream) {
      return this.handleOpenAIStream(requestBody, tokenContext, request.model, res, startTime, clientIp);
    }

    try {
      const result = await this.client.generateNoStream(requestBody, tokenContext.accessToken);
      this.logRequest(
        mappedModel, tokenContext.email, '/v1/chat/completions', startTime, true, false,
        { input_tokens: result.usage?.prompt_tokens, output_tokens: result.usage?.completion_tokens },
        undefined, clientIp
      );
      return this.formatOpenAIResponse(result, request.model);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      this.logRequest(
        mappedModel, tokenContext.email, '/v1/chat/completions', startTime, false, false,
        undefined,
        { message: apiError?.message, status: apiError?.status },
        clientIp
      );
      throw error;
    }
  }

  private async handleOpenAIStream(
    requestBody: ReturnType<typeof generateOpenAIRequestBody>,
    tokenContext: TokenContext,
    originalModel: string,
    res: Response,
    startTime: number,
    clientIp?: string
  ): Promise<void> {
    const completionId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    setupSSEHeaders(res);
    const heartbeat = createHeartbeat(res);

    const sendChunk = (chunk: OpenAIStreamChunk) => {
      res.write(formatOpenAISSE(chunk));
    };

    sendChunk({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: originalModel,
      choices: [{
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      }],
    });

    try {
      await this.client.generateStream(
        requestBody,
        tokenContext.accessToken,
        (data: StreamCallbackData) => {
          switch (data.type) {
            case 'content':
              if (data.content) {
                sendChunk({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: originalModel,
                  choices: [{
                    index: 0,
                    delta: { content: data.content },
                    finish_reason: null,
                  }],
                });
              }
              break;

            case 'reasoning':
              if (data.reasoning_content) {
                sendChunk({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: originalModel,
                  choices: [{
                    index: 0,
                    delta: { reasoning_content: data.reasoning_content },
                    finish_reason: null,
                  }],
                });
              }
              break;

            case 'tool_calls':
              if (data.tool_calls) {
                for (let i = 0; i < data.tool_calls.length; i++) {
                  const tc = data.tool_calls[i];
                  const originalName = getOriginalToolName(requestBody.model, tc.function.name) || tc.function.name;
                  sendChunk({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model: originalModel,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index: i,
                          id: tc.id,
                          type: 'function',
                          function: {
                            name: originalName,
                            arguments: tc.function.arguments,
                          },
                        }],
                      },
                      finish_reason: null,
                    }],
                  });
                }
              }
              break;

            case 'usage':
              break;
          }
        }
      );

      sendChunk({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: originalModel,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
      });

      res.write(formatOpenAIDone());
      this.logRequest(
        requestBody.model, tokenContext.email, '/v1/chat/completions', startTime, true, true,
        undefined, undefined, clientIp
      );
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      this.logRequest(
        requestBody.model, tokenContext.email, '/v1/chat/completions', startTime, false, true,
        undefined,
        { message: apiError?.message || (error instanceof Error ? error.message : 'Unknown error'), status: apiError?.status },
        clientIp
      );
      const errorChunk = {
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          type: 'server_error',
        },
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    } finally {
      heartbeat.stop();
      res.end();
    }
  }

  private formatOpenAIResponse(result: GenerationResult, model: string): OpenAIResponse {
    const toolCalls = result.toolCalls.map(tc => {
      const originalName = getOriginalToolName(model, tc.function.name) || tc.function.name;
      return {
        id: tc.id,
        type: 'function' as const,
        function: {
          name: originalName,
          arguments: JSON.stringify(safeParseToolArgs(tc.function.arguments)),
        },
      };
    });

    return {
      id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: result.content || null,
          reasoning_content: result.reasoningContent || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      }],
      usage: result.usage ? {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        total_tokens: result.usage.total_tokens,
      } : undefined,
    };
  }

  async getModels(): Promise<{ id: string; object: string; created: number; owned_by: string }[]> {
    const tokenContext = await this.getTokenContext();
    const models = await this.client.getAvailableModels(tokenContext.accessToken);
    const created = Math.floor(Date.now() / 1000);
    
    return models.map(id => ({
      id,
      object: 'model',
      created,
      owned_by: 'google',
    }));
  }
}

export { ApiError };
export * from './types.js';
export { 
  generateClaudeRequestBody,
  generateOpenAIRequestBody,
  generateSessionId,
  mapModel,
  isThinkingEnabled,
  sanitizeToolName,
  getOriginalToolName,
} from './converter.js';
export type { TokenContext } from './converter.js';
export * from './streaming.js';
export * from './client.js';
