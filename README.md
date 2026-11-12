# homebridge-hap-homematic

<!-- Modified by california444 (2026). See NOTICE. -->

[![Release](https://github.com/california444/homebridge-hap-homematic/actions/workflows/release.yml/badge.svg)](https://github.com/california444/homebridge-hap-homematic/actions/workflows/release.yml)
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
ports are supported. Each interface is supervised with ping/PONG and
re-subscribed after a CCU restart. Start values come from `getParamset`;
new services: irrigation (IrrigationSystem + Valves), doorbell
(HmIP-DSD-PCB); HmIP smoke detector via `SMOKE_DETECTOR_ALARM_STATUS`;
HmIP transmitter/receiver channel pairing. The custom UI maps channels
or whole devices (irrigation), edits service options and offers the
local IPv4 addresses as callback address. Planned:

- release pipeline, installation and acceptance on the real system

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

## Releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore(deps):` …). Every push to `main` builds and tests;
[semantic-release](https://github.com/semantic-release/semantic-release)
then tags `vX.Y.Z` and creates the GitHub release with notes
(`feat` → minor, `fix` / `chore(deps)` → patch, breaking change → major).
`package.json` keeps the placeholder `0.0.0-development`; the tag is the
version. Publishing to npm (trusted publishing, provenance) is a separate
job that needs approval in the `npm` environment and is switched off
until the plugin has passed acceptance (repository variable
`NPM_PUBLISH`).

## Acknowledgements

Built on the work of [mattein](https://github.com/matthiaseinig)
(Homebridge-Homematic-HAP) and [thkl](https://github.com/thkl)
(hap-homematic, homebridge-homematic). See [NOTICE](NOTICE) for the full
attribution.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
