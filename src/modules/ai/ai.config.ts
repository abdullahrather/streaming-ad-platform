/**
 * src/modules/ai/ai.config.ts
 *
 * The assistant is optional. It turns on when whoever runs the platform sets
 * AI_PROVIDER, with their own key where the provider needs one. Keys stay on the
 * server and are never sent to the browser.
 */
import { env } from '@/config/env';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import type { AiProvider } from './providers/types';

export const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  local: 'qwen2.5:7b',
} as const;

const LOCAL_URL = 'http://localhost:11434/v1';
const OPENAI_URL = 'https://api.openai.com/v1';

export interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string;
  /** Why it's off, in words the dashboard can show. */
  reason: string;
}

let override: AiProvider | null | undefined;

/** Tests swap in a provider pointed at a local stub server. */
export const setAiProvider = (provider: AiProvider | null | undefined): void => {
  override = provider;
};

let cached: { provider: AiProvider | null; status: AiStatus } | null = null;

const build = (): { provider: AiProvider | null; status: AiStatus } => {
  const off = (reason: string): { provider: null; status: AiStatus } => ({
    provider: null,
    status: { enabled: false, provider: env.AI_PROVIDER, model: '', reason },
  });

  switch (env.AI_PROVIDER) {
    case '':
      return off('The AI assistant is off. Set AI_PROVIDER in .env to turn it on.');
    case 'anthropic': {
      if (!env.AI_API_KEY) return off('AI_PROVIDER is anthropic, but AI_API_KEY is not set.');
      const model = env.AI_MODEL || DEFAULT_MODELS.anthropic;
      return {
        provider: new AnthropicProvider(model, {
          apiKey: env.AI_API_KEY,
          ...(env.AI_BASE_URL ? { baseURL: env.AI_BASE_URL } : {}),
          timeoutMs: env.AI_TIMEOUT_MS,
        }),
        status: { enabled: true, provider: 'anthropic', model, reason: '' },
      };
    }
    case 'openai': {
      if (!env.AI_API_KEY) return off('AI_PROVIDER is openai, but AI_API_KEY is not set.');
      if (!env.AI_MODEL) return off('AI_PROVIDER is openai, but AI_MODEL is not set.');
      return {
        provider: new OpenAiCompatibleProvider('openai', env.AI_MODEL, {
          apiKey: env.AI_API_KEY,
          baseURL: env.AI_BASE_URL || OPENAI_URL,
          timeoutMs: env.AI_TIMEOUT_MS,
        }),
        status: { enabled: true, provider: 'openai', model: env.AI_MODEL, reason: '' },
      };
    }
    case 'local': {
      const model = env.AI_MODEL || DEFAULT_MODELS.local;
      return {
        provider: new OpenAiCompatibleProvider('local', model, {
          apiKey: env.AI_API_KEY,
          baseURL: env.AI_BASE_URL || LOCAL_URL,
          // Local models run on this machine and can be slower than an API.
          timeoutMs: Math.max(env.AI_TIMEOUT_MS, 180_000),
        }),
        status: { enabled: true, provider: 'local', model, reason: '' },
      };
    }
  }
};

export const aiProvider = (): AiProvider | null => {
  if (override !== undefined) return override;
  cached ??= build();
  return cached.provider;
};

export const aiStatus = (): AiStatus => {
  if (override !== undefined) {
    return override
      ? { enabled: true, provider: override.name, model: override.model, reason: '' }
      : { enabled: false, provider: '', model: '', reason: 'The AI assistant is off.' };
  }
  cached ??= build();
  return cached.status;
};
