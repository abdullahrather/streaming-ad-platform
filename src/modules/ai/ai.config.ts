/**
 * src/modules/ai/ai.config.ts
 *
 * The assistant is optional. A platform admin turns it on from the dashboard, or
 * whoever runs the platform sets AI_PROVIDER in .env, which takes priority. Keys
 * stay on the server: stored encrypted, and never sent to the browser.
 */
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/security';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import type { AiProvider } from './providers/types';
import { logger } from '@/lib/logger';

export const PROVIDERS = ['anthropic', 'openai', 'local'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  local: 'qwen2.5:7b',
} as const;

export const LOCAL_URL = 'http://localhost:11434/v1';
const OPENAI_URL = 'https://api.openai.com/v1';

export interface AiConfig {
  provider: ProviderName;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string;
  /** Why it's off, in words the dashboard can show. */
  reason: string;
  /** Where the settings come from. .env can't be changed from the dashboard. */
  source: 'env' | 'dashboard' | '';
}

type Built = { provider: AiProvider; model: string } | { provider: null; reason: string };

/** A provider for these settings, or the reason they can't work. */
export const buildProvider = (config: AiConfig): Built => {
  switch (config.provider) {
    case 'anthropic': {
      if (!config.apiKey) return { provider: null, reason: 'Claude needs an API key.' };
      const model = config.model || DEFAULT_MODELS.anthropic;
      return {
        model,
        provider: new AnthropicProvider(model, {
          apiKey: config.apiKey,
          ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
          timeoutMs: env.AI_TIMEOUT_MS,
        }),
      };
    }
    case 'openai': {
      if (!config.apiKey)
        return { provider: null, reason: 'An OpenAI-compatible API needs a key.' };
      if (!config.model)
        return { provider: null, reason: 'An OpenAI-compatible API needs a model.' };
      return {
        model: config.model,
        provider: new OpenAiCompatibleProvider('openai', config.model, {
          apiKey: config.apiKey,
          baseURL: config.baseUrl || OPENAI_URL,
          timeoutMs: env.AI_TIMEOUT_MS,
        }),
      };
    }
    case 'local': {
      const model = config.model || DEFAULT_MODELS.local;
      return {
        model,
        provider: new OpenAiCompatibleProvider('local', model, {
          apiKey: config.apiKey,
          baseURL: config.baseUrl || LOCAL_URL,
          // Local models run on this machine and can be slower than an API.
          timeoutMs: Math.max(env.AI_TIMEOUT_MS, 180_000),
        }),
      };
    }
  }
};

let override: AiProvider | null | undefined;

/** Tests swap in a provider pointed at a local stub server. */
export const setAiProvider = (provider: AiProvider | null | undefined): void => {
  override = provider;
};

/** The dashboard's saved settings, as last read from the database. */
let saved: AiConfig | null = null;
let cached: { provider: AiProvider | null; status: AiStatus } | null = null;

const resolve = (): { provider: AiProvider | null; status: AiStatus } => {
  const fromEnv = env.AI_PROVIDER !== '';
  const config: AiConfig | null = fromEnv
    ? {
        provider: env.AI_PROVIDER as ProviderName,
        apiKey: env.AI_API_KEY,
        model: env.AI_MODEL,
        baseUrl: env.AI_BASE_URL,
      }
    : saved;
  const source = fromEnv ? 'env' : config ? 'dashboard' : '';

  if (!config) {
    return {
      provider: null,
      status: {
        enabled: false,
        provider: '',
        model: '',
        source,
        reason:
          'The AI assistant is off. A platform admin can turn it on here, or set AI_PROVIDER in .env.',
      },
    };
  }

  const built = buildProvider(config);
  return built.provider
    ? {
        provider: built.provider,
        status: {
          enabled: true,
          provider: config.provider,
          model: built.model,
          reason: '',
          source,
        },
      }
    : {
        provider: null,
        status: {
          enabled: false,
          provider: config.provider,
          model: '',
          source,
          reason: `The AI assistant is off: ${built.reason}`,
        },
      };
};

/**
 * Reads the dashboard's settings again. Runs at startup, after a save, and every
 * 30 seconds, so every API process picks up a change. A failed read keeps the last
 * settings rather than switching the assistant off.
 */
export const refreshAiSettings = async (): Promise<void> => {
  try {
    const row = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
    saved =
      row?.enabled && (PROVIDERS as readonly string[]).includes(row.provider)
        ? {
            provider: row.provider as ProviderName,
            apiKey: row.apiKey ? decrypt(row.apiKey) : '',
            model: row.model,
            baseUrl: row.baseUrl,
          }
        : null;
    cached = null;
  } catch (error) {
    logger.error({ err: String(error) }, 'Could not read the AI settings');
  }
};

export const aiProvider = (): AiProvider | null => {
  if (override !== undefined) return override;
  cached ??= resolve();
  return cached.provider;
};

export const aiStatus = (): AiStatus => {
  if (override !== undefined) {
    return override
      ? { enabled: true, provider: override.name, model: override.model, reason: '', source: 'env' }
      : {
          enabled: false,
          provider: '',
          model: '',
          reason: 'The AI assistant is off.',
          source: '',
        };
  }
  cached ??= resolve();
  return cached.status;
};
