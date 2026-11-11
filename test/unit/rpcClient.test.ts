// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect, vi } from 'vitest';
import { RpcClient, type RpcTransport } from '../../src/ccu/RpcClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

function makeTransport(): RpcTransport & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    call: vi.fn(async (method: string, params: unknown[]) => {
      calls.push([method, params]);
      if (method === 'system.listMethods') {
        return ['init', 'getValue'];
      }
      if (method === 'getValue') {
        return 42;
      }
      return '';
    }),
    close: vi.fn(async () => undefined),
  };
}

function makeClient(transport?: RpcTransport): RpcClient {
  return new RpcClient({
    interfaceId: 'BidCos-RF',
    host: '127.0.0.1',
    callbackUrl: 'http://example/cb',
    callbackId: 'cbid',
    log: new PrefixedLogger(makeLog(), 'rpc-test'),
    transport,
  });
}

describe('RpcClient', () => {
  it('listDevices and listMethods return arrays, [] for non-array answers', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    expect(await c.listMethods()).toEqual(['init', 'getValue']);
    expect(await c.listDevices()).toEqual([]); // transport answers '' for listDevices
    vi.mocked(t.call).mockResolvedValueOnce([{ ADDRESS: 'X', TYPE: 'T' }]);
    expect(await c.listDevices()).toEqual([{ ADDRESS: 'X', TYPE: 'T' }]);
    vi.mocked(t.call).mockResolvedValueOnce('nope');
    expect(await c.listMethods()).toEqual([]);
    expect(t.calls.map(([m]) => m)).toContain('listDevices');
  });

  it('listMethods probes TCP first and fails fast when the port is closed', async () => {
    const c = new RpcClient({
      interfaceId: 'HmIP-RF',
      host: '127.0.0.1',
      port: 1, // nothing listens on port 1
      callbackUrl: 'http://example/cb',
      callbackId: 'cbid',
      log: new PrefixedLogger(makeLog(), 'rpc-test'),
    });
    await expect(c.listMethods()).rejects.toThrow(/ECONNREFUSED|EACCES|connect/);
  });

  it('subscribe calls init and marks subscribed', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    expect(c.isSubscribed()).toBe(false);
    await c.subscribe();
    expect(c.isSubscribed()).toBe(true);
    expect(t.calls[0]).toEqual(['init', ['http://example/cb', 'cbid']]);
  });

  it('unsubscribe re-calls init with empty id', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    await c.subscribe();
    t.calls.length = 0;
    await c.unsubscribe();
    expect(t.calls[0]).toEqual(['init', ['http://example/cb', '']]);
    expect(c.isSubscribed()).toBe(false);
  });

  it('unsubscribe is a no-op when not subscribed', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    await c.unsubscribe();
    expect(t.calls).toEqual([]);
  });

  it('unsubscribe swallows errors', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    await c.subscribe();
    (t.call as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await expect(c.unsubscribe()).resolves.toBeUndefined();
    expect(c.isSubscribed()).toBe(false);
  });

  it('getValue and setValue forward to transport', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    expect(await c.getValue('HmIP.0:1', 'STATE')).toBe(42);
    await c.setValue('HmIP.0:1', 'STATE', true);
    expect(t.calls.find((c) => c[0] === 'setValue')).toBeDefined();
  });

  it('ping sends the caller id and throws when unreachable', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    await expect(c.ping('me')).resolves.toBeUndefined();
    expect(vi.mocked(t.call).mock.calls.at(-1)).toEqual(['ping', ['me']]);
    vi.mocked(t.call).mockRejectedValueOnce(new Error('Invalid XML-RPC message'));
    await expect(c.ping('me')).rejects.toThrow('Invalid XML-RPC message');
  });

  it('unsubscribes with exactly the same callback URL and an empty id (plan 7.5)', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    await c.unsubscribe(); // not subscribed → no call
    expect(t.calls).toHaveLength(0);
    await c.subscribe();
    await c.unsubscribe();
    expect(t.calls).toEqual([
      ['init', ['http://example/cb', 'cbid']],
      ['init', ['http://example/cb', '']],
    ]);
    expect(c.isSubscribed()).toBe(false);
  });

  it('close releases the transport', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    await c.subscribe();
    await c.close();
    expect(t.close).toHaveBeenCalled();
  });
});

