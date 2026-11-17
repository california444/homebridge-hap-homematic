import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SendQueue, SendTimeoutError, type SendJob } from '../../src/ccu/SendQueue.js';
import { CcuClient, SetValueError } from '../../src/ccu/CcuClient.js';
import { switchService } from '../../src/services/impl/SwitchAccessory.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import type { CcuChannel } from '../../src/types.js';
import { makeLog } from '../helpers/hapStub.js';
import { build, makeSvcEnv } from '../helpers/svcEnv.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function queue(opts: { timeoutMs?: number; gapMs?: number } = {}) {
  return new SendQueue({ log: new PrefixedLogger(makeLog(), 'send'), timeoutMs: opts.timeoutMs ?? 5000, gapMs: opts.gapMs ?? 100 });
}

/** A job whose run() stays open until resolve()/reject() is called. */
function pending(key: string, events: string[]) {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const errors: Array<{ err: unknown; ms: number }> = [];
  const job: SendJob = {
    key,
    label: key,
    run: () => {
      events.push(`start ${key}`);
      return new Promise<void>((res, rej) => {
        resolve = () => { events.push(`end ${key}`); res(); };
        reject = (e) => { events.push(`fail ${key}`); rej(e); };
      });
    },
    onError: (err, ms) => errors.push({ err, ms }),
  };
  return { job, errors, resolve: () => resolve(), reject: (e: Error) => reject(e) };
}

