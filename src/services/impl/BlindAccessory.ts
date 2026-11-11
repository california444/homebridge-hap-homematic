// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
// Taken from upstream commit 2011787 (2026-11-11); see NOTICE.
// Changed for plan 8.4 / 8.6: transmitter state, invert, unknown values.
import type { Service } from 'homebridge';
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { normalizeLevelToPercent, percentToLevelFraction } from '../../util/sanitize.js';

const BLIND_CHANNEL_TYPES = [
  'BLIND',
  'BLIND_VIRTUAL_RECEIVER',
  'SHUTTER_VIRTUAL_RECEIVER',
  'BLIND_TRANSMITTER',
  'SHUTTER_TRANSMITTER',
];

const STATE_STOPPED = 2;
const STATE_INCREASING = 1;
const STATE_DECREASING = 0;

/** No LEVEL change and no explicit stop within this window: treat as stopped. */
const SETTLE_MS = 5000;
/** Safety net while the CCU itself says "moving" (WORKING / ACTIVITY_STATE). */
const FAILSAFE_MS = 120000;

type Direction = -1 | 0 | 1;

/**
 * Window covering with live movement reporting.
 *
 * - Classic BLIND: WORKING (bool) and DIRECTION (1 up, 2 down) mark movement.
 * - HmIP (BLIND_/SHUTTER_VIRTUAL_RECEIVER): ACTIVITY_STATE (1 up, 2 down,
 *   3 stable); HmIP has no WORKING datapoint.
 * - Every intermediate LEVEL is pushed as CurrentPosition; the direction of
 *   successive LEVELs and of target vs current right after a command also
 *   drive PositionState.
 * - TargetPosition stays the commanded target until the move is finished
 *   (target reached, CCU reports stable, or the level stops changing); a
 *   move stopped midway then sets target = current. Moves started outside
 *   HomeKit (wall button) have no known target, so target follows current.
 * HomeKit 100 equals CCU LEVEL 1.0 (open). Option `invert` (awnings)
 * maps HomeKit p to LEVEL 1 - p/100; directions flip accordingly.
 * HmIP: LEVEL and ACTIVITY_STATE are read from the *_TRANSMITTER
 * (`stateAddress`), commands go to the first receiver (`address`).
 * Unknown position (device unreachable at start) → "No Response".
 */
class BlindHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private invert = false;
  private known = false;
  private current = 0;
  private target = 0;
  private commanded = false;
  private moving = false;
  private direction: Direction = 0;
  private explicitMoving = false;
  private explicitStable = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private service?: Service;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    this.invert = this.accessory.context.settings?.invert === true;
    const stateAddress = channel.stateAddress ?? channel.address;
    const service = this.getOrAddService(this.Service.WindowCovering, channel.name);
    this.service = service;
    const dir = (d: Direction): Direction => (this.invert ? (-d as Direction) : d);

    service.getCharacteristic(this.Characteristic.CurrentPosition)
      .onGet(this.wrapGet<number>(() => (this.known ? this.current : this.unknown())));

    service.getCharacteristic(this.Characteristic.TargetPosition)
      .onGet(this.wrapGet<number>(() => (this.known ? this.target : this.unknown())))
      .onSet(this.wrapSet<number>(async (value) => {
        const pct = normalizeLevelToPercent(value) ?? 0;
        this.onCommand(pct);
        await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(this.invert ? 100 - pct : pct));
      }));

    service.getCharacteristic(this.Characteristic.PositionState)
      .onGet(this.wrapGet<number>(() => this.positionState()));

    // Start value and events; the start value just sets the position.
    this.registerListener(stateAddress, 'LEVEL', (raw) => {
      const pct = this.toHomeKit(raw);
      if (pct !== undefined) {
        this.known = true;
        this.onLevel(pct);
      }
    });
    this.readOnRefresh(stateAddress, 'LEVEL', (raw) => {
      const pct = this.toHomeKit(raw);
      if (pct === undefined) return;
      const first = !this.known;
      this.known = true;
      if (first || !this.moving) {
        this.current = pct;
        this.target = pct;
        service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
        service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
        service.updateCharacteristic(this.Characteristic.PositionState, STATE_STOPPED);
      }
    });

    this.registerListener(stateAddress, 'WORKING', (raw) => {
      if (raw) {
        this.onExplicitMoving(this.direction);
      } else {
        this.finish();
      }
    });

    // HmIP: 0 unknown, 1 up, 2 down, 3 stable.
    this.registerListener(stateAddress, 'ACTIVITY_STATE', (raw) => {
      const n = Number(raw);
      if (n === 1) {
        this.onExplicitMoving(dir(1));
      } else if (n === 2) {
        this.onExplicitMoving(dir(-1));
      } else if (n === 3) {
        this.explicitStable = true;
        this.finish();
      }
    });

    // Classic: 0 none, 1 up, 2 down, 3 undefined.
    this.registerListener(stateAddress, 'DIRECTION', (raw) => {
      const n = Number(raw);
      if (n === 1 || n === 2) {
        this.direction = dir(n === 1 ? 1 : -1);
        if (this.moving) {
          this.pushState();
        }
      }
    });
  }

  /** CCU LEVEL → HomeKit position, honouring `invert`. */
  private toHomeKit(raw: unknown): number | undefined {
    const pct = normalizeLevelToPercent(raw);
    return pct === undefined ? undefined : this.invert ? 100 - pct : pct;
  }

  override dispose(): void {
    this.clearTimer();
    super.dispose();
  }

  private onCommand(pct: number): void {
    this.target = pct;
    this.commanded = true;
    this.explicitStable = false;
    if (pct === this.current) {
      this.finish();
      return;
    }
    this.moving = true;
    this.direction = pct > this.current ? 1 : -1;
    this.pushState();
    this.arm(SETTLE_MS);
  }

  private onLevel(pct: number): void {
    const previous = this.current;
    this.current = pct;
    this.service?.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
    if (pct !== previous) {
      this.direction = pct > previous ? 1 : -1;
      // A LEVEL arriving after the CCU said "stable" is the final value.
      if (!this.explicitStable) {
        this.moving = true;
      }
    }
    if (this.commanded && pct === this.target) {
      this.finish();
      return;
    }
    if (!this.commanded) {
      this.target = pct;
      this.service?.updateCharacteristic(this.Characteristic.TargetPosition, pct);
    }
    if (this.moving) {
      this.arm(this.explicitMoving ? FAILSAFE_MS : SETTLE_MS);
    }
    this.pushState();
  }

  private onExplicitMoving(direction: Direction): void {
    this.explicitMoving = true;
    this.explicitStable = false;
    this.moving = true;
    if (direction !== 0) {
      this.direction = direction;
    } else if (this.commanded && this.target !== this.current) {
      this.direction = this.target > this.current ? 1 : -1;
    }
    this.arm(FAILSAFE_MS);
    this.pushState();
  }

  /** Move is over: report STOPPED and settle TargetPosition on where it ended. */
  private finish(): void {
    this.clearTimer();
    this.moving = false;
    this.explicitMoving = false;
    this.commanded = false;
    this.direction = 0;
    this.target = this.current;
    this.service?.updateCharacteristic(this.Characteristic.TargetPosition, this.current);
    this.pushState();
  }

  private arm(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.finish(), ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private pushState(): void {
    this.service?.updateCharacteristic(this.Characteristic.PositionState, this.positionState());
  }

  private positionState(): number {
    if (!this.moving || this.direction === 0) {
      return STATE_STOPPED;
    }
    return this.direction > 0 ? STATE_INCREASING : STATE_DECREASING;
  }
}

export const blindService: ServiceDefinition = {
  key: 'BlindAccessory',
  description: 'Window covering / blind / shutter',
  channelTypes: BLIND_CHANNEL_TYPES,
  priority: 10,
  options: [
    { key: 'invert', label: 'Invert (awning)', type: 'boolean', default: false,
      hint: 'HomeKit 100 % = CCU level 0. For awnings that are open when the CCU says closed.' },
  ],
  build: (ctx: ServiceContext) => new BlindHandler(ctx),
};
