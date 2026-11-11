# Architecture

<!--
  Modified by california444 (2026) for homebridge-hap-homematic,
  a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
-->

This document explains how `homebridge-hap-homematic` works at a
level of detail that should be sufficient for a contributor to make
meaningful changes without reading every file first. The companion
[INTEGRATION.md](INTEGRATION.md) covers operational concerns
(networking, configuration); this one is about the code.

## High-level shape

```text
┌──────────────────────────┐                                  ┌─────────────────┐
│ Homebridge process       │ ── XML-RPC: listDevices, init, ─►│                 │
│                          │    getValue, setValue            │  CCU / OpenCCU  │
│  HomematicPlatform       │    (2001 BidCos-RF, 2010 HmIP-RF)│                 │
│   ├─ CcuClient           │                                  │  rfd (BidCos-RF)│
│   │    ├─ RpcClient × 2  │ ◄── XML-RPC callbacks ───────────│  HMIPServer     │
│   │    └─ EventServer    │     (event, listDevices,         │  (HmIP-RF)      │
│   └─ Services × M        │      newDevices; port 9875)      └─────────────────┘
│        (Switch, Blind…)  │ ─── HAP characteristic update ─► HomeKit hub / Home app
└──────────────────────────┘
```

The plugin talks to the CCU over **XML-RPC only**:

1. **Outbound XML-RPC** to `rfd` (BidCos-RF, port 2001) and
   `HMIPServer` (HmIP-RF, port 2010): `listDevices` for discovery,
   `init` to subscribe to push events, `getValue` / `setValue`, and
   `system.listMethods` for the UI's connection test. No JSON-RPC, no
   ReGa scripts, no CCU login.
2. **Local XML-RPC server** ("EventServer", port 9875 by default) that
   the CCU calls back into when device state changes. Inbound XML is
   parsed with a small in-house parser
   ([src/ccu/xmlRpc.ts](../src/ccu/xmlRpc.ts)) that **rejects
   `<!DOCTYPE>`** and external entity references, so the LAN service
   isn't trivially XXE-able.

XML-RPC carries no device or channel names. Discovery therefore uses a
placeholder name (`TYPE ADDRESS`); the HomeKit name comes from the
mapping in `devices.json` (set in the UI) or from the Home app.

## Configuration and storage

| Data | Where |
| --- | --- |
| Connection | `config.json`, platform block (`util/config.ts`) |
| Device mappings | `<storagePath>/homebridge-hap-homematic/devices.json` (`util/devices.ts`, format in [DEVICES.md](DEVICES.md)) |
| Discovery cache (`listDevices` per interface) | `…/discovery.json` (`ccu/Discovery.ts`) |
| Paramset cache (`getParamsetDescription` per device type + firmware + channel type) | `…/paramsets.json` (`ccu/Discovery.ts`) |

All writes go through `util/storage.ts` (confined to the storage
directory, temp file + rename, mode 0600). The caches are rebuilt if
they are broken; devices.json is never overwritten when invalid.

## Module map

```text
src/
├── index.ts             registers the platform with Homebridge
├── settings.ts          PLATFORM_NAME / PLUGIN_NAME constants
├── platform.ts          HomematicPlatform — DynamicPlatformPlugin
├── types.ts             cross-module types: ResolvedConfig,
│                        AccessoryContext, CcuDevice, CcuChannel
├── util/
│   ├── config.ts        resolveConfig() validates & defaults raw config
│   ├── logger.ts        PrefixedLogger with secret-scrubbing
│   ├── address.ts       parse / build CCU addresses
│   ├── sanitize.ts      defensive value coercion at CCU↔HomeKit boundary
│   ├── devices.ts       devices.json: validate, load, save, flatten
│   └── storage.ts       confines all writes to <storagePath>/homebridge-hap-homematic/
├── ccu/
│   ├── CcuClient.ts     facade: RpcClient per interface + EventServer,
│   │                    discovery, routing, listener dispatch, watchdog
│   ├── Discovery.ts     listDevices with cache fallback, paramset cache
│   ├── RpcClient.ts     XML-RPC client per interface (HTTP / HTTPS, Basic auth)
│   ├── EventServer.ts   inbound HTTP + XML-RPC dispatcher
│   └── xmlRpc.ts        in-house XML-RPC parser/serializer (no XXE)
└── services/
    ├── types.ts         ServiceDefinition / ServiceContext interfaces
    ├── AccessoryBase.ts shared per-accessory handler base class
    ├── registry.ts      static SERVICE_DEFINITIONS table
    └── impl/            one file per HAP service mapping
homebridge-ui/
├── server.src.js        HomebridgePluginUiServer (bundled to server.js)
└── public/              HTML + plain JS frontend (Bootstrap 5)
```

## Lifecycle

1. **Homebridge constructs `HomematicPlatform`** with the user's config
   block. `resolveConfig` validates it; if validation fails, the
   platform logs `error` and stays idle (per the verified-plugin
   "must not start unless configured" rule). It does *not* throw,
   because that would crash the bridge.
2. **`configureAccessory`** is called once per cached accessory restored
   from disk. We just remember them; we never re-register.
