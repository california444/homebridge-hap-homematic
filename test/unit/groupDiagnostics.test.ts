import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GroupDiagnostics,
  isGroupAddress,
  CHECK_DELAY_MS,
  ATTRIBUTE_WINDOW_MS,
} from '../../src/ccu/GroupDiagnostics.js';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { RpcClient } from '../../src/ccu/RpcClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Log lines with the arguments filled in (like Homebridge prints them). */
function setup(values: Record<string, Record<string, unknown> | undefined> = {}) {
  const raw = makeLog();
  const lines: string[] = [];
  vi.mocked(raw.info).mockImplementation((msg: string, ...args: unknown[]) => {
    let i = 0;
    lines.push(msg.replace(/%[sd]/g, () => String(args[i++])));
  });
  const getValue = vi.fn(async (_a: string, _dp: string): Promise<unknown> => 21);
  const readValues = vi.fn(async (a: string) => values[a]);
  const diag = new GroupDiagnostics({
    log: new PrefixedLogger(raw, 'groups'),
    readValues,
    getValue,
  });
  return { diag, lines, getValue, readValues };
}

describe('GroupDiagnostics (plan-gruppen 3.9)', () => {
  it('recognises group addresses only', () => {
    expect(isGroupAddress('INT0000001')).toBe(true);
    expect(isGroupAddress('INT0000001:1')).toBe(true);
    expect(isGroupAddress('OEQ0000001:1')).toBe(false);
    expect(isGroupAddress('00000000000A01:1')).toBe(false);
  });

  it('ignores other addresses', () => {
    const { diag, lines } = setup();
    expect(diag.onSend('OEQ0000001:1', 'SET_TEMPERATURE', 21)).toBeUndefined();
    diag.onEvent('OEQ0000001:1', 'SET_TEMPERATURE', 21);
    diag.onSendResult(undefined);
    expect(lines).toEqual([]);
  });

  it('setValue → events with delay → getParamset check after 3 s', async () => {
    vi.useFakeTimers();
    const { diag, lines } = setup({ 'INT0000001:1': { SET_POINT_TEMPERATURE: 21.5 } });
    const n = diag.onSend('INT0000001:1', 'SET_POINT_TEMPERATURE', 21.5);
    expect(n).toBe(1);
    vi.advanceTimersByTime(40);
    diag.onSendResult(n);
    vi.advanceTimersByTime(272);
    diag.onEvent('INT0000001:1', 'SET_POINT_TEMPERATURE', 21.5);
    diag.onEvent('INT0000001:1', 'ACTUAL_TEMPERATURE', 19.5);
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(lines).toEqual([
      '[groups] [group-diag] #1 setValue INT0000001:1 SET_POINT_TEMPERATURE=21.5',
      '[groups] [group-diag] #1 setValue OK after 40 ms',
      '[groups] [group-diag] event INT0000001:1 SET_POINT_TEMPERATURE=21.5 +312ms after #1',
      '[groups] [group-diag] event INT0000001:1 ACTUAL_TEMPERATURE=19.5 +312ms after #1',
      '[groups] [group-diag] #1 check after 3000 ms: getParamset SET_POINT_TEMPERATURE=21.5 (written 21.5, events 1)',
    ]);
  });

  it('no echo: check shows 0 events; failures and missing values are logged', async () => {
    vi.useFakeTimers();
    const { diag, lines } = setup({ 'INT0000002:1': { SET_TEMPERATURE: '20.0' } });
    const n = diag.onSend('INT0000002:1', 'MANU_MODE', 22);
    diag.onSendResult(n, new Error('setValue failed: Generic error (-1)'));
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(lines.slice(1)).toEqual([
      '[groups] [group-diag] #1 setValue failed after 0 ms: setValue failed: Generic error (-1)',
      '[groups] [group-diag] #1 check after 3000 ms: getParamset MANU_MODE=(missing) (written 22, events 0)',
    ]);
  });

  it('events later than the window are not attributed', () => {
    vi.useFakeTimers();
    const { diag, lines } = setup();
    diag.onSend('INT0000001:1', 'SET_POINT_TEMPERATURE', 21);
    vi.advanceTimersByTime(ATTRIBUTE_WINDOW_MS + 1);
    diag.onEvent('INT0000001:1', 'SET_POINT_TEMPERATURE', 21);
    expect(lines.at(-1)).toBe('[groups] [group-diag] event INT0000001:1 SET_POINT_TEMPERATURE=21');
    diag.dispose();
  });

  it('probe: getValue next to getParamset, mode and humidity, once per channel', async () => {
    const { diag, lines, getValue } = setup({
      'INT0000001:1': { SET_POINT_TEMPERATURE: 21, HUMIDITY: 0 },
      'INT0000002:1': { SET_TEMPERATURE: '20.0', CONTROL_MODE: '1', ACTUAL_HUMIDITY: '20.0' },
    });
    getValue.mockImplementation(async (a: string) => {
      if (a === 'INT0000002:1') throw new Error('getValue failed: Unknown (-5)');
      return 21;
    });
    await diag.probe(['INT0000001:1', 'INT0000002:1', 'INT0000003:1', 'OEQ0000001:1']);
    await diag.probe(['INT0000001:1']);
    expect(lines).toEqual([
      '[groups] [group-diag] start INT0000001:1 SET_POINT_TEMPERATURE getParamset=21 getValue ok 21; SET_POINT_MODE=(missing); HUMIDITY=0',
      '[groups] [group-diag] start INT0000002:1 SET_TEMPERATURE getParamset="20.0" getValue failed (getValue failed: Unknown (-5)); CONTROL_MODE="1"; ACTUAL_HUMIDITY="20.0"',
      '[groups] [group-diag] start INT0000003:1 getParamset failed',
    ]);
    expect(getValue).toHaveBeenCalledTimes(2);
  });

  it('logs the init duration', () => {
    const { diag, lines } = setup();
    diag.onInit('initial', 42);
    expect(lines).toEqual([
      '[groups] [group-diag] VirtualDevices init (initial) answered after 42 ms',
    ]);
  });
});

