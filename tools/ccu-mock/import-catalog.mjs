#!/usr/bin/env node
// import-catalog.mjs — baut die Katalogdateien für ccu-mock.mjs.
//
//   node tools/ccu-mock/import-catalog.mjs pydevccu <Pfad zu pydevccu-0.2.6/pydevccu>
//       → catalog/pydevccu/devices.json  (nur Geräte-/Kanalbeschreibungen und VALUES-Beschreibungen)
//
//   node tools/ccu-mock/import-catalog.mjs master <Pfad zu pydevccu/pydevccu>
//       → catalog/pydevccu/master.json  (MASTER-Beschreibungen je Gerätetyp, nur die Parameter
//         in MASTER_PARAMS; Schlüssel = Kanalnummer, "device" für das Gerät selbst)
//
//   node tools/ccu-mock/import-catalog.mjs virtual <virtual-devices.json aus p03-spike.mjs>
//       → catalog/virtual/<TYP>.json  (je Gruppentyp eine Datei, Adresse auf INT0000001 normiert)
//
//   node tools/ccu-mock/import-catalog.mjs local <Ordner mit BidCos-RF.json/HmIP-RF.json aus dump-ccu.mjs>
//       → catalog/local/*.json  (Kopie; enthält echte Seriennummern, steht in .gitignore)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [mode, src] = process.argv.slice(2);
if (!mode || !src) {
  console.error('Aufruf: import-catalog.mjs pydevccu|virtual|local <Quelle>');
  process.exit(1);
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data) + '\n');
  console.log(
    `→ ${path.relative(process.cwd(), f)} (${Math.round(fs.statSync(f).size / 1024)} KB)`,
  );
};

if (mode === 'pydevccu') {
  const devDir = path.join(src, 'device_descriptions');
  const psDir = path.join(src, 'paramset_descriptions');
  const out = {};
  for (const file of fs
    .readdirSync(devDir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const devices = readJson(path.join(devDir, file));
    const paramsets = fs.existsSync(path.join(psDir, file)) ? readJson(path.join(psDir, file)) : {};
    const parent = devices.find((d) => !d.PARENT);
    if (!parent) continue;
    const values = {};
    for (const d of devices) {
      if (d.PARENT && paramsets[d.ADDRESS]?.VALUES) values[d.ADDRESS] = paramsets[d.ADDRESS].VALUES;
    }
    out[file.replace(/\.json$/, '')] = { type: parent.TYPE, devices, values };
  }
  writeJson(path.join(here, 'catalog/pydevccu/devices.json'), out);
  console.log(`${Object.keys(out).length} Gerätetypen übernommen.`);
} else if (mode === 'master') {
  // Nur was das Plugin auswerten könnte: Batteriegrenze, Thermostat-Grenzen, Betriebsart von Eingängen
  const MASTER_PARAMS = [
    'LOW_BAT_LIMIT',
    'TEMPERATURE_MINIMUM',
    'TEMPERATURE_MAXIMUM',
    'MIN_MAX_VALUE_NOT_RELEVANT_FOR_MANU_MODE',
    'CHANNEL_OPERATION_MODE',
  ];
  const KEEP = ['ID', 'TYPE', 'OPERATIONS', 'FLAGS', 'MIN', 'MAX', 'DEFAULT', 'UNIT', 'VALUE_LIST'];
  const devDir = path.join(src, 'device_descriptions');
  const psDir = path.join(src, 'paramset_descriptions');
  const out = {};
  for (const file of fs
    .readdirSync(psDir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const devFile = path.join(devDir, file);
    const parent = fs.existsSync(devFile) ? readJson(devFile).find((d) => !d.PARENT) : null;
    if (!parent) continue;
    const byChannel = {};
    for (const [address, sets] of Object.entries(readJson(path.join(psDir, file)))) {
      const master = sets?.MASTER ?? {};
      const picked = {};
      for (const p of MASTER_PARAMS) {
        if (!master[p]) continue;
        picked[p] = Object.fromEntries(
          KEEP.filter((k) => k in master[p]).map((k) => [k, master[p][k]]),
        );
      }
      if (Object.keys(picked).length === 0) continue;
      byChannel[address.includes(':') ? address.split(':')[1] : 'device'] = picked;
    }
    if (Object.keys(byChannel).length) out[parent.TYPE] = byChannel;
  }
  writeJson(path.join(here, 'catalog/pydevccu/master.json'), out);
  console.log(`${Object.keys(out).length} Gerätetypen mit MASTER-Parametern übernommen.`);
} else if (mode === 'virtual') {
  const { devices } = readJson(src);
  for (const parent of devices.filter((d) => !d.PARENT)) {
    const base = parent.ADDRESS;
    const norm = (s) => (typeof s === 'string' ? s.replace(base, 'INT0000001') : s);
    const own = devices.filter((d) => d.ADDRESS === base || d.PARENT === base);
    const outDevices = [];
    const desc = {};
    const values = {};
    for (const d of own) {
      const { VALUES_DESCRIPTION, VALUES, ERROR: _error, ...rest } = d;
      rest.ADDRESS = norm(rest.ADDRESS);
      rest.PARENT = norm(rest.PARENT);
      if (Array.isArray(rest.CHILDREN)) rest.CHILDREN = rest.CHILDREN.map(norm);
      outDevices.push(rest);
      if (VALUES_DESCRIPTION) desc[rest.ADDRESS] = VALUES_DESCRIPTION;
      if (VALUES) values[rest.ADDRESS] = VALUES;
    }
    writeJson(path.join(here, `catalog/virtual/${parent.TYPE}.json`), {
      type: parent.TYPE,
      source: `CCU, ${new Date().toISOString().slice(0, 10)}, gemessen mit p03-spike.mjs (leere Gruppe)`,
      devices: outDevices,
      descriptions: desc,
      values,
    });
  }
} else if (mode === 'local') {
  for (const f of ['BidCos-RF.json', 'HmIP-RF.json']) {
    const p = path.join(src, f);
    if (!fs.existsSync(p)) continue;
    const { host: _host, ...rest } = readJson(p); // IP der CCU nicht mitnehmen
    writeJson(path.join(here, 'catalog/local', f), rest);
  }
} else {
  console.error(`Unbekannter Modus ${mode}`);
  process.exit(1);
}
