// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase, isTrue } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const CONTACT_CHANNEL_TYPES = [
  'SHUTTER_CONTACT',
  'ROTARY_HANDLE_SENSOR',
  'CONTACT_INTERFACE_TRANSMITTER',
  'TILT_SENSOR',
];

/** HM-Sec-SCo ERROR enum: 7 = SABOTAGE. */
const ERROR_SABOTAGE = 7;

/**
 * Door / window contact as HomeKit ContactSensor. STATE true = open.
 * Option `invert` swaps open / closed (contacts mounted the other way
 * round). Unknown state → "No Response"; ERROR = SABOTAGE →
 * StatusTampered; UNREACH / interface down → StatusFault.
 *
 * The former variants `door` / `window` (upstream) used the HAP services
 * for motorised doors and windows: Home showed a position slider that did
 * nothing. They are mapped to the contact sensor now (warning in the log)
 * and a Door / Window service left in the accessory cache is removed.
 */
class ContactHandler extends AccessoryBase implements ChannelService {
  private open: boolean | undefined;

  attach(channel: CcuChannel): void {
    const subtype = String(this.accessory.context.subtype ?? 'contact').toLowerCase();
    if (subtype === 'door' || subtype === 'window') {
      this.log.warn('%s: variant "%s" is no longer supported; using a contact sensor. '
        + 'Set the variant to "Contact sensor" in the plugin settings.', this.accessory.displayName, subtype);
    }
    for (const legacy of [this.Service.Door, this.Service.Window]) {
      const old = this.accessory.getService(legacy);
      if (old) {
        this.accessory.removeService(old);
      }
    }
    const invert = this.accessory.context.settings?.invert === true;
    const service = this.getOrAddService(this.Service.ContactSensor, channel.name);

    const contactValue = (): number => {
      if (this.open === undefined) {
        return this.unknown();
      }
      return this.open
        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
    };

    service.getCharacteristic(this.Characteristic.ContactSensorState).onGet(this.wrapGet<number>(contactValue));

    this.need(channel.address, 'STATE', (raw) => {
      this.open = isTrue(raw) !== invert;
      this.update(service, this.Characteristic.ContactSensorState, contactValue());
    });

    this.need(channel.address, 'ERROR', (raw) => {
      const tampered = Number(raw) === ERROR_SABOTAGE;
      service.updateCharacteristic(this.Characteristic.StatusTampered, tampered
        ? this.Characteristic.StatusTampered.TAMPERED
        : this.Characteristic.StatusTampered.NOT_TAMPERED);
    });
    this.watchFault(service, channel.address);

    this.attachBattery(channel.address);
  }
}

export const contactService: ServiceDefinition = {
  key: 'ContactAccessory',
  description: 'Door / window contact sensor',
  channelTypes: CONTACT_CHANNEL_TYPES,
  priority: 10,
  options: [
    { key: 'invert', label: 'Invert open / closed', type: 'boolean', default: false },
  ],
  build: (ctx: ServiceContext) => new ContactHandler(ctx),
};
