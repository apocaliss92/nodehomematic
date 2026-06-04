import { describe, it, expect } from 'vitest';
import {
  escapeRegaString,
  sanitizeJsonControlChars,
  decodeRegaName,
  runScript,
  type RegaPostClient,
} from '../../../../src/central/rega/rega-runner.js';
import { JsonRpcMethod } from '../../../../src/transport/jsonrpc/methods.js';

/** A fake ReGa client that records every post and returns a canned result. */
class FakeClient implements RegaPostClient {
  public readonly posts: Array<{
    method: string;
    params?: Record<string, unknown>;
    opts?: { sessionId?: string };
  }> = [];

  public constructor(private readonly result: unknown) {}

  public async post(
    method: string,
    params?: Record<string, unknown>,
    opts?: { sessionId?: string },
  ): Promise<unknown> {
    this.posts.push({ method, params, opts });
    return this.result;
  }
}

describe('escapeRegaString', () => {
  it('escapes backslashes before quotes', () => {
    expect(escapeRegaString('a\\b')).toBe('a\\\\b');
    expect(escapeRegaString('say "hi"')).toBe('say \\"hi\\"');
    // A backslash followed by a quote: backslash doubled first, then quote escaped.
    expect(escapeRegaString('\\"')).toBe('\\\\\\"');
  });

  it('leaves plain strings untouched', () => {
    expect(escapeRegaString('plain text 123')).toBe('plain text 123');
  });
});

describe('sanitizeJsonControlChars', () => {
  it('makes a control-char-containing string JSON-parseable', () => {
    // A raw control char (0x01) inside a JSON string literal breaks JSON.parse.
    const broken = '{"a":"xy"}';
    expect(() => JSON.parse(broken)).toThrow();
    const fixed = sanitizeJsonControlChars(broken);
    expect(() => JSON.parse(fixed)).not.toThrow();
  });

  it('preserves valid escaped whitespace and ordinary text', () => {
    const ok = '{"a":"line1\\nline2"}';
    const fixed = sanitizeJsonControlChars(ok);
    const parsed = JSON.parse(fixed) as { a: string };
    expect(parsed.a).toBe('line1\nline2');
  });
});

describe('decodeRegaName', () => {
  it('decodes a latin1 percent-encoded accented name', () => {
    // %E8 is latin1 'è'; %20 is a space.
    expect(decodeRegaName('Cucina%20caff%E8')).toBe('Cucina caffè');
  });

  it('returns ASCII names unchanged', () => {
    expect(decodeRegaName('Living%20Room')).toBe('Living Room');
  });
});

describe('runScript', () => {
  it('parses a JSON-string result into an object', async () => {
    const client = new FakeClient('{"rooms":{},"functions":{}}');
    const result = await runScript(client, 'sid-1', 'script body', {});
    expect(result).toEqual({ rooms: {}, functions: {} });
  });

  it('returns an already-object result as-is', async () => {
    const client = new FakeClient({ already: 'object' });
    const result = await runScript(client, 'sid-1', 'body');
    expect(result).toEqual({ already: 'object' });
  });

  it('substitutes ##key## params (escaping quotes) into the posted script', async () => {
    const client = new FakeClient('{}');
    await runScript(client, 'sid-9', 'name=##name##; value=##value##;', {
      name: 'My "Var"',
      value: 42,
    });
    const post = client.posts[0];
    expect(post?.method).toBe(JsonRpcMethod.REGA_RUN_SCRIPT);
    expect(post?.opts).toEqual({ sessionId: 'sid-9' });
    const script = (post?.params as { script: string }).script;
    expect(script).toBe('name=My \\"Var\\"; value=42;');
  });

  it('replaces all occurrences of a placeholder', async () => {
    const client = new FakeClient('{}');
    await runScript(client, undefined, '##x##-##x##', { x: 'Z' });
    const script = (client.posts[0]?.params as { script: string }).script;
    expect(script).toBe('Z-Z');
  });

  it('throws a clear error when the result is missing', async () => {
    const client: RegaPostClient = {
      post: async () => undefined,
    };
    await expect(runScript(client, 'sid', 'body')).rejects.toThrow(/result/i);
  });
});
