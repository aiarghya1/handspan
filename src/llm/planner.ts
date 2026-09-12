/**
 * The planner seam.
 *
 * `Planner` is the only thing the discovery agent knows about the model: hand
 * it tool results, get back the next tool calls. Two implementations ship: the
 * Anthropic one, and a scripted one that replays a fixed sequence of calls.
 *
 * The scripted planner is not a toy. It means the entire discovery path -
 * perception, the policy gate, escalation, the recorder, the compiler - is
 * exercised in tests and reproducible offline, with no API key and no
 * nondeterminism, while the real planner is swapped in for the run that
 * actually has to prove the model can do it.
 */

import type Anthropic from '@anthropic-ai/sdk';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  /** Plain text result. */
  text: string;
  /** Optional PNG, shown to the model alongside the text. */
  imagePng?: Buffer;
  isError?: boolean;
}

export interface PlannerTurn {
  text?: string;
  calls: ToolCall[];
  stop: 'tool_use' | 'end_turn' | 'refusal' | 'max_tokens' | 'other';
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * True when the model refused the credential rather than the request.
 *
 * Kept structural rather than `instanceof Anthropic.AuthenticationError` so
 * that callers can classify the error without pulling the SDK's module graph
 * in, which is the whole reason the scripted path stays cheap.
 */
export function isAuthFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return status === 401 || status === 403;
}

export interface Planner {
  readonly model: string;
  /** Pass null on the first call; afterwards, the results of the last turn. */
  next(results: ToolResult[] | null): Promise<PlannerTurn>;
}

// -- tool surface -----------------------------------------------------------

/**
 * The model's action space is named controls, never coordinates.
 *
 * Every tool that touches the page takes a `handle` from the most recent
 * observation. That is the constraint that makes a discovery run recordable:
 * the recorder can turn "the button named Continue in frame main" into a
 * durable ControlRef, and cannot turn "the pixel at 412,308" into anything at
 * all. Screenshots still go to the model, because vision is what lets it read
 * a dense legacy screen - but they inform the choice, they are not the address.
 *
 * `intent` and `expect` are required on acting tools because they are what the
 * artifact needs and the model is the only participant that knows them: why
 * this click, and what should be true afterwards.
 */
export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'observe',
    description:
      'Look at the current screen. Returns the URL of every frame, any alert or dialog text, and the list of controls with a stable handle for each. Also returns a screenshot. Call this before your first action and whenever you are unsure what changed.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'click',
    description: 'Click a control by handle. Use for buttons and links.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'handle from the most recent observe' },
        intent: { type: 'string', description: 'why, in plain language, e.g. "submit the member search"' },
        expect: {
          type: 'string',
          description:
            'A short phrase that should appear on screen once this worked, e.g. "MEMBER DETAIL". This becomes the recorded success condition, so pick something that identifies the screen and will be true for any input, not just this one.',
        },
        phase: {
          type: 'string',
          enum: ['signon', 'navigate', 'input', 'commit', 'read'],
          description:
            'Which part of the flow this belongs to. signon = authenticating; navigate = moving between screens; input = filling a form; commit = the action that changes data; read = reading a value. Used to rebuild the flow after a session timeout, so label it accurately.',
        },
      },
      required: ['handle', 'intent', 'expect', 'phase'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description:
      'Type into a text field by handle. If the value came from the goal parameters you were given, pass its name in `parameter` so the recording is reusable with a different value.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        text: { type: 'string' },
        parameter: {
          type: 'string',
          description: 'name of the goal parameter this value came from, if any',
        },
        intent: { type: 'string' },
        phase: { type: 'string', enum: ['signon', 'navigate', 'input', 'commit', 'read'] },
      },
      required: ['handle', 'text', 'intent', 'phase'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_secret',
    description:
      'Type a credential into a field without ever seeing it. Pass the vault key from the list you were given; the value is fetched and typed by the system. You will not be shown it and it will not appear in any log.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        secret_key: { type: 'string', description: 'e.g. meridian.password' },
        intent: { type: 'string' },
      },
      required: ['handle', 'secret_key', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a dropdown by handle. `value` may be the option value or its visible label.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        value: { type: 'string' },
        parameter: { type: 'string' },
        intent: { type: 'string' },
        phase: { type: 'string', enum: ['signon', 'navigate', 'input', 'commit', 'read'] },
      },
      required: ['handle', 'value', 'intent', 'phase'],
      additionalProperties: false,
    },
  },
  {
    name: 'press_key',
    description: 'Press a key, optionally focused on a control. Use when a screen has no clickable submit.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'e.g. Enter, Tab, F3' },
        handle: { type: 'string' },
        intent: { type: 'string' },
        expect: { type: 'string' },
        phase: { type: 'string', enum: ['signon', 'navigate', 'input', 'commit', 'read'] },
      },
      required: ['key', 'intent', 'phase'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_value',
    description:
      'Read one of the values the goal asked you to return. Give either a control handle, or a regular expression with one capture group to pull the value out of the screen text. `name` must be one of the declared return names.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'one of the declared return names' },
        handle: { type: 'string' },
        text_pattern: { type: 'string', description: 'regex with one capture group, as an alternative to handle' },
        intent: { type: 'string' },
      },
      required: ['name', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'declare_outcome',
    description:
      'Record a legitimate non-success result this flow can produce, so that replay reports it to the caller as an answer rather than as a crash. Example: searching for a member that does not exist. Only declare outcomes you have actually seen or that the screen explicitly documents.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'SCREAMING_SNAKE_CASE, e.g. MEMBER_NOT_FOUND' },
        description: { type: 'string' },
        when_text: { type: 'string', description: 'text that appears on screen when this happens' },
        disposition: {
          type: 'string',
          enum: ['return', 'escalate'],
          description: 'return = hand it to the caller as a result; escalate = a person should look at it',
        },
      },
      required: ['id', 'description', 'when_text', 'disposition'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_help',
    description:
      'Hand the session to a human operator. Use this when you are stuck, when a screen asks for something you were not given, or when an action would commit a change you are not authorised to make. Describe precisely what you need done. Control comes back to you afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        what_you_need: { type: 'string', description: 'the concrete thing the operator should do' },
      },
      required: ['reason', 'what_you_need'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description:
      'Declare the goal met. Only call this once every declared return value has been read and you can see the screen that proves the goal is complete.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'what you did, in two or three sentences' },
        success_text: {
          type: 'string',
          description: 'a phrase on the final screen that proves the flow completed, used as the overall checkpoint',
        },
      },
      required: ['summary', 'success_text'],
      additionalProperties: false,
    },
  },
];

