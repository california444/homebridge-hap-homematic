import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InterfaceSupervisor, type InterfaceState } from '../../src/ccu/InterfaceSupervisor.js';
import type { RpcClient } from '../../src/ccu/RpcClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-11T11:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * A scripted CCU interface. `phase` decides how ping / init behave, like
 * the phases of the CCU restart in plan 3.1, finding 14.
 */
type Phase = 'up' | 'timeout' | 'refused' | 'booting' | 'upNoRegistration';

function fakeCcu(initial: Phase = 'up') {
  const ccu = {
    phase: initial as Phase,
    /** Is our registration alive on the CCU side? */
    registered: false,
    callsBack: true,
    sup: undefined as InterfaceSupervisor | undefined,
  };
  const fail = (): Error | undefined => {
    switch (ccu.phase) {
      case 'timeout': return new Error('ping failed: timeout after 15000 ms');
      case 'refused': return new Error('ping failed: connect ECONNREFUSED 10.0.0.2:2010');
      case 'booting': return new Error('ping failed: Invalid XML-RPC message');
      default: return undefined;
    }
  };
  const client = {
    interfaceId: 'HmIP-RF',
    ping: vi.fn(async () => {
      const e = fail();
      if (e) throw e;
      // Only a live registration produces the PONG event.
      if (ccu.registered && ccu.phase === 'up') {
        ccu.sup?.noteActivity('pong');
      }
    }),
    subscribe: vi.fn(async () => {
      const e = fail();
      if (e) throw new Error(e.message.replace('ping', 'init'));
      if (ccu.callsBack) {
        ccu.sup?.noteActivity('listDevices'); // CCU calls listDevices before init returns
      }
      ccu.registered = true;
      ccu.phase = 'up';
    }),
    unsubscribe: vi.fn(async () => { ccu.registered = false; }),
    close: vi.fn(async () => undefined),
  };
  return { ccu, client: client as unknown as RpcClient & typeof client };
}

function makeSup(client: RpcClient, ccu: { sup?: InterfaceSupervisor }) {
  const log = new PrefixedLogger(makeLog(), 'link');
  const spies = {
    info: vi.spyOn(log, 'info'),
    warn: vi.spyOn(log, 'warn'),
    error: vi.spyOn(log, 'error'),
    debug: vi.spyOn(log, 'debug'),
  };
  const sup = new InterfaceSupervisor({ client, log, pingId: 'me', callbackUrl: 'http://10.0.0.13:9875' });
  ccu.sup = sup;
  const states: InterfaceState[] = [];
  const subs: string[] = [];
  sup.on('state', (s) => states.push(s));
  sup.on('subscribed', (r) => subs.push(r));
  return { sup, spies, states, subs };
}

const minutes = (m: number) => vi.advanceTimersByTimeAsync(m * 60_000);
const seconds = (s: number) => vi.advanceTimersByTimeAsync(s * 1000);

