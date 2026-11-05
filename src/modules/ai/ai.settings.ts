/**
 * src/modules/ai/ai.settings.ts
 *
 * Turning the assistant on from the dashboard. Platform admins choose a provider,
 * paste a key (stored encrypted, shown only as its last four characters), test the
 * connection, and for local models check Ollama and download a model through it.
 *
 * Installing Ollama itself stays a manual step: a web page that runs installers on
 * the server would be a far bigger risk than it's worth.
 */
import type { AiSetting } from '@prisma/client';
import { z } from 'zod';
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { decrypt, encrypt } from '@/lib/security';
import { AppError } from '@/middleware/errorHandler';
import {
  aiStatus,
  buildProvider,
  LOCAL_URL,
  PROVIDERS,
  refreshAiSettings,
  type AiConfig,
  type AiStatus,
} from './ai.config';

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,120}$/;

const urlOrEmpty = z
  .string()
  .trim()
  .max(300)
  .refine((value) => value === '' || /^https?:\/\/[^\s]+$/.test(value), {
    error: 'Use a full address starting with http:// or https://.',
  });

export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(PROVIDERS, {
    error: 'Choose Claude, an OpenAI-compatible API, or a local model.',
  }),
  model: z
    .string()
    .trim()
    .max(120)
    .refine((value) => value === '' || MODEL_NAME.test(value), {
      error: 'That model name has characters it can’t use.',
    })
    .default(''),
  baseUrl: urlOrEmpty.default(''),
  /** Empty keeps the saved key, if the provider is unchanged. */
  apiKey: z.string().trim().max(500).default(''),
});
export type AiSettingsDto = z.infer<typeof aiSettingsSchema>;

export const pullSchema = z.object({
  model: z
    .string()
    .trim()
    .regex(MODEL_NAME, { error: 'That model name has characters it can’t use.' }),
  baseUrl: urlOrEmpty.default(''),
});

export interface AiSettingsView {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  /** The key's last four characters, so an admin can tell which one is saved. */
  keyHint: string;
  /** True when AI_PROVIDER in .env decides, and the dashboard can't change it. */
  lockedByEnv: boolean;
  updatedAt: string | null;
  status: AiStatus;
}

const hint = (key: string): string => (key.length > 8 ? `…${key.slice(-4)}` : key ? '…' : '');

const savedRow = (): Promise<AiSetting | null> =>
  prisma.aiSetting.findUnique({ where: { id: 'default' } });

/** The saved key, decrypted, or '' if there is none or it can't be read. */
const savedKey = (encrypted: string | null | undefined): string => {
  if (!encrypted) return '';
  try {
    return decrypt(encrypted);
  } catch {
    // ENCRYPTION_KEY changed since it was saved. The admin pastes it again.
    return '';
  }
};

const assertNotLocked = (): void => {
  if (env.DEMO_MODE) throw new AppError(403, 'AI settings can’t be changed in the public demo.');
  if (env.AI_PROVIDER) {
    throw new AppError(409, 'AI_PROVIDER is set in .env, which takes priority. Change it there.');
  }
};

/** What the form needs to fill in an unchanged field: the provider's saved key. */
const keyFor = async (dto: AiSettingsDto): Promise<string> => {
  if (dto.apiKey) return dto.apiKey;
  const row = await savedRow();
  return row?.provider === dto.provider ? savedKey(row.apiKey) : '';
};

/** Short, plain reasons for a failed test. Never includes the key. */
export const describeError = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const status =
    (error as { status?: number } | null)?.status ?? Number(/returned (\d{3})/.exec(text)?.[1]);
  if (status === 401 || status === 403) return 'The key was refused. Check it and try again.';
  if (status === 404) return 'The model or address wasn’t found. Check the model name.';
  if (status === 429) return 'The provider is rate-limiting this key, or it has run out of credit.';
  if (/took too long|timed? ?out|abort/i.test(text)) return 'No answer in time. Try again.';
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|Connection error/i.test(text)) {
    return 'Couldn’t reach the server at that address. Is it running?';
  }
  return `The provider returned an error: ${text.slice(0, 200)}`;
};

const PING_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

/** Where Ollama's own API lives, from its OpenAI-compatible address. */
const ollamaRoot = (baseUrl: string): string =>
  (baseUrl || LOCAL_URL).replace(/\/+$/, '').replace(/\/v1$/, '');

interface PullJob {
  model: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error: string;
}

/** Downloads in progress or just finished, by model. One process, so kept in memory. */
const pulls = new Map<string, PullJob>();