describe('RpcClient TCP reachability probe', () => {
  it('subscribe() rejects fast with a clear message when the port is unreachable', async () => {
    // Use a port we know is closed on localhost (well-known unassigned).
    // No transport is injected so the real probe runs.
    const c = new RpcClient({
      interfaceId: 'BidCos-RF',
      host: '127.0.0.1',
      port: 1, // privileged + unbound -> immediate ECONNREFUSED
      callbackUrl: 'http://example/cb',
      callbackId: 'cbid',
      log: new PrefixedLogger(makeLog(), 'rpc-test'),
    });
    await expect(c.subscribe()).rejects.toThrow(/init failed: connect/);
    expect(c.isSubscribed()).toBe(false);
  });

  it('skips the probe when a test transport is injected', async () => {
    // Transport injection is the contract that lets unit tests bypass real
    // sockets. Verifies the probe stays out of the way for tests.
    const t = makeTransport();
    const c = makeClient(t);
    await expect(c.subscribe()).resolves.toBeUndefined();
    expect(c.isSubscribed()).toBe(true);
  });
});

describe('RpcClient transport options (homematic-xmlrpc 2.0)', () => {
  type Factory = (opts: Record<string, unknown>) => { methodCall: (m: string, p: unknown[], cb: (e: Error | null, v?: unknown) => void) => void };
  async function capture(tls: boolean, auth?: { username: string; password: string }) {
    const seen: { factory?: string; opts?: Record<string, unknown> } = {};
    const fake = (name: string): Factory => (opts) => {
      seen.factory = name;
      seen.opts = opts;
      return { methodCall: (_m, _p, cb) => cb(null, ['x']) };
    };
    const api = { createClient: fake('createClient'), createSecureClient: fake('createSecureClient') };
    // ensureTransport() imports homematic-xmlrpc lazily, so doMock applies.
    vi.doMock('homematic-xmlrpc', () => ({ ...api, default: api }));
    const c = new RpcClient({
      interfaceId: 'HmIP-RF', host: '10.0.0.2', callbackUrl: 'http://cb', callbackId: 'id',
      log: new PrefixedLogger(makeLog(), 'rpc-test'), skipProbe: true, tls, ...(auth ? { auth } : {}),
    });
    expect(await c.listMethods()).toEqual(['x']);
    vi.doUnmock('homematic-xmlrpc');
    return seen;
  }

  it('uses plain HTTP on the default port', async () => {
    const seen = await capture(false);
    expect(seen.factory).toBe('createClient');
    expect(seen.opts).toEqual({ host: '10.0.0.2', port: 2010 });
  });

  it('uses HTTPS on 42010, accepts the self-signed cert, sends Basic auth', async () => {
    const seen = await capture(true, { username: 'u', password: 'p' });
    expect(seen.factory).toBe('createSecureClient');
    expect(seen.opts).toEqual({
      host: '10.0.0.2', port: 42010, rejectUnauthorized: false, basic_auth: { user: 'u', pass: 'p' },
    });
  });
});

describe('RpcClient.getParamsetDescription', () => {
  it('asks for the VALUES paramset and returns {} for non-objects', async () => {
    const t = makeTransport();
    const c = makeClient(t);
    vi.mocked(t.call).mockResolvedValueOnce({ STATE: { TYPE: 'BOOL', OPERATIONS: 7 } });
    expect(await c.getParamsetDescription('OEQ0000001:1')).toEqual({ STATE: { TYPE: 'BOOL', OPERATIONS: 7 } });
    expect(vi.mocked(t.call).mock.calls.at(-1)).toEqual(['getParamsetDescription', ['OEQ0000001:1', 'VALUES']]);
    vi.mocked(t.call).mockResolvedValueOnce([]);
    expect(await c.getParamsetDescription('OEQ0000001:1')).toEqual({});
  });
});
