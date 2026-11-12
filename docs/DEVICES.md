# devices.json

Device → HomeKit mappings live in
`<storagePath>/homebridge-hap-homematic/devices.json`, not in `config.json`.
The custom UI writes the file (atomically, mode 0600); the plugin reads it
at start. Restart the child bridge after a change.

The file is validated on every load and save. If it is invalid, the plugin
logs every problem, creates **no** accessories and leaves the file as it
is; the UI shows the errors and refuses to edit until the file is fixed.

## Format

```json
{
  "version": 1,
  "devices": {
    "BidCos-RF:ABC0000002": {
      "enabled": true,
      "service": "IrrigationAccessory",
      "channels": {
        "1": { "name": "Rasen vorne", "valveType": "Irrigation" },
        "2": { "name": "Rasen hinten" }
      }
    },
    "HmIP-RF:00000000000A01": {
      "mode": "perChannel",
      "channels": {
        "6": { "service": "SwitchAccessory", "variant": "lightbulb", "name": "WZ1" }
      }
    },
    "HmIP-RF:00000000000A02": {
      "service": "BlindAccessory",
      "options": { "invert": true }
    }
  }
}
```

### Device entry — key `"<Interface>:<Serial>"`

The key is always interface + serial (`BidCos-RF` or `HmIP-RF`), never a
name.

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | `false` skips the device (default `true`). |
| `mode` | `"device"` \| `"perChannel"` | Default: `device` if `service` is set, else `perChannel`. |
| `service` | string | `device` mode only: one accessory for the whole device. |
| `variant` | string | Service variant (`device` mode). |
| `name` | string (≤ 64) | HomeKit name (`device` mode). |
| `options` | object | Service options; in `perChannel` mode the defaults for every channel. |
| `channels` | object | Per channel number (`"0"`–`"999"`), see below. |

### Channel entry — key `"<channel number>"`

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | `false` skips the channel. |
| `service` | string | Required in `perChannel` mode, not allowed in `device` mode. |
| `variant` | string | Service variant, e.g. `outlet`, `lightbulb`. |
| `name` | string (≤ 64) | HomeKit name. Default: placeholder `TYPE SERIAL:N`. |
| `options` | object | Service options for this channel (override the device's). |
| *other* | string / number / boolean | Service-specific extras, e.g. `valveType`. |

## Service options

Set in `options` (device or channel) or, for per-channel extras, directly
in the channel entry.

| Service | Option | Default | Meaning |
| --- | --- | --- | --- |
| `SwitchAccessory` | `variant` | `switch` | `switch`, `outlet` or `lightbulb` (case-insensitive) |
| `BlindAccessory` | `invert` | `false` | HomeKit 100 % = LEVEL 0 (awnings) |
| `ContactAccessory` | `invert` | `false` | swap open / closed; `variant` `contact`, `door`, `window` |
| `SmokeAccessory` | `secondaryAlarm` | `true` | `false`: an alarm of another detector of the group does not show smoke on this one |
| `DoorbellAccessory` | `trigger` | `PRESS_SHORT` | `PRESS_SHORT`, `PRESS_LONG` or `STATE` (rising edge) |
| `DoorbellAccessory` | `debounceSeconds` | `2` | repeats within this time are ignored |
| `IrrigationAccessory` | `defaultDuration` | `600` | seconds, used until a duration is set in Home (0 = no auto-off) |
| `IrrigationAccessory` | channel `valveType` | `Irrigation` | `Irrigation`, `GenericValve`, `ShowerHead`, `WaterFaucet` |
| `IrrigationAccessory` | channel `name` | `Valve N` | name of the valve |

`IrrigationAccessory` is a whole-device mapping: one valve per `SWITCH`
channel of the device (e.g. HM-LC-Sw4-DR-2, channels 1–4).

### HmIP actuators

For HmIP-PS, HmIP-DRSI4, HmIP-BROLL / FROLL map the group's
`*_TRANSMITTER` channel: HmIP-PS channel 2, HmIP-BROLL / FROLL channel 3,
HmIP-DRSI4 channels 5 / 9 / 13 / 17 (one per output). The plugin reads the
state there and sends commands to the first `*_VIRTUAL_RECEIVER` after it.
Mapping a receiver of the group works the same. The custom UI lists only one
channel per group and hides channels no service can handle as well as the
CCU's virtual remote (RCV-50); "Show all channels" lists every channel.

## Accessory identity (decision D6)

Each accessory's UUID is derived from
`<Interface>:<Serial>:<Channel>:<Service>`, with `device` in place of the
channel number for `device` mappings. Renaming keeps the accessory; **changing
the service creates a new accessory** in Home (room and automations are lost).
