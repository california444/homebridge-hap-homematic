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
    },
    "VirtualDevices:INT0000001": {
      "mode": "perChannel",
      "channels": {
        "1": { "service": "ThermostatAccessory", "name": "Wohnzimmer" }
      }
    }
  }
}
```

### Device entry — key `"<Interface>:<Serial>"`

The key is always interface + serial (`BidCos-RF`, `HmIP-RF` or
`VirtualDevices` for heating groups), never a name.

| Field      | Type                         | Meaning                                                               |
| ---------- | ---------------------------- | --------------------------------------------------------------------- |
| `enabled`  | boolean                      | `false` skips the device (default `true`).                            |
| `mode`     | `"device"` \| `"perChannel"` | Default: `device` if `service` is set, else `perChannel`.             |
| `service`  | string                       | `device` mode only: one accessory for the whole device.               |
| `variant`  | string                       | Service variant (`device` mode).                                      |
| `name`     | string (≤ 64)                | HomeKit name (`device` mode).                                         |
| `options`  | object                       | Service options; in `perChannel` mode the defaults for every channel. |
| `channels` | object                       | Per channel number (`"0"`–`"999"`), see below.                        |

### Channel entry — key `"<channel number>"`

| Field     | Type                      | Meaning                                                      |
| --------- | ------------------------- | ------------------------------------------------------------ |
| `enabled` | boolean                   | `false` skips the channel.                                   |
| `service` | string                    | Required in `perChannel` mode, not allowed in `device` mode. |
| `variant` | string                    | Service variant, e.g. `outlet`, `lightbulb`.                 |
| `name`    | string (≤ 64)             | HomeKit name. Default: placeholder `TYPE SERIAL:N`.          |
| `options` | object                    | Service options for this channel (override the device's).    |
| _other_   | string / number / boolean | Service-specific extras, e.g. `valveType`.                   |

## Service options

Set in `options` (device or channel) or, for per-channel extras, directly
in the channel entry.

| Service               | Option              | Default       | Meaning                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SwitchAccessory`     | `variant`           | `switch`      | `switch`, `outlet` or `lightbulb` (case-insensitive)                                                                                                                                                                                                                                   |
| `BlindAccessory`      | `invert`            | `false`       | HomeKit 100 % = LEVEL 0 (awnings)                                                                                                                                                                                                                                                      |
| `ContactAccessory`    | `invert`            | `false`       | swap open / closed. Always a HomeKit contact sensor; the former variants `door` / `window` (motorised-door services with a useless position slider) are mapped to it                                                                                                                   |
| `ThermostatAccessory` | `showHumidity`      | `false`       | humidity (`HUMIDITY` / `ACTUAL_HUMIDITY`) on the thermostat; only for devices with a sensor (wall thermostats) or heating groups with one as member — an empty group reports placeholders. Not offered in the UI and ignored for channels without the datapoint (radiator thermostats) |
| `SmokeAccessory`      | `secondaryAlarm`    | `true`        | `false`: an alarm of another detector of the group does not show smoke on this one                                                                                                                                                                                                     |
| `DoorbellAccessory`   | `trigger`           | `PRESS_SHORT` | `PRESS_SHORT`, `PRESS_LONG` or `STATE` (rising edge); must fit the input's operating mode, see [Input channels](#input-channels)                                                                                                                                                       |
| `DoorbellAccessory`   | `debounceSeconds`   | `2`           | repeats within this time are ignored                                                                                                                                                                                                                                                   |
| `IrrigationAccessory` | `defaultDuration`   | `600`         | run time in seconds (max. 3600), sent as `ON_TIME`; the actuator switches off by itself. A duration set for a valve in Home replaces it for that valve. `0` = stays on until switched off                                                                                              |
| `IrrigationAccessory` | channel `valveType` | `Irrigation`  | `Irrigation`, `GenericValve`, `ShowerHead`, `WaterFaucet`                                                                                                                                                                                                                              |
| `IrrigationAccessory` | channel `name`      | `Valve N`     | name of the valve                                                                                                                                                                                                                                                                      |
| `IrrigationAccessory` | channel `duration`  | –             | fixed run time of this valve in seconds (1–3600); a duration chosen in Home is ignored (Home only offers 5 min and more). Empty: Home's duration, else `defaultDuration`                                                                                                               |

`IrrigationAccessory` is a whole-device mapping: one valve per `SWITCH`
channel of the device (e.g. HM-LC-Sw4-DR-2, channels 1–4).

### HmIP actuators

For HmIP-PS, HmIP-DRSI4, HmIP-BROLL / FROLL map the group's
`*_TRANSMITTER` channel: HmIP-PS channel 2, HmIP-BROLL / FROLL channel 3,
HmIP-DRSI4 channels 5 / 9 / 13 / 17 (one per output). The plugin reads the
state there and sends commands to the first `*_VIRTUAL_RECEIVER` after it.
Mapping a receiver of the group works the same. The custom UI lists only one
channel per group and hides channels no service can handle as well as the
CCU's virtual remote (RCV-50) and the built-in buttons / wall-button inputs (`KEY_TRANSCEIVER`, `MULTI_MODE_INPUT_TRANSMITTER`) of actuators; "Show all channels" lists every channel.

### Input channels

