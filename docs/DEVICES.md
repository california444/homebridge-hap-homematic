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

## Accessory identity (decision D6)

Each accessory's UUID is derived from
`<Interface>:<Serial>:<Channel>:<Service>`, with `device` in place of the
channel number for `device` mappings. Renaming keeps the accessory; **changing
the service creates a new accessory** in Home (room and automations are lost).
