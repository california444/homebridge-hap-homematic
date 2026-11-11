# Security Policy

## Threat model

`homebridge-hap-homematic` runs in the trusted Homebridge process on a
LAN host that already has full RPC and ReGa access to your CCU. It is not a
multi-tenant product and is not intended to be exposed to the public
internet. The relevant threats it actively mitigates are:

1. **Hostile values from the CCU.** Device names, datapoint values, ReGa
   script output, and event payloads are parsed defensively; no value is
   used to build a shell command or evaluated as code.
2. **Hostile values from the Homebridge custom-UI iframe.** All
   `onRequest` handlers in `homebridge-ui/server` validate their payloads
   (type, length, allowlist) before passing them to the CCU client.
   The frontend is treated as untrusted.
3. **Persistence of secrets.** CCU credentials, when configured, live in
   `config.json` (Homebridge's own file). They are never logged, never
   printed by `--debug` mode, and never sent to the iframe. The iframe
   retrieves and updates them only via the official `homebridge.getPluginConfig`
   / `updatePluginConfig` / `savePluginConfig` API.
4. **Filesystem writes.** All plugin-owned files (cache, import staging,
   diagnostics dumps) are written under `api.user.storagePath()`. No path
   that originates from user input or CCU output is ever opened directly;
   all paths are normalized and confined to the storage root before use.
5. **TLS to the CCU.** TLS is opt-in via config (`useTls`). When enabled,
   the CCU's self-signed certificate is accepted (this is unavoidable for
   default Raspberrymatic installations) but only for the configured
   `ccuIp` host — connections to any other host fail closed.

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
