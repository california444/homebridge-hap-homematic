# Security Policy

<!-- Modified by california444 (2026). See NOTICE. -->

## Threat model

`homebridge-hap-homematic` runs in the trusted Homebridge process on a
LAN host that already has XML-RPC access to your CCU. It is not a
multi-tenant product and is not intended to be exposed to the public
internet. The relevant threats it actively mitigates are:

1. **Hostile values from the CCU.** Device descriptions, datapoint
   values and event payloads are parsed defensively; no value is
   used to build a shell command or evaluated as code.
2. **Hostile values from the Homebridge custom-UI iframe.** All
   `onRequest` handlers in `homebridge-ui/server` validate their payloads
   (type, length, allowlist) before passing them to the CCU client.
   The frontend is treated as untrusted.
3. **XML-RPC credentials.** Optional Basic-auth credentials (`rpcAuth`)
   live in `config.json` (Homebridge's own file). They are scrubbed from
   log arguments (`util/logger.ts`). The iframe reads and writes them
   only through the official `getPluginConfig` / `updatePluginConfig`
   API.
4. **Filesystem writes.** All plugin-owned files (caches, mappings)
   are written under `<storagePath>/homebridge-hap-homematic/`. No path
   that originates from user input or CCU output is ever opened directly;
   all paths are normalized and confined to the storage root before use.
5. **TLS to the CCU.** Opt-in (`useTls`, ports 42001 / 42010). The
   CCU's self-signed certificate is accepted (unavoidable for default
   installations); connections only ever go to the configured `ccuIp`.
   The CCU's callback to the event server stays plain HTTP.

## Reporting a vulnerability

Please report it privately to the maintainer of this fork (via the
repository's private security advisory feature once it is hosted)
rather than in a public issue. Include:

- A clear description of the issue.
- Steps to reproduce, ideally a minimal config.
- Impact (information disclosure, denial of service, code execution, …).
- Affected versions if known.

We aim to acknowledge within 72 hours and ship a fix as a patch release.

## Hardening checklist (kept in sync with CI)

Before any release we verify:

- [ ] `npm audit --omit=dev` is clean (no high or critical findings).
- [ ] No `eval`, `new Function`, or `require()` of user-controlled paths.
- [ ] No `child_process.exec` of strings built from config or CCU values.
- [ ] All `onRequest` UI handlers validate payload shape and length.
- [ ] No credential ever flows into `log.*` calls (lint rule + manual review).
- [ ] All file writes use `path.resolve` and assert containment in
      `api.user.storagePath()`.
- [ ] Test coverage ≥ 95 % lines / statements / functions.
- [ ] `pluginRules` (eslint) report no warnings.
- [ ] No native dependency added without an explicit decision recorded
      in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
