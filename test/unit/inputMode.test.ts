import { describe, expect, it, vi } from 'vitest';
import { build, makeSvcEnv } from '../helpers/svcEnv.js';
import { toInputMode, sendsKeyPresses, sendsState } from '../../src/services/inputMode.js';
import { doorbellService } from '../../src/services/impl/DoorbellAccessory.js';
import { programmableSwitchService } from '../../src/services/impl/ProgrammableSwitchAccessory.js';
import type { CcuChannel } from '../../src/types.js';

/** Operating mode of input channels (CHANNEL_OPERATION_MODE, MASTER). */
const input: CcuChannel = {
  address: '0026E0C998CD25:1',
  name: 'Bell',
  index: 1,
  type: 'MULTI_MODE_INPUT_TRANSMITTER',
};
const KEY = 1;
const SWITCH = 2;
const BINARY = 3;

describe('toInputMode', () => {
  it('maps the ENUM index and names', () => {
    expect(toInputMode(0)).toBe('INACTIVE');
    expect(toInputMode(1)).toBe('KEY_BEHAVIOR');
    expect(toInputMode('2')).toBe('SWITCH_BEHAVIOR');
    expect(toInputMode(3)).toBe('BINARY_BEHAVIOR');
    expect(toInputMode('KEY_BEHAVIOR')).toBe('KEY_BEHAVIOR');
    expect(toInputMode(4)).toBeUndefined();
    expect(toInputMode(undefined)).toBeUndefined();
    expect(toInputMode('x')).toBeUndefined();
    expect(sendsKeyPresses('KEY_BEHAVIOR')).toBe(true);
    expect(sendsState('BINARY_BEHAVIOR')).toBe(true);
    expect(sendsState('KEY_BEHAVIOR')).toBe(false);
  });
});

describe('input channels: warning on a mapping that does not fit the operating mode', () => {
  const setup = async (
    def: typeof doorbellService,
    mode: number | undefined,
    settings: Record<string, unknown> = {},
    channel: CcuChannel = input,
  ) => {
    const env = makeSvcEnv();
    if (mode !== undefined) env.master[channel.address] = { CHANNEL_OPERATION_MODE: mode };
    const warn = vi.spyOn(env.log, 'warn');
    const b = build(env, def, channel, { name: 'Bell', settings });
    await b.handler.refresh();
    return { env, warn, b };
  };
  const warned = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.map((c) => c.slice(1).join(' | '));

  it('button in key mode: no warning', async () => {
    const { warn } = await setup(programmableSwitchService, KEY);
    expect(warn).not.toHaveBeenCalled();
  });

  it('button in switch mode: sends no key presses', async () => {
    const { warn } = await setup(programmableSwitchService, SWITCH);
    expect(warn).toHaveBeenCalledWith(
      '%s: input %s is set to "%s" in the CCU: %s',
      'Bell',
      input.address,
      'switch',
      expect.stringContaining('no key presses'),
    );
  });

  it('inactive input: sends nothing', async () => {
    const { warn } = await setup(programmableSwitchService, 0);
    expect(warned(warn)[0]).toContain('inactive | it sends nothing');
  });

  it('doorbell PRESS_SHORT on a binary input: use trigger STATE', async () => {
    const { warn } = await setup(doorbellService, BINARY);
    expect(warned(warn)[0]).toContain('set the option Trigger to STATE');
  });

  it('doorbell STATE on a key input: use trigger PRESS_SHORT', async () => {
    const { warn } = await setup(doorbellService, KEY, { trigger: 'STATE' });
    expect(warned(warn)[0]).toContain('set the option Trigger to PRESS_SHORT');
  });

  it('doorbell STATE on a switch input, PRESS_LONG on a key input: no warning', async () => {
    expect(
      (await setup(doorbellService, SWITCH, { trigger: 'STATE' })).warn,
    ).not.toHaveBeenCalled();
    expect(
      (await setup(doorbellService, KEY, { trigger: 'PRESS_LONG' })).warn,
    ).not.toHaveBeenCalled();
  });

  it('unknown mode: no warning; a change in the CCU is picked up via CONFIG_PENDING', async () => {
    const { env, warn } = await setup(programmableSwitchService, undefined);
    expect(warn).not.toHaveBeenCalled();
    env.master[input.address] = { CHANNEL_OPERATION_MODE: SWITCH };
    env.fire('0026E0C998CD25:0', 'CONFIG_PENDING', true);
    env.fire('0026E0C998CD25:0', 'CONFIG_PENDING', false);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    // Same mode again: no second warning.
    env.fire('0026E0C998CD25:0', 'CONFIG_PENDING', true);
    env.fire('0026E0C998CD25:0', 'CONFIG_PENDING', false);
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('other channel types: MASTER is not read', async () => {
    const remote: CcuChannel = { ...input, address: '000A1B2C3D4E5F:1', type: 'KEY_TRANSCEIVER' };
    const { env } = await setup(programmableSwitchService, SWITCH, {}, remote);
    expect(env.readMaster).not.toHaveBeenCalled();
  });

  it('service definitions carry the modes for the UI', () => {
    expect(programmableSwitchService.inputModes).toEqual(['KEY_BEHAVIOR']);
    expect(doorbellService.inputModes).toEqual([
      'KEY_BEHAVIOR',
      'SWITCH_BEHAVIOR',
      'BINARY_BEHAVIOR',
    ]);
    const trigger = doorbellService.options!.find((o) => o.key === 'trigger')!;
    expect(trigger.inputModeValues).toEqual({
      KEY_BEHAVIOR: ['PRESS_SHORT', 'PRESS_LONG'],
      SWITCH_BEHAVIOR: ['STATE'],
      BINARY_BEHAVIOR: ['STATE'],
    });
  });
});
