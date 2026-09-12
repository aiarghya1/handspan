/**
 * The planner seam.
 *
 * `AnthropicPlanner` is driven with a stand-in client rather than the network:
 * what matters is the conversation bookkeeping - thinking blocks echoed back
 * unchanged, tool results carrying an image, a refusal recognised, the
 * server-side fallback dropped rather than failing the run - none of which
 * needs a real model to verify.
 */

import { describe, expect, it, vi } from 'vitest';
import { AnthropicPlanner, DISCOVERY_TOOLS, ScriptedPlanner } from '../src/llm/planner.js';

type Message = {
  content: Array<Record<string, unknown>>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
};

/** A stand-in for the SDK: records what it was sent, returns queued messages. */
function fakeClient(messages: Message[], opts: { betaThrows?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const next = () => {
    const m = messages.shift();
    if (!m) throw new Error('the fake client ran out of messages');
    return { finalMessage: async () => m };
  };
  return {
    sent,
    client: {
      beta: {
        messages: {
          stream: (params: Record<string, unknown>) => {
            if (opts.betaThrows) throw new Error('unknown beta: server-side-fallback');
            sent.push(params);
            return next();
          },
        },
      },
      messages: {
        stream: (params: Record<string, unknown>) => {
          sent.push(params);
          return next();
        },
      },
    } as never,
  };
}

const textBlock = (text: string) => ({ type: 'text', text });
const toolBlock = (name: string, input: Record<string, unknown>, id = 'tu_1') => ({ type: 'tool_use', id, name, input });

describe('the tool surface offered to the model', () => {
  it('names every tool the agent can dispatch, and no others', () => {
    expect(DISCOVERY_TOOLS.map((t) => t.name).sort()).toEqual(
      ['click', 'declare_outcome', 'finish', 'observe', 'press_key', 'read_value', 'request_help', 'select_option', 'type_secret', 'type_text'].sort(),
    );
  });

  it('requires an intent and a phase on every acting tool', () => {
    for (const name of ['click', 'type_text', 'select_option', 'press_key']) {
      const required = (DISCOVERY_TOOLS.find((t) => t.name === name)!.input_schema as { required: string[] }).required;
      expect(required, name).toContain('intent');
      expect(required, name).toContain('phase');
    }
  });

  it('requires a post-condition on a click, which is where a screen transition happens', () => {
    // Not on press_key: Tab and F3 are navigation within a screen and have no
    // honest expectation to state, and a weak checkpoint is worse than none.
    const click = (DISCOVERY_TOOLS.find((t) => t.name === 'click')!.input_schema as { required: string[] }).required;
    expect(click).toContain('expect');
    const press = (DISCOVERY_TOOLS.find((t) => t.name === 'press_key')!.input_schema as { required: string[] }).required;
    expect(press).not.toContain('expect');
  });

  it('never offers the model a way to name a credential value', () => {
    const secret = DISCOVERY_TOOLS.find((t) => t.name === 'type_secret')!;
    const props = Object.keys((secret.input_schema as { properties: Record<string, unknown> }).properties);
    expect(props).toContain('secret_key');
    expect(props).not.toContain('text');
    expect(props).not.toContain('value');
  });
});

describe('AnthropicPlanner', () => {
  const base = { system: 'be careful', firstMessage: 'begin' };

  it('sends the goal, the tools, and a cached system prompt', async () => {
    const f = fakeClient([{ content: [textBlock('starting'), toolBlock('observe', {})], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } }]);
    const planner = new AnthropicPlanner({ client: f.client, ...base });
    const turn = await planner.next(null);

    expect(turn.stop).toBe('tool_use');
    expect(turn.text).toBe('starting');
    expect(turn.calls).toEqual([{ id: 'tu_1', name: 'observe', input: {} }]);
    expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 2 });

    const params = f.sent[0]!;
    expect(params['model']).toBe('claude-opus-5');
    expect(params['thinking']).toMatchObject({ type: 'adaptive' });
    expect((params['system'] as Array<Record<string, unknown>>)[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect((params['tools'] as unknown[]).length).toBe(DISCOVERY_TOOLS.length);
    expect(params['fallbacks']).toBe('default');
  });

  it('honours an explicit model and effort', async () => {
    const f = fakeClient([{ content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }]);
    const planner = new AnthropicPlanner({ client: f.client, model: 'claude-sonnet-5', effort: 'low', ...base });
    await planner.next(null);
    expect(f.sent[0]!['model']).toBe('claude-sonnet-5');
    expect(f.sent[0]!['output_config']).toMatchObject({ effort: 'low' });
    expect(planner.model).toBe('claude-sonnet-5');
  });

  it('echoes the whole assistant turn back, so thinking blocks survive', async () => {
    // Thinking blocks are bound to the model that produced them; dropping them
    // and keeping only the text loses state the model expects to see again.
    const thinking = { type: 'thinking', thinking: 'weighing the options', signature: 'sig' };
    const f = fakeClient([
      { content: [thinking, toolBlock('observe', {})], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [textBlock('done')], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const planner = new AnthropicPlanner({ client: f.client, ...base });
    await planner.next(null);
    await planner.next([{ id: 'tu_1', text: 'a screen' }]);

    const history = f.sent[1]!['messages'] as Array<{ role: string; content: unknown }>;
    expect(history[1]).toMatchObject({ role: 'assistant' });
    expect(JSON.stringify(history[1]!.content)).toContain('weighing the options');
  });

  it('sends a tool result with its screenshot, and marks an error result', async () => {
    const f = fakeClient([
      { content: [toolBlock('observe', {})], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [textBlock('ok')], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const planner = new AnthropicPlanner({ client: f.client, ...base });
    await planner.next(null);
    await planner.next([
      { id: 'tu_1', text: 'the screen', imagePng: Buffer.from('png-bytes') },
      { id: 'tu_2', text: 'that failed', isError: true },
    ]);

    const results = (f.sent[1]!['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>)[2]!;
    expect(results.role).toBe('user');
    const withImage = results.content[0]!;
    expect((withImage['content'] as Array<{ type: string }>).map((c) => c.type)).toEqual(['text', 'image']);
    expect(results.content[1]).toMatchObject({ is_error: true });
  });

  it('reports a refusal instead of treating it as an empty turn', async () => {
    const f = fakeClient([{ content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } }]);
    const planner = new AnthropicPlanner({ client: f.client, ...base });
    const turn = await planner.next(null);
    expect(turn.stop).toBe('refusal');
    expect(turn.calls).toEqual([]);
  });

  it('maps the remaining stop reasons', async () => {
    const f = fakeClient([
      { content: [], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [], stop_reason: 'pause_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const planner = new AnthropicPlanner({ client: f.client, ...base });
    expect((await planner.next(null)).stop).toBe('max_tokens');
    expect((await planner.next(null)).stop).toBe('other');
    expect((await planner.next(null)).stop).toBe('end_turn');
  });

  it('carries on without server-side fallbacks when the deployment lacks the beta', async () => {
    // A resilience feature must not be the thing that stops the run.
    const f = fakeClient([{ content: [textBlock('ok')], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }], {
      betaThrows: true,
    });
    const onText = vi.fn();
    const planner = new AnthropicPlanner({ client: f.client, ...base, onText });
    const turn = await planner.next(null);
    expect(turn.stop).toBe('end_turn');
    expect(onText.mock.calls.some(([t]) => String(t).includes('fallbacks unavailable'))).toBe(true);
    // The next turn goes straight to the non-beta path.
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!['fallbacks']).toBeUndefined();
  });

  it('reports the model text through onText once per turn', async () => {
    const f = fakeClient([
      { content: [textBlock('first')], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const onText = vi.fn();
    const planner = new AnthropicPlanner({ client: f.client, ...base, onText, maxTokens: 100 });
    await planner.next(null);
    await planner.next([]);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(f.sent[0]!['max_tokens']).toBe(100);
  });
});

describe('ScriptedPlanner', () => {
  it('replays its script and then stops', async () => {
    const planner = new ScriptedPlanner([
      { text: 'looking', calls: [{ name: 'observe', input: {} }] },
      { calls: [{ name: 'finish', input: { summary: 's', success_text: 't' } }] },
    ]);
    expect(planner.model).toBe('scripted');
    const first = await planner.next(null);
    expect(first).toMatchObject({ text: 'looking', stop: 'tool_use' });
    expect(first.calls[0]).toMatchObject({ name: 'observe' });
    expect((await planner.next([])).calls[0]).toMatchObject({ name: 'finish' });
    expect(await planner.next([])).toMatchObject({ calls: [], stop: 'end_turn', text: 'script exhausted' });
  });
});

describe('a tool call with no arguments at all', () => {
  it('is passed on as an empty object rather than as undefined', async () => {
    const f = fakeClient([
      { content: [{ type: 'tool_use', id: 't1', name: 'observe', input: null }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const planner = new AnthropicPlanner({ client: f.client, system: 's', firstMessage: 'go' });
    expect((await planner.next(null)).calls[0]).toEqual({ id: 't1', name: 'observe', input: {} });
  });
});