describe('CcuClient wiring of the group diagnostics', () => {
  const make = () =>
    new CcuClient({
      config: resolveConfig({
        platform: 'HapHomematic',
        ccuIp: '127.0.0.1',
        interfaces: { virtualDevices: true },
        eventServer: { callbackHost: '127.0.0.1' },
      }),
      log: new PrefixedLogger(makeLog(), 'ccu-test'),
    });

  it('setValue on a group goes through onSend / onSendResult', async () => {
    const c = make();
    vi.spyOn(RpcClient.prototype, 'setValue').mockResolvedValue(undefined);
    const onSend = vi.spyOn(c.groupDiagnostics, 'onSend');
    const onResult = vi.spyOn(c.groupDiagnostics, 'onSendResult');
    c.sendQueue.start();
    await c.setValue('INT0000001:1', 'SET_POINT_TEMPERATURE', 21);
    await c.sendQueue.idle();
    expect(onSend).toHaveBeenCalledWith('INT0000001:1', 'SET_POINT_TEMPERATURE', 21);
    expect(onResult).toHaveBeenCalledWith(1);
    c.groupDiagnostics.dispose();
    c.sendQueue.stop();
  });

  it('events (not PONG) reach onEvent', () => {
    const c = make();
    const onEvent = vi.spyOn(c.groupDiagnostics, 'onEvent');
    const fire = (address: string, datapoint: string, value: unknown) =>
      (c as unknown as { handleEvent(ev: object): void }).handleEvent({
        callbackId: 'homebridge-hap-homematic:VirtualDevices',
        channelAddress: address,
        datapoint,
        value,
        receivedAt: Date.now(),
      });
    fire('CENTRAL', 'PONG', 'homebridge-hap-homematic:VirtualDevices');
    fire('INT0000001:1', 'SET_POINT_TEMPERATURE', 21);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('INT0000001:1', 'SET_POINT_TEMPERATURE', 21);
  });
});
