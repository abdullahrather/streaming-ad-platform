/**
 * tests/ai-settings.test.ts
 *
 * Turning the assistant on from the dashboard: admin-only access, the key stored
 * encrypted and never returned, .env taking priority, the connection test, and the
 * local Ollama helpers. Providers are local stand-in servers, so nothing is billed.
 */
import request from 'supertest';
import { Role } from '@prisma/client';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { aiProvider, refreshAiSettings, setAiProvider } from '@/modules/ai/ai.config';
import {
  claudeJson,
  startClaudeStub,
  startOllamaStub,
  type OllamaStub,
  type Stub,
} from './helpers/ai-stub';
import { clearDatabase, createTestUser, testPrisma } from './helpers/db';

const app = createApp();
const KEY = 'sk-ant-test-key-1234567890-wxyz';

const login = async (user: { email: string; password: string }): Promise<string> => {
  const res = await request(app).post('/auth/login').send(user);
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  return `Bearer ${(res.body as { data: { token: string } }).data.token}`;
};

const asAdmin = async (): Promise<string> =>
  login(await createTestUser({ email: 'admin@example.com', role: Role.ADMIN }));

/** Temporarily changes a setting, for tests of .env and demo behaviour. */
const withEnv = async (
  changes: Partial<Record<'AI_PROVIDER' | 'DEMO_MODE', unknown>>,
  run: () => Promise<void>,
): Promise<void> => {
  const settings = env as unknown as Record<string, unknown>;
  const before = Object.fromEntries(Object.keys(changes).map((key) => [key, settings[key]]));
  Object.assign(settings, changes);
  await refreshAiSettings();
  try {
    await run();
  } finally {
    Object.assign(settings, before);
    await refreshAiSettings();
  }
};

let claude: Stub;
let ollama: OllamaStub;

beforeAll(async () => {
  claude = await startClaudeStub();
  ollama = await startOllamaStub();
});

afterAll(async () => {
  await claude.close();
  await ollama.close();
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  await clearDatabase();
  setAiProvider(undefined);
  await refreshAiSettings();
  claude.requests.length = 0;
  claude.headers.length = 0;
  ollama.chats = 0;
});

describe('AI settings: access', () => {
  it('is for platform admins only', async () => {
    const owner = await login(await createTestUser());
    const body = { enabled: true, provider: 'local', baseUrl: `${ollama.url}/v1` };

    const read = await request(app).get('/ai/settings').set('Authorization', owner);
    const write = await request(app).put('/ai/settings').set('Authorization', owner).send(body);
    const test = await request(app)
      .post('/ai/settings/test')
      .set('Authorization', owner)
      .send(body);
    const local = await request(app).get('/ai/local/status').set('Authorization', owner);
    const pull = await request(app)
      .post('/ai/local/pull')
      .set('Authorization', owner)
      .send({ model: 'gemma4:12b' });

    expect([read.status, write.status, test.status, local.status, pull.status]).toEqual([
      403, 403, 403, 403, 403,
    ]);
    expect(await testPrisma.aiSetting.count()).toBe(0);
  });

  it('starts off and says who can turn it on', async () => {
    const res = await request(app)
      .get('/ai/status')
      .set('Authorization', await login(await createTestUser()));

    expect(res.body.data).toMatchObject({ enabled: false, source: '' });
    expect(res.body.data.reason).toContain('A platform admin can turn it on');
  });
});

describe('AI settings: saving', () => {
  it('turns a local model on without a restart', async () => {
    const auth = await asAdmin();

    const res = await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'local', model: 'qwen2.5:7b', baseUrl: `${ollama.url}/v1` });
    const status = await request(app).get('/ai/status').set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(status.body.data).toMatchObject({
      enabled: true,
      provider: 'local',
      model: 'qwen2.5:7b',
      source: 'dashboard',
    });
    // The assistant now answers through it.
    await aiProvider()?.json({ system: 's', prompt: 'p', schema: { type: 'object' } });
    expect(ollama.chats).toBe(1);
  });

  it('stores the key encrypted and never sends it back', async () => {
    const auth = await asAdmin();

    const saved = await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'anthropic', apiKey: KEY });
    const read = await request(app).get('/ai/settings').set('Authorization', auth);

    expect(saved.status).toBe(200);
    expect(read.body.data).toMatchObject({
      provider: 'anthropic',
      keyHint: '…wxyz',
      enabled: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    expect(JSON.stringify(read.body)).not.toContain(KEY);
    const row = await testPrisma.aiSetting.findUniqueOrThrow({ where: { id: 'default' } });
    expect(row.apiKey).toBeTruthy();
    expect(row.apiKey).not.toContain(KEY);
    const audit = await testPrisma.auditLog.findFirstOrThrow({
      where: { action: 'ai.settings.updated' },
    });
    expect(JSON.stringify(audit.details)).not.toContain(KEY);
    expect(audit.details).toMatchObject({ provider: 'anthropic', keyChanged: true });
  });

  it('keeps the saved key when the field is left empty, but not for another provider', async () => {
    const auth = await asAdmin();
    await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'anthropic', apiKey: KEY });

    const sameProvider = await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'anthropic', model: 'claude-sonnet-5-5' });
    const otherProvider = await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'openai', model: 'gpt-test' });

    expect(sameProvider.status).toBe(200);
    expect(sameProvider.body.data.keyHint).toBe('…wxyz');
    expect(otherProvider.status).toBe(422);
    expect(otherProvider.body.message).toContain('needs a key');
  });

  it('turns off and keeps the settings for next time', async () => {
    const auth = await asAdmin();
    await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'anthropic', apiKey: KEY });

    const off = await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: false, provider: 'anthropic' });

    expect(off.body.data).toMatchObject({ enabled: false, keyHint: '…wxyz' });
    expect(off.body.data.status.enabled).toBe(false);
    expect(aiProvider()).toBeNull();
  });

  it('rejects addresses and model names it can’t use', async () => {
    const auth = await asAdmin();

    const badUrl = await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'local', baseUrl: 'file:///etc/passwd' });
    const badModel = await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'local', model: 'qwen; rm -rf /' });

    expect(badUrl.status).toBe(422);
    expect(badModel.status).toBe(422);
  });

  it('leaves .env in charge when AI_PROVIDER is set there', async () => {
    const auth = await asAdmin();
    await withEnv({ AI_PROVIDER: 'local' }, async () => {
      const read = await request(app).get('/ai/settings').set('Authorization', auth);
      const write = await request(app)
        .put('/ai/settings')
        .set('Authorization', auth)
        .send({ enabled: false, provider: 'local' });

      expect(read.body.data.lockedByEnv).toBe(true);
      expect(read.body.data.status.source).toBe('env');
      expect(write.status).toBe(409);
    });
  });

  it('can’t be changed in the public demo', async () => {
    const auth = await asAdmin();
    await withEnv({ DEMO_MODE: true }, async () => {
      const write = await request(app)
        .put('/ai/settings')
        .set('Authorization', auth)
        .send({ enabled: true, provider: 'local' });
      const pull = await request(app)
        .post('/ai/local/pull')
        .set('Authorization', auth)
        .send({ model: 'gemma4:12b' });

      expect(write.status).toBe(403);
      expect(pull.status).toBe(403);
    });
  });
});

