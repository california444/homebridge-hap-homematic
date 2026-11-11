# Integration guide

<!--
  Modified by california444 (2026) for homebridge-hap-homematic,
  a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
-->

## Prerequisites

| Item | Minimum |
| ---- | ------- |
| Homebridge | 2.4.0 |
| Node.js | 24 |
| CCU firmware | OpenCCU / RaspberryMatic or CCU3 firmware with XML-RPC on 2001 / 2010 |
| Network | CCU reachable from the Homebridge host, and vice versa (event callback) |

The plugin only talks to the CCU over the **LAN**. It does not need
internet access. It does not contact any of the author's servers, send
analytics, or auto-update.

## CCU access

No CCU user and no login: the plugin uses the XML-RPC ports of `rfd`
and `HMIPServer` directly. They must be reachable from the Homebridge
host (CCU WebUI → Settings → Control Panel → Security → Firewall:
"XML-RPC API" *Open*, or *Restricted access* with the Homebridge host
whitelisted). Basic auth on the XML-RPC ports is not supported yet.

## Network requirements

| Direction | Port | Protocol | Why |
| --------- | ---- | -------- | --- |
| Plugin → CCU | 2001 | XML-RPC | BidCos-RF: discovery, subscription, `getValue` / `setValue` |
| Plugin → CCU | 2010 | XML-RPC | HmIP-RF: discovery, subscription, `getValue` / `setValue` |
| CCU → Plugin | 9875 (default, configurable) | XML-RPC | inbound push events |

If the CCU and Homebridge are not on the same broadcast domain, you
need to **set the event-server bind host explicitly** to a routable
address that the CCU can reach. The default `0.0.0.0` makes the plugin
auto-detect a local IPv4, which works for most home setups.

If you run Homebridge in Docker, the event server port (9875 by
default) must be reachable from the CCU, and `eventServer.host` must be
the **host's** IP, not a container-internal address. Example:

```yaml
ports:
  - "9875:9875"
```

## Configuration

The plugin renders a custom UI in the Homebridge UI; you should rarely
need to edit JSON by hand. For reference, the persisted config block
looks like this:

```json
{
  "platform": "HapHomematic",
  "name": "HapHomematic",
  "ccuIp": "192.168.1.10",
  "useTls": false,
  "interfaces": {
    "bidcosRf": true,
    "hmIpRf": true
  },
  "interfacePorts": {},
  "eventServer": {
    "host": "0.0.0.0",
    "port": 9875,
    "watchdogSeconds": 300
  },
  "channels": [
    {
      "address": "000ABCDEF12345:3",
      "name": "Living Room Light",
      "service": "SwitchAccessory",
      "subtype": "outlet"
    }
  ]
}
```

| Field | Description |
| ----- | ----------- |
| `ccuIp` | IP or hostname of the CCU. |
| `useTls` | Not supported for XML-RPC yet; ignored with a warning. |
| `interfaces.*` | Toggle BidCos-RF / HmIP-RF. Disable an interface you don't use. |
| `interfacePorts.*` | XML-RPC port per interface. Defaults: `BidCos-RF` 2001, `HmIP-RF` 2010. |
| `eventServer.host` | Address the CCU should call back. `0.0.0.0` auto-detects. Set explicitly when running in Docker or behind multiple NICs. |
| `eventServer.port` | Default 9875. Pick anything in 1024–65535. |
| `eventServer.watchdogSeconds` | If no events arrive for this long, every interface re-subscribes. Default 300 s. |
| `channels[]` | Per-channel HomeKit mapping, see service registry below. Addresses as reported by XML-RPC, without interface prefix. |

### Service registry

| `service` key | HAP service(s) | Suitable for | Variants (`subtype`) |
| ------------- | --------------- | ------------ | --------------------- |
| `SwitchAccessory` | Switch / Outlet / Lightbulb | Binary relays, IP outlets | `switch`, `outlet`, `lightbulb` |
| `DimmerAccessory` | Lightbulb (with Brightness) | Dimmable lights | – |
| `BlindAccessory` | WindowCovering | Roller shutters, blinds | – |
| `ThermostatAccessory` | Thermostat | Radiator and IP wall thermostats | – |
| `ContactAccessory` | ContactSensor / Door / Window | Door & window contacts | `contact`, `door`, `window` |
| `MotionAccessory` | MotionSensor | Motion + IR detectors | – |
| `SmokeAccessory` | SmokeSensor | Homematic smoke detectors | – |
| `LeakAccessory` | LeakSensor | Water-detection sensors | – |
| `TemperatureAccessory` | TemperatureSensor | Climate / weather channels | – |
| `HumidityAccessory` | HumiditySensor | Climate / weather channels | – |

## Security

- Run Homebridge as a **dedicated, non-root user**, the way the
  Homebridge installer does by default.
- `config.json` is plain JSON. Make sure it is `chmod 600` and owned by
  the Homebridge user.
- The plugin writes its own state under `<homebridge-storage>/homebridge-hap-homematic/`.
  No file outside that directory is opened by the plugin.
- Besides the event server (9875), the plugin opens no listeners. Do not
  expose the Homebridge UI or the event server to the public internet.

See [SECURITY.md](../SECURITY.md) for the full threat model.

## Troubleshooting

**Devices show up but never update in real time.**
Check the EventServer port and `eventServer.host`. The CCU must be able
to open a connection to `http://<eventServer.host>:<port>`. After a
CCU restart the CCU forgets all subscriptions; the watchdog re-subscribes
after `watchdogSeconds` without events.

**`init failed: connect ETIMEDOUT` / `ECONNREFUSED`**
The interface failed to subscribe at startup. Most common cause: the
CCU firewall blocks the XML-RPC ports. Open the CCU WebUI →
**Settings → Control Panel → Security → Configure firewall**, set
**XML-RPC API** to *Open* or *Restricted access* with the Homebridge
host whitelisted, and restart Homebridge.

**Heavy log spam from `[HapHomematic:ccu:events]`**
Set `--debug` off — at default verbosity, only errors and reconnects
log.
