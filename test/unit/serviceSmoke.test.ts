/**
 * Smoke test over every registered service: attach it in every variant,
 * feed typical start values and events, then call every getter and setter.
 *
 * Getters may only return a value or throw "No Response" (HapStatusError);
 * any other exception is a bug. Setters may fail only through the CCU
 * (here: never) or with "No Response".
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SERVICE_DEFINITIONS } from '../../src/services/registry.js';
import { build, makeSvcEnv } from '../helpers/svcEnv.js';
import type { CcuChannel, CcuDevice } from '../../src/types.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Plausible values for the datapoints the services read. */
const VALUES: Record<string, unknown> = {
  STATE: true, LEVEL: 0.5, LEVEL_2: 0.25, WORKING: false, DIRECTION: 0, ACTIVITY_STATE: 3,
  ACTUAL_TEMPERATURE: 21.5, TEMPERATURE: 19.0, SET_TEMPERATURE: 22, SET_POINT_TEMPERATURE: 22,
  HUMIDITY: 55, ACTUAL_HUMIDITY: 55, ILLUMINATION: 1200, RAINING: false, MOTION: true,
  BRIGHTNESS: 80, DOOR_STATE: 1, ERROR: 0, COLOR: 100, COLOR_TEMPERATURE: 3000, POWER: 12.3,
  CURRENT: 50, VOLTAGE: 230, ENERGY_COUNTER: 1000, FREQUENCY: 50, CONTROL_MODE: 0,
  SET_POINT_MODE: 0, VALVE_STATE: 50, LEVEL_STATUS: 0, LOW_BAT: false, LOWBAT: false,
  OPERATING_VOLTAGE: 2.9, UNREACH: false, SMOKE_DETECTOR_ALARM_STATUS: 0, ERROR_DEGRADED_CHAMBER: false,
  WIND_SPEED: 3, HUMIDITY_STATUS: 0,
};
/** A second set of values for the events, to hit both branches. */
const EVENTS: Record<string, unknown> = {
  STATE: false, LEVEL: 1, LEVEL_2: 0, WORKING: true, DIRECTION: 1, ACTIVITY_STATE: 1,
  ACTUAL_TEMPERATURE: 'x', TEMPERATURE: 25, SET_TEMPERATURE: 'nan', SET_POINT_TEMPERATURE: 18,
  HUMIDITY: 101, ILLUMINATION: -5, RAINING: true, MOTION: false, DOOR_STATE: 0, ERROR: 1,
  COLOR: 200, POWER: 'n/a', ENERGY_COUNTER: 2000, LOW_BAT: true, OPERATING_VOLTAGE: 2.2,
  UNREACH: true, SMOKE_DETECTOR_ALARM_STATUS: 1, PRESS_SHORT: true, PRESS_LONG: true,
};

/** Values to try on every setter. */
const SET_VALUES: unknown[] = [0, 1, 50, 100, true, false, 3];

function isHapError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { hapStatus?: number }).hapStatus === -70402;
}

describe('every service: getters / setters / events stay well-behaved', () => {
  for (const def of SERVICE_DEFINITIONS) {
    const variants = [undefined, ...(def.variants ?? []).map((v) => v.id)];
    for (const variant of variants) {
      it(`${def.key}${variant ? ` (${variant})` : ''}`, async () => {
        vi.useFakeTimers();
        const env = makeSvcEnv();
        const serial = '00000000000A0F';
        const type = def.channelTypes[0]!;
        const channels: CcuChannel[] = [1, 2, 3, 4].map((i) => ({ address: `${serial}:${i}`, index: i, type, name: `ch${i}` }));
        const device: CcuDevice = { address: serial, type: 'X', name: 'X', interface: 'HmIP-RF', channels };
        const channel = channels[0]!;
        const settings = Object.fromEntries((def.options ?? []).map((o) => [o.key, o.default]));
        const a = build(env, def, channel, { ...(variant ? { subtype: variant } : {}), settings }, device);

        // 1. Getters before any value.
        const all = () => a.accessory.services.flatMap((s) => [...s.characteristics.values()]);
        const callGetters = async () => {
          for (const c of all()) {
            if (!c.onGetHandler) continue;
            try {
              await c.onGetHandler();
            } catch (err) {
              expect(isHapError(err), `${def.key} get ${c.uuid}: ${String(err)}`).toBe(true);
            }
          }
        };
        await callGetters();

        // 2. Start values, then getters again.
        for (const ch of [...channels, { address: `${serial}:0` }]) {
          env.values[ch.address] = { ...VALUES };
        }
        await a.handler.refresh();
        await callGetters();

        // 3. Events with other values, then getters.
        for (const ch of [...channels, { address: `${serial}:0` }]) {
          for (const [dp, v] of Object.entries(EVENTS)) {
            env.fire(ch.address, dp, v);
          }
        }
        await vi.advanceTimersByTimeAsync(1000);
        await callGetters();

        // 4. Every setter with a few values.
        for (const c of all()) {
          if (!c.onSetHandler) continue;
          for (const v of SET_VALUES) {
            try {
              await c.onSetHandler(v);
            } catch (err) {
              expect(isHapError(err), `${def.key} set ${c.uuid}=${String(v)}: ${String(err)}`).toBe(true);
            }
          }
        }
        await vi.advanceTimersByTimeAsync(130_000); // timers (blind failsafe, door opener, …)
        await callGetters();

        // 5. A failing CCU on every setter.
        env.setValue.mockRejectedValue(new Error('ccu down'));
        for (const c of all()) {
          if (!c.onSetHandler) continue;
          try {
            await c.onSetHandler(1);
          } catch (err) {
            expect(isHapError(err) || /ccu down/.test(String(err)), `${def.key} set: ${String(err)}`).toBe(true);
          }
        }
        await vi.advanceTimersByTimeAsync(130_000);
        a.handler.dispose?.();
      });
    }
  }
});
