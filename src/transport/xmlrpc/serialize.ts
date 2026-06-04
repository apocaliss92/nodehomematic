/**
 * XML-RPC serializer producing ISO-8859-1 (latin1) encoded payloads, matching
 * the Homematic CCU wire format. The XML declaration advertises `iso-8859-1`
 * and the returned `Buffer` is latin1-encoded so accented characters travel as
 * single bytes.
 */
import { ValidationError } from '../../support/errors.js';
import type { XmlRpcValue } from './types.js';

const XML_DECLARATION = '<?xml version="1.0" encoding="iso-8859-1"?>';

/** Escape the five XML-significant characters within text content. */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Format a `Date` as the XML-RPC `dateTime.iso8601` basic format (UTC). */
function formatDateTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}:${mi}:${ss}`;
}

/**
 * Serialize a single value into its `<value>...</value>` XML representation.
 * Numbers: integers → `<i4>`, non-integers → `<double>`.
 */
export function serializeValue(value: XmlRpcValue): string {
  if (value === null) return '<value><nil/></value>';

  if (typeof value === 'boolean') {
    return `<value><boolean>${value ? '1' : '0'}</boolean></value>`;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`Cannot serialize non-finite number: ${String(value)}`);
    }
    if (Number.isInteger(value)) return `<value><i4>${value}</i4></value>`;
    return `<value><double>${value}</double></value>`;
  }

  if (typeof value === 'string') {
    return `<value><string>${escapeXml(value)}</string></value>`;
  }

  if (value instanceof Date) {
    return `<value><dateTime.iso8601>${formatDateTime(value)}</dateTime.iso8601></value>`;
  }

  if (value instanceof Uint8Array) {
    return `<value><base64>${Buffer.from(value).toString('base64')}</base64></value>`;
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => serializeValue(item)).join('');
    return `<value><array><data>${items}</data></array></value>`;
  }

  // Plain object → struct.
  const members = Object.entries(value)
    .map(
      ([name, member]) =>
        `<member><name>${escapeXml(name)}</name>${serializeValue(member)}</member>`,
    )
    .join('');
  return `<value><struct>${members}</struct></value>`;
}

function paramsBlock(params: readonly XmlRpcValue[]): string {
  if (params.length === 0) return '<params></params>';
  const inner = params.map((p) => `<param>${serializeValue(p)}</param>`).join('');
  return `<params>${inner}</params>`;
}

/** Encode an XML string to a latin1 (ISO-8859-1) buffer for the wire. */
function toLatin1(xml: string): Buffer {
  return Buffer.from(xml, 'latin1');
}

/** Serialize a `<methodCall>` with positional params. Returns a latin1 Buffer. */
export function serializeMethodCall(methodName: string, params: readonly XmlRpcValue[]): Buffer {
  const xml =
    `${XML_DECLARATION}<methodCall><methodName>${escapeXml(methodName)}</methodName>` +
    `${paramsBlock(params)}</methodCall>`;
  return toLatin1(xml);
}

/** Serialize a successful `<methodResponse>` wrapping a single value. */
export function serializeMethodResponse(value: XmlRpcValue): Buffer {
  const xml =
    `${XML_DECLARATION}<methodResponse><params><param>${serializeValue(value)}</param></params>` +
    `</methodResponse>`;
  return toLatin1(xml);
}

/** Serialize a `<fault>` response. */
export function serializeFault(faultCode: number, faultString: string): Buffer {
  const fault = serializeValue({ faultCode, faultString });
  const xml = `${XML_DECLARATION}<methodResponse><fault>${fault}</fault></methodResponse>`;
  return toLatin1(xml);
}
