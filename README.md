# homebridge-hap-homematic

<!--
  Modified by california444 (2026) for homebridge-hap-homematic,
  a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
-->

[![CI](https://github.com/california444/homebridge-hap-homematic/actions/workflows/ci.yml/badge.svg)](https://github.com/california444/homebridge-hap-homematic/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A Homebridge plugin for **HomeMatic** (BidCos-RF) and **HomematicIP** (HmIP-RF)
devices on a CCU / OpenCCU. It talks to `rfd` and `HMIPServer` over **XML-RPC
only**: no JSON-RPC, no ReGa, no CCU login.

## Which project is which?

The names are close, so to be clear:

| Project | What it is |
| --- | --- |
| **homebridge-hap-homematic** (this repo) | Homebridge plugin, hard fork of Homebridge-Homematic-HAP, XML-RPC only, one child bridge |
| [Homebridge-Homematic-HAP](https://github.com/matthiaseinig/Homebridge-Homematic-HAP) (npm `homebridge-homematic-hap`) | The upstream Homebridge plugin this fork is based on (JSON-RPC + XML-RPC, variables, programs, multi-bridge, hap-homematic import) |
| [hap-homematic](https://github.com/thkl/hap-homematic) | thkl's original HomeKit bridge, running as a CCU add-on |

This fork is maintained independently. No changes are sent upstream or
taken from it.

## Status

Work in progress. Based on upstream v1.2.12; JSON-RPC, system
variables, programs, rooms, the hap-homematic import and multi-bridge
support are removed (see NOTICE). Discovery runs over XML-RPC
`listDevices` with a cache, mappings live in
`<storagePath>/homebridge-hap-homematic/devices.json`
([docs/DEVICES.md](docs/DEVICES.md)), TLS and Basic auth on the XML-RPC
ports are supported. Planned:

- per-interface reconnect after a CCU restart (ping/PONG watchdog)
- new services: irrigation (IrrigationSystem + Valves), doorbell
  (HmIP-DSD-PCB); HmIP smoke detector via `SMOKE_DETECTOR_ALARM_STATUS`;
  HmIP transmitter/receiver channel pairing

## Requirements

- Node.js ≥ 24
- Homebridge ≥ 2.4.0
- CCU / OpenCCU with the XML-RPC ports reachable from the Homebridge host
  (default 2001 for BidCos-RF, 2010 for HmIP-RF), and the plugin's event
  server port (default 9875) reachable from the CCU

## Install (local build)

`dist/` is not checked in. Build a package and install it on the
Homebridge host:

```bash
npm ci
npm run build
npm pack                      # → homebridge-hap-homematic-<version>.tgz
# on the Homebridge host:
npm install -g ./homebridge-hap-homematic-<version>.tgz
```

## Development

```bash
npm ci
npm run lint
npm run build
npm run coverage
```

## Acknowledgements

Built on the work of [mattein](https://github.com/matthiaseinig)
(Homebridge-Homematic-HAP) and [thkl](https://github.com/thkl)
(hap-homematic, homebridge-homematic). See [NOTICE](NOTICE) for the full
attribution.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
