import { describe, it, expect } from 'vitest';
import {
  serializeMethodCall,
  serializeMethodResponse,
  serializeFault,
  serializeValue,
} from '../../../../src/transport/xmlrpc/serialize.js';
import { ValidationError } from '../../../../src/support/errors.js';

const decodeLatin1 = (buf: Buffer): string => new TextDecoder('latin1').decode(buf);

describe('serializeMethodCall', () => {
  it('produce un methodCall con methodName e params posizionali', () => {
    const xml = decodeLatin1(serializeMethodCall('getValue', ['VCU001:1', 'STATE']));
    expect(xml).toContain('<?xml version="1.0" encoding="iso-8859-1"?>');
    expect(xml).toContain('<methodCall>');
    expect(xml).toContain('<methodName>getValue</methodName>');
    expect(xml).toContain('<params>');
    expect(xml).toMatch(/<param><value><string>VCU001:1<\/string><\/value><\/param>/);
    expect(xml).toMatch(/<param><value><string>STATE<\/string><\/value><\/param>/);
  });

  it('emette params vuoto quando non ci sono argomenti', () => {
    const xml = decodeLatin1(serializeMethodCall('listDevices', []));
    expect(xml).toContain('<params></params>');
  });
});

describe('serializeValue per tipo', () => {
  const s = (v: Parameters<typeof serializeValue>[0]): string => serializeValue(v);

  it('int → <i4>', () => {
    expect(s(42)).toBe('<value><i4>42</i4></value>');
    expect(s(-7)).toBe('<value><i4>-7</i4></value>');
  });

  it('float → <double>', () => {
    expect(s(3.5)).toBe('<value><double>3.5</double></value>');
  });

  it('numero non-finito (NaN/Infinity) → ValidationError', () => {
    expect(() => s(NaN)).toThrow(ValidationError);
    expect(() => s(Infinity)).toThrow(ValidationError);
    expect(() => s(-Infinity)).toThrow(ValidationError);
    // i valori finiti continuano a serializzare come prima
    expect(s(42)).toBe('<value><i4>42</i4></value>');
    expect(s(3.5)).toBe('<value><double>3.5</double></value>');
  });

  it('bool → <boolean> con 1/0', () => {
    expect(s(true)).toBe('<value><boolean>1</boolean></value>');
    expect(s(false)).toBe('<value><boolean>0</boolean></value>');
  });

  it('string → <string> con escaping di & < >', () => {
    expect(s('a & b < c > d')).toBe('<value><string>a &amp; b &lt; c &gt; d</string></value>');
  });

  it('null → <nil/>', () => {
    expect(s(null)).toBe('<value><nil/></value>');
  });

  it('array → <array><data>', () => {
    expect(s([1, 'x'])).toBe(
      '<value><array><data>' +
        '<value><i4>1</i4></value>' +
        '<value><string>x</string></value>' +
        '</data></array></value>',
    );
  });

  it('struct (object) → <struct><member><name>', () => {
    expect(s({ ON: true })).toBe(
      '<value><struct><member><name>ON</name><value><boolean>1</boolean></value></member></struct></value>',
    );
  });

  it('Date → <dateTime.iso8601>', () => {
    const d = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
    expect(s(d)).toBe('<value><dateTime.iso8601>20200102T03:04:05</dateTime.iso8601></value>');
  });

  it('Uint8Array → <base64>', () => {
    expect(s(new Uint8Array([1, 2, 3]))).toBe('<value><base64>AQID</base64></value>');
  });
});

describe('encoding ISO-8859-1', () => {
  it('codifica i caratteri accentati in latin1 sul filo', () => {
    const bytes = serializeMethodCall('setValue', ['Wohnzimmer Tür', 'café']);
    // ü = 0xFC, é = 0xE9 in latin1 (single byte each)
    expect(bytes.includes(0xfc)).toBe(true);
    expect(bytes.includes(0xe9)).toBe(true);
    // and NOT the UTF-8 two-byte sequence 0xC3 0xBC
    const utf8 = Buffer.from('Tür', 'utf-8');
    expect(utf8.includes(0xc3)).toBe(true); // sanity: utf-8 would use 0xC3
    expect(bytes.includes(0xc3)).toBe(false);
  });
});

describe('serializeMethodResponse / serializeFault', () => {
  it('methodResponse incapsula un singolo valore', () => {
    const xml = decodeLatin1(serializeMethodResponse(true));
    expect(xml).toContain('<methodResponse><params><param><value><boolean>1</boolean></value>');
  });

  it('fault serializza faultCode/faultString', () => {
    const xml = decodeLatin1(serializeFault(-32601, 'method not found'));
    expect(xml).toContain('<methodResponse><fault><value><struct>');
    expect(xml).toContain('<name>faultCode</name><value><i4>-32601</i4></value>');
    expect(xml).toContain(
      '<name>faultString</name><value><string>method not found</string></value>',
    );
  });
});
