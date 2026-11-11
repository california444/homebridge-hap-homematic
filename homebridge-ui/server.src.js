// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * homebridge-config-ui-x runs this in its own Node process. It bridges
 * the iframe-side HTML to the runtime CCU client and the backup
 * importer. Every onRequest handler validates its payload — the iframe
 * is treated as untrusted.
 *
 * The handlers do NOT touch the live HomematicPlatform instance; they
 * spin up their own short-lived CcuClient against the credentials the
 * user just typed (so "Test connection" can run before the user even
 * saves the config). After save, the actual Platform takes over.
 */

import { Buffer } from 'node:buffer';
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
  importBackupTarball,
  importConfigJson,
  ImportError,
  mergeIntoConfig,
  splitReportIntoBridges,
} from '../dist/src/import/HapHomematicImporter.js';
import {
  SERVICE_DEFINITIONS,
  VARIABLE_SERVICE_DEFINITIONS,
  servicesForChannelType,
} from '../dist/src/services/registry.js';

const MAX_BASE64_BYTES = 96 * 1024 * 1024; // ~64 MiB after base64 inflation

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
    this.onRequest('/import-backup', (payload) => this.handleImportBackup(payload));
    this.onRequest('/import-config-json', (payload) => this.handleImportConfigJson(payload));
    this.onRequest('/split-into-bridges', (payload) => this.handleSplitIntoBridges(payload));

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
      variableServices: VARIABLE_SERVICE_DEFINITIONS.map((s) => ({
        key: s.key,
        description: s.description,
        forValueType: s.forValueType,
      })),
    };
  }

  async handleTestConnection(payload) {
    const config = this.coerceConfig(payload);
    const log = new PrefixedLogger(new UiLogger(), 'ui:test');
    const ccu = new CcuClient({ config, log });
    try {
      // Probe via JSON-RPC — listing interfaces is a cheap, side-effect-free
      // call that confirms both reachability AND auth.
      const intfs = await ccu.api.call('Interface.listInterfaces');
      return {
        ok: true,
        message: `CCU reachable (${Array.isArray(intfs) ? intfs.length : '?'} interfaces)`,
      };
    } catch (err) {
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
      const [devices, variables, programs, rooms] = await Promise.all([
        ccu.listDevices(),
        ccu.listVariables(),
        ccu.listPrograms(),
        ccu.listRooms(),
      ]);

      // Annotate channels with suggested services.
      const enrichedDevices = devices.map((d) => ({
        ...d,
        channels: d.channels.map((c) => ({
          ...c,
          suggestedServices: servicesForChannelType(c.type).map((s) => s.key),
        })),
      }));

      return { devices: enrichedDevices, variables, programs, rooms };
    } catch (err) {
      throw new RequestError(`Discovery failed: ${err.message}`, { status: 502 });
    } finally {
      try { await ccu.stop(); } catch { /* ignore */ }
    }
  }

  async handleImportBackup(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new RequestError('Empty payload', { status: 400 });
    }
    const { tarballBase64 } = payload;
    if (typeof tarballBase64 !== 'string' || tarballBase64.length === 0) {
      throw new RequestError('Missing tarballBase64', { status: 400 });
    }
    if (tarballBase64.length > MAX_BASE64_BYTES) {
      throw new RequestError('Backup too large', { status: 413 });
    }
    let buf;
    try {
      buf = Buffer.from(tarballBase64, 'base64');
    } catch (err) {
      throw new RequestError(`Invalid base64: ${err.message}`, { status: 400 });
    }
    try {
      const report = await importBackupTarball(buf);
      return report;
    } catch (err) {
      if (err instanceof ImportError) {
        throw new RequestError(err.message, { status: 400 });
      }
      throw new RequestError(`Import failed: ${err.message}`, { status: 500 });
    }
  }

  handleSplitIntoBridges(payload) {
    if (!payload || typeof payload !== 'object' || !payload.report) {
      throw new RequestError('Missing report', { status: 400 });
    }
    try {
      return splitReportIntoBridges(payload.report);
    } catch (err) {
      throw new RequestError(`Split failed: ${err.message}`, { status: 500 });
    }
  }

  handleImportConfigJson(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new RequestError('Empty payload', { status: 400 });
    }
    const { configJson } = payload;
    if (typeof configJson !== 'string' || configJson.length === 0) {
      throw new RequestError('Missing configJson', { status: 400 });
    }
    if (configJson.length > 16 * 1024 * 1024) {
      throw new RequestError('configJson too large', { status: 413 });
    }
    try {
      return importConfigJson(configJson);
    } catch (err) {
      if (err instanceof ImportError) {
        throw new RequestError(err.message, { status: 400 });
      }
      throw new RequestError(`Import failed: ${err.message}`, { status: 500 });
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
        ccuAuth: payload.ccuAuth,
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

export { HapHomematicUiServer, mergeIntoConfig };
export default new HapHomematicUiServer();
