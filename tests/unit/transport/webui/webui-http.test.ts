import { describe, it, expect } from 'vitest';
import {
  WebUiHttpClient,
  jsEscape,
  type WebUiFetch,
} from '../../../../src/transport/webui/webui-http.js';
import { CcuManagementError } from '../../../../src/support/errors.js';

interface Seen {
  url: string;
  method: string;
  body: string | undefined;
  contentType: string | undefined;
}

function make(respond: (seen: Seen) => { status: number; text: string } | Error): {
  client: WebUiHttpClient;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetchFn: WebUiFetch = (url, init) => {
    const entry: Seen = {
      url,
      method: init.method,
      body: init.body,
      contentType: init.headers['Content-Type'],
    };
    seen.push(entry);
    const out = respond(entry);
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve({ status: out.status, text: () => Promise.resolve(out.text) });
  };
  return { client: new WebUiHttpClient({ url: 'http://ccu/', fetch: fetchFn }), seen };
}

describe('jsEscape (the WebUI uses JS escape())', () => {
  it('matches escape() for ASCII, latin1 and BMP characters', () => {
    expect(jsEscape('Büro 1/2 @_-.*+')).toBe('B%FCro%201/2%20@_-.*+');
    expect(jsEscape('€')).toBe('%u20AC');
  });
});

describe('WebUiHttpClient', () => {
  it('POSTs the raw JSON body with the sid in the query', async () => {
    const { client, seen } = make(() => ({ status: 200, text: '{"isSuccessful":true}' }));
    await expect(client.post('/pages/jpages/group/save', 'SID', '{"a":1}')).resolves.toBe(
      '{"isSuccessful":true}',
    );
    expect(seen[0]).toMatchObject({
      url: 'http://ccu/pages/jpages/group/save?sid=SID',
      method: 'POST',
      body: '{"a":1}',
    });
  });

  it('GETs a page', async () => {
    const { client, seen } = make(() => ({ status: 200, text: 'x' }));
    await client.get('/pages/jpages/group/create', 'SID');
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: 'http://ccu/pages/jpages/group/create?sid=SID',
    });
  });

  it('errors name the path and status but never the session id', async () => {
    const http = make(() => ({ status: 500, text: 'boom SID' }));
    const err = await http.client.get('/pages/jpages/group/create', 'SID').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CcuManagementError);
    expect(String((err as Error).message)).toContain('/pages/jpages/group/create');
    expect(String((err as Error).message)).toContain('500');
    expect(String((err as Error).message)).not.toContain('SID');
    const net = make(() => new Error('connect ECONNREFUSED http://ccu/x?sid=SID'));
    const err2 = await net.client.post('/p', 'SID', '{}').catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(CcuManagementError);
    expect(String((err2 as Error).message)).not.toContain('SID');
  });
});
