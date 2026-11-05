/**
 * tests/helpers/ai-stub.ts
 *
 * Local stand-ins for the Claude and OpenAI-compatible APIs. The real provider
 * adapters (the Claude one through the official SDK) talk to them over HTTP, so the
 * tests cover the wire format without a key or any cost. Each stub replays scripted
 * responses in order and records every request it receives.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

export interface Stub {
  url: string;
  requests: Array<Record<string, unknown>>;
  headers: Array<Record<string, unknown>>;
  /** Queues responses; each is sent once, in order. A number sends that status. */
  reply: (...responses: Array<Record<string, unknown> | number>) => void;
  close: () => Promise<void>;
}

const startStub = async (path: string): Promise<Stub> => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const queue: Array<Record<string, unknown> | number> = [];
  const requests: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, unknown>> = [];

  app.post(path, (req, res) => {
    requests.push(req.body as Record<string, unknown>);
    headers.push(req.headers as Record<string, unknown>);
    const next = queue.shift();
    if (next === undefined) {
      res.status(500).json({ error: { type: 'api_error', message: 'No scripted response left.' } });
    } else if (typeof next === 'number') {
      res
        .status(next)
        .json({ error: { type: 'invalid_request_error', message: 'Scripted failure.' } });
    } else {
      res.json(next);
    }
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    headers,
    reply: (...responses) => queue.push(...responses),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

export const startClaudeStub = (): Promise<Stub> => startStub('/v1/messages');
export const startOpenAiStub = (): Promise<Stub> => startStub('/v1/chat/completions');

/** A Messages API response, as the API returns it. */
export const claudeMessage = (
  content: Array<Record<string, unknown>>,
  stopReason = 'end_turn',
): Record<string, unknown> => ({
  id: `msg_${Math.random().toString(36).slice(2)}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50 },
});

export const claudeText = (text: string): Record<string, unknown> =>
  claudeMessage([{ type: 'text', text }]);

export const claudeJson = (value: unknown): Record<string, unknown> =>
  claudeMessage([{ type: 'text', text: JSON.stringify(value) }]);

export const claudeToolUse = (
  name: string,
  input: Record<string, unknown>,
  id = `toolu_${Math.random().toString(36).slice(2)}`,
): Record<string, unknown> =>
  claudeMessage(
    [
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'tool_use', id, name, input },
    ],
    'tool_use',
  );

export const openAiMessage = (
  message: Record<string, unknown>,
  finish = 'stop',
): Record<string, unknown> => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
});

export interface OllamaStub {
  url: string;
  /** Models it reports as installed. A finished download adds to it. */
  models: string[];
  chats: number;
  close: () => Promise<void>;
}

/** A stand-in for Ollama: its own API (version, models, streamed downloads) and the
 * OpenAI-compatible chat endpoint the assistant uses. */
export const startOllamaStub = async (): Promise<OllamaStub> => {
  const app = express();
  app.use(express.json());
  const stub = { models: ['qwen2.5:7b'], chats: 0 };

  app.get('/api/version', (_req, res) => {
    res.json({ version: '0.40.14' });
  });
  app.get('/api/tags', (_req, res) => {
    res.json({ models: stub.models.map((name) => ({ name, size: 4_700_000_000 })) });
  });
  app.post('/api/pull', (req, res) => {
    const { model } = req.body as { model: string };
    res.setHeader('content-type', 'application/x-ndjson');
    if (model === 'missing:1b') {
      res.end(`${JSON.stringify({ error: 'pull model manifest: file does not exist' })}\n`);
      return;
    }
    const total = 1000;
    res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
    for (const completed of [250, 600, 1000]) {
      res.write(`${JSON.stringify({ status: 'pulling layer', total, completed })}\n`);
    }
    stub.models.push(model);
    res.end(`${JSON.stringify({ status: 'success' })}\n`);
  });
  app.post('/v1/chat/completions', (_req, res) => {
    stub.chats += 1;
    res.json(openAiMessage({ content: '{"ok": true}' }));
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return Object.assign(stub, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
};
