/**
 * src/modules/ai/providers/anthropic.ts
 *
 * Claude through the official SDK. The system prompt and tools are kept identical
 * between requests so the prompt cache can serve them, and assistant turns are sent
 * back exactly as received, including thinking blocks.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  AiRefusalError,
  type AiProvider,
  type JsonRequest,
  type ToolCallRecord,
  type ToolRunRequest,
  type ToolRunResult,
} from './types';

const MAX_TOKENS = 16_000;
const DEFAULT_TURNS = 8;

// Models that accept server-side fallback, which retries a declined request on
// another Claude model inside the same call.
const FALLBACK_MODELS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

const toolResult = (value: unknown): string => {
  const text = JSON.stringify(value);
  // Tool results stay small, so one call can't flood the context.
  return text.length > 40_000 ? `${text.slice(0, 40_000)}…(truncated)` : text;
};

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    options: { apiKey: string; baseURL?: string; timeoutMs: number },
  ) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      timeout: options.timeoutMs,
      maxRetries: 2,
    });
  }

  private fallback(): Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, 'betas' | 'fallbacks'> {
    return FALLBACK_MODELS.has(this.model)
      ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
      : {};
  }

  async runTools(request: ToolRunRequest): Promise<ToolRunResult> {
    const tools: Anthropic.Beta.BetaTool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...request.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: request.prompt },
    ];
    const toolCalls: ToolCallRecord[] = [];

    for (let turn = 0; turn < (request.maxTurns ?? DEFAULT_TURNS); turn += 1) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages,
        output_config: { effort: 'medium' },
        ...this.fallback(),
      });

      if (response.stop_reason === 'refusal') return { text: '', toolCalls, stopped: 'refusal' };

      const text = response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      if (response.stop_reason === 'max_tokens') return { text, toolCalls, stopped: 'max_tokens' };
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      const uses = response.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use',
      );
      if (response.stop_reason !== 'tool_use' || uses.length === 0) {
        return { text, toolCalls, stopped: null };
      }

      messages.push({ role: 'assistant', content: response.content });
      // Every result goes back in one message, which keeps parallel calls working.
      const results = await Promise.all(
        uses.map(async (use): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const tool = request.tools.find(({ name }) => name === use.name);
          const input = (use.input ?? {}) as Record<string, unknown>;
          try {
            if (!tool) throw new Error(`Unknown tool ${use.name}`);
            const value = await tool.run(input);
            toolCalls.push({ name: use.name, input, failed: false });
            return { type: 'tool_result', tool_use_id: use.id, content: toolResult(value) };
          } catch (error) {
            toolCalls.push({ name: use.name, input, failed: true });
            return {
              type: 'tool_result',
              tool_use_id: use.id,
              content: `Error: ${error instanceof Error ? error.message : String(error)}`,
              is_error: true,
            };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }

    return { text: '', toolCalls, stopped: 'max_turns' };
  }

  async json(request: JsonRequest): Promise<unknown> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...(request.image
        ? [
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: request.image.mediaType,
                data: request.image.data,
              },
            },
          ]
        : []),
      { type: 'text', text: request.prompt },
    ];

    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: request.system,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: request.schema } },
      ...this.fallback(),
    });

    if (response.stop_reason === 'refusal') throw new AiRefusalError();
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return JSON.parse(text) as unknown;
  }
}
