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
whitelisted). If authentication is enabled on the CCU, set `rpcAuth`
(HTTP Basic auth on the XML-RPC ports).

## Network requirements

| Direction | Port | Protocol | Why |
| --------- | ---- | -------- | --- |
| Plugin → CCU | 2001 (TLS: 42001) | XML-RPC | BidCos-RF: discovery, subscription, `getValue` / `setValue` |
| Plugin → CCU | 2010 (TLS: 42010) | XML-RPC | HmIP-RF: discovery, subscription, `getValue` / `setValue` |
| CCU → Plugin | 9875 (default, configurable) | XML-RPC | inbound push events |

`eventServer.callbackHost` is **required**: the address under which the
CCU reaches this Homebridge host. The CCU sends its events to
`http://<callbackHost>:<port>`.

If you run Homebridge in Docker, the event server port (9875 by
default) must be reachable from the CCU, and `callbackHost` must be the
**host's** IP, not a container-internal address. Example:

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
  "rpcAuth": { "enabled": false },
  "interfaces": {
    "bidcosRf": true,
    "hmIpRf": true
  },
  "interfacePorts": {},
  "eventServer": {
    "host": "0.0.0.0",
    "callbackHost": "192.168.1.20",
    "port": 9875
  }
}
```

Device mappings are **not** part of `config.json`; they live in
`devices.json`, see [DEVICES.md](DEVICES.md).

| Field | Description |
| ----- | ----------- |
| `ccuIp` | IP or hostname of the CCU. |
| `useTls` | XML-RPC over HTTPS (default ports 42001 / 42010). The CCU's self-signed certificate is accepted. |
| `rpcAuth.*` | `enabled`, `username`, `password`: HTTP Basic auth on the XML-RPC ports. Only if enabled on the CCU. |
| `interfaces.*` | Toggle BidCos-RF / HmIP-RF. Disable an interface you don't use. |
| `interfacePorts.*` | XML-RPC port per interface. Defaults: `BidCos-RF` 2001, `HmIP-RF` 2010; with TLS 42001 / 42010. |
| `eventServer.host` | Local bind address of the event server. Default `0.0.0.0` (all interfaces). |
| `eventServer.callbackHost` | **Required.** Address the CCU calls back. |
| `eventServer.port` | Default 9875. Pick anything in 1024–65535. |

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
- The plugin writes its own state under `<homebridge-storage>/homebridge-hap-homematic/`
  (`devices.json`, `discovery.json`, `paramsets.json`, all mode 0600).
  No file outside that directory is opened by the plugin.
- Besides the event server (9875), the plugin opens no listeners. Do not
  expose the Homebridge UI or the event server to the public internet.

See [SECURITY.md](../SECURITY.md) for the full threat model.

## Troubleshooting

**Devices show up but never update in real time.**
Check the EventServer port and `eventServer.callbackHost`. The CCU must be able
to open a connection to `http://<eventServer.host>:<port>`. After a
CCU restart the CCU forgets all subscriptions; the plugin notices it
(ping / PONG per interface, see ARCHITECTURE.md) and subscribes again
within about 15–90 s.

**`did not call back within 15 s`**
`init` worked, but the CCU cannot reach the event server. Check
`eventServer.callbackHost`, the port, the host firewall and Docker port
mappings.

**`init failed: connect ETIMEDOUT` / `ECONNREFUSED`**
The interface failed to subscribe at startup. Most common cause: the
CCU firewall blocks the XML-RPC ports. Open the CCU WebUI →
**Settings → Control Panel → Security → Configure firewall**, set
**XML-RPC API** to *Open* or *Restricted access* with the Homebridge
host whitelisted, and restart Homebridge.

**Heavy log spam from `[HapHomematic:ccu:events]`**
Set `--debug` off — at default verbosity, only errors and reconnects
log.
