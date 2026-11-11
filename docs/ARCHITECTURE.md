# Architecture

This document explains how `homebridge-hap-homematic` works at a
level of detail that should be sufficient for a contributor to make
meaningful changes without reading every file first. The companion
[INTEGRATION.md](INTEGRATION.md) covers operational concerns
(networking, configuration); this one is about the code.

## High-level shape

```
┌──────────────────────────┐    LAN, /api/homematic.cgi     ┌─────────────────┐
│ Homebridge process       │ ─── JSON-RPC (control plane) ─►│                 │
│                          │ ◄────  session token, JSON ────│  CCU3 /         │
│  HomematicPlatform       │                                │  Raspberrymatic │
│   ├─ CcuClient           │ ◄── XML-RPC events ────────────│                 │
│   │    ├─ CcuJsonRpcClient│      LAN, port 9875           │  (BidCos-RF,    │
│   │    ├─ RpcClient × N  │ ─── XML-RPC subscribe / setValue│   HmIP-RF, …)  │
│   │    └─ EventServer    │      LAN, ports 2001/2010/…   └─────────────────┘
│   └─ Services × M        │
│        (Switch, Dimmer…) │ ─── HAP characteristic update ─► HomeKit hub / Home app
└──────────────────────────┘
```

The plugin uses two separate CCU surfaces:

1. **JSON-RPC at `/api/homematic.cgi`** — the modern, structured CCU
   API. Used for everything declarative: device / channel / variable /
   program discovery, room layout, variable read/write, program
   execution, and individual `getValue` / `setValue` calls. Auth is via
   `Session.login` returning a session id that we attach to every
   subsequent call as `_session_id_` in the `params` object.
2. **XML-RPC** on the per-interface ports (2001 = BidCos-RF, 2010 =
   HmIP-RF, etc.) — used only to **subscribe** to push events and to
   send fast `setValue` calls (lower latency than going through
   /api/homematic.cgi for state writes that round-trip to events).
3. **Local XML-RPC server** ("EventServer", port 9875 by default) that
   the CCU calls back into when device state changes. We deliberately
   parse the inbound XML with a small in-house parser
   ([src/ccu/xmlRpc.ts](../src/ccu/xmlRpc.ts)) that **rejects
   `<!DOCTYPE>`** and external entity references, so the LAN service
   isn't trivially XXE-able.

### Why JSON-RPC, not ReGa scripts?

The predecessor plugins (`thkl/homebridge-homematic`,
`thkl/hap-homematic`, `AlexanderSchmutz/homebridge-homematic-asaw`) all
used the legacy `/tclrega.exe` ReGa-script endpoint with HTTP Basic
auth. We started there too, then ran into a real RaspberryMatic quirk:
ReGa scripts run in a per-user security context that sometimes refuses
to enumerate the device tree even for an *Admin* user, returning empty
arrays from `root.Devices().EnumIDs()`. The JSON-RPC API doesn't have
that hole — it returns the full tree as long as the user is
authenticated and has Admin role. JSON-RPC is also strictly
better-typed (returns JSON, not stringly-typed XML scraped from script
stdout) and has built-in session management.

## Module map

