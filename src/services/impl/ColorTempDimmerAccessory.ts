// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { normalizeLevelToPercent, percentToLevelFraction } from '../../util/sanitize.js';

/**
 * Tunable-white (dual-white) dimmer. The brightness lives on this channel
 * (`LEVEL` datapoint) and the color temperature lives on the *sibling*
 * channel — typically the next index of the same device. CCU stores the
 * color-temperature LEVEL inverted relative to HomeKit: HM 1.0 = warm,
 * HM 0.0 = cool. HomeKit's ColorTemperature is in mireds, 140–500
 * (cool → warm).
 *
 * The user can override the sibling address in `settings.coltempAddress`
 * if our auto-derivation doesn't fit the device topology.
 */
const COLOR_TEMP_CHANNEL_TYPES = [
  'DIMMER_VIRTUAL_RECEIVER',
  'DUAL_WHITE_BRIGHTNESS',
];

const HK_MIRED_MIN = 140;
const HK_MIRED_MAX = 500;
const HK_MIRED_RANGE = HK_MIRED_MAX - HK_MIRED_MIN;

function deriveColortempAddress(brightnessAddress: string): string | undefined {
  const colon = brightnessAddress.lastIndexOf(':');
  if (colon === -1) {
    return undefined;
  }
  const idx = Number.parseInt(brightnessAddress.slice(colon + 1), 10);
  if (!Number.isFinite(idx)) {
    return undefined;
  }
  return `${brightnessAddress.slice(0, colon)}:${idx + 1}`;
}

class ColorTempDimmerHandler extends AccessoryBase implements ChannelService {
  private brightnessAddress = '';
  private coltempAddress = '';
  private cachedLevel = 0;
  private cachedMired = HK_MIRED_MIN;

  attach(channel: CcuChannel): void {
    this.brightnessAddress = channel.address;
    const settings = (this.accessory.context.settings ?? {}) as Record<string, unknown>;
    const explicit = typeof settings.coltempAddress === 'string' ? settings.coltempAddress : undefined;
    this.coltempAddress = explicit ?? deriveColortempAddress(channel.address) ?? '';

    const service = this.getOrAddService(this.Service.Lightbulb, channel.name);

    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => this.cachedLevel > 0))
      .onSet(this.wrapSet<boolean>(async (value) => {
        const pct = value ? Math.max(this.cachedLevel, 1) : 0;
        await this.ccu.setValue(this.brightnessAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    service.getCharacteristic(this.Characteristic.Brightness)
      .onGet(this.wrapGet<number>(() => this.cachedLevel))
      .onSet(this.wrapSet<number>(async (value) => {
        const pct = normalizeLevelToPercent(value) ?? 0;
        this.cachedLevel = pct;
        await this.ccu.setValue(this.brightnessAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    if (this.coltempAddress) {
      service.getCharacteristic(this.Characteristic.ColorTemperature)
        .setProps({ minValue: HK_MIRED_MIN, maxValue: HK_MIRED_MAX, minStep: 1 })
        .onGet(this.wrapGet<number>(() => this.cachedMired))
        .onSet(this.wrapSet<number>(async (value) => {
          this.cachedMired = value;
          // HomeKit cool→warm = 140→500. CCU LEVEL: 0.0 = cool, 1.0 = warm
          // (HM convention — verified in legacy hap-homematic).
          const fraction = (value - HK_MIRED_MIN) / HK_MIRED_RANGE;
          await this.ccu.setValue(this.coltempAddress, 'LEVEL', fraction);
        }));

      this.registerListener(this.coltempAddress, 'LEVEL', (raw) => {
        const fraction = typeof raw === 'number'
          ? raw
          : Number.parseFloat(String(raw));
        if (!Number.isFinite(fraction)) {
          return;
        }
        const clamped = Math.max(0, Math.min(1, fraction));
        this.cachedMired = HK_MIRED_MIN + clamped * HK_MIRED_RANGE;
        service.updateCharacteristic(this.Characteristic.ColorTemperature, this.cachedMired);
      });

      this.readOnRefresh(this.coltempAddress, 'LEVEL', (raw) => {
        const fraction = typeof raw === 'number'
          ? raw
          : Number.parseFloat(String(raw));
        if (!Number.isFinite(fraction)) return;
        const clamped = Math.max(0, Math.min(1, fraction));
        this.cachedMired = HK_MIRED_MIN + clamped * HK_MIRED_RANGE;
        service.updateCharacteristic(this.Characteristic.ColorTemperature, this.cachedMired);
      });
    }

    this.registerListener(this.brightnessAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) {
        return;
      }
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    });

    this.readOnRefresh(this.brightnessAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) return;
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    });
  }
}

export const colorTempDimmerService: ServiceDefinition = {
  key: 'ColorTempDimmerAccessory',
  description: 'Tunable-white dimmer (brightness + color temperature)',
  channelTypes: COLOR_TEMP_CHANNEL_TYPES,
  // Lower priority than the plain dimmer — the user opts in by picking
  // this service explicitly in the UI.
  priority: 50,
  build: (ctx: ServiceContext) => new ColorTempDimmerHandler(ctx),
};

export const _testing = { deriveColortempAddress };