3. On `didFinishLaunching`:
   1. Read and validate `devices.json`; each mapping pins its device
      serial to its interface.
   2. `Discovery.run()`: `listDevices` once per interface; an interface
      that fails falls back to `discovery.json`. Then
      `getParamsetDescription` for each new device-type / firmware /
      channel-type combination of the mapped channels and channel 0.
   3. `CcuClient.start()` boots the EventServer and subscribes each
      interface via `init`. Unreachable interfaces log a warning and the
      rest still come up.
   4. One accessory per mapping:
      - UUID from `<Interface>:<Serial>:<Channel>:<Service>` (D6;
        `device` instead of the channel for whole-device mappings).
      - If cached, mutate `accessory.context` and call
        `api.updatePlatformAccessories([accessory])`.
      - Otherwise, construct + register via
        `api.registerPlatformAccessories(...)`.
   5. Anything that was cached but isn't mapped any more is
      `unregisterPlatformAccessories(...)`'d.
4. On shutdown, `CcuClient.stop()` unregisters from every interface
   (`init` with the same URL and an empty id) and closes the
   EventServer.

## Address routing

Addresses are used exactly as XML-RPC reports them (`ABC0000002:1`,
`00000000000A01:6`, no interface prefix). `CcuClient` routes each call
to the interface whose `listDevices` answer contained the address.
Before discovery it falls back to the serial shape: 14 hex digits →
HmIP-RF, everything else → BidCos-RF.

## Service registry

`src/services/registry.ts` keeps a **static** array of
`ServiceDefinition`s. Each definition declares:

- `key` — stable identifier saved in `accessory.context.service`.
- `channelTypes` — list of CCU channel-type strings it can handle
  (e.g. `'SWITCH_VIRTUAL_RECEIVER'`).
- `priority` — lower wins when multiple services match a channel type.
- `variants` — optional sub-types the user can pick.
- `build(ctx)` — constructs the per-accessory handler.

To add a new service type: create
`src/services/impl/MyAccessory.ts` exporting a `ServiceDefinition`,
then import + push it into `registry.ts`. There is no auto-discovery
(no `fs.readdir`-based loader) — a static list keeps the dependency
graph analysable.

## Per-accessory handler contract

A handler is built once per accessory and lives for the process
lifetime. It must:

- Call `getOrAddService(...)` to set up its HAP service and
  characteristics.
- Use `registerListener(channelAddress, datapoint, callback)` for any
  CCU datapoint it cares about. The base class tracks the disposer so
  `dispose()` can remove the listener cleanly.
- Implement `onGet` handlers that return a **cached** value
  immediately — never block on the network. Push fresh values to
  HomeKit through `service.updateCharacteristic(...)` in the
  EventServer callback.
- For setters, route through `this.ccu.setValue(...)` (XML-RPC on the
  channel's interface).
- Throw at most for genuinely-bad input. Normal failures should log
  and let HomeKit see "Not Responding" via a HapStatusError later.

## Custom UI

`homebridge-config-ui-x` spawns `homebridge-ui/server.js` in its own
Node process. `server.js` is generated by `npm run build` (esbuild
bundle of `server.src.js` plus `@homebridge/plugin-ui-utils`; it
imports the compiled `dist/` at runtime). The server receives
`onRequest` calls from the iframe and talks to the CCU itself by
spinning up a short-lived `CcuClient` against the settings the user
just typed (so **Test connection** works before they save):

- `/services` — the service registry for the edit dialog.
- `/test-connection` — `system.listMethods` on every enabled port,
  result per interface.
- `/discover` — `listDevices` on every enabled interface, with
  suggested services per channel.
- `/devices/get`, `/devices/put` — read / validate and write
  `devices.json`.

Critical security points:

- The iframe is treated as untrusted. Every `onRequest` validates its
  payload (type, length, allowlisted shape).
- The xmlRpc parser refuses DOCTYPE / external entities.

## Watchdog

A CCU XML-RPC subscription is fire-and-forget — the CCU forgets
clients after a restart and does not re-register them. The CcuClient
keeps a `lastEventAt` timestamp; if no events arrive within
`watchdogSeconds` (default 300), every interface re-issues `init`.
A per-interface state machine with ping/PONG is planned (plan
section 7).

## Testing strategy

- **Vitest** with v8 coverage. Coverage thresholds: 95 % lines,
  95 % statements, 95 % functions, 90 % branches. The full
  quality gate is `npm run lint && npm run build && npm run coverage
  && npm audit --omit=dev --audit-level=high`.
- All tests live in `test/unit/`. `RpcClient` is stubbed (no sockets)
  in the `CcuClient` tests; the `EventServer` is exercised against a
  local HTTP server; HAP types are stubbed by `test/helpers/hapStub.ts`
  rather than dragging in the full hap-nodejs runtime.

## Removed from upstream

- JSON-RPC control plane (`CcuJsonRpcClient`, `Session.login`, CCU
  user), ReGa, system variables, programs, rooms.
- hap-homematic import (backup tarball / `config.json`).
- Multi-bridge support: one plugin instance = one child bridge.
- Interfaces other than BidCos-RF and HmIP-RF (Wired, VirtualDevices,
  CUxD).