describe('InterfaceSupervisor', () => {
  it('connects, pings every 60 s and stays CONNECTED while PONGs arrive', async () => {
    const { ccu, client } = fakeCcu();
    const { sup, states, subs, spies } = makeSup(client, ccu);
    await sup.start();
    expect(sup.state).toBe('CONNECTED');
    expect(subs).toEqual(['initial']);
    await minutes(10);
    expect(client.ping).toHaveBeenCalledTimes(10);
    expect(client.ping).toHaveBeenCalledWith('me');
    expect(client.subscribe).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['CONNECTING', 'CONNECTED']);
    expect(spies.error).not.toHaveBeenCalled();
    await sup.start(); // no-op while running
    expect(client.subscribe).toHaveBeenCalledTimes(1);
  });

  it('CCU restart (finding 14): DISCONNECTED on failing pings, init at once when ping works again', async () => {
    const { ccu, client } = fakeCcu();
    const { sup, states, subs, spies } = makeSup(client, ccu);
    await sup.start();
    await seconds(30);

    ccu.phase = 'timeout'; // CCU shuts down
    ccu.registered = false;
    await seconds(35); // next ping at 60 s fails
    expect(sup.state).toBe('DISCONNECTED');
    ccu.phase = 'refused';
    await seconds(30);
    ccu.phase = 'booting';
    await seconds(30);
    expect(sup.state).toBe('DISCONNECTED');
    // still one warning for the whole outage (log on state change only)
    expect(spies.warn.mock.calls.filter((c) => String(c[0]).includes('unreachable'))).toHaveLength(1);
    expect(spies.debug.mock.calls.some((c) => String(c[2]).includes('Invalid XML-RPC message'))).toBe(true);

    ccu.phase = 'upNoRegistration'; // ping answers again, registration lost
    await seconds(15); // retry every 15 s after a first connect
    expect(sup.state).toBe('CONNECTED');
    expect(subs).toEqual(['initial', 'reconnect']);
    expect(ccu.registered).toBe(true);
    expect(states).toEqual(['CONNECTING', 'CONNECTED', 'DISCONNECTED', 'CONNECTED']);
    expect(spies.info.mock.calls.some((c) => String(c[2]).includes('was DISCONNECTED'))).toBe(true);
  });

  it('ping OK but no PONG and no events for 90 s → STALE → init', async () => {
    const { ccu, client } = fakeCcu();
    const { sup, states, subs, spies } = makeSup(client, ccu);
    await sup.start();
    ccu.registered = false; // CCU forgot us, but still answers ping
    await seconds(95);
    expect(states).toEqual(['CONNECTING', 'CONNECTED', 'STALE', 'CONNECTED']);
    expect(subs).toEqual(['initial', 'stale']);
    expect(spies.warn.mock.calls.some((c) => String(c[0]).includes('no PONG and no events'))).toBe(true);
  });

  it('other callbacks (events, foreign PONGs) count as signs of life', async () => {
    const { ccu, client } = fakeCcu();
    const { sup, subs } = makeSup(client, ccu);
    await sup.start();
    ccu.registered = false; // no own PONG any more …
    for (let i = 0; i < 10; i++) {
      await seconds(30);
      sup.noteActivity('event'); // … but events keep coming
    }
    expect(subs).toEqual(['initial']);
  });

  it('a STALE re-init that fails goes DISCONNECTED', async () => {
    const { ccu, client } = fakeCcu();
    const { sup, states } = makeSup(client, ccu);
    await sup.start();
    ccu.registered = false;
    client.subscribe.mockRejectedValueOnce(new Error('init failed: fault'));
    await seconds(95);
    expect(states.slice(-2)).toEqual(['STALE', 'DISCONNECTED']);
  });

  it('delayed HMIPServer: backoff 5 s → 5 min before the first connect', async () => {
    const { ccu, client } = fakeCcu('refused');
    const { sup, spies, subs } = makeSup(client, ccu);
    const start = Date.now();
    await sup.start();
    expect(sup.state).toBe('DISCONNECTED');
    expect(spies.warn.mock.calls.some((c) => String(c[0]).startsWith('Hint:'))).toBe(true);
    // Waits 5, 10, 20, 40, 80, 160, 300, 300 … s → attempts at
    // 5, 15, 35, 75, 155, 315, 615, 915 s after the first failure.
    const at: number[] = [];
    const scripted = client.ping.getMockImplementation()!;
    client.ping.mockImplementation(async () => {
      at.push(Math.round((Date.now() - start) / 1000));
      throw new Error('ping failed: connect ECONNREFUSED');
    });
    await seconds(16 * 60);
    expect(at).toEqual([5, 15, 35, 75, 155, 315, 615, 915]);
    client.ping.mockImplementation(scripted); // answers with PONG once registered
    ccu.phase = 'up';
    await minutes(6);
    expect(sup.state).toBe('CONNECTED');
    expect(subs).toEqual(['initial']);
  });

  it('logs a clear error when the CCU never calls back after init (handshake)', async () => {
    const { ccu, client } = fakeCcu();
    ccu.callsBack = false;
    const { sup, spies } = makeSup(client, ccu);
    await sup.start();
    await seconds(20);
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(String(spies.error.mock.calls[0]![3])).toBe('http://10.0.0.13:9875');
    await seconds(60);
    expect(spies.error).toHaveBeenCalledTimes(1); // once per subscribe
  });

  it('stop() unsubscribes a live interface and closes the client', async () => {
    const { ccu, client } = fakeCcu();
    const { sup } = makeSup(client, ccu);
    await sup.start();
    await sup.stop();
    expect(sup.state).toBe('STOPPED');
    expect(client.unsubscribe).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    await minutes(5);
    expect(client.ping).not.toHaveBeenCalled();
  });

  it('stop() of a disconnected interface does not try to unsubscribe', async () => {
    const { ccu, client } = fakeCcu('refused');
    const { sup } = makeSup(client, ccu);
    await sup.start();
    await sup.stop();
    expect(client.unsubscribe).not.toHaveBeenCalled();
  });

  it('skips a tick while an operation is still running and survives tick errors', async () => {
    const { ccu, client } = fakeCcu();
    const { sup, spies } = makeSup(client, ccu);
    await sup.start();
    let release: () => void = () => undefined;
    client.ping.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    await seconds(65); // ping hangs
    await seconds(10); // ticks while busy are skipped
    expect(client.ping).toHaveBeenCalledTimes(1);
    release();
    await seconds(1);
    // A throwing tick is caught and logged at debug level.
    vi.spyOn(sup as unknown as { tick(): Promise<void> }, 'tick').mockRejectedValueOnce(new Error('tick boom'));
    await seconds(5);
    expect(spies.debug.mock.calls.some((c) => String(c[1]).includes('tick boom'))).toBe(true);
  });

  it('measures the handshake from the start of init (listDevices arrives during init)', async () => {
    const { ccu, client } = fakeCcu('up');
    const { sup, spies } = makeSup(client, ccu);
    await sup.start();
    const line = spies.debug.mock.calls.find((c) => String(c[0]).includes('handshake'));
    expect(line).toBeDefined();
    expect(Number(line![2])).toBeLessThan(1000);
    await sup.stop();
  });
});