describe('AI settings: connection test', () => {
  it('reports live when the provider answers, before anything is saved', async () => {
    const auth = await asAdmin();
    claude.reply(claudeJson({ ok: true }));

    const res = await request(app)
      .post('/ai/settings/test')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'anthropic', apiKey: KEY, baseUrl: claude.url });

    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.message).toMatch(/^Live: claude-opus-5-5 answered in/);
    expect(claude.headers[0]?.['authorization']).toBe(`Bearer ${KEY}`);
    expect(await testPrisma.aiSetting.count()).toBe(0);
  });

  it('explains a refused key in plain words', async () => {
    const auth = await asAdmin();
    claude.reply(401);

    const res = await request(app)
      .post('/ai/settings/test')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'anthropic', apiKey: 'wrong-key', baseUrl: claude.url });

    expect(res.body.data).toMatchObject({
      ok: false,
      message: 'The key was refused. Check it and try again.',
    });
  });

  it('uses the saved key when the field is left empty', async () => {
    const auth = await asAdmin();
    await request(app)
      .put('/ai/settings')
      .set('Authorization', auth)
      .send({ enabled: false, provider: 'anthropic', apiKey: KEY, baseUrl: claude.url });
    claude.reply(claudeJson({ ok: true }));

    const res = await request(app)
      .post('/ai/settings/test')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'anthropic', baseUrl: claude.url });

    expect(res.body.data.ok).toBe(true);
    expect(claude.headers[0]?.['authorization']).toBe(`Bearer ${KEY}`);
  });

  it('says when a local server isn’t running', async () => {
    const auth = await asAdmin();

    const res = await request(app)
      .post('/ai/settings/test')
      .set('Authorization', auth)
      .send({ enabled: true, provider: 'local', baseUrl: 'http://127.0.0.1:9/v1' });

    expect(res.body.data).toMatchObject({
      ok: false,
      message: 'Couldn’t reach the server at that address. Is it running?',
    });
  });
});

describe('AI settings: local models', () => {
  it('finds Ollama and lists its models', async () => {
    const auth = await asAdmin();

    const running = await request(app)
      .get('/ai/local/status')
      .query({ baseUrl: `${ollama.url}/v1` })
      .set('Authorization', auth);
    const missing = await request(app)
      .get('/ai/local/status')
      .query({ baseUrl: 'http://127.0.0.1:9/v1' })
      .set('Authorization', auth);

    expect(running.body.data).toMatchObject({
      running: true,
      version: '0.40.14',
      models: [{ name: 'qwen2.5:7b', sizeBytes: 4_700_000_000 }],
    });
    expect(missing.body.data).toEqual({ running: false, version: '', models: [] });
  });

  it('downloads a model through Ollama and reports progress', async () => {
    const auth = await asAdmin();

    const started = await request(app)
      .post('/ai/local/pull')
      .set('Authorization', auth)
      .send({ model: 'gemma4:12b', baseUrl: `${ollama.url}/v1` });
    let job: { done: boolean; error: string; completed: number; total: number; status: string };
    do {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = await request(app)
        .get('/ai/local/pull')
        .query({ model: 'gemma4:12b' })
        .set('Authorization', auth);
      job = res.body.data;
    } while (!job.done);

    expect(started.status).toBe(202);
    expect(job).toMatchObject({ status: 'success', completed: 1000, total: 1000, error: '' });
    expect(ollama.models).toContain('gemma4:12b');
  });

  it('reports a failed download', async () => {
    const auth = await asAdmin();

    await request(app)
      .post('/ai/local/pull')
      .set('Authorization', auth)
      .send({ model: 'missing:1b', baseUrl: `${ollama.url}/v1` });
    let job: { done: boolean; error: string };
    do {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = await request(app)
        .get('/ai/local/pull')
        .query({ model: 'missing:1b' })
        .set('Authorization', auth);
      job = res.body.data;
    } while (!job.done);

    expect(job.error).toContain('file does not exist');
  });
});