// -- Anthropic ---------------------------------------------------------------

export interface AnthropicPlannerOptions {
  client: Anthropic;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  system: string;
  firstMessage: string;
  maxTokens?: number;
  /** Called with each turn's raw text, for the run log. */
  onText?: (text: string) => void;
}

export class AnthropicPlanner implements Planner {
  readonly model: string;
  private readonly messages: Anthropic.MessageParam[] = [];
  private readonly opts: AnthropicPlannerOptions;
  /** Server-side refusal fallbacks are on by default; dropped if rejected. */
  private useFallbacks = true;

  constructor(opts: AnthropicPlannerOptions) {
    this.opts = opts;
    this.model = opts.model ?? 'claude-opus-5';
    this.messages.push({ role: 'user', content: opts.firstMessage });
  }

  async next(results: ToolResult[] | null): Promise<PlannerTurn> {
    if (results) {
      this.messages.push({
        role: 'user',
        content: results.map((r): Anthropic.ToolResultBlockParam => {
          const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
            { type: 'text', text: r.text },
          ];
          if (r.imagePng) {
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: r.imagePng.toString('base64') },
            });
          }
          return { type: 'tool_result', tool_use_id: r.id, content, is_error: r.isError };
        }),
      });
    }

    const message = await this.send();

    if (message.stop_reason === 'refusal') {
      return { calls: [], stop: 'refusal', text: 'the model declined this request' };
    }

    // Thinking blocks are echoed back unchanged on the same model, so the whole
    // content array goes into the history rather than just the text.
    this.messages.push({ role: 'assistant', content: message.content });

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) this.opts.onText?.(text);

    const calls = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));

    return {
      text: text || undefined,
      calls,
      stop:
        message.stop_reason === 'tool_use'
          ? 'tool_use'
          : message.stop_reason === 'end_turn'
            ? 'end_turn'
            : message.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : 'other',
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }

  private async send(): Promise<Anthropic.Message> {
    const params = {
      model: this.model,
      max_tokens: this.opts.maxTokens ?? 8_000,
      // Adaptive thinking, with the summary returned so the run log records the
      // model's reasoning alongside what it did.
      thinking: { type: 'adaptive' as const, display: 'summarized' as const },
      output_config: { effort: this.opts.effort ?? 'high' },
      system: [{ type: 'text' as const, text: this.opts.system, cache_control: { type: 'ephemeral' as const } }],
      tools: DISCOVERY_TOOLS,
      messages: this.messages,
    };

    if (this.useFallbacks) {
      try {
        const stream = this.opts.client.beta.messages.stream({
          ...params,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        } as never);
        return (await stream.finalMessage()) as Anthropic.Message;
      } catch (err) {
        // A rejected credential is not a missing beta. Retrying the plain
        // request would fail identically one turn later, having already put a
        // misleading "fallbacks unavailable" note in the run log - which is
        // exactly how an invalid key came to surface as an unhandled 401.
        if (isAuthFailure(err)) throw err;
        // If this deployment does not have the fallback beta, fall through to a
        // plain request rather than failing the run over a resilience feature.
        this.useFallbacks = false;
        this.opts.onText?.(`[planner] server-side fallbacks unavailable, continuing without: ${String(err).slice(0, 200)}`);
      }
    }

    const stream = this.opts.client.messages.stream(params);
    return stream.finalMessage();
  }
}

// -- scripted ---------------------------------------------------------------

export interface ScriptedStep {
  text?: string;
  calls: Array<{ name: string; input: Record<string, unknown> }>;
}

/**
 * Replays a fixed sequence of tool calls. Handles are resolved lazily: a step
 * may name a control as `role|name` instead of a handle, and the agent looks it
 * up in the current observation. That keeps scripts readable and keeps them
 * from breaking when handle numbering shifts.
 */
export class ScriptedPlanner implements Planner {
  readonly model = 'scripted';
  private i = 0;

  constructor(private readonly script: ScriptedStep[]) {}

  async next(_results: ToolResult[] | null): Promise<PlannerTurn> {
    if (this.i >= this.script.length) return { calls: [], stop: 'end_turn', text: 'script exhausted' };
    const step = this.script[this.i++]!;
    return {
      text: step.text,
      calls: step.calls.map((c, n) => ({ id: `scripted-${this.i}-${n}`, name: c.name, input: c.input })),
      stop: 'tool_use',
    };
  }
}
