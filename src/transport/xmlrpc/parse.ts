/**
 * XML-RPC parser. Accepts a string or Buffer (decoded as the document's
 * declared encoding, defaulting to latin1 for raw Buffers without an explicit
 * decode) and returns a discriminated {@link XmlRpcParsed}: a method response
 * value, a fault, or a method call.
 *
 * Homematic quirks handled:
 * - `<i4>`, `<i8>`, `<int>` → number; `<double>` → number.
 * - A `<value>` with no inner type tag defaults to a string.
 * - `<dateTime.iso8601>` → string (kept raw; the model layer decides).
 * - `<base64>` → Uint8Array.
 * - Empty HTTP body → {@link EmptyBodyError} (not a parse crash).
 */
import { XMLParser } from 'fast-xml-parser';
import { BaseHomematicError } from '../../support/errors.js';
import type { XmlRpcFault, XmlRpcMethodCall, XmlRpcParsed, XmlRpcValue } from './types.js';

/** Thrown when an HTTP 200 carried no XML body to parse. */
export class EmptyBodyError extends BaseHomematicError {}

/** Thrown when the document is well-formed XML but not a recognizable XML-RPC document. */
export class MalformedXmlRpcError extends BaseHomematicError {}

// preserveOrder yields a predictable array-of-nodes structure, so we never rely
// on fast-xml-parser's value coercion. Each node is `{ tagName: [...children], ':@'?: attrs }`
// and text nodes are `{ '#text': string }`.
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  trimValues: false,
  parseTagValue: false,
  processEntities: true,
  htmlEntities: false,
});

type OrderedNode = Record<string, unknown>;

function decodeInput(input: string | Buffer | Uint8Array): string {
  if (typeof input === 'string') return input;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  // Detect declared encoding from the XML declaration prologue (first bytes are ASCII-safe).
  const head = buf.subarray(0, 120).toString('latin1').toLowerCase();
  const match = /encoding\s*=\s*["']([^"']+)["']/.exec(head);
  const enc = match?.[1] ?? 'iso-8859-1';
  if (enc === 'utf-8' || enc === 'utf8') return buf.toString('utf-8');
  // latin1 / iso-8859-1 (and any single-byte default).
  return buf.toString('latin1');
}

/** Find the children array for a given tag inside an ordered-node list. */
function childrenOf(nodes: OrderedNode[], tag: string): OrderedNode[] | undefined {
  for (const node of nodes) {
    if (Object.prototype.hasOwnProperty.call(node, tag)) {
      return node[tag] as OrderedNode[];
    }
  }
  return undefined;
}

/** Collect the concatenated text directly under a node list. */
function textOf(nodes: OrderedNode[]): string {
  let text = '';
  for (const node of nodes) {
    if (Object.prototype.hasOwnProperty.call(node, '#text')) {
      text += String(node['#text']);
    }
  }
  return text;
}

/** Return the first non-text element tag name present in the node list, if any. */
function firstElementTag(nodes: OrderedNode[]): string | undefined {
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      if (key !== '#text' && key !== ':@') return key;
    }
  }
  return undefined;
}

/** Parse the children of a `<value>` element into a JS value. */
function parseValue(valueChildren: OrderedNode[]): XmlRpcValue {
  const tag = firstElementTag(valueChildren);
  if (tag === undefined) {
    // No type element → string content (Homematic default).
    return textOf(valueChildren);
  }

  const inner = childrenOf(valueChildren, tag) ?? [];
  switch (tag) {
    case 'i4':
    case 'i8':
    case 'int':
      return Number(textOf(inner).trim());
    case 'double':
      return Number(textOf(inner).trim());
    case 'boolean':
      return textOf(inner).trim() === '1';
    case 'string':
      return textOf(inner);
    case 'dateTime.iso8601':
      return textOf(inner).trim();
    case 'base64':
      return new Uint8Array(Buffer.from(textOf(inner).trim(), 'base64'));
    case 'nil':
      return null;
    case 'array':
      return parseArray(inner);
    case 'struct':
      return parseStruct(inner);
    default:
      // Unknown type tag → treat its text as a string.
      return textOf(inner);
  }
}

