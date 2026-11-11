// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import type { CharacteristicProps, Service } from 'homebridge';
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { toFiniteNumber } from '../../util/sanitize.js';

/**
 * Energy / power meter (HmIP-PSM, HmIP-FSM, HmIP-FSI, HM-ES-PMSw1-Pl, …).
 * Binds to the ENERGIE_METER_TRANSMITTER channel and exposes Eve's
 * Voltage / ElectricCurrent / ElectricPower / TotalConsumption custom
 * characteristics on a HomeKit Outlet service. Eve and Apple's Home app
 * will display these — generic HomeKit clients ignore them but still see
 * the Outlet "in use" indicator.
 *
 * Eve characteristic UUIDs are documented at
 *   https://github.com/simont77/fakegato-history/wiki and
 *   https://github.com/homespun/homebridge-platform-eve
 * The values are reproduced inline here so we don't take a dependency.
 *
 * The Characteristic instances are constructed at runtime against the
 * `Characteristic` class supplied via ServiceContext (i.e. the one
 * Homebridge passes in via `api.hap.Characteristic`). That avoids an
 * import-time dependency on a specific @homebridge/hap-nodejs version.
 */

const POWER_METER_CHANNEL_TYPES = [
  'ENERGIE_METER_TRANSMITTER',
  'POWERMETER',
  'POWERMETER_IGL',
];

const EVE_VOLTAGE_UUID            = 'E863F10A-079E-48FF-8F27-9C2605A29F52';
const EVE_ELECTRIC_CURRENT_UUID   = 'E863F126-079E-48FF-8F27-9C2605A29F52';
const EVE_ELECTRIC_POWER_UUID     = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
const EVE_TOTAL_CONSUMPTION_UUID  = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

class PowerMeterHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.Outlet, channel.name);

    const voltage = this.ensureCustomCharacteristic(service, EVE_VOLTAGE_UUID,
      'Voltage', 'V', 400, 0.1);
    const current = this.ensureCustomCharacteristic(service, EVE_ELECTRIC_CURRENT_UUID,
      'Electric Current', 'A', 100, 0.001);
    const power = this.ensureCustomCharacteristic(service, EVE_ELECTRIC_POWER_UUID,
      'Consumption', 'W', 3500, 0.1);
    const total = this.ensureCustomCharacteristic(service, EVE_TOTAL_CONSUMPTION_UUID,
      'Total Consumption', 'kWh', 1_000_000, 0.001);

    let lastPowerW = 0;
    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => lastPowerW > 0));
    service.getCharacteristic(this.Characteristic.OutletInUse)
      .onGet(this.wrapGet<boolean>(() => lastPowerW > 0.1));

    const subscribe = (datapoint: string,
      apply: (value: number) => void): void => {
      this.registerListener(this.channelAddress, datapoint, (raw) => {
        const v = toFiniteNumber(raw);
        if (v !== undefined) apply(v);
      });
      this.readOnRefresh(this.channelAddress, datapoint, (raw) => {
        const v = toFiniteNumber(raw);
        if (v !== undefined) apply(v);
      });
    };

    subscribe('VOLTAGE', (v) => voltage.updateValue(round(v, 1)));
    subscribe('CURRENT', (raw) => {
      // CCU reports CURRENT in mA. HomeKit/Eve expects A.
      current.updateValue(round(raw / 1000, 3));
    });
    subscribe('POWER', (raw) => {
      lastPowerW = raw;
      power.updateValue(round(raw, 1));
      service.updateCharacteristic(this.Characteristic.On, lastPowerW > 0);
      service.updateCharacteristic(this.Characteristic.OutletInUse, lastPowerW > 0.1);
    });
    subscribe('ENERGY_COUNTER', (raw) => {
      // CCU reports ENERGY_COUNTER in Wh. Eve expects kWh.
      total.updateValue(round(raw / 1000, 3));
    });
  }

  private ensureCustomCharacteristic(service: Service, uuid: string,
    displayName: string, unit: string, maxValue: number, minStep: number,
  ): InstanceType<typeof this.Characteristic> {
    const existing = findCharacteristicByUuid(service, uuid);
    if (existing) {
      // findCharacteristicByUuid walks an opaque container and returns
      // unknown; the caller knows it stored a Characteristic instance.
      return existing as InstanceType<typeof this.Characteristic>;
    }
    const props: CharacteristicProps = {
      format: 'float' as CharacteristicProps['format'],
      perms: ['pr' as CharacteristicProps['perms'][number],
              'ev' as CharacteristicProps['perms'][number]],
      unit,
      minValue: 0,
      maxValue,
      minStep,
    };
    type CharCtor = new (displayName: string, UUID: string,
      props: CharacteristicProps) => InstanceType<typeof this.Characteristic>;
    const Ctor = this.Characteristic as unknown as CharCtor;
    const instance = new Ctor(displayName, uuid, props);
    service.addCharacteristic(instance);
    return instance;
  }
}

// hap-nodejs's Service.characteristics is `Characteristic[]`. Our test stubs
// use a `Map<string, …>` for ergonomics. Both are iterable; values for the
// Map come back as `[uuid, char]` tuples, for the Array they come back as
// raw chars. Walk either shape and return the matching Characteristic.
function findCharacteristicByUuid(service: Service, uuid: string): unknown {
  const chars = (service as unknown as { characteristics?: unknown }).characteristics;
  if (!chars || typeof (chars as Iterable<unknown>)[Symbol.iterator] !== 'function') {
    return undefined;
  }
  for (const entry of chars as Iterable<unknown>) {
    const ch: unknown = Array.isArray(entry) ? entry[1] : entry;
    if (ch && typeof ch === 'object' && (ch as { UUID?: string }).UUID === uuid) {
      return ch;
    }
  }
  return undefined;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export const powerMeterService: ServiceDefinition = {
  key: 'PowerMeterAccessory',
  description: 'Energy meter (Voltage / Current / Power / Total)',
  channelTypes: POWER_METER_CHANNEL_TYPES,
  priority: 10,
  build: (ctx: ServiceContext) => new PowerMeterHandler(ctx),
};