class AiSettingsService {
  async view(): Promise<AiSettingsView> {
    const row = await savedRow();
    return {
      enabled: row?.enabled ?? false,
      provider: row?.provider ?? '',
      model: row?.model ?? '',
      baseUrl: row?.baseUrl ?? '',
      keyHint: hint(savedKey(row?.apiKey)),
      lockedByEnv: env.AI_PROVIDER !== '',
      updatedAt: row?.updatedAt.toISOString() ?? null,
      status: aiStatus(),
    };
  }

  async save(actorId: string, dto: AiSettingsDto): Promise<AiSettingsView> {
    assertNotLocked();
    const apiKey = await keyFor(dto);
    if (dto.enabled) {
      const built = buildProvider({ ...dto, apiKey });
      if (!built.provider) throw new AppError(422, built.reason);
    }
    const data = {
      enabled: dto.enabled,
      provider: dto.provider,
      model: dto.model,
      baseUrl: dto.baseUrl,
      apiKey: apiKey ? encrypt(apiKey) : null,
      updatedById: actorId,
    };
    await prisma.aiSetting.upsert({ where: { id: 'default' }, create: data, update: data });
    await refreshAiSettings();
    return this.view();
  }

  /** Sends a tiny request with these settings (or the saved ones) and reports what happened. */
  async test(dto: AiSettingsDto): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const config: AiConfig = { ...dto, apiKey: await keyFor(dto) };
    const built = buildProvider(config);
    if (!built.provider) return { ok: false, latencyMs: 0, message: built.reason };

    const started = Date.now();
    // A local model may need to load into memory first, which takes a while.
    const limit = config.provider === 'local' ? 120_000 : 30_000;
    try {
      await Promise.race([
        built.provider.json({
          system: 'This is a connection check. Reply with {"ok": true}.',
          prompt: 'Connection check.',
          schema: PING_SCHEMA,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('The model took too long.')), limit),
        ),
      ]);
      const latencyMs = Date.now() - started;
      return {
        ok: true,
        latencyMs,
        message: `Live: ${built.model} answered in ${(latencyMs / 1000).toFixed(1)} s.`,
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, message: describeError(error) };
    }
  }

  /** Whether Ollama is running at that address, and which models it already has. */
  async localStatus(baseUrl: string): Promise<{
    running: boolean;
    version: string;
    models: Array<{ name: string; sizeBytes: number }>;
  }> {
    const root = ollamaRoot(baseUrl);
    try {
      const [version, tags] = await Promise.all([
        fetch(`${root}/api/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()),
        fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()),
      ]);
      const models = (
        (tags as { models?: Array<{ name: string; size: number }> }).models ?? []
      ).map(({ name, size }) => ({ name, sizeBytes: size }));
      return {
        running: true,
        version: String((version as { version?: string }).version ?? ''),
        models,
      };
    } catch {
      return { running: false, version: '', models: [] };
    }
  }

  /** Starts downloading a model through Ollama. Progress is read with pullStatus. */
  startPull(model: string, baseUrl: string): PullJob {
    assertNotLocked();
    const running = pulls.get(model);
    if (running && !running.done) return running;

    const job: PullJob = {
      model,
      status: 'starting',
      completed: 0,
      total: 0,
      done: false,
      error: '',
    };
    pulls.set(model, job);
    void this.runPull(job, ollamaRoot(baseUrl));
    return job;
  }

  pullStatus(model: string): PullJob | null {
    return pulls.get(model) ?? null;
  }

  private async runPull(job: PullJob, root: string): Promise<void> {
    try {
      const response = await fetch(`${root}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: job.model, stream: true }),
      });
      if (!response.ok || !response.body) throw new Error(`Ollama returned ${response.status}`);

      // Ollama streams one JSON object per line: status, and bytes done of total.
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines.filter(Boolean)) {
          const update = JSON.parse(line) as {
            status?: string;
            completed?: number;
            total?: number;
            error?: string;
          };
          if (update.error) throw new Error(update.error);
          job.status = update.status ?? job.status;
          if (update.total) job.total = update.total;
          if (update.completed) job.completed = update.completed;
        }
      }
      if (job.status !== 'success') throw new Error('The download stopped before it finished.');
      job.done = true;
    } catch (error) {
      job.error = /ECONNREFUSED|fetch failed/i.test(String(error))
        ? 'Couldn’t reach Ollama. Is it running?'
        : String(error instanceof Error ? error.message : error).slice(0, 200);
      job.done = true;
    }
  }
}

export const aiSettingsService = new AiSettingsService();
