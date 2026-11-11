# Integration guide

## Prerequisites

| Item | Minimum |
| ---- | ------- |
| Homebridge | 1.8 (also runs on 2.0 beta) |
| Node.js | 20.18 / 22.10 / 24.0 (LTS lines) |
| CCU firmware | RaspberryMatic 3.65 or recent CCU3 firmware |
| Network | Plugin host and CCU must be on the same routable subnet |

The plugin only talks to the CCU over the **LAN**. It does not need
internet access. It does not contact any of the author's servers, send
analytics, or auto-update.

## CCU user / role

The plugin authenticates to the CCU via the modern JSON-RPC API
(`/api/homematic.cgi`, `Session.login`). It needs a CCU user account
with the **Admin** role. *User* role is not enough — the JSON-RPC
endpoints we call (`Device.listAllDetail`, `SysVar.setBool`, etc.) are
gated to Admin.

A few things to get right when creating the user:

- **Don't enable Auto-Login on this user.** Auto-Login is an IP-based
  short-circuit for browser sessions; users configured that way often
  have no separately-stored password hash that `Session.login` can
  validate against, and the JSON-RPC API rejects every credential.
  Create a regular Admin user with a real password.
- Verify the password works by signing in to the CCU's WebUI in an
  *incognito* window before pasting it into the plugin config. If the
  WebUI login succeeds, the JSON-RPC call will too.
- A dedicated service user (e.g. `homebridge`) is cleaner than reusing
  the human `admin` account.

## Network requirements

| Direction | Port | Protocol | Why |
| --------- | ---- | -------- | --- |
| Plugin → CCU | 80 / 443 | JSON-RPC over HTTP(S) | discovery, variables, programs, rooms, getValue/setValue (control plane) |
| Plugin → CCU | 2001 | XML-RPC | BidCos-RF event subscription + fast `setValue` |
| Plugin → CCU | 2010 | XML-RPC | HmIP-RF event subscription + fast `setValue` |
| Plugin → CCU | 2000 | XML-RPC | BidCos-Wired (optional) |
| Plugin → CCU | 9292 | XML-RPC | VirtualDevices |
| CCU → Plugin | 9875 (default, configurable) | XML-RPC | inbound push events |

If the CCU and Homebridge are not on the same broadcast domain, you
need to **set the event-server bind host explicitly** to a routable
address that the CCU can reach. The default `0.0.0.0` makes the plugin
auto-detect a local IPv4, which works for most home setups.

If you run Homebridge in Docker, the event server port (9875 by
default) must be **published with the host's IP**, not just the
`0.0.0.0` shorthand — otherwise the CCU will try to call back on a
container-internal address it can't reach. Example:

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
    "hmIpRf": true,
    "bidcosWired": false,
    "virtualDevices": true,
    "cuxd": false
  },
  "interfacePorts": {
    "BidCos-RF": 32001,
    "HmIP-RF": 32010,
    "VirtualDevices": 39292
  },
  "ccuAuth": {
    "enabled": false,
    "username": "",
    "password": ""
  },
  "eventServer": {
    "host": "0.0.0.0",
    "port": 9875,
    "watchdogSeconds": 300
  },
  "channels": [
    {
      "address": "HmIP.000ABCDEF12345:1",
      "name": "Living Room Light",
      "service": "SwitchAccessory",
      "subtype": "outlet"
    }
  ],
  "variables": [{ "name": "PartyMode" }],
  "programs":  [{ "name": "Wake up" }]
}
```

| Field | Description |
| ----- | ----------- |
| `ccuIp` | IP or hostname of the CCU. Both work; hostnames are resolved at start-up. |
| `useTls` | If `true`, ReGa scripts use HTTPS on port 48181. The CCU's self-signed cert is accepted. |
| `interfaces.*` | Toggle per CCU interface. Disable interfaces you don't use to silence warnings on hosts that block those ports. |
| `interfacePorts.*` | Manual XML-RPC port override per interface. Leave blank to auto-discover via `Interface.listInterfaces`. Set explicitly when the auto-discovered port is not reachable from the Homebridge host (e.g. blocked by the CCU's firewall — RaspberryMatic's "Restrict access" presets block the +30000 ports unless XML-RPC API is set to *Open* or *Restricted access* with the Homebridge host whitelisted). |
| `ccuAuth.enabled` | Set to `true` if your CCU requires Basic auth on the WebUI. The credentials never leave `config.json` and are never logged. |
| `eventServer.host` | Address the CCU should call back. `0.0.0.0` auto-detects. Set explicitly when running in Docker or behind multiple NICs. |
| `eventServer.port` | Default 9875. Pick anything in 1024–65535. |
| `eventServer.watchdogSeconds` | If no events arrive for this long, every interface re-subscribes. Default 300 s. |
| `channels[]` | Per-channel HomeKit mapping, see service registry below. |
| `variables[]` | CCU variables exposed as Switch (boolean) / Lightbulb (numeric). |
| `programs[]` | CCU programs exposed as a single-shot Switch. |

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

For variables, the plugin auto-picks `VariableSwitchAccessory` for
boolean variables and `VariableLightAccessory` for numeric ones (with
the variable's min/max as the Brightness range).

## Security

- Run Homebridge as a **dedicated, non-root user**, the way the
  Homebridge installer does by default.
- `config.json` is plain JSON. Make sure it is `chmod 600` and owned by
  the Homebridge user.
- The plugin writes its own state under `<homebridge-storage>/homebridge-hap-homematic/`.
  No file outside that directory is opened by the plugin.
- The custom UI is reachable only through the Homebridge UI itself;
  the plugin does not open any extra TCP/HTTP listeners. Do not expose
  the Homebridge UI to the public internet.

See [SECURITY.md](../SECURITY.md) for the full threat model.

## Troubleshooting

**The CCU is reachable but discovery is empty.**
Check that the CCU's WebUI Settings → Security do not have *Authenticate
internal access* set without ticking the "Use CCU authentication"
option in this plugin too.

**Devices show up but never update in real time.**
Check the EventServer port. The CCU's *Status & Maintenance → Service
Messages* page lists registered RPC clients — your callback URL should
be there. If it isn't, there's a routing or NAT issue between CCU and
Homebridge.

**"No RPC client for interface X" or `init failed: connect ETIMEDOUT`**
The interface failed to subscribe at startup. Most common cause on
RaspberryMatic: the CCU firewall blocks external XML-RPC ports
(32001/32010/39292). Open the CCU WebUI → **Settings → Control Panel →
Security → Configure firewall**, set **XML-RPC API** to *Open* or
*Restricted access* with the Homebridge host whitelisted, and restart
Homebridge.

If you cannot change the firewall, you can pin alternative ports in
`interfacePorts.*` — e.g. `2001/2010/9292` if Homebridge runs on the
**same host** as the CCU and can reach loopback. Otherwise the CCU
binds those legacy ports to localhost only.

**Variables seem to lag.**
Variables are polled every 60 s. The CCU does not push variable
updates through the RPC channel reliably. There is no fix on our side.

**Heavy log spam from `[HapHomematic:ccu:events]`**
Set `--debug` off — at default verbosity, only errors and reconnects
log.