describe('SendQueue', () => {
  it('runs one job at a time and waits gapMs after a success', async () => {
    const q = queue();
    const ev: string[] = [];
    const a = pending('a', ev);
    const b = pending('b', ev);
    q.enqueue(a.job);
    q.enqueue(b.job);
    expect(ev).toEqual(['start a']);
    a.resolve();
    await vi.advanceTimersByTimeAsync(99);
    expect(ev).toEqual(['start a', 'end a']);
    await vi.advanceTimersByTimeAsync(1);
    expect(ev).toEqual(['start a', 'end a', 'start b']);
    b.resolve();
    await q.idle();
  });

  it('goes on at once after a failure and reports it', async () => {
    const q = queue();
    const ev: string[] = [];
    const a = pending('a', ev);
    const b = pending('b', ev);
    q.enqueue(a.job);
    q.enqueue(b.job);
    await vi.advanceTimersByTimeAsync(1200);
    a.reject(new Error('setValue failed: Generic error (UNREACH) (-1)'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ev).toEqual(['start a', 'fail a', 'start b']);
    expect(a.errors).toHaveLength(1);
    expect(a.errors[0]!.ms).toBe(1200);
    b.resolve();
    await q.idle();
  });

  it('gives up after timeoutMs and goes on at once', async () => {
    const q = queue({ timeoutMs: 5000 });
    const ev: string[] = [];
    const a = pending('a', ev);
    const b = pending('b', ev);
    q.enqueue(a.job);
    q.enqueue(b.job);
    await vi.advanceTimersByTimeAsync(4999);
    expect(ev).toEqual(['start a']);
    await vi.advanceTimersByTimeAsync(1);
    expect(ev).toEqual(['start a', 'start b']);
    expect(a.errors[0]!.err).toBeInstanceOf(SendTimeoutError);
    expect(a.errors[0]!.ms).toBe(5000);
    a.resolve(); // late answer: ignored
    b.resolve();
    await q.idle();
    expect(a.errors).toHaveLength(1);
  });

  it('a new job for a waiting key replaces it in place', async () => {
    const q = queue({ gapMs: 0 });
    const ev: string[] = [];
    const run = pending('run', ev);
    q.enqueue(run.job);
    const sent: string[] = [];
    const job = (key: string, v: string): SendJob => ({
      key, label: v, run: async () => { sent.push(v); }, onError: () => undefined,
    });
    q.enqueue(job('LEVEL', 'L 0.1'));
    q.enqueue(job('STATE', 'S on'));
    q.enqueue(job('LEVEL', 'L 0.5'));
    q.enqueue(job('LEVEL', 'L 0.9'));
    expect(q.size).toBe(2);
    run.resolve();
    await q.idle();
    expect(sent).toEqual(['L 0.9', 'S on']);
  });

  it('gapMs 0: no pause', async () => {
    const q = queue({ gapMs: 0 });
    const sent: number[] = [];
    for (let i = 0; i < 3; i++) {
      q.enqueue({ key: String(i), label: String(i), run: async () => { sent.push(i); }, onError: () => undefined });
    }
    await q.idle();
    expect(sent).toEqual([0, 1, 2]);
  });

  it('stop() drops waiting jobs and refuses new ones until start()', async () => {
    const q = queue();
    const ev: string[] = [];
    const a = pending('a', ev);
    const b = pending('b', ev);
    q.enqueue(a.job);
    q.enqueue(b.job);
    q.stop();
    a.resolve();
    await q.idle();
    expect(ev).toEqual(['start a', 'end a']);
    q.enqueue(pending('c', ev).job);
    expect(ev).toEqual(['start a', 'end a']);
    q.start();
    const d = pending('d', ev);
    q.enqueue(d.job);
    expect(ev.at(-1)).toBe('start d');
    d.resolve();
    await q.idle();
  });
});

describe('CcuClient send queue', () => {
  function makeCcu(sendQueue?: object): CcuClient {
    const config = resolveConfig({
      platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' },
      ...(sendQueue ? { sendQueue } : {}),
    });
    return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'ccu') });
  }

  it('never sends two setValue at once, across both interfaces', async () => {
    const ccu = makeCcu();
    let open = 0;
    let maxOpen = 0;
    const order: string[] = [];
    vi.spyOn(ccu as unknown as { clientFor(a: string): unknown }, 'clientFor').mockReturnValue({
      setValue: async (a: string) => {
        open++;
        maxOpen = Math.max(maxOpen, open);
        order.push(a);
        await new Promise((r) => setTimeout(r, 300));
        open--;
      },
    });
    const addresses = ['OEQ0000001:1', '000A0000000B02:1', 'OEQ0000002:1', '000A0000000B03:4', 'OEQ0000003:1'];
    for (const a of addresses) {
      await ccu.setValue(a, 'STATE', true); // returns at once
    }
    expect(order).toEqual([addresses[0]]);
    await vi.advanceTimersByTimeAsync(5 * 300 + 4 * 100);
    await ccu.sendQueue.idle();
    expect(order).toEqual(addresses);
    expect(maxOpen).toBe(1);
  });

  it('reports a timeout as SetValueError with timedOut', async () => {
    const ccu = makeCcu({ timeoutMs: 2000 });
    vi.spyOn(ccu as unknown as { clientFor(a: string): unknown }, 'clientFor').mockReturnValue({
      setValue: () => new Promise(() => undefined),
    });
    const reported: SetValueError[] = [];
    ccu.setOwner('OEQ0000001:1', (e) => reported.push(e));
    await ccu.setValue('OEQ0000001:1', 'LEVEL', 0.5);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reported[0]).toMatchObject({ datapoint: 'LEVEL', value: 0.5, timedOut: true, durationMs: 2000 });
  });
});

describe('CcuClient.setOwner', () => {
  it('the first owner keeps an address; release frees it', () => {
    const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } });
    const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'ccu') });
    const owners = (ccu as unknown as { owners: Map<string, unknown> }).owners;
    const a = (): void => undefined;
    const b = (): void => undefined;
    const offA = ccu.setOwner('X:1', a);
    const offB = ccu.setOwner('X:1', b);
    expect(owners.get('X:1')).toBe(a);
    offB(); // not the owner: no effect
    expect(owners.get('X:1')).toBe(a);
    offA();
    expect(owners.has('X:1')).toBe(false);
  });
});

