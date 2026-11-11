// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * homebridge-config-ui-x runs this in its own Node process. It bridges
 * the iframe-side HTML to the runtime CCU client (XML-RPC only). Every
 * onRequest handler validates its payload — the iframe is treated as
 * untrusted.
 *
 * The handlers do NOT touch the live HomematicPlatform instance; they
 * spin up their own short-lived CcuClient against the credentials the
 * user just typed (so "Test connection" can run before the user even
 * saves the config). After save, the actual Platform takes over.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

// Boot-time diagnostic banner. homebridge-config-ui-x captures stdout of
// the UI subprocess and surfaces it under "Custom UI logs" — and if the
// user is just running `node server.js` to verify the install, this is
// the first thing they see. If you DON'T see this line, the file isn't
// reachable from the install path.
// Read once at boot so /services can return it without re-reading per
// request and so the boot banner has the same source of truth.
const PLUGIN_VERSION = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolvePath(here, '..', 'package.json');
  let version = 'unknown';
  try {
    if (existsSync(pkgPath)) {
      version = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown';
    }
  } catch { /* ignore */ }
  const distRoot = resolvePath(here, '..', 'dist', 'src');
  const distPresent = existsSync(distRoot);
  console.log(`[homebridge-hap-homematic UI] v${version} booting from ${here}; dist present: ${distPresent}`);
  if (!distPresent) {
    console.error(`[homebridge-hap-homematic UI] FATAL: ${distRoot} does not exist. ` +
      'The custom UI cannot start without the compiled dist/ folder. ' +
      'Re-install the plugin (npm install --install-links /path/to/clone) and restart Homebridge.');
  }
  return version;
})();

import { CcuClient } from '../dist/src/ccu/CcuClient.js';
import { resolveConfig, ConfigError } from '../dist/src/util/config.js';
import { PrefixedLogger } from '../dist/src/util/logger.js';
import {
  SERVICE_DEFINITIONS,
  servicesForChannelType,
} from '../dist/src/services/registry.js';

class UiLogger {
  info(...args)    { console.log('[ui]', ...args); }
  success(...args) { console.log('[ui]', ...args); }
  warn(...args)    { console.warn('[ui]', ...args); }
  error(...args)   { console.error('[ui]', ...args); }
  debug()          { /* drop */ }
  log(_level, ...args) { console.log('[ui]', ...args); }
  prefix = 'ui';
}

class HapHomematicUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/services', () => this.handleServices());
    this.onRequest('/test-connection', (payload) => this.handleTestConnection(payload));
    this.onRequest('/discover', (payload) => this.handleDiscover(payload));

    this.ready();
    console.log('[homebridge-hap-homematic UI] handlers registered, ready signaled');
  }

  // --- handlers ----------------------------------------------------

  handleServices() {
    return {
      pluginVersion: PLUGIN_VERSION,
      channelServices: SERVICE_DEFINITIONS.map((s) => ({
        key: s.key,
        description: s.description,
        channelTypes: s.channelTypes,
        priority: s.priority,
        variants: s.variants ?? [],
      })),
    };
  }

  async handleTestConnection(payload) {
    const config = this.coerceConfig(payload);
    const log = new PrefixedLogger(new UiLogger(), 'ui:test');
    const ccu = new CcuClient({ config, log });
    try {
      // system.listMethods on every enabled XML-RPC port: cheap and
      // side-effect-free. Result per interface.
      const results = await ccu.probeInterfaces();
      if (results.length === 0) {
        throw new RequestError('No interface enabled', { status: 400 });
      }
      const ok = results.every((r) => r.ok);
      const message = results
        .map((r) => (r.ok ? `${r.interfaceId}:${r.port} OK` : `${r.interfaceId}:${r.port} failed (${r.error})`))
        .join(' · ');
      return { ok, message, interfaces: results };
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError(`CCU unreachable: ${err.message}`, { status: 502 });
    } finally {
      try { await ccu.stop(); } catch { /* ignore */ }
    }
  }

  async handleDiscover(payload) {
    const config = this.coerceConfig(payload);
    const log = new PrefixedLogger(new UiLogger(), 'ui:discover');
    const ccu = new CcuClient({ config, log });
    try {
      const devices = await ccu.listDevices();

      // Annotate channels with suggested services.
      const enrichedDevices = devices.map((d) => ({
        ...d,
        channels: d.channels.map((c) => ({
          ...c,
          suggestedServices: servicesForChannelType(c.type).map((s) => s.key),
        })),
      }));

      return { devices: enrichedDevices };
    } catch (err) {
      throw new RequestError(`Discovery failed: ${err.message}`, { status: 502 });
    } finally {
      try { await ccu.stop(); } catch { /* ignore */ }
    }
  }

  // --- helpers -----------------------------------------------------

  coerceConfig(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new RequestError('Missing config payload', { status: 400 });
    }
    try {
      return resolveConfig({
        platform: 'HapHomematic',
        name: typeof payload.name === 'string' ? payload.name : 'HapHomematic',
        ccuIp: payload.ccuIp,
        useTls: payload.useTls,
        interfaces: payload.interfaces,
        interfacePorts: payload.interfacePorts,
        eventServer: payload.eventServer,
      });
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new RequestError(err.message, { status: 400 });
      }
      throw err;
    }
  }
}

export { HapHomematicUiServer };
export default new HapHomematicUiServer();
