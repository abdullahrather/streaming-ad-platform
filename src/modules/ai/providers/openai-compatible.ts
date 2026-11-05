/**
 * src/modules/ai/providers/openai-compatible.ts
 *
 * Any server that speaks the OpenAI chat completions API: OpenAI itself, or a local
 * model through Ollama (http://localhost:11434/v1), which needs no key and no internet.
 */
import {
  AiRefusalError,
  type AiProvider,
  type JsonRequest,
  type ToolCallRecord,
  type ToolRunRequest,
  type ToolRunResult,
} from './types';

const DEFAULT_TURNS = 8;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  refusal?: string | null;
}

interface ChatResponse {
  choices: Array<{ message: ChatMessage; finish_reason: string }>;
}

export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    readonly name: 'openai' | 'local',
    readonly model: string,
    private readonly options: { apiKey: string; baseURL: string; timeoutMs: number },
  ) {}

  private async chat(body: Record<string, unknown>): Promise<ChatResponse> {
    const response = await fetch(`${this.options.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, ...body }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${this.name} returned ${response.status}: ${detail.slice(0, 300)}`);
    }
    return (await response.json()) as ChatResponse;
  }

  async runTools(request: ToolRunRequest): Promise<ToolRunResult> {
    const tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        ...(this.name === 'openai' ? { strict: true } : {}),
      },
    }));
    const messages: ChatMessage[] = [
      { role: 'system', content: request.system },
      ...request.history,
      { role: 'user', content: request.prompt },
    ];
    const toolCalls: ToolCallRecord[] = [];

    for (let turn = 0; turn < (request.maxTurns ?? DEFAULT_TURNS); turn += 1) {
      const { choices } = await this.chat({ messages, tools, tool_choice: 'auto' });
      const choice = choices[0];
      if (!choice) throw new Error(`${this.name} returned no answer.`);
      const { message } = choice;

      if (message.refusal) return { text: '', toolCalls, stopped: 'refusal' };
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (choice.finish_reason === 'length') return { text, toolCalls, stopped: 'max_tokens' };
      if (!message.tool_calls?.length) return { text, toolCalls, stopped: null };

      messages.push({
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: message.tool_calls,
      });
      for (const call of message.tool_calls) {
        const tool = request.tools.find(({ name }) => name === call.function.name);
        let input: Record<string, unknown> = {};
        let content: string;
        try {
          input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
          if (!tool) throw new Error(`Unknown tool ${call.function.name}`);
          const value = JSON.stringify(await tool.run(input));
          content = value.length > 40_000 ? `${value.slice(0, 40_000)}…(truncated)` : value;
          toolCalls.push({ name: call.function.name, input, failed: false });
        } catch (error) {
          content = `Error: ${error instanceof Error ? error.message : String(error)}`;
          toolCalls.push({ name: call.function.name, input, failed: true });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }

    return { text: '', toolCalls, stopped: 'max_turns' };
  }

  async json(request: JsonRequest): Promise<unknown> {
    const userContent = request.image
      ? [
          { type: 'text', text: request.prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${request.image.mediaType};base64,${request.image.data}` },
          },
        ]
      : request.prompt;
    const messages: ChatMessage[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: userContent },
    ];

    let response: ChatResponse;
    try {
      response = await this.chat({
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'result', schema: request.schema, strict: this.name === 'openai' },
        },
      });
    } catch (error) {
      // Some local servers only know plain JSON mode, so the schema goes in the prompt.
      if (this.name !== 'local') throw error;
      response = await this.chat({
        messages: [
          {
            role: 'system',
            content: `${request.system}\n\nReply with JSON only, matching this JSON Schema:\n${JSON.stringify(request.schema)}`,
          },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
      });
    }

    const message = response.choices[0]?.message;
    if (message?.refusal) throw new AiRefusalError();
    const text = typeof message?.content === 'string' ? message.content : '';
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as unknown;
  }
}