describe('failed commands from the queue in the log', () => {
  const ch: CcuChannel = { address: 'ABC0000001:14', index: 14, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'K' };

  it('HomeKit gets its answer at once; the failure is logged with name and duration', async () => {
    const env = makeSvcEnv();
    env.setValue.mockRestore();
    env.setValues.mockRestore();
    const raw = makeLog();
    env.log = new PrefixedLogger(raw, 'svc:SwitchAccessory:ABC0000001:14');
    vi.spyOn(env.ccu as unknown as { clientFor(a: string): unknown }, 'clientFor').mockReturnValue({
      setValue: () => new Promise((_, rej) => setTimeout(() => rej(new Error('setValue failed: Failure (-1)')), 1200)),
    });
    env.values['ABC0000001:0'] = { RSSI_DEVICE: -72 };
    const a = build(env, switchService, ch, { name: 'Garten Licht' });
    await a.char(a.svc('Switch'), 'On').onSetHandler!(true); // resolves, no HAP error
    await vi.advanceTimersByTimeAsync(1200);
    await vi.waitFor(() => expect(raw.warn).toHaveBeenCalled());
    const [fmt, ...args] = (raw.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string, ...unknown[]];
    let i = 0;
    expect(fmt.replace(/%s/g, () => String(args[i++]))).toBe(
      '[svc:SwitchAccessory:ABC0000001:14] Garten Licht: STATE=true not delivered after 1.2 s, (Failure (-1)) '
      + 'last known signal:-72 dBm(CCU)');
  });

  it('names the accessory for its command channel it does not listen on (paired HmIP channels)', async () => {
    const env = makeSvcEnv();
    env.setValue.mockRestore();
    env.setValues.mockRestore();
    const raw = makeLog();
    env.log = new PrefixedLogger(raw, 'svc:SwitchAccessory:00021A49A609DA:3');
    vi.spyOn(env.ccu as unknown as { clientFor(a: string): unknown }, 'clientFor').mockReturnValue({
      setValue: () => Promise.reject(new Error('setValue failed: Generic error (UNREACH) (-1)')),
    });
    const paired: CcuChannel = { address: '00021A49A609DA:3', stateAddress: '00021A49A609DA:2', index: 3,
      type: 'SWITCH_VIRTUAL_RECEIVER', name: 'K' };
    const a = build(env, switchService, paired, { name: 'Steckdose' });
    await a.char(a.svc('Switch'), 'On').onSetHandler!(true);
    await vi.waitFor(() => expect(raw.warn).toHaveBeenCalled());
    expect(String((raw.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1])).toBe('Steckdose');
  });

  it('dispose() releases the addresses', () => {
    const env = makeSvcEnv();
    const a = build(env, switchService, ch, { name: 'Licht' });
    const owners = (env.ccu as unknown as { owners: Map<string, unknown> }).owners;
    expect(owners.has('ABC0000001:14')).toBe(true);
    a.handler.dispose();
    expect(owners.size).toBe(0);
  });

  it('a timeout gets its own wording', async () => {
    const env = makeSvcEnv();
    env.setValue.mockRestore();
    env.setValues.mockRestore();
    const raw = makeLog();
    env.log = new PrefixedLogger(raw, 'svc:SwitchAccessory:ABC0000001:14');
    vi.spyOn(env.ccu as unknown as { clientFor(a: string): unknown }, 'clientFor').mockReturnValue({
      setValue: () => new Promise(() => undefined),
    });
    const a = build(env, switchService, ch, { name: 'Licht' });
    await a.char(a.svc('Switch'), 'On').onSetHandler!(false);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(raw.warn).toHaveBeenCalled());
    const [fmt, ...args] = (raw.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string, ...unknown[]];
    let i = 0;
    expect(fmt.replace(/%s/g, () => String(args[i++]))).toBe(
      '[svc:SwitchAccessory:ABC0000001:14] Licht: STATE=false no answer from the CCU within 5.0 s (it may still be sent)');
  });
});