What an input channel (`MULTI_MODE_INPUT_TRANSMITTER`: HmIP-DSD-PCB,
HmIP-FCI1 / FCI6, wall-button inputs of HmIP-DRSI4) sends depends on its
operating mode in the CCU (`CHANNEL_OPERATION_MODE`, `MASTER`):

| Operating mode | Sends                       | Services                                       |
| -------------- | --------------------------- | ---------------------------------------------- |
| key            | `PRESS_SHORT`, `PRESS_LONG` | push button; doorbell with `trigger` `PRESS_*` |
| switch, binary | `STATE`                     | doorbell with `trigger: STATE`                 |
| inactive       | nothing                     | none                                           |

The custom UI reads the mode when the channel editor opens and offers only
the services and trigger values that fit (all of them if the CCU does not
tell). For a doorbell on a switch or binary input it stores
`trigger: STATE`. The plugin reads the mode at start, after every
re-subscribe and after a configuration change (`CONFIG_PENDING`) and logs
a warning once if a mapping does not fit, e.g. a push button on an input
that was later set to switch in the CCU.

### Battery

Battery-powered devices get a HomeKit battery service with "battery low"
from `LOW_BAT` / `LOWBAT`. A percentage appears only for devices that
report `OPERATING_VOLTAGE`. The CCU has no percentage; the plugin derives
it from the voltage: 0 % at `LOW_BAT_LIMIT` (the voltage at which the
device reports low battery, `MASTER` of channel 0, on the device for
BidCos) and 100 % at `LOW_BAT_LIMIT / 0.75`, e.g. 1.1–1.47 V for one
cell, 2.2–2.93 V for two. Without the limit: 2.4–3.2 V. The limit is read
at start, after every re-subscribe and after a configuration change
(`CONFIG_PENDING`).

### Thermostats

The target temperature range in Home comes from the device settings in
the CCU (`MASTER` paramset: `TEMPERATURE_MINIMUM` / `TEMPERATURE_MAXIMUM`,
on the thermostat channel for HmIP, on the device for BidCos and
`HM-CC-VG-1`). It is read at start, after every re-subscribe and when the
device reports `CONFIG_PENDING` going back to false after a change in the
CCU. If `MIN_MAX_VALUE_NOT_RELEVANT_FOR_MANU_MODE` is set, the limits do
not apply to what Home writes (manual mode) and the range stays
4.5–30.5 °C, as without `MASTER` values. The hidden options `minTemp` /
`maxTemp` win over both.

On HmIP, Off and Heat write the mode and the set point in one
`putParamset` (`CONTROL_MODE` 1 and `SET_POINT_TEMPERATURE`), so the CCU
applies both at once; a heating group passes them on together. Auto writes
`CONTROL_MODE` 0, a temperature from Home `SET_POINT_TEMPERATURE` alone.
BidCos uses `MANU_MODE` with the temperature and `AUTO_MODE`.

Off writes manual mode with 4.5 °C. A device whose minimum is higher
(HmIP-eTRV-B and HmIP-WTH-2 ship with 5.0 °C) raises that to its minimum
and reports it back. After Off chosen in Home the accessory stays Off as
long as the device is in manual mode at or below its minimum; during the
first 15 s it stays Off whatever arrives (a heating group passes on its
members one by one). A higher set point or Auto reported by the CCU ends
it, as do Heat, Auto or a temperature from Home. Heat then restores the
target before Off. While Off, Home sees that target temperature, not the
off value (4.5 °C, the minimum, a group's member reports), so switching
back to Heat shows no jump; Auto shows it until the CCU reports the week
program's set point. The target is kept across restarts. The plugin logs once per device that Off is reported
as the minimum; the device then regulates to that temperature, it is not
fully off. A set point of 4.5 °C counts as Off in every mode, also in an
Auto week program.

### Heating groups (VirtualDevices)

Needs `interfaces.virtualDevices` in the plugin settings. Map channel 1 of
the group as `ThermostatAccessory`:

| Group type     | Radio system | Channel 1                            | Writes                                                                          |
| -------------- | ------------ | ------------------------------------ | ------------------------------------------------------------------------------- |
| `HmIP-HEATING` | HmIP         | `HEATING_CLIMATECONTROL_TRANSCEIVER` | `SET_POINT_TEMPERATURE`, `CONTROL_MODE` (Off / Heat: both in one `putParamset`) |
| `HM-CC-VG-1`   | BidCos       | `CLIMATECONTROL_RT_TRANSCEIVER`      | `SET_TEMPERATURE`, `MANU_MODE`, `AUTO_MODE`                                     |

The custom UI hides the other channels of a group (window contact, switch
outputs, floor heating): they only mirror the members. `HM-CC-VG-1` sends
its values as strings; the plugin reads them as numbers. A group has no
`LOW_BAT` of its own until a member reports one, so its battery shows
"normal" meanwhile. Without `SET_POINT_MODE` (possible after a CCU
restart) the set point decides between Off and Heat (see
[Thermostats](#thermostats)).

## Accessory identity (decision D6)

Each accessory's UUID is derived from
`<Interface>:<Serial>:<Channel>:<Service>`, with `device` in place of the
channel number for `device` mappings. Renaming keeps the accessory; **changing
the service creates a new accessory** in Home (room and automations are lost).
