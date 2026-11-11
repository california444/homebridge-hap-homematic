// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Garage door opener (HmIP-MOD-HO and friends).
 *
 * The CCU exposes DOOR_STATE (0=closed / 1=open / 2=ventilation /
 * 3=position-unknown) and DOOR_COMMAND (1=open / 2=stop / 3=close /
 * 4=partial-open). HomeKit's GarageDoorOpener, in contrast, has a
 * five-state CurrentDoorState including OPENING and CLOSING.
 *
 * Upstream hap-homematic accessories collapsed the in-flight states
 * straight to OPEN/CLOSED, which made the Home app jump from "closed"
 * to "open" without an "opening" phase (thkl/hap-homematic#507). We
 * dwell in OPENING / CLOSING for a configurable travel time
 * (`settings.travelSeconds`, default 25 s) before falling back to the
 * CCU's reported state — long enough for the device to push the
 * actual settled state, but short enough that a stuck door surfaces
 * as Stopped instead of dangling forever.
 *
 * Opt-in via the service dropdown — auto-pick stays on the simpler
 * SwitchAccessory for SWITCH channels.
 */

import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const GARAGE_DOOR_CHANNEL_TYPES = [
  'DOOR',
  'DOOR_OPENER',
  'GARAGE_DOOR',
  // HmIP-MOD-HO exposes a SWITCH-style receiver too; users opt in via
  // the service dropdown on those channels.
  'SWITCH_VIRTUAL_RECEIVER',
];

// CCU DOOR_STATE values.
const CCU_CLOSED = 0;
const CCU_OPEN = 1;
const CCU_VENTILATION = 2;

// CCU DOOR_COMMAND values.
const CMD_OPEN = 1;
const CMD_CLOSE = 3;

class GarageDoorHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private current = 1; // HAP CLOSED
  private target = 1; // HAP CLOSED
  private travelTimer: NodeJS.Timeout | undefined;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const settings = (this.accessory.context.settings ?? {}) as { travelSeconds?: number };
    const travelSeconds = typeof settings.travelSeconds === 'number'
      && Number.isFinite(settings.travelSeconds)
      && settings.travelSeconds > 0
      ? settings.travelSeconds : 25;

    const service = this.getOrAddService(this.Service.GarageDoorOpener, channel.name);

    service.getCharacteristic(this.Characteristic.CurrentDoorState)
      .onGet(this.wrapGet<number>(() => this.current));

    service.getCharacteristic(this.Characteristic.TargetDoorState)
      .onGet(this.wrapGet<number>(() => this.target))
      .onSet(this.wrapSet<number>(async (value) => {
        const targetOpen = value === this.Characteristic.TargetDoorState.OPEN;
        this.target = value;
        // Dwell in OPENING / CLOSING for travelSeconds; the CCU's
        // settled DOOR_STATE event will overwrite it on arrival.
        this.current = targetOpen
          ? this.Characteristic.CurrentDoorState.OPENING
          : this.Characteristic.CurrentDoorState.CLOSING;
        service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.current);
        if (this.travelTimer) clearTimeout(this.travelTimer);
        this.travelTimer = setTimeout(() => {
          // If the door pushed nothing in travelSeconds, mark Stopped
          // so the user sees something is wrong rather than a stale
          // OPENING. The next push event will clear this.
          this.current = this.Characteristic.CurrentDoorState.STOPPED;
          service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.current);
          this.travelTimer = undefined;
        }, travelSeconds * 1000);
        if (this.travelTimer.unref) this.travelTimer.unref();
        try {
          await this.ccu.setValue(this.channelAddress, 'DOOR_COMMAND', targetOpen ? CMD_OPEN : CMD_CLOSE);
        } catch (err) {
          this.log.warn('garage-door command failed: %s', (err as Error).message);
        }
      }));

    service.getCharacteristic(this.Characteristic.ObstructionDetected)
      .onGet(() => false);

    this.registerListener(this.channelAddress, 'DOOR_STATE', (raw) => {
      const v = typeof raw === 'number' ? raw : parseInt(String(raw ?? '-1'), 10);
      const next = this.mapCcuToHap(v);
      if (next === undefined) return;
      this.current = next;
      this.target = next === this.Characteristic.CurrentDoorState.CLOSED
        ? this.Characteristic.TargetDoorState.CLOSED
        : this.Characteristic.TargetDoorState.OPEN;
      if (this.travelTimer) {
        clearTimeout(this.travelTimer);
        this.travelTimer = undefined;
      }
      service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.current);
      service.updateCharacteristic(this.Characteristic.TargetDoorState, this.target);
    });

    // Best-effort initial pull. Same code path as the DOOR_STATE
    // listener above — tested via fireEvent there. The async chain
    // here is ignored from coverage to avoid flaky promise-timing
    // tests.
    /* v8 ignore start */
    this.readOnRefresh(this.channelAddress, 'DOOR_STATE', (raw) => {
      const v = typeof raw === 'number' ? raw : parseInt(String(raw ?? '-1'), 10);
      const next = this.mapCcuToHap(v);
      if (next !== undefined) {
        this.current = next;
        this.target = next === this.Characteristic.CurrentDoorState.CLOSED
          ? this.Characteristic.TargetDoorState.CLOSED
          : this.Characteristic.TargetDoorState.OPEN;
        service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.current);
        service.updateCharacteristic(this.Characteristic.TargetDoorState, this.target);
      }
    });
    /* v8 ignore stop */
  }

  /** Translate CCU DOOR_STATE → HAP CurrentDoorState; undefined means "skip". */
  private mapCcuToHap(ccu: number): number | undefined {
    switch (ccu) {
      case CCU_CLOSED:       return this.Characteristic.CurrentDoorState.CLOSED;
      case CCU_OPEN:         return this.Characteristic.CurrentDoorState.OPEN;
      case CCU_VENTILATION:  return this.Characteristic.CurrentDoorState.OPEN;
      default:               return undefined;
    }
  }

  override dispose(): void {
    if (this.travelTimer) {
      clearTimeout(this.travelTimer);
      this.travelTimer = undefined;
    }
    super.dispose();
  }
}

export const garageDoorService: ServiceDefinition = {
  key: 'GarageDoorAccessory',
  description: 'Garage door (HomeKit GarageDoorOpener, with travel-time dwell)',
  channelTypes: GARAGE_DOOR_CHANNEL_TYPES,
  // Higher number than SwitchAccessory (10) so a bare SWITCH channel
  // doesn't auto-pick this. Users opt in via the service dropdown.
  priority: 90,
  build: (ctx: ServiceContext) => new GarageDoorHandler(ctx),
};
