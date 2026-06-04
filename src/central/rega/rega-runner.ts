/**
 * ReGa (Homematic scripting) runner over JSON-RPC.
 *
 * The CCU exposes a `ReGa.runScript` JSON-RPC method whose single `script`
 * param is the entire HomeMatic-Script body. We substitute `##key##`
 * placeholders, POST the body, and re-parse the textual `result`:
 *
 * - The CCU returns the script `WriteLine(...)` output as a JSON **string**,
 *   which we sanitize (strip raw control chars that would break `JSON.parse`)
 *   and parse.
 * - Names emitted by the CCU are `UriEncode`d over **latin1** (ISO-8859-1)
 *   bytes, so percent-decoding must reassemble the raw bytes and decode them as
 *   latin1 rather than UTF-8.
 *
 * This module is pure transport glue: it never owns a session, it is handed one.
 */
import { ClientError } from '../../support/errors.js';
import { JsonRpcMethod } from '../../transport/jsonrpc/methods.js';

/**
 * The minimal client contract the runner needs: a JSON-RPC `post` returning the
 * raw `{ result }` envelope. {@link JsonRpcClient} satisfies this structurally.
 */
export interface RegaPostClient {
  post(
    method: string,
    params?: Record<string, unknown>,
    opts?: { sessionId?: string },
  ): Promise<unknown>;
}

/**
 * Escape a string for safe interpolation into a double-quoted ReGa string
 * literal. Order matters: backslashes are doubled first, then quotes are
 * escaped (so an already-present `\"` is not mangled).
 */
export function escapeRegaString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Strip raw ASCII control characters (U+0000–U+001F) from a string so that a
 * JSON document carrying them inside string literals becomes parseable. Valid
 * JSON escapes (`\n`, `\t`, …) are already backslash sequences and are left
 * intact; only *raw* control bytes are removed. Mirrors aiohomematic's intent
 * of tolerating malformed ReGa output.
 */
const CONTROL_CHARS = /[\u0000-\u001F]/g;

export function sanitizeJsonControlChars(s: string): string {
  return s.replace(CONTROL_CHARS, '');
}

/**
 * Decode a CCU `UriEncode`d name. The CCU percent-encodes the latin1 byte
 * sequence of the name, so `%E8` is the single byte 0xE8 ('è' in latin1), not a
 * UTF-8 continuation. We therefore rebuild the raw bytes and decode them as
 * latin1; `decodeURIComponent` cannot be used because it assumes UTF-8.
 */
export function decodeRegaName(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i] as string;
    if (ch === '%' && i + 2 < encoded.length) {
      const hex = encoded.slice(i + 1, i + 3);
      const byte = Number.parseInt(hex, 16);
      if (!Number.isNaN(byte) && /^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(byte);
        i += 2;
        continue;
      }
    }
    if (ch === '+') {
      bytes.push(0x20);
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString('latin1');
}

/**
 * Substitute every `##key##` placeholder in `body` with the ReGa-escaped string
 * form of its value (all occurrences, literal match — no regex meta in keys).
 */
function substitute(body: string, params: Record<string, string | number>): string {
  let out = body;
  for (const [key, value] of Object.entries(params)) {
    const escaped = escapeRegaString(String(value));
    out = out.split(`##${key}##`).join(escaped);
  }
  return out;
}

/**
 * Run a ReGa script body. Placeholders are substituted, the script is POSTed via
 * `ReGa.runScript`, and the returned value is interpreted as the script result:
 * `JsonRpcClient.post` already unwraps the JSON-RPC envelope, so its return
 * value is the script's `WriteLine`/`Write` output. A string result is
 * sanitized (raw control chars stripped) and JSON-parsed; an already-structured
 * (object) result is returned unchanged.
 *
 * @throws {ClientError} when the response carries no usable result.
 */
export async function runScript(
  client: RegaPostClient,
  sessionId: string | undefined,
  body: string,
  params?: Record<string, string | number>,
): Promise<unknown> {
  const script = params ? substitute(body, params) : body;
  const result = await client.post(
    JsonRpcMethod.REGA_RUN_SCRIPT,
    { script },
    sessionId !== undefined ? { sessionId } : undefined,
  );

  if (result === undefined || result === null) {
    throw new ClientError('ReGa.runScript returned no result');
  }
  if (typeof result === 'string') {
    const parsed: unknown = JSON.parse(sanitizeJsonControlChars(result));
    return parsed;
  }
  return result;
}
