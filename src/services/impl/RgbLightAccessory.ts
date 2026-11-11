// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { normalizeLevelToPercent, percentToLevelFraction } from '../../util/sanitize.js';

/**
 * Coloured light. Two HomeMatic encodings are supported:
 *
 *  - **Discrete (HmIP-BSL)** — `COLOR` is an integer enum 0..7 mapping
 *    BLACK / BLUE / GREEN / TURQUOISE / RED / PURPLE / YELLOW / WHITE.
 *    HomeKit Hue (0..360°) is snapped to the nearest entry.
 *  - **Continuous (HM-LC-RGBW-WM)** — `COLOR` is 0..199 across the hue
 *    ring with 200 = pure white. HomeKit Hue maps linearly; saturation
 *    < 10 selects 200 (white).
 *
 * Pick the encoding via `subtype` ("discrete" or "continuous"). Default
 * is "continuous" — picking "discrete" is the right choice for HmIP-BSL.
 *
 * Brightness comes from `LEVEL` on the same channel.
 */

const RGB_CHANNEL_TYPES = [
  'RGBW_COLOR',
  'DIMMER_VIRTUAL_RECEIVER',
];

const HMIP_BSL_COLOR_TO_HUE: Record<number, number> = {
  0: 0,    // BLACK — represented as hue 0 / saturation 0 in HomeKit
  1: 246,  // BLUE
  2: 111,  // GREEN
  3: 176,  // TURQUOISE
  4: 0,    // RED
  5: 319,  // PURPLE
  6: 49,   // YELLOW
  7: 0,    // WHITE — represented as hue 0 / saturation 0
};

function snapHueToBslIndex(hue: number, sat: number): number {
  if (sat < 10) {
    return 7; // white
  }
  let bestIdx = 1;
  let bestDist = 360;
  for (const [idx, h] of Object.entries(HMIP_BSL_COLOR_TO_HUE)) {
    const i = Number(idx);
    if (i === 0 || i === 7) continue; // skip BLACK / WHITE here
    const d = Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

class RgbLightHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private cachedLevel = 0;
  private cachedHue = 0;
  private cachedSat = 0;
  private discrete = false;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    this.discrete = (this.accessory.context.subtype ?? 'continuous') === 'discrete';
    const service = this.getOrAddService(this.Service.Lightbulb, channel.name);

    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => this.cachedLevel > 0))
      .onSet(this.wrapSet<boolean>(async (value) => {
        const pct = value ? Math.max(this.cachedLevel, 1) : 0;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    service.getCharacteristic(this.Characteristic.Brightness)
      .onGet(this.wrapGet<number>(() => this.cachedLevel))
      .onSet(this.wrapSet<number>(async (value) => {
        const pct = normalizeLevelToPercent(value) ?? 0;
        this.cachedLevel = pct;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    service.getCharacteristic(this.Characteristic.Hue)
      .onGet(this.wrapGet<number>(() => this.cachedHue))
      .onSet(this.wrapSet<number>(async (value) => {
        this.cachedHue = value;
        await this.writeColor();
      }));

    service.getCharacteristic(this.Characteristic.Saturation)
      .onGet(this.wrapGet<number>(() => this.cachedSat))
      .onSet(this.wrapSet<number>(async (value) => {
        this.cachedSat = value;
        await this.writeColor();
      }));

    // LEVEL events
    this.registerListener(this.channelAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) return;
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    });

    // COLOR events
    this.registerListener(this.channelAddress, 'COLOR', (raw) => {
      const num = Number(raw);
      if (!Number.isFinite(num)) return;
      this.applyColorFromCcu(num);
      service.updateCharacteristic(this.Characteristic.Hue, this.cachedHue);
      service.updateCharacteristic(this.Characteristic.Saturation, this.cachedSat);
    });

    // Initial pulls — same apply paths as the listeners above.
    /* v8 ignore start */
    this.readOnRefresh(this.channelAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) return;
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    });

    this.readOnRefresh(this.channelAddress, 'COLOR', (raw) => {
      const num = Number(raw);
      if (!Number.isFinite(num)) return;
      this.applyColorFromCcu(num);
      service.updateCharacteristic(this.Characteristic.Hue, this.cachedHue);
      service.updateCharacteristic(this.Characteristic.Saturation, this.cachedSat);
    });
    /* v8 ignore stop */
  }

  private applyColorFromCcu(num: number): void {
    if (this.discrete) {
      const hue = HMIP_BSL_COLOR_TO_HUE[Math.round(num)] ?? 0;
      this.cachedHue = hue;
      this.cachedSat = (Math.round(num) === 0 || Math.round(num) === 7) ? 0 : 100;
    } else {
      // Continuous: 0..199 = hue ring, 200 = white. Map back.
      if (num >= 200) {
        this.cachedHue = 0;
        this.cachedSat = 0;
      } else {
        this.cachedHue = (num / 199) * 360;
        this.cachedSat = 100;
      }
    }
  }

  private async writeColor(): Promise<void> {
    if (this.discrete) {
      const idx = snapHueToBslIndex(this.cachedHue, this.cachedSat);
      await this.ccu.setValue(this.channelAddress, 'COLOR', idx);
    } else {
      const colorVal = this.cachedSat < 10
        ? 200
        : Math.round((this.cachedHue / 360) * 199);
      await this.ccu.setValue(this.channelAddress, 'COLOR', colorVal);
    }
  }
}

export const rgbLightService: ServiceDefinition = {
  key: 'RgbLightAccessory',
  description: 'Coloured light (RGB / HmIP-BSL discrete colours)',
  channelTypes: RGB_CHANNEL_TYPES,
  // Lower priority than the plain dimmer / switch — user opts in.
  priority: 60,
  variants: [
    { id: 'continuous', label: 'Continuous (HM-LC-RGBW-WM)' },
    { id: 'discrete',   label: 'Discrete 7-colour (HmIP-BSL)' },
  ],
  build: (ctx: ServiceContext) => new RgbLightHandler(ctx),
};

export const _testing = { snapHueToBslIndex, HMIP_BSL_COLOR_TO_HUE };