function parseArray(arrayChildren: OrderedNode[]): XmlRpcValue[] {
  const data = childrenOf(arrayChildren, 'data') ?? [];
  const result: XmlRpcValue[] = [];
  for (const node of data) {
    if (Object.prototype.hasOwnProperty.call(node, 'value')) {
      result.push(parseValue(node['value'] as OrderedNode[]));
    }
  }
  return result;
}

function parseStruct(structChildren: OrderedNode[]): { [key: string]: XmlRpcValue } {
  const result: { [key: string]: XmlRpcValue } = {};
  for (const node of structChildren) {
    if (!Object.prototype.hasOwnProperty.call(node, 'member')) continue;
    const member = node['member'] as OrderedNode[];
    const nameNodes = childrenOf(member, 'name');
    const valueNodes = childrenOf(member, 'value');
    if (nameNodes === undefined || valueNodes === undefined) continue;
    const name = textOf(nameNodes);
    result[name] = parseValue(valueNodes);
  }
  return result;
}

/** Parse the `<params>` block into positional values. */
function parseParams(paramsChildren: OrderedNode[]): XmlRpcValue[] {
  const params: XmlRpcValue[] = [];
  for (const node of paramsChildren) {
    if (!Object.prototype.hasOwnProperty.call(node, 'param')) continue;
    const param = node['param'] as OrderedNode[];
    const valueNodes = childrenOf(param, 'value');
    params.push(valueNodes === undefined ? '' : parseValue(valueNodes));
  }
  return params;
}

function parseFault(faultChildren: OrderedNode[]): XmlRpcFault {
  const valueNodes = childrenOf(faultChildren, 'value');
  const struct = valueNodes === undefined ? {} : parseValue(valueNodes);
  const record =
    typeof struct === 'object' && struct !== null && !Array.isArray(struct)
      ? (struct as Record<string, XmlRpcValue>)
      : {};
  const rawCode = record['faultCode'];
  const rawString = record['faultString'];
  const faultCode = typeof rawCode === 'number' ? rawCode : Number(rawCode);
  const faultString = typeof rawString === 'string' ? rawString : '';
  return { faultCode, faultString };
}

/** Parse a complete XML-RPC document. */
export function parseXmlRpc(input: string | Buffer | Uint8Array): XmlRpcParsed {
  const xml = decodeInput(input);
  if (xml.trim().length === 0) {
    throw new EmptyBodyError('XML-RPC response had an empty body');
  }

  let root: OrderedNode[];
  try {
    root = parser.parse(xml) as OrderedNode[];
  } catch (err) {
    throw new MalformedXmlRpcError(
      `failed to parse XML-RPC document: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const responseChildren = childrenOf(root, 'methodResponse');
  if (responseChildren !== undefined) {
    const faultChildren = childrenOf(responseChildren, 'fault');
    if (faultChildren !== undefined) {
      return { kind: 'fault', fault: parseFault(faultChildren) };
    }
    const paramsChildren = childrenOf(responseChildren, 'params');
    const params = paramsChildren === undefined ? [] : parseParams(paramsChildren);
    return { kind: 'response', value: params[0] ?? null };
  }

  const callChildren = childrenOf(root, 'methodCall');
  if (callChildren !== undefined) {
    const nameNodes = childrenOf(callChildren, 'methodName');
    const methodName = nameNodes === undefined ? '' : textOf(nameNodes).trim();
    const paramsChildren = childrenOf(callChildren, 'params');
    const params = paramsChildren === undefined ? [] : parseParams(paramsChildren);
    const call: XmlRpcMethodCall = { methodName, params };
    return { kind: 'call', call };
  }

  throw new MalformedXmlRpcError('document is neither a methodResponse nor a methodCall');
}
