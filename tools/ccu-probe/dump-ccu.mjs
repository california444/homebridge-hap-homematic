#!/usr/bin/env node
// dump-ccu.mjs — P0.1: liest Geräte, Kanäle und Datenpunkte per XML-RPC von der CCU.
// Nur lesende Aufrufe (listDevices, getParamsetDescription, getParamset), kein init, kein Callback.
//
// Aufruf:
//   node dump-ccu.mjs --host <CCU-IP> [--ports 2001,2010] [--tls] [--user U --pass P] [--out <Ordner>]
//
// Ergebnis: <out>/BidCos-RF.json, <out>/HmIP-RF.json und eine Kurzübersicht auf der Konsole.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xmlrpc from 'homematic-xmlrpc';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--'))
      acc.push([
        a.slice(2),
        all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1],
      ]);
    return acc;
  }, []),
);
if (!args.host) {
  console.error('Fehlt: --host <CCU-IP>');
  process.exit(1);
}
const tls = args.tls === true;
const [portRf, portIp] = String(args.ports ?? (tls ? '42001,42010' : '2001,2010'))
  .split(',')
  .map(Number);
const outDir = String(
  args.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'dump'),
);
const IFACES = [
  { name: 'BidCos-RF', port: portRf },
  { name: 'HmIP-RF', port: portIp },
];

function client(port) {
  const opts = { host: args.host, port, path: '/' };
  if (args.user) opts.basic_auth = { user: String(args.user), pass: String(args.pass ?? '') };
  if (tls) opts.rejectUnauthorized = false; // CCU nutzt meist ein selbstsigniertes Zertifikat
  return tls ? xmlrpc.createSecureClient(opts) : xmlrpc.createClient(opts);
}

function call(c, method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout bei ${method}`)), timeoutMs);
    c.methodCall(method, params, (err, val) => {
      clearTimeout(t);
      if (err) reject(err);
      else resolve(val);
    });
  });
}

await fs.mkdir(outDir, { recursive: true });

for (const iface of IFACES) {
  const c = client(iface.port);
  console.log(`\n=== ${iface.name} (${args.host}:${iface.port}${tls ? ', TLS' : ''}) ===`);

  let devices;
  try {
    devices = await call(c, 'listDevices', []);
  } catch (e) {
    console.error(`listDevices fehlgeschlagen: ${e.message}`);
    console.error(
      'Prüfen: Port erreichbar? CCU-Firewall erlaubt XML-RPC für diese IP? Auth aktiv?',
    );
    continue;
  }

  const result = {
    interface: iface.name,
    host: args.host,
    port: iface.port,
    dumpedAt: new Date().toISOString(),
    devices,
    channels: {},
  };
  const parents = devices.filter((d) => !d.PARENT);
  const channels = devices.filter((d) => d.PARENT);

  // Kanäle sequenziell abfragen (CCU schonen); Kanal 0 (MAINTENANCE) eingeschlossen.
  for (const ch of channels) {
    const entry = { type: ch.TYPE, parent: ch.PARENT, parentType: ch.PARENT_TYPE };
    try {
      entry.description = await call(c, 'getParamsetDescription', [ch.ADDRESS, 'VALUES']);
    } catch (e) {
      entry.descriptionError = e.message;
    }
    try {
      entry.values = await call(c, 'getParamset', [ch.ADDRESS, 'VALUES']);
    } catch (e) {
      entry.valuesError = e.message;
    }
    result.channels[ch.ADDRESS] = entry;
  }

  const file = path.join(outDir, `${iface.name}.json`);
  await fs.writeFile(file, JSON.stringify(result, null, 2));

  // Kurzübersicht: Gerät → Kanal → Kanaltyp → Datenpunkte (Typ/Operations)
  for (const dev of parents.sort((a, b) => a.TYPE.localeCompare(b.TYPE))) {
    console.log(`\n${dev.TYPE}  ${dev.ADDRESS}  FW ${dev.FIRMWARE ?? '?'}`);
    for (const chAddr of dev.CHILDREN ?? []) {
      const e = result.channels[chAddr];
      if (!e) continue;
      const dps = e.description
        ? Object.entries(e.description)
            .map(
              ([k, d]) =>
                `${k}:${d.TYPE}${d.OPERATIONS & 2 ? 'w' : ''}${d.OPERATIONS & 4 ? 'e' : ''}`,
            )
            .join(' ')
        : `(${e.descriptionError})`;
      console.log(`  ${chAddr.padEnd(18)} ${String(e.type).padEnd(32)} ${dps}`);
    }
  }
  console.log(`\n→ ${file} (${parents.length} Geräte, ${channels.length} Kanäle)`);
}
