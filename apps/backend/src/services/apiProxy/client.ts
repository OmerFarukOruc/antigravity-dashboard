import { AntigravityRequest, ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_HEADERS, StreamCallbackData } from './types.js';
import { getLineBuffer, releaseLineBuffer, parseAndEmitStreamChunk, createStreamState } from './streaming.js';

interface AntigravityClientConfig {
  timeout?: number;
  maxRetries?: number;
  baseRetryDelay?: number;
}

interface RetryableError {
  status: number;
  retryAfter?: number;
  quotaResetTime?: Date;
}

function parseRetryInfo(errorText: string): RetryableError | null {
  try {
    const parsed = JSON.parse(errorText);
    const error = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
    if (!error) return null;
    
    const details = error.details || [];
    let retryAfter: number | undefined;
    let quotaResetTime: Date | undefined;
    
    for (const detail of details) {
      if (detail['@type']?.includes('RetryInfo') && detail.retryDelay) {
        const match = detail.retryDelay.match(/^(\d+(?:\.\d+)?)/);
        if (match) retryAfter = Math.ceil(parseFloat(match[1]));
      }
      if (detail.metadata?.quotaResetTimeStamp) {
        quotaResetTime = new Date(detail.metadata.quotaResetTimeStamp);
      }
    }
    
    return { status: error.code || 429, retryAfter, quotaResetTime };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface AntigravityResponsePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  };
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface AntigravityNonStreamResponse {
  response?: {
    candidates?: Array<{
      content?: {
        parts?: AntigravityResponsePart[];
      };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
}

export interface GenerationResult {
  content: string;
  reasoningContent: string | null;
  reasoningSignature: string | null;
  toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    thoughtSignature?: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export class AntigravityClient {
  private config: Required<AntigravityClientConfig>;

  constructor(config: AntigravityClientConfig = {}) {
    this.config = {
      timeout: config.timeout ?? 120000,
      maxRetries: config.maxRetries ?? 3,
      baseRetryDelay: config.baseRetryDelay ?? 1000,
    };
  }

  private buildHeaders(accessToken: string): Record<string, string> {
    return {
      ...ANTIGRAVITY_HEADERS,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
    };
  }

  private calculateRetryDelay(attempt: number, retryAfter?: number): number {
    if (retryAfter && retryAfter < 60) {
      return retryAfter * 1000;
    }
    return Math.min(this.config.baseRetryDelay * Math.pow(2, attempt), 30000);
  }

  private isRetryable(status: number): boolean {
    return status === 429 || status === 503 || status === 502 || status === 500;
  }

  async generateStream(
    requestBody: AntigravityRequest,
    accessToken: string,
    callback: (data: StreamCallbackData) => void
  ): Promise<void> {
    const headers = this.buildHeaders(accessToken);
    let lastError: ApiError | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const state = createStreamState(
        requestBody.request.sessionId,
        requestBody.model
      );
      const lineBuffer = getLineBuffer();
      let bufferReleased = false;
      
      const safeReleaseBuffer = () => {
        if (!bufferReleased) {
          releaseLineBuffer(lineBuffer);
          bufferReleased = true;
        }
      };

      try {
        const response = await fetch(ANTIGRAVITY_ENDPOINTS.stream, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(this.config.timeout),
        });

        if (!response.ok) {
          const errorText = await response.text();
          const retryInfo = parseRetryInfo(errorText);
          
          if (this.isRetryable(response.status) && attempt < this.config.maxRetries) {
            const delay = this.calculateRetryDelay(attempt, retryInfo?.retryAfter);
            console.log(`[AntigravityClient] Stream ${response.status} error, retrying in ${delay}ms (attempt ${attempt + 1}/${this.config.maxRetries})`);
            await sleep(delay);
            continue;
          }
          
          throw new ApiError(
            `API request failed (${response.status}): ${errorText}`,
            response.status,
            errorText
          );
        }

        if (!response.body) {
          throw new ApiError('No response body', 500, 'No response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = lineBuffer.append(chunk);
            for (const line of lines) {
              parseAndEmitStreamChunk(line, state, callback);
            }
          }
          return;
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        if (error instanceof ApiError) {
          lastError = error;
          if (!this.isRetryable(error.status) || attempt >= this.config.maxRetries) {
            throw error;
          }
          const delay = this.calculateRetryDelay(attempt, error.retryAfter);
          console.log(`[AntigravityClient] Stream error ${error.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${this.config.maxRetries})`);
          await sleep(delay);
          continue;
        } else {
          throw error;
        }
      } finally {
        safeReleaseBuffer();
      }
    }

    throw lastError || new ApiError('Max retries exceeded for stream', 503, 'Max retries exceeded');
  }

  async generateNoStream(
    requestBody: AntigravityRequest,
    accessToken: string
  ): Promise<GenerationResult> {
    const headers = this.buildHeaders(accessToken);
    let lastError: ApiError | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(ANTIGRAVITY_ENDPOINTS.noStream, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(this.config.timeout),
        });

        if (!response.ok) {
          const errorText = await response.text();
          const retryInfo = parseRetryInfo(errorText);
          
          if (this.isRetryable(response.status) && attempt < this.config.maxRetries) {
            const delay = this.calculateRetryDelay(attempt, retryInfo?.retryAfter);
            console.log(`[AntigravityClient] ${response.status} error, retrying in ${delay}ms (attempt ${attempt + 1}/${this.config.maxRetries})`);
            await sleep(delay);
            continue;
          }
          
          throw new ApiError(
            `API request failed (${response.status}): ${errorText}`,
            response.status,
            errorText
          );
        }

        const data = await response.json() as AntigravityNonStreamResponse;
        return this.parseNonStreamResponse(data, requestBody.model);
      } catch (error) {
        if (error instanceof ApiError) {
          lastError = error;
          if (!this.isRetryable(error.status) || attempt >= this.config.maxRetries) {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }

    throw lastError || new ApiError('Max retries exceeded', 503, 'Max retries exceeded');
  }

  private parseNonStreamResponse(
    data: AntigravityNonStreamResponse,
    model: string
  ): GenerationResult {
    const parts = data.response?.candidates?.[0]?.content?.parts || [];
    let content = '';
    let reasoningContent = '';
    let reasoningSignature: string | null = null;
    let lastSeenSignature: string | null = null;
    const toolCalls: GenerationResult['toolCalls'] = [];

    for (const part of parts) {
      if (part.thoughtSignature) {
        lastSeenSignature = part.thoughtSignature;
      }
      if (part.thought === true) {
        reasoningContent += part.text || '';
        if (part.thoughtSignature) {
          reasoningSignature = part.thoughtSignature;
        }
      } else if (part.text !== undefined) {
        content += part.text;
      } else if (part.functionCall) {
        const toolCall: GenerationResult['toolCalls'][0] = {
          id: part.functionCall.id,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        };
        const sig = part.thoughtSignature || lastSeenSignature;
        if (sig) toolCall.thoughtSignature = sig;
        toolCalls.push(toolCall);
      }
    }

    if (!reasoningSignature && lastSeenSignature) {
      reasoningSignature = lastSeenSignature;
    }

    const usage = data.response?.usageMetadata;
    const usageData = usage ? {
      prompt_tokens: usage.promptTokenCount || 0,
      completion_tokens: usage.candidatesTokenCount || 0,
      total_tokens: usage.totalTokenCount || 0,
    } : null;

    return {
      content,
      reasoningContent: reasoningContent || null,
      reasoningSignature,
      toolCalls,
      usage: usageData,
    };
  }

  async getAvailableModels(accessToken: string): Promise<string[]> {
    const headers = this.buildHeaders(accessToken);

    const response = await fetch(ANTIGRAVITY_ENDPOINTS.models, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error('[AntigravityClient] Failed to fetch models:', response.status);
      return DEFAULT_MODELS;
    }

    const data = await response.json() as { models?: Record<string, unknown> };
    if (!data.models) return DEFAULT_MODELS;

    return Object.keys(data.models);
  }
}

export class ApiError extends Error {
  status: number;
  body: string;
  quotaResetTime?: Date;
  retryAfter?: number;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    
    const retryInfo = parseRetryInfo(body);
    if (retryInfo) {
      this.quotaResetTime = retryInfo.quotaResetTime;
      this.retryAfter = retryInfo.retryAfter;
    }
  }
}

const DEFAULT_MODELS = [
  'claude-opus-4-5',
  'claude-opus-4-5-thinking',
  'claude-sonnet-4-5-thinking',
  'claude-sonnet-4-5',
  'gemini-3-pro-high',
  'gemini-2.5-flash-lite',
  'gemini-3-pro-image',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3-pro-low',
];
