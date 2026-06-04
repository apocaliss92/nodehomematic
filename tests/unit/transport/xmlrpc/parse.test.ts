import { describe, it, expect } from 'vitest';
import { parseXmlRpc, EmptyBodyError } from '../../../../src/transport/xmlrpc/parse.js';
import type {
  XmlRpcFault,
  XmlRpcMethodCall,
  XmlRpcValue,
} from '../../../../src/transport/xmlrpc/types.js';

const resp = (inner: string): string =>
  `<?xml version="1.0"?><methodResponse><params><param><value>${inner}</value></param></params></methodResponse>`;

function expectResponse(xml: string): XmlRpcValue {
  const parsed = parseXmlRpc(xml);
  if (parsed.kind !== 'response') throw new Error(`expected response, got ${parsed.kind}`);
  return parsed.value;
}

describe('parseXmlRpc — methodResponse values per tipo', () => {
  it('i4 / int / i8 → number', () => {
    expect(expectResponse(resp('<i4>42</i4>'))).toBe(42);
    expect(expectResponse(resp('<int>7</int>'))).toBe(7);
    expect(expectResponse(resp('<i8>9007199254740991</i8>'))).toBe(9007199254740991);
  });

  it('double → number', () => {
    expect(expectResponse(resp('<double>3.5</double>'))).toBe(3.5);
  });

  it('boolean → bool', () => {
    expect(expectResponse(resp('<boolean>1</boolean>'))).toBe(true);
    expect(expectResponse(resp('<boolean>0</boolean>'))).toBe(false);
  });

  it('string → string', () => {
    expect(expectResponse(resp('<string>hi</string>'))).toBe('hi');
  });

  it('string con entità decodificate', () => {
    expect(expectResponse(resp('<string>a &amp; b &lt; c</string>'))).toBe('a & b < c');
  });

  it('value senza type tag → string', () => {
    expect(expectResponse(resp('plain text'))).toBe('plain text');
  });

  it('value vuoto senza tag → stringa vuota', () => {
    expect(expectResponse(resp(''))).toBe('');
  });

  it('nil → null', () => {
    expect(expectResponse(resp('<nil/>'))).toBe(null);
  });

  it('dateTime.iso8601 → string', () => {
    expect(expectResponse(resp('<dateTime.iso8601>20200102T03:04:05</dateTime.iso8601>'))).toBe(
      '20200102T03:04:05',
    );
  });

  it('base64 → Uint8Array', () => {
    const v = expectResponse(resp('<base64>AQID</base64>'));
    expect(v).toBeInstanceOf(Uint8Array);
    expect(Array.from(v as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('array → array', () => {
    const xml = resp(
      '<array><data><value><i4>1</i4></value><value><string>x</string></value></data></array>',
    );
    expect(expectResponse(xml)).toEqual([1, 'x']);
  });

  it('array vuoto → []', () => {
    expect(expectResponse(resp('<array><data></data></array>'))).toEqual([]);
  });

  it('struct → object', () => {
    const xml = resp(
      '<struct>' +
        '<member><name>ON</name><value><boolean>1</boolean></value></member>' +
        '<member><name>LEVEL</name><value><double>0.5</double></value></member>' +
        '</struct>',
    );
    expect(expectResponse(xml)).toEqual({ ON: true, LEVEL: 0.5 });
  });

  it('struct con un solo membro', () => {
    const xml = resp('<struct><member><name>A</name><value><i4>1</i4></value></member></struct>');
    expect(expectResponse(xml)).toEqual({ A: 1 });
  });

  it('struct annidato in array (listDevices-like)', () => {
    const xml = resp(
      '<array><data>' +
        '<value><struct><member><name>ADDRESS</name><value><string>VCU001</string></value></member></struct></value>' +
        '</data></array>',
    );
    expect(expectResponse(xml)).toEqual([{ ADDRESS: 'VCU001' }]);
  });
});

describe('parseXmlRpc — fault', () => {
  it('ritorna {faultCode, faultString}', () => {
    const xml =
      '<?xml version="1.0"?><methodResponse><fault><value><struct>' +
      '<member><name>faultCode</name><value><i4>-1</i4></value></member>' +
      '<member><name>faultString</name><value><string>Unauthorized</string></value></member>' +
      '</struct></value></fault></methodResponse>';
    const parsed = parseXmlRpc(xml);
    expect(parsed.kind).toBe('fault');
    const fault = (parsed as { fault: XmlRpcFault }).fault;
    expect(fault.faultCode).toBe(-1);
    expect(fault.faultString).toBe('Unauthorized');
  });
});

describe('parseXmlRpc — methodCall (callback server)', () => {
  it('ritorna {methodName, params}', () => {
    const xml =
      '<?xml version="1.0"?><methodCall><methodName>event</methodName><params>' +
      '<param><value><string>MyCCU-HmIP-RF</string></value></param>' +
      '<param><value><string>VCU001:1</string></value></param>' +
      '<param><value><string>STATE</string></value></param>' +
      '<param><value><boolean>1</boolean></value></param>' +
      '</params></methodCall>';
    const parsed = parseXmlRpc(xml);
    expect(parsed.kind).toBe('call');
    const call = (parsed as { call: XmlRpcMethodCall }).call;
    expect(call.methodName).toBe('event');
    expect(call.params).toEqual(['MyCCU-HmIP-RF', 'VCU001:1', 'STATE', true]);
  });

  it('methodCall senza params → params vuoto', () => {
    const xml = '<methodCall><methodName>listMethods</methodName></methodCall>';
    const parsed = parseXmlRpc(xml);
    expect(parsed.kind).toBe('call');
    expect((parsed as { call: XmlRpcMethodCall }).call.params).toEqual([]);
  });
});

describe('parseXmlRpc — robustezza', () => {
  it('body vuoto → EmptyBodyError', () => {
    expect(() => parseXmlRpc('')).toThrow(EmptyBodyError);
    expect(() => parseXmlRpc('   ')).toThrow(EmptyBodyError);
  });

  it('XML non riconoscibile come rpc → throw', () => {
    expect(() => parseXmlRpc('<html><body>oops</body></html>')).toThrow();
  });

  it('accetta input come Buffer latin1 con accenti', () => {
    const xml = resp('<string>café</string>');
    const buf = Buffer.from(xml.replace('café', 'café'), 'latin1');
    expect(parseXmlRpc(buf)).toBeDefined();
  });
});
