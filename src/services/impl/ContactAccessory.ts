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
 * Door / window contact. STATE true = open. Options: `invert` swaps
 * open / closed (contacts mounted the other way round).
 * Unknown state → "No Response"; ERROR = SABOTAGE → StatusTampered;
 * UNREACH / interface down → StatusFault (ContactSensor only).
 */
class ContactHandler extends AccessoryBase implements ChannelService {
  private open: boolean | undefined;

  attach(channel: CcuChannel): void {
    const subtype = (this.accessory.context.subtype ?? 'contact').toLowerCase();
    const invert = this.accessory.context.settings?.invert === true;
    const svcType = subtype === 'door'
      ? this.Service.Door
      : subtype === 'window'
        ? this.Service.Window
        : this.Service.ContactSensor;
    const service = this.getOrAddService(svcType, channel.name);
    const isSensor = svcType === this.Service.ContactSensor;

    const contactValue = (): number => {
      if (this.open === undefined) {
        return this.unknown();
      }
      return this.open
        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
    };
    const position = (): number => {
      if (this.open === undefined) {
        return this.unknown();
      }
      return this.open ? 100 : 0;
    };

    if (isSensor) {
      service.getCharacteristic(this.Characteristic.ContactSensorState).onGet(this.wrapGet<number>(contactValue));
    } else {
      service.getCharacteristic(this.Characteristic.CurrentPosition).onGet(this.wrapGet<number>(position));
      service.getCharacteristic(this.Characteristic.TargetPosition).onGet(this.wrapGet<number>(position));
      service.getCharacteristic(this.Characteristic.PositionState).onGet(this.wrapGet<number>(() => 2));
    }

    this.need(channel.address, 'STATE', (raw) => {
      this.open = isTrue(raw) !== invert;
      if (isSensor) {
        this.update(service, this.Characteristic.ContactSensorState, contactValue());
      } else {
        this.update(service, this.Characteristic.CurrentPosition, position());
        this.update(service, this.Characteristic.TargetPosition, position());
      }
    });

    if (isSensor) {
      this.need(channel.address, 'ERROR', (raw) => {
        const tampered = Number(raw) === ERROR_SABOTAGE;
        service.updateCharacteristic(this.Characteristic.StatusTampered, tampered
          ? this.Characteristic.StatusTampered.TAMPERED
          : this.Characteristic.StatusTampered.NOT_TAMPERED);
      });
      this.watchFault(service, channel.address);
    }

    this.attachBattery(channel.address);
  }
}

export const contactService: ServiceDefinition = {
  key: 'ContactAccessory',
  description: 'Door / window contact sensor',
  channelTypes: CONTACT_CHANNEL_TYPES,
  priority: 10,
  variants: [
    { id: 'contact', label: 'Contact sensor', hapServices: ['ContactSensor'] },
    { id: 'door', label: 'Door', hapServices: ['Door'] },
    { id: 'window', label: 'Window', hapServices: ['Window'] },
  ],
  build: (ctx: ServiceContext) => new ContactHandler(ctx),
};