```
src/
├── index.ts             registers the platform with Homebridge
├── settings.ts          PLATFORM_NAME / PLUGIN_NAME constants
├── platform.ts          HomematicPlatform — DynamicPlatformPlugin
├── types.ts             cross-module types: ResolvedConfig,
│                        AccessoryContext, CcuDevice, CcuVariable, …
├── util/
│   ├── config.ts        resolveConfig() validates & defaults raw config
│   ├── logger.ts        PrefixedLogger with secret-scrubbing
│   ├── address.ts       parse / build CCU addresses
│   ├── sanitize.ts      defensive value coercion at CCU↔HomeKit boundary
│   └── storage.ts       confines all writes to api.user.storagePath()
├── ccu/
│   ├── CcuClient.ts        facade: owns api+rpc+eventServer, dispatch
│   ├── CcuJsonRpcClient.ts JSON-RPC at /api/homematic.cgi (control plane)
│   ├── RpcClient.ts        XML-RPC per interface (event subscription)
│   ├── EventServer.ts      inbound HTTP + XML-RPC dispatcher
│   └── xmlRpc.ts           in-house XML-RPC parser/serializer (no XXE)
├── services/
│   ├── types.ts         ServiceDefinition / ServiceContext interfaces
│   ├── AccessoryBase.ts shared per-accessory handler base class
│   ├── registry.ts      static SERVICE_DEFINITIONS table
│   └── impl/            one file per HAP service mapping
├── import/
│   └── HapHomematicImporter.ts  reads hap-homematic config / .tar.gz +
│                                 splits into Homebridge child-bridge
│                                 platform blocks (one per hap-homematic
│                                 instance)
homebridge-ui/
├── server.js            HomebridgePluginUiServer in its own process
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
   1. `CcuClient.start()` boots the EventServer and tries to subscribe
      every enabled XML-RPC interface via `init`. Unreachable interfaces
      log a warning and the rest still come up.
   2. We iterate `config.channels[]`, `config.variables[]`,
      `config.programs[]`. For each:
      - Compute a stable UUID with `api.hap.uuid.generate(...)`.
      - If cached, mutate `accessory.context` and call
        `api.updatePlatformAccessories([accessory])`.
      - Otherwise, construct + register via
        `api.registerPlatformAccessories(...)`.
   3. Anything that was cached but isn't in the new config is
      `unregisterPlatformAccessories(...)`'d.
4. On shutdown, `CcuClient.stop()` unregisters from every interface,
   closes the EventServer, and invalidates the JSON-RPC session.

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
- For setters, route through `this.ccu.setValue(...)`, which prefers
  the XML-RPC interface client (lower latency) and falls back to
  JSON-RPC `Interface.setValue` if no XML-RPC client is subscribed.
- Throw at most for genuinely-bad input. Normal failures should log
  and let HomeKit see "Not Responding" via a HapStatusError later.

## Custom UI

`homebridge-config-ui-x` spawns `homebridge-ui/server.js` in its own
Node process. The server receives `onRequest` calls from the iframe
and talks to the CCU itself by spinning up a short-lived `CcuClient`
against the credentials the user just typed (so **Test connection**
works before they save).

Critical security points:

- The iframe is treated as untrusted. Every `onRequest` validates its
  payload (type, length, allowlisted shape).
- Credentials never leave `config.json`; they flow through
  `homebridge.savePluginConfig()` only.
- Tarballs uploaded for hap-homematic import are size-capped (64 MiB)
  and parsed with `tar.list` (parse-only, no disk writes).
- The xmlRpc parser refuses DOCTYPE / external entities.

## Watchdog

A CCU XML-RPC subscription is fire-and-forget — the CCU forgets
clients that don't poke it for a while, and the network can
silently drop the connection. The CcuClient keeps a `lastEventAt`
timestamp; if no events arrive within `watchdogSeconds` (default 300),
every interface re-issues `init`. The implementation is a deliberate
adaptation of the proven loop in
[thkl/homebridge-homematic#HomeMaticRPC.js](https://github.com/thkl/homebridge-homematic/blob/master/HomeMaticRPC.js).

## Testing strategy

- **Vitest** with v8 coverage. Coverage thresholds: 95 % lines,
  95 % statements, 95 % functions, 90 % branches. The full
  quality gate is `npm run lint && npm run build && npm run coverage
  && npm audit --omit=dev --audit-level=high`.
- All tests live in `test/unit/`. Network code is exercised against
  on-the-fly local HTTP servers (`CcuJsonRpcClient`, `EventServer`);
  HAP types are stubbed by `test/helpers/hapStub.ts` rather than
  dragging in the full hap-nodejs runtime.

## What we deliberately did *not* port from upstream

- **Multi-instance bridge model.** hap-homematic spins up multiple HAP
  bridges under one server. Homebridge has a native
  [child-bridge mechanism](https://github.com/homebridge/homebridge/wiki/Child-Bridges)
  — users opt into it from the UI by setting `_bridge` on this
  platform's config block. Our hap-homematic importer can
  automatically emit one platform block per source instance with the
  right `_bridge` identity (see
  [IMPORT-FROM-HAP-HOMEMATIC.md](IMPORT-FROM-HAP-HOMEMATIC.md)).
- **ReGa-script transport.** Replaced by JSON-RPC for the reasons in
  the *Why JSON-RPC* section above.
- **Custom HAP pairing storage.** Homebridge owns it; we don't touch.
- **Variable change events** — the CCU doesn't push variable changes
  through the XML-RPC channel reliably. We poll variables every 60 s.
