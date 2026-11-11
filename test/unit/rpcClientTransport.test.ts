// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Forces the RpcClient to take its lazy-load path through the
 * homematic-xmlrpc module by stubbing the module via vi.mock.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('homematic-xmlrpc', () => {
  return {
    createClient: vi.fn(() => ({
      methodCall: (method: string, _params: unknown[], cb: (err: Error | null, value: unknown) => void) => {
        if (method === 'system.listMethods') {
          cb(null, ['init']);
        } else if (method === 'init') {
          cb(null, '');
        } else if (method === 'fail') {
          cb(new Error('boom'), null);
        } else if (method === 'getValue') {
          cb(null, 17);
        } else {
          cb(null, '');
        }
      },
    })),
  };
});

import { RpcClient } from '../../src/ccu/RpcClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

function makeClient(): RpcClient {
  return new RpcClient({
    interfaceId: 'BidCos-RF',
    host: '127.0.0.1',
    callbackUrl: 'http://example/cb',
    callbackId: 'cbid',
    log: new PrefixedLogger(makeLog(), 'rpc'),
    // The vi.mock of homematic-xmlrpc replaces the methodCall path, so
    // the test never opens a real socket — opt out of the pre-init TCP
    // probe (which would still try 127.0.0.1:2001).
    skipProbe: true,
  });
}

describe('RpcClient lazy-loaded transport', () => {
  it('subscribe then ping then getValue use the real (mocked) module', async () => {
    const c = makeClient();
    await c.subscribe();
    expect(c.isSubscribed()).toBe(true);
    await expect(c.ping('caller')).resolves.toBeUndefined();
    expect(await c.getValue('addr', 'STATE')).toBe(17);
    await c.setValue('addr', 'STATE', true);
  });

  it('rejects errors as RpcError', async () => {
    const c = makeClient();
    const transport = await (c as unknown as { ensureTransport(): Promise<{ call(m: string, p: unknown[]): Promise<unknown> }> }).ensureTransport();
    await expect(transport.call('fail', [])).rejects.toThrow(/RpcError|fail|boom/);
  });
});
