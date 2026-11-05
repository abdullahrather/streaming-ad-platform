/**
 * src/modules/ai/providers/types.ts
 *
 * What the assistant needs from a model, whichever provider runs it. Each provider
 * runs its own tool loop, so provider-specific message shapes (Claude's thinking
 * blocks, OpenAI's tool_calls) never leak out of the adapter.
 */

/** A read-only tool the model may call. Schemas allow no extra properties. */
export interface AiTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface AiImage {
  mediaType: 'image/jpeg' | 'image/png';
  /** Base64, without a data: prefix. */
  data: string;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  failed: boolean;
}

export interface ToolRunResult {
  text: string;
  toolCalls: ToolCallRecord[];
  /** The model declined, or stopped before finishing. */
  stopped: 'refusal' | 'max_tokens' | 'max_turns' | null;
}

export interface ToolRunRequest {
  system: string;
  /** Earlier turns as plain text, oldest first. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  prompt: string;
  tools: AiTool[];
  maxTurns?: number;
}

export interface JsonRequest {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  image?: AiImage;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  runTools(request: ToolRunRequest): Promise<ToolRunResult>;
  /** Returns parsed JSON matching the schema, or throws. */
  json(request: JsonRequest): Promise<unknown>;
}

/** The model declined to help, so there's nothing to show. */
export class AiRefusalError extends Error {
  constructor() {
    super('The AI model declined this request.');
  }
}
