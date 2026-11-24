#!/usr/bin/env node
// ccu-mock.mjs — verhält sich für homebridge-hap-homematic wie eine CCU:
// BidCos-RF, HmIP-RF und VirtualDevices per XML-RPC, Events an angemeldete Clients
// und eine Weboberfläche zum Auswählen von Geräten, Setzen von Werten und Simulieren von Fehlern.
//
// Aufruf:  node tools/ccu-mock/ccu-mock.mjs [--rf 2001] [--ip 2010] [--groups 9292] [--ui 8080]
//                                           [--host 0.0.0.0] [--state ./state.json]
// Siehe README.md im selben Ordner.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const xmlrpc = require('homematic-xmlrpc');
const Serializer = require('homematic-xmlrpc/lib/serializer.js');
const Deserializer = require('homematic-xmlrpc/lib/deserializer.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// ---- Optionen --------------------------------------------------------------------
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
const bindHost = String(args.host ?? '0.0.0.0');
const uiPort = Number(args.ui ?? 8080);
const stateFile = path.resolve(String(args.state ?? path.join(here, 'state.json')));

const IFACES = {
  'BidCos-RF': { name: 'BidCos-RF', port: Number(args.rf ?? 2001), path: null, pong: 'CENTRAL' },
  'HmIP-RF': { name: 'HmIP-RF', port: Number(args.ip ?? 2010), path: null, pong: 'CENTRAL:0' },
  VirtualDevices: {
    name: 'VirtualDevices',
    port: Number(args.groups ?? 9292),
    path: '/groups',
    pong: 'CENTRAL',
  },
};
const GROUP_TYPES = {
  // Gruppentyp → Kanaltypen, die als Mitglied in Frage kommen, und Interface der Mitglieder
  'HmIP-HEATING': {
    memberIface: 'HmIP-RF',
    memberChannelTypes: ['HEATING_CLIMATECONTROL_TRANSCEIVER'],
    channel: 1,
  },
  'HM-CC-VG-1': {
    memberIface: 'BidCos-RF',
    memberChannelTypes: ['CLIMATECONTROL_RT_TRANSCEIVER', 'THERMALCONTROL_TRANSMIT'],
    channel: 1,
  },
};
// Datenpunkte, die eine Gruppe von ihren Mitgliedern übernimmt („Gruppe folgt Mitgliedern“)
const FOLLOW_DPS = [
  'SET_POINT_TEMPERATURE',
  'SET_POINT_MODE',
  'SET_TEMPERATURE',
  'CONTROL_MODE',
  'ACTUAL_TEMPERATURE',
  'HUMIDITY',
  'ACTUAL_HUMIDITY',
];

const ts = () => new Date().toISOString().slice(11, 23);
const say = (msg) => process.stdout.write(`${ts()} ${msg}\n`);

// ---- Protokoll (für die UI, per SSE) --------------------------------------------
const LOG_MAX = 200;
const logRing = [];
const sseClients = new Set();
let corrSeq = 0;
function log(entry) {
  const e = { t: new Date().toISOString(), ...entry };
  logRing.push(e);
  if (logRing.length > LOG_MAX) logRing.shift();
  const data = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of sseClients) res.write(data);
}

// ---- Katalog ----------------------------------------------------------------------
// Ein Katalogeintrag beschreibt ein konkretes Gerät (Adresse fest) oder eine Vorlage.
//   { address, type, iface, source, template?, devices: [listDevices-Einträge], desc: {ch: VALUES-Beschreibung},
//     defaults: {ch: {dp: wert}}, rawStrings? }
const catalog = new Map(); // address → Gerät
const templates = new Map(); // `${source}:${type}` → Vorlage (Adresse = Original)
// MASTER-Beschreibungen je Gerätetyp aus pydevccu: type → { Kanalnummer | 'device' → { param → Beschreibung } }
const masterByType = (() => {
  const f = path.join(here, 'catalog/pydevccu/master.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
})();

function ifaceForType(type) {
  if (GROUP_TYPES[type]) return 'VirtualDevices';
  if (/^(HmIP|HmIPW|ELV-SH)/.test(type)) return 'HmIP-RF';
  return 'BidCos-RF';
}

function defaultValue(d) {
  if (!d || d.TYPE === 'ACTION') return undefined;
  if (d.DEFAULT !== undefined && d.DEFAULT !== '') return d.DEFAULT;
  if (d.TYPE === 'BOOL') return false;
  if (d.TYPE === 'STRING') return '';
  if (d.MIN !== undefined) return d.MIN;
  return 0;
}

function supportedChannelTypes() {
  const reg = path.join(repoRoot, 'dist/src/services/registry.js');
  if (!fs.existsSync(reg)) return null;
  return import(pathToFileURL(reg).href).then(
    (m) => new Set(m.SERVICE_DEFINITIONS.flatMap((d) => d.channelTypes)),
  );
}

function readJson(f) {
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function loadCatalog(supported) {
  const isSupported = (devices) =>
    !supported || devices.some((d) => d.PARENT && supported.has(d.TYPE));
  const stats = { local: 0, pydevccu: 0, virtual: 0, skipped: 0 };

  // eigene Dumps (echte Adressen)
  const localDir = path.join(here, 'catalog/local');
  if (fs.existsSync(localDir)) {
    for (const f of fs.readdirSync(localDir).filter((x) => x.endsWith('.json'))) {
      const dump = readJson(path.join(localDir, f));
      const iface = dump.interface ?? f.replace(/\.json$/, '');
      for (const parent of dump.devices.filter((d) => !d.PARENT)) {
        const devices = dump.devices.filter(
          (d) => d.ADDRESS === parent.ADDRESS || d.PARENT === parent.ADDRESS,
        );
        if (!isSupported(devices)) {
          stats.skipped++;
          continue;
        }
        const desc = {};
        const defaults = {};
        for (const ch of devices.filter((d) => d.PARENT)) {
          const c = dump.channels?.[ch.ADDRESS];
          if (c?.description) desc[ch.ADDRESS] = c.description;
          defaults[ch.ADDRESS] = {
            ...Object.fromEntries(
              Object.entries(desc[ch.ADDRESS] ?? {}).map(([k, d]) => [k, defaultValue(d)]),
            ),
            ...c?.values,
          };
        }
        catalog.set(parent.ADDRESS, {
          address: parent.ADDRESS,
          type: parent.TYPE,
          iface,
          source: 'local',
          devices,
          desc,
          defaults,
        });
        stats.local++;
      }
    }
  }

  // Gruppen aus der eigenen CCU (Vorlagen)
  const virtDir = path.join(here, 'catalog/virtual');
  for (const f of fs.existsSync(virtDir)
    ? fs.readdirSync(virtDir).filter((x) => x.endsWith('.json'))
    : []) {
    const v = readJson(path.join(virtDir, f));
    const parent = v.devices.find((d) => !d.PARENT);
    templates.set(`virtual:${v.type}`, {
      address: parent.ADDRESS,
      type: v.type,
      iface: 'VirtualDevices',
      source: 'virtual',
      devices: v.devices,
      desc: v.descriptions,
      defaults: v.values,
      // HM-CC-VG-1 liefert an der echten CCU alle Werte als Strings
      rawStrings: Object.values(v.values ?? {}).some((vals) =>
        Object.values(vals).some((x) => typeof x === 'string' && x !== ''),
      ),
    });
    stats.virtual++;
  }

  // pydevccu
  const pyFile = path.join(here, 'catalog/pydevccu/devices.json');
  if (fs.existsSync(pyFile)) {
    for (const [, entry] of Object.entries(readJson(pyFile))) {
      if (GROUP_TYPES[entry.type]) continue; // Version aus catalog/virtual/ hat Vorrang
      if (entry.type.startsWith('HMW-')) continue; // Wired kennt das Plugin nicht
      if (!isSupported(entry.devices)) {
        stats.skipped++;
        continue;
      }
      const parent = entry.devices.find((d) => !d.PARENT);
      const defaults = {};
      for (const [ch, desc] of Object.entries(entry.values)) {
        defaults[ch] = Object.fromEntries(
          Object.entries(desc).map(([k, d]) => [k, defaultValue(d)]),
        );
      }
      const t = {
        address: parent.ADDRESS,
        type: entry.type,
        iface: ifaceForType(entry.type),
        source: 'pydevccu',
        devices: entry.devices,
        desc: entry.values,
        defaults,
      };
      templates.set(`pydevccu:${entry.type}`, t);
      if (!catalog.has(parent.ADDRESS))
        catalog.set(parent.ADDRESS, { ...t, template: `pydevccu:${entry.type}` });
      stats.pydevccu++;
    }
  }
  return stats;
}

function instantiate(templateKey, address) {
  const t = templates.get(templateKey);
  if (!t) throw new Error(`Unbekannte Vorlage ${templateKey}`);
  const re = (s) => (typeof s === 'string' ? s.split(t.address).join(address) : s);
  const devices = t.devices.map((d) => ({
    ...d,
    ADDRESS: re(d.ADDRESS),
    PARENT: re(d.PARENT),
    CHILDREN: Array.isArray(d.CHILDREN) ? d.CHILDREN.map(re) : d.CHILDREN,
  }));
  const remap = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [re(k), v]));
  return {
    ...t,
    address,
    template: templateKey,
    devices,
    desc: remap(t.desc),
    defaults: remap(t.defaults),
  };
}

// ---- Zustand ------------------------------------------------------------------------
const state = {
  selected: [], // Adressen
  instances: [], // { template, address }
  groups: {}, // address → { members: [deviceAddress], follow: true, echo: false }
  values: {}, // channelAddress → { dp: wert }
  master: {}, // Kanal- oder Geräteadresse → { param: wert } (MASTER, nur geänderte)
  faults: {}, // deviceAddress → { unreach, failOnce, failAlways, delayMs }
  global: {
    multicall: false,
    suppressPong: false,
    virtualPong: true,
    virtualPongAddress: 'CENTRAL',
    virtualLowBat: true,
    restartSeconds: 60,
    blindTravelSeconds: 10,
    blindIntermediate: false,
    // Sollwert auf TEMPERATURE_MINIMUM/MAXIMUM begrenzen: 'aus' | 'außer 4,5' | 'alle'
    setPointLimits: 'aus',
  },
};
function loadState() {
  if (!fs.existsSync(stateFile)) return;
  try {
    const s = readJson(stateFile);
    Object.assign(state, s, { global: { ...state.global, ...s.global } });
  } catch (e) {
    say(`state.json nicht lesbar (${e.message}), starte leer`);
  }
}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(
    () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n'),
    200,
  );
}

const isSelected = (addr) => state.selected.includes(addr);
const deviceOf = (addr) => catalog.get(String(addr).split(':')[0]);
function selectedDevice(addr) {
  const dev = deviceOf(addr);
  return dev && isSelected(dev.address) ? dev : null;
}
function channelEntry(dev, ch) {
  return dev.devices.find((d) => d.ADDRESS === ch);
}
function getVal(ch, dp) {
  const v = state.values[ch];
  if (v && dp in v) return v[dp];
  return deviceOf(ch)?.defaults?.[ch]?.[dp];
}
function setVal(ch, dp, value) {
  (state.values[ch] ??= {})[dp] = value;
  saveState();
}
function descOf(ch) {
  const dev = deviceOf(ch);
  const desc = dev?.desc?.[ch];
  if (!desc) return desc;
  // „LOW_BAT an Kanal 0 der Gruppe: ohne“
  if (dev.iface === 'VirtualDevices' && !state.global.virtualLowBat && ch.endsWith(':0')) {
    const { LOW_BAT: _lowBat, LOWBAT: _lowbat, ...rest } = desc;
    return rest;
  }
  return desc;
}
function paramset(ch) {
  const desc = descOf(ch) ?? {};
  const out = {};
  for (const [dp, d] of Object.entries(desc)) {
    if (d.TYPE === 'ACTION' || !(d.OPERATIONS & 1)) continue;
    const v = getVal(ch, dp);
    if (v !== undefined) out[dp] = wire(deviceOf(ch), d, v);
  }
  return out;
}

// ---- MASTER -------------------------------------------------------------------------
/** MASTER-Beschreibung einer Kanal- oder Geräteadresse (nach Gerätetyp). */
function masterDescOf(addr) {
  const dev = deviceOf(addr);
  if (!dev) return undefined;
  const key = String(addr).includes(':') ? String(addr).split(':')[1] : 'device';
  return masterByType[dev.type]?.[key];
}
function masterDefault(d) {
  // pydevccu führt ENUM-Vorgaben als Namen; die CCU liefert den Index
  if (d.TYPE === 'ENUM' && Array.isArray(d.VALUE_LIST) && typeof d.DEFAULT === 'string') {
    const i = d.VALUE_LIST.indexOf(d.DEFAULT);
    return i >= 0 ? i : 0;
  }
  return defaultValue(d);
}
function getMaster(addr, p) {
  const v = state.master[addr];
  if (v && p in v) return v[p];
  const d = masterDescOf(addr)?.[p];
  return d ? masterDefault(d) : undefined;
}
function masterParamset(addr) {
  const dev = deviceOf(addr);
  return Object.fromEntries(
    Object.entries(masterDescOf(addr) ?? {}).map(([p, d]) => [p, wire(dev, d, getMaster(addr, p))]),
  );
}
/**
 * MASTER schreiben (putParamset oder UI). Gruppen geben Thermostat-Grenzen an die
 * Mitglieder weiter. HmIP meldet CONFIG_PENDING kurz true, dann false.
 * Liefert eine Fehlermeldung oder null.
 */
function putMaster(addr, values, corr) {
  const desc = masterDescOf(addr) ?? {};
  for (const p of Object.keys(values)) if (!desc[p]) return `Unknown parameter ${p}`;
  const dev = deviceOf(addr);
  // HM-CC-VG-1 führt alle Werte als Strings
  const typed = (v) => (dev?.rawStrings && typeof v === 'number' ? String(v) : v);
  for (const [p, v] of Object.entries(values)) (state.master[addr] ??= {})[p] = typed(v);
  saveState();
  if (dev?.iface === 'HmIP-RF') {
    const ch0 = `${dev.address}:0`;
    if (descOf(ch0)?.CONFIG_PENDING) {
      emit(ch0, 'CONFIG_PENDING', true, { corr });
      setTimeout(() => emit(ch0, 'CONFIG_PENDING', false, { corr }), 1500);
    }
  }
  if (dev?.iface === 'VirtualDevices') {
    const cfg = state.groups[dev.address];
    for (const m of cfg?.members ?? []) {
      for (const mch of memberChannels(dev, m)) {
        const mdesc = masterDescOf(mch) ?? {};
        const own = Object.fromEntries(Object.entries(values).filter(([p]) => mdesc[p]));
        if (Object.keys(own).length) {
          for (const [p, v] of Object.entries(own)) (state.master[mch] ??= {})[p] = v;
          log({
            iface: 'HmIP-RF',
            dir: 'info',
            method: 'MASTER von Gruppe',
            params: [mch, own],
            corr,
          });
        }
      }
    }
    saveState();
  }
  return null;
}
/** Grenzen für den Sollwert eines Thermostatkanals (Kanal-MASTER, sonst Geräte-MASTER). */
function setPointLimits(ch) {
  const dev = deviceOf(ch);
  const from = masterDescOf(ch)?.TEMPERATURE_MINIMUM ? ch : dev?.address;
  if (!from || !masterDescOf(from)?.TEMPERATURE_MINIMUM) return null;
  return {
    min: Number(getMaster(from, 'TEMPERATURE_MINIMUM')),
    max: Number(getMaster(from, 'TEMPERATURE_MAXIMUM')),
    notInManu: !!getMaster(from, 'MIN_MAX_VALUE_NOT_RELEVANT_FOR_MANU_MODE'),
  };
}
/** Sollwert nach Einstellung „Sollwert-Grenzen“ begrenzen. `manual` = manueller Modus. */
function limitSetPoint(ch, value, manual) {
  const mode = state.global.setPointLimits;
  const v = Number(value);
  if (mode === 'aus' || !Number.isFinite(v)) return value;
  if (mode === 'außer 4,5' && v <= 4.5) return value;
  const lim = setPointLimits(ch);
  if (!lim || (manual && lim.notInManu)) return value;
  return Math.min(lim.max, Math.max(lim.min, v));
}

// Wert für die Leitung: FLOAT immer als <double>, wie die CCU. Strings bei Geräten mit rawStrings unverändert.
function wire(dev, d, v) {
  if (dev?.rawStrings && typeof v === 'string') return v;
  switch (d?.TYPE) {
    case 'FLOAT':
      return { explicitDouble: Number(v) || 0 };
    case 'INTEGER':
    case 'ENUM':
      return typeof v === 'boolean' ? Number(v) : Math.round(Number(v) || 0);
    case 'BOOL':
    case 'ACTION':
      return v === true || v === 1 || v === 'true' || v === '1';
    case 'STRING':
      return String(v ?? '');
    default:
      return v;
  }
}

// ---- Anmeldungen und Callbacks ------------------------------------------------------
const clients = { 'BidCos-RF': new Map(), 'HmIP-RF': new Map(), VirtualDevices: new Map() }; // id → { url, id }
let restartUntil = 0;

function callbackCall(iface, client, method, params) {
  const u = new URL(client.url);
  const c = xmlrpc.createClient({
    host: u.hostname,
    port: Number(u.port || 80),
    path: u.pathname || '/',
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: 'Timeout' }), 5000);
    c.methodCall(method, params, (err, val) => {
      clearTimeout(timer);
      resolve(err ? { error: err.message } : { value: val });
    });
  });
}

const pending = new Map(); // `${iface}|${id}` → [[addr, dp, value, corr]]
function sendEvent(ifaceName, address, dp, value, corr) {
  for (const client of clients[ifaceName].values()) {
    const key = `${ifaceName}|${client.id}`;
    if (!pending.has(key)) {
      pending.set(key, []);
      setTimeout(() => flush(ifaceName, client, key), 10);
    }
    pending.get(key).push([address, dp, value, corr]);
  }
}
async function flush(ifaceName, client, key) {
  const batch = pending.get(key) ?? [];
  pending.delete(key);
  if (!batch.length || !clients[ifaceName].has(client.id)) return;
  if (state.global.multicall) {
    const calls = batch.map(([a, dp, v]) => ({
      methodName: 'event',
      params: [client.id, a, dp, v],
    }));
    const r = await callbackCall(ifaceName, client, 'system.multicall', [calls]);
    log({
      iface: ifaceName,
      dir: 'out',
      method: 'system.multicall',
      params: batch.map(([a, dp, v]) => [a, dp, v]),
      result: r.error ?? 'OK',
      corr: batch[0][3],
    });
  } else {
    for (const [a, dp, v, corr] of batch) {
      const r = await callbackCall(ifaceName, client, 'event', [client.id, a, dp, v]);
      log({
        iface: ifaceName,
        dir: 'out',
        method: 'event',
        params: [a, dp, v],
        result: r.error ?? 'OK',
        corr,
      });
    }
  }
}

/** Wert setzen und (falls gewünscht) als Event melden. Wert wird für die Leitung nach Beschreibung typisiert. */
function emit(ch, dp, value, { store = true, corr } = {}) {
  const dev = deviceOf(ch);
  if (!dev) return;
  const d = descOf(ch)?.[dp];
  if (store && d?.TYPE !== 'ACTION') setVal(ch, dp, value);
  if (!isSelected(dev.address)) return;
  sendEvent(dev.iface, ch, dp, wire(dev, d, value), corr);
  afterChange(dev, ch, dp, value, corr);
  if (dp === 'OPERATING_VOLTAGE') lowBatFromVoltage(dev, ch, value, corr);
}

/** Wie das Gerät: LOW_BAT folgt OPERATING_VOLTAGE ≤ LOW_BAT_LIMIT (MASTER Kanal 0 bzw. Gerät). */
function lowBatFromVoltage(dev, ch, value, corr) {
  const from = masterDescOf(ch)?.LOW_BAT_LIMIT ? ch : dev.address;
  if (!masterDescOf(from)?.LOW_BAT_LIMIT) return;
  const dp = descOf(ch)?.LOW_BAT ? 'LOW_BAT' : descOf(ch)?.LOWBAT ? 'LOWBAT' : null;
  if (!dp) return;
  const low = Number(value) <= Number(getMaster(from, 'LOW_BAT_LIMIT'));
  if (Boolean(getVal(ch, dp)) !== low) emit(ch, dp, low, { corr });
}

async function doInit(iface, [url, id]) {
  const map = clients[iface.name];
  if (!id) {
    for (const [k, c] of map) if (c.url === url) map.delete(k);
    return { before: [], after: [] };
  }
  const client = { url, id: String(id) };
  map.set(client.id, client);
  const devices = listDevices(iface.name);
  const steps = [
    () =>
      callbackCall(iface.name, client, 'listDevices', [client.id]).then((r) =>
        log({
          iface: iface.name,
          dir: 'out',
          method: 'listDevices',
          params: [client.id],
          result: r.error ?? `${r.value?.length ?? 0} bekannt`,
        }),
      ),
    () =>
      callbackCall(iface.name, client, 'newDevices', [client.id, devices]).then((r) =>
        log({
          iface: iface.name,
          dir: 'out',
          method: 'newDevices',
          params: [client.id, `${devices.length} Einträge`],
          result: r.error ?? 'OK',
        }),
      ),
  ];
  if (iface.name === 'VirtualDevices') {
    // Echte CCU: einmal je Gruppe, alles bevor init antwortet (gemessen 19.11.)
    for (const _g of devices.filter((d) => !d.PARENT)) {
      steps.push(() =>
        callbackCall(iface.name, client, 'setReadyConfig', [client.id]).then((r) =>
          log({
            iface: iface.name,
            dir: 'out',
            method: 'setReadyConfig',
            params: [client.id],
            result: r.error ?? 'OK',
          }),
        ),
      );
    }
    return { before: steps, after: [] };
  }
  return { before: [], after: steps };
}

function listDevices(ifaceName) {
  const out = [];
  for (const addr of state.selected) {
    const dev = catalog.get(addr);
    if (dev && dev.iface === ifaceName) out.push(...dev.devices);
  }
  return out;
}

// ---- Gerätelogik --------------------------------------------------------------------
const timers = new Map(); // `${ch}|kind` → Timer
const onTimes = new Map(); // ch → Sekunden
const travels = new Map(); // ch → { from, to, start, durMs, timer }

function fault(code, msg) {
  return { faultCode: code, faultString: msg };
}

function transmitterFor(dev, ch) {
  const children = dev.devices.find((d) => !d.PARENT)?.CHILDREN ?? [];
  const idx = children.indexOf(ch);
  const type = channelEntry(dev, ch)?.TYPE ?? '';
  if (idx < 0 || !type.endsWith('_VIRTUAL_RECEIVER')) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const t = channelEntry(dev, children[i])?.TYPE ?? '';
    if (t.endsWith('_TRANSMITTER')) return children[i];
    if (!t.endsWith('_VIRTUAL_RECEIVER')) break;
  }
  return null;
}

function isBlindChannel(dev, ch) {
  const type = channelEntry(dev, ch)?.TYPE ?? '';
  return (
    /BLIND|SHUTTER|JALOUSIE/.test(type) && type !== 'SHUTTER_CONTACT' && !type.includes('CONTACT')
  );
}

function mirror(dev, ch, dp, value, corr) {
  const tx = transmitterFor(dev, ch);
  if (tx && descOf(tx)?.[dp]) emit(tx, dp, value, { corr });
}

function startTravel(dev, ch, target, corr) {
  const d = descOf(ch) ?? {};
  const from = Number(getVal(ch, 'LEVEL') ?? 0);
  const to = Number(target);
  const prev = travels.get(ch);
  if (prev) clearInterval(prev.timer);
  const durMs = Math.max(0, state.global.blindTravelSeconds * 1000 * Math.abs(to - from));
  const up = to > from;
  const setMoving = (moving) => {
    if (d.ACTIVITY_STATE) emit(ch, 'ACTIVITY_STATE', moving ? (up ? 1 : 2) : 3, { corr });
    if (d.WORKING) emit(ch, 'WORKING', moving, { corr });
    if (d.DIRECTION) emit(ch, 'DIRECTION', moving ? (up ? 1 : 2) : 0, { corr });
    const tx = transmitterFor(dev, ch);
    if (tx && descOf(tx)?.ACTIVITY_STATE)
      emit(tx, 'ACTIVITY_STATE', moving ? (up ? 1 : 2) : 3, { corr });
  };
  if (durMs === 0) {
    emit(ch, 'LEVEL', to, { corr });
    mirror(dev, ch, 'LEVEL', to, corr);
    return;
  }
  setMoving(true);
  const start = Date.now();
  const t = { from, to, start, durMs, timer: null };
  t.timer = setInterval(() => {
    const p = Math.min(1, (Date.now() - start) / durMs);
    const lvl = Math.round((from + (to - from) * p) * 100) / 100;
    if (p >= 1) {
      clearInterval(t.timer);
      travels.delete(ch);
      emit(ch, 'LEVEL', to, { corr });
      mirror(dev, ch, 'LEVEL', to, corr);
      setMoving(false);
    } else if (state.global.blindIntermediate) {
      emit(ch, 'LEVEL', lvl, { corr });
    } else {
      setVal(ch, 'LEVEL', lvl);
    }
  }, 1000);
  travels.set(ch, t);
}

function stopTravel(dev, ch, corr) {
  const t = travels.get(ch);
  if (!t) return;
  clearInterval(t.timer);
  travels.delete(ch);
  const lvl =
    Math.round((t.from + (t.to - t.from) * Math.min(1, (Date.now() - t.start) / t.durMs)) * 100) /
    100;
  emit(ch, 'LEVEL', lvl, { corr });
  mirror(dev, ch, 'LEVEL', lvl, corr);
  const d = descOf(ch) ?? {};
  if (d.ACTIVITY_STATE) emit(ch, 'ACTIVITY_STATE', 3, { corr });
  if (d.WORKING) emit(ch, 'WORKING', false, { corr });
  if (d.DIRECTION) emit(ch, 'DIRECTION', 0, { corr });
}

/** Logik für ein setValue des Plugins (oder der UI mit Event). */
function applySet(dev, ch, dp, value, corr) {
  const d = descOf(ch)?.[dp];
  const chType = channelEntry(dev, ch)?.TYPE ?? '';

  // Gruppen
  if (dev.iface === 'VirtualDevices') return applyGroupSet(dev, ch, dp, value, corr);

  if (dp === 'ON_TIME') {
    onTimes.set(ch, Number(value));
    setVal(ch, dp, value);
    return;
  }
  if (dp === 'STATE') {
    const key = `${ch}|ontime`;
    clearTimeout(timers.get(key));
    timers.delete(key);
    emit(ch, 'STATE', value, { corr });
    mirror(dev, ch, 'STATE', value, corr);
    if ((value === true || value === 1 || value === 'true') && onTimes.has(ch)) {
      const secs = onTimes.get(ch);
      onTimes.delete(ch);
      if (secs > 0) {
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key);
            emit(ch, 'STATE', false, { corr });
            mirror(dev, ch, 'STATE', false, corr);
          }, secs * 1000),
        );
      }
    }
    return;
  }
  if (dp === 'LEVEL' && isBlindChannel(dev, ch)) return startTravel(dev, ch, value, corr);
  if (dp === 'STOP' && isBlindChannel(dev, ch)) return stopTravel(dev, ch, corr);

  // Thermostate: Sollwert nach MASTER-Grenzen (Einstellung „Sollwert-Grenzen“)
  const limited = (v, manual) => {
    const out = limitSetPoint(ch, v, manual);
    if (Number(out) !== Number(v))
      log({
        iface: dev.iface,
        dir: 'info',
        method: 'Sollwert begrenzt',
        params: [ch, dp, v],
        result: out,
        corr,
      });
    return out;
  };
  if (chType === 'HEATING_CLIMATECONTROL_TRANSCEIVER' && dp === 'SET_POINT_TEMPERATURE')
    value = limited(value, Number(getVal(ch, 'SET_POINT_MODE')) === 1);
  if (/CLIMATECONTROL_RT_TRANSCEIVER|THERMALCONTROL_TRANSMIT/.test(chType)) {
    if (dp === 'MANU_MODE') value = limited(value, true);
    if (dp === 'SET_TEMPERATURE') value = limited(value, Number(getVal(ch, 'CONTROL_MODE')) === 1);
  }

  // Thermostate: nur zurückmelden, plus die Modus-Datenpunkte der Plugin-Aufrufe
  if (chType === 'HEATING_CLIMATECONTROL_TRANSCEIVER' && dp === 'CONTROL_MODE') {
    emit(ch, 'SET_POINT_MODE', Number(value), { corr });
    return;
  }
  if (/CLIMATECONTROL_RT_TRANSCEIVER|THERMALCONTROL_TRANSMIT/.test(chType)) {
    if (dp === 'AUTO_MODE') return emit(ch, 'CONTROL_MODE', 0, { corr });
    if (dp === 'MANU_MODE') {
      emit(ch, 'CONTROL_MODE', 1, { corr });
      return emit(ch, 'SET_TEMPERATURE', Number(value), { corr });
    }
    if (dp === 'BOOST_MODE') return emit(ch, 'CONTROL_MODE', 3, { corr });
  }

  if (d?.TYPE === 'ACTION') {
    if (d.OPERATIONS & 4) emit(ch, dp, true, { store: false, corr });
    return;
  }
  emit(ch, dp, value, { corr });
  mirror(dev, ch, dp, value, corr);
}

function groupFor(memberAddr) {
  for (const [g, cfg] of Object.entries(state.groups))
    if (cfg.members.includes(memberAddr)) return g;
  return null;
}
function memberChannels(groupDev, memberAddr) {
  const gt = GROUP_TYPES[groupDev.type];
  const mdev = catalog.get(memberAddr);
  if (!gt || !mdev) return [];
  return mdev.devices
    .filter((d) => d.PARENT && gt.memberChannelTypes.includes(d.TYPE))
    .map((d) => d.ADDRESS);
}

function applyGroupSet(gdev, ch, dp, value, corr) {
  const cfg = state.groups[gdev.address] ?? { members: [], follow: true, echo: false };
  const members = cfg.members.filter((m) => isSelected(m));
  if (!members.length) {
    // Gemessen 19.11.: leere Gruppe beantwortet setValue mit OK, speichert nicht, kein Event
    log({
      iface: 'VirtualDevices',
      dir: 'info',
      method: 'Gruppe ohne Mitglieder',
      params: [ch, dp, value],
      result: 'nicht gespeichert, kein Event',
      corr,
    });
    return;
  }
  // Ohne „meldet zurück“ übernimmt die Gruppe den Wert erst über „Gruppe folgt Mitgliedern“.
  // Sind beide aus, behält die Gruppe den alten Wert (getValue liefert ihn weiter).
  const d = descOf(ch)?.[dp];
  if (cfg.echo) {
    if (d?.TYPE !== 'ACTION') setVal(ch, dp, value);
    const reported = dp === 'CONTROL_MODE' && descOf(ch)?.SET_POINT_MODE ? 'SET_POINT_MODE' : dp;
    sendEvent('VirtualDevices', ch, reported, wire(gdev, descOf(ch)?.[reported], value), corr);
  }
  for (const m of members) {
    const mdev = catalog.get(m);
    for (const mch of memberChannels(gdev, m)) {
      if (!descOf(mch)?.[dp]) continue;
      const delay = 100 + Math.floor(Math.random() * 400);
      setTimeout(() => applySet(mdev, mch, dp, value, corr), delay);
    }
  }
}

/** Nach jeder Änderung: Gruppe folgt Mitgliedern. */
function afterChange(dev, ch, dp, value, corr) {
  if (dev.iface === 'VirtualDevices' || !FOLLOW_DPS.includes(dp)) return;
  const g = groupFor(dev.address);
  if (!g || !isSelected(g) || !state.groups[g]?.follow) return;
  const gdev = catalog.get(g);
  const gch = `${g}:${GROUP_TYPES[gdev.type]?.channel ?? 1}`;
  if (!descOf(gch)?.[dp]) return;
  if (
    getVal(gch, dp) === value &&
    dp !== 'ACTUAL_TEMPERATURE' &&
    dp !== 'HUMIDITY' &&
    dp !== 'ACTUAL_HUMIDITY'
  )
    return;
  setVal(gch, dp, value);
  sendEvent('VirtualDevices', gch, dp, wire(gdev, descOf(gch)[dp], value), corr);
}

// ---- XML-RPC-Methoden ---------------------------------------------------------------
const METHODS = [
  'init',
  'ping',
  'listDevices',
  'getParamsetDescription',
  'getParamset',
  'getValue',
  'setValue',
  'putParamset',
  'system.listMethods',
];

/** Liefert { value } oder { fault }; `rawTypes` = Typen der Parameter laut XML (für die Double-Prüfung). */
async function handle(iface, method, params, rawTypes) {
  switch (method) {
    case 'system.listMethods':
      return { value: METHODS };
    case 'init':
      return { init: await doInit(iface, params), value: '' };
    case 'ping': {
      const id = String(params[0] ?? '');
      const suppress =
        state.global.suppressPong || (iface.name === 'VirtualDevices' && !state.global.virtualPong);
      if (!suppress) {
        const addr = iface.name === 'VirtualDevices' ? state.global.virtualPongAddress : iface.pong;
        setTimeout(() => sendEvent(iface.name, addr, 'PONG', id), 20);
      }
      return { value: true };
    }
    case 'listDevices':
      return { value: listDevices(iface.name) };
    case 'getParamsetDescription': {
      const [addr, key] = params;
      const dev = selectedDevice(addr);
      if (!dev || dev.iface !== iface.name || !channelEntry(dev, addr))
        return { fault: fault(-2, 'Unknown instance') };
      if (key === 'MASTER') return { value: masterDescOf(addr) ?? {} };
      if (key !== 'VALUES') return { value: {} };
      return { value: descOf(addr) ?? {} };
    }
    case 'getParamset': {
      const [addr, key] = params;
      const dev = selectedDevice(addr);
      if (!dev || dev.iface !== iface.name || !channelEntry(dev, addr))
        return { fault: fault(-2, 'Unknown instance') };
      if (key === 'MASTER') return { value: masterParamset(addr) };
      if (key !== 'VALUES') return { value: {} };
      if (dev.iface === 'HmIP-RF' && state.faults[dev.address]?.unreach) return { value: {} };
      return { value: paramset(addr) };
    }
    case 'putParamset': {
      const [addr, key, values] = params;
      const dev = selectedDevice(addr);
      if (!dev || dev.iface !== iface.name || !channelEntry(dev, addr))
        return { fault: fault(-2, 'Unknown instance') };
      if (!values || typeof values !== 'object')
        return { fault: fault(-1, 'putParamset: Struktur erwartet') };
      if (dev.iface === 'HmIP-RF' && state.faults[dev.address]?.unreach)
        return { fault: fault(-1, 'Generic error (UNREACH)') };
      const corr = ++corrSeq;
      if (key === 'MASTER') {
        const err = putMaster(addr, values, corr);
        return err ? { fault: fault(-5, err) } : { value: '', corr };
      }
      if (key !== 'VALUES') return { fault: fault(-1, `Unknown paramset ${key}`) };
      const desc = descOf(addr) ?? {};
      for (const dp of Object.keys(values))
        if (!desc[dp] || !(desc[dp].OPERATIONS & 2))
          return { fault: fault(-5, 'Unknown Parameter value for value key') };
      // In der Reihenfolge der Struktur, wie die CCU (CONTROL_MODE vor SET_POINT_TEMPERATURE)
      setImmediate(() => {
        for (const [dp, v] of Object.entries(values)) applySet(dev, addr, dp, v, corr);
      });
      return { value: '', corr };
    }
    case 'getValue': {
      const [addr, dp] = params;
      const dev = selectedDevice(addr);
      if (!dev || dev.iface !== iface.name || !channelEntry(dev, addr))
        return { fault: fault(-2, 'Unknown instance') };
      const d = descOf(addr)?.[dp];
      if (!d) return { fault: fault(-5, 'Unknown Parameter value for value key') };
      return { value: wire(dev, d, getVal(addr, dp) ?? defaultValue(d)) };
    }
    case 'setValue': {
      const [addr, dp, value] = params;
      const dev = selectedDevice(addr);
      if (!dev || dev.iface !== iface.name || !channelEntry(dev, addr))
        return { fault: fault(-2, 'Unknown instance') };
      const d = descOf(addr)?.[dp];
      if (!d || !(d.OPERATIONS & 2))
        return { fault: fault(-5, 'Unknown Parameter value for value key') };
      if (d.TYPE === 'FLOAT' && rawTypes[2] !== 'double') {
        return {
          fault: fault(
            -1,
            `Type mismatch: FLOAT ${dp} kam als ${rawTypes[2] ?? '?'}, erwartet double`,
          ),
        };
      }
      const f = state.faults[dev.address] ?? {};
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      const failMsg = dev.iface === 'HmIP-RF' ? 'Generic error (UNREACH)' : 'Failure';
      if (dev.iface === 'HmIP-RF' && f.unreach)
        return { fault: fault(-1, 'Generic error (UNREACH)') };
      if (f.failOnce) {
        f.failOnce = false;
        saveState();
        return { fault: fault(-1, failMsg) };
      }
      if (f.failAlways) return { fault: fault(-1, failMsg) };
      const corr = ++corrSeq;
      setImmediate(() => applySet(dev, addr, dp, value, corr));
      return { value: '', corr };
    }
    default:
      return { fault: fault(-1, `Unknown method ${method}`) };
  }
}

/** Typen der obersten Parameter im XML (int/i4/double/boolean/string/struct/array …). */
function paramTypes(xml) {
  const types = [];
  const re = /<param>\s*<value>\s*(?:<(\w+)[\s>/])?/g;
  let m;
  while ((m = re.exec(xml)))
    types.push(m[1] === 'i4' || m[1] === 'int' ? 'int' : (m[1] ?? 'string'));
  return types;
}

function startRpc(iface) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (iface.path && req.url !== iface.path) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 - page no exist');
        log({
          iface: iface.name,
          dir: 'in',
          method: `HTTP ${req.method} ${req.url}`,
          result: '404 (falscher Pfad)',
        });
        return;
      }
      if (Date.now() < restartUntil) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable');
        return;
      }
      const body = Buffer.concat(chunks);
      new Deserializer().deserializeMethodCall(
        Readable.from([body]),
        async (err, method, params) => {
          if (err) {
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(Serializer.serializeFault(fault(-1, 'Invalid XML-RPC message')));
            return;
          }
          let r;
          try {
            r = await handle(iface, method, params ?? [], paramTypes(body.toString('latin1')));
          } catch (e) {
            r = { fault: fault(-1, e.message) };
          }
          if (r.init) for (const step of r.init.before) await step();
          const xml = r.fault
            ? Serializer.serializeFault(r.fault)
            : Serializer.serializeMethodResponse(r.value);
          res.writeHead(200, {
            'Content-Type': 'text/xml',
            'Content-Length': Buffer.byteLength(xml),
          });
          res.end(xml);
          if (method !== 'ping' || r.fault) {
            log({
              iface: iface.name,
              dir: 'in',
              method,
              params,
              result: r.fault
                ? `Fault ${r.fault.faultCode} ${r.fault.faultString}`
                : summarizeResult(method, r.value),
              corr: r.corr,
            });
          } else {
            lastPing[iface.name] = new Date().toISOString();
          }
          if (method === 'init')
            say(
              `${iface.name}: init ${params?.[1] ? `${params[1]} → ${params[0]}` : `abgemeldet ${params?.[0]}`}`,
            );
          if (r.init) for (const step of r.init.after) await step();
        },
      );
    });
  });
  server.listen(iface.port, bindHost, () =>
    say(`${iface.name} lauscht auf ${bindHost}:${iface.port}${iface.path ?? '/'}`),
  );
  return server;
}
const lastPing = {};
function summarizeResult(method, v) {
  if (method === 'listDevices') return `${v.length} Einträge`;
  if (method === 'system.listMethods') return `${v.length} Methoden`;
  if (method === 'getParamsetDescription') return `${Object.keys(v).length} Datenpunkte`;
  if (method === 'getParamset') return v;
  if (method === 'putParamset') return v === '' ? 'OK' : v;
  return v === '' ? 'OK' : v;
}

// ---- Auswahl ändern ---------------------------------------------------------------
async function setSelected(addr, on) {
  const dev = catalog.get(addr);
  if (!dev) throw new Error(`Unbekanntes Gerät ${addr}`);
  if (on === isSelected(addr)) return;
  state.selected = on ? [...state.selected, addr] : state.selected.filter((a) => a !== addr);
  saveState();
  for (const client of clients[dev.iface].values()) {
    const r = on
      ? await callbackCall(dev.iface, client, 'newDevices', [client.id, dev.devices])
      : await callbackCall(dev.iface, client, 'deleteDevices', [
          client.id,
          dev.devices.map((d) => d.ADDRESS),
        ]);
    log({
      iface: dev.iface,
      dir: 'out',
      method: on ? 'newDevices' : 'deleteDevices',
      params: [client.id, addr],
      result: r.error ?? 'OK',
    });
  }
}

function nextAddress(prefix) {
  for (let i = 1; i < 1e7; i++) {
    const a = `${prefix}${String(i).padStart(7, '0')}`;
    if (!catalog.has(a)) return a;
  }
  throw new Error('Keine Adresse frei');
}
function addInstance(templateKey, address) {
  const inst = instantiate(templateKey, address);
  catalog.set(address, inst);
  return inst;
}

// ---- HTTP-API und UI ---------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function summaryOf(dev) {
  return {
    address: dev.address,
    type: dev.type,
    iface: dev.iface,
    source: dev.source,
    template: dev.template ?? null,
    selected: isSelected(dev.address),
    channels: dev.devices.filter((d) => d.PARENT).map((d) => d.TYPE),
    isGroup: dev.iface === 'VirtualDevices',
  };
}
function masterRows(addr) {
  return Object.entries(masterDescOf(addr) ?? {}).map(([p, d]) => ({
    id: p,
    type: d.TYPE,
    operations: d.OPERATIONS,
    min: d.MIN,
    max: d.MAX,
    unit: d.UNIT,
    valueList: d.VALUE_LIST,
    value: getMaster(addr, p),
    changed: p in (state.master[addr] ?? {}),
  }));
}
function detailOf(dev) {
  return {
    master: masterRows(dev.address),
    ...summaryOf(dev),
    fault: state.faults[dev.address] ?? {},
    group:
      dev.iface === 'VirtualDevices'
        ? {
            ...(state.groups[dev.address] ?? { members: [], follow: true, echo: false }),
            candidates: groupCandidates(dev),
          }
        : null,
    memberOf: groupFor(dev.address),
    channels: dev.devices
      .filter((d) => d.PARENT)
      .map((c) => ({
        address: c.ADDRESS,
        type: c.TYPE,
        datapoints: Object.entries(descOf(c.ADDRESS) ?? {}).map(([dp, d]) => ({
          id: dp,
          type: d.TYPE,
          operations: d.OPERATIONS,
          min: d.MIN,
          max: d.MAX,
          unit: d.UNIT,
          valueList: d.VALUE_LIST,
          value: getVal(c.ADDRESS, dp),
        })),
        master: masterRows(c.ADDRESS),
      })),
  };
}
function groupCandidates(gdev) {
  const gt = GROUP_TYPES[gdev.type];
  if (!gt) return [];
  return state.selected
    .map((a) => catalog.get(a))
    .filter(
      (d) =>
        d &&
        d.iface === gt.memberIface &&
        d.devices.some((c) => gt.memberChannelTypes.includes(c.TYPE)),
    )
    .map((d) => ({ address: d.address, type: d.type, groupOf: groupFor(d.address) }));
}

async function api(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/catalog') {
    return json(res, 200, {
      devices: [...catalog.values()].map(summaryOf),
      templates: [...templates.values()].map((t) => ({
        key: `${t.source}:${t.type}`,
        type: t.type,
        iface: t.iface,
        source: t.source,
      })),
    });
  }
  if (req.method === 'GET' && p === '/api/status') {
    return json(res, 200, {
      interfaces: Object.values(IFACES).map((i) => ({
        name: i.name,
        port: i.port,
        path: i.path ?? '/',
        clients: [...clients[i.name].values()],
        lastPing: lastPing[i.name] ?? null,
      })),
      global: state.global,
      restartUntil: restartUntil > Date.now() ? new Date(restartUntil).toISOString() : null,
    });
  }
  if (req.method === 'GET' && p.startsWith('/api/device/')) {
    const dev = catalog.get(decodeURIComponent(p.slice('/api/device/'.length)));
    return dev ? json(res, 200, detailOf(dev)) : json(res, 404, { error: 'unbekannt' });
  }
  if (req.method === 'GET' && p === '/api/log') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const e of logRing) res.write(`data: ${JSON.stringify(e)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Methode' });
  const body = await readBody(req);

  if (p === '/api/selection') {
    await setSelected(body.address, !!body.selected);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/instance') {
    const t = templates.get(body.template);
    if (!t) return json(res, 400, { error: 'Vorlage unbekannt' });
    const address = nextAddress(t.iface === 'VirtualDevices' ? 'INT' : 'VCU');
    state.instances.push({ template: body.template, address });
    addInstance(body.template, address);
    if (t.iface === 'VirtualDevices')
      state.groups[address] = { members: [], follow: true, echo: false };
    saveState();
    await setSelected(address, true);
    return json(res, 200, { address });
  }
  if (p === '/api/instance/delete') {
    const inst = state.instances.find((i) => i.address === body.address);
    if (!inst) return json(res, 400, { error: 'keine Instanz' });
    await setSelected(body.address, false);
    state.instances = state.instances.filter((i) => i.address !== body.address);
    delete state.groups[body.address];
    for (const g of Object.values(state.groups))
      g.members = g.members.filter((m) => m !== body.address);
    catalog.delete(body.address);
    saveState();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/group') {
    const g = (state.groups[body.address] ??= { members: [], follow: true, echo: false });
    if (Array.isArray(body.members)) {
      for (const m of body.members) {
        const other = groupFor(m);
        if (other && other !== body.address)
          return json(res, 400, { error: `${m} ist schon in ${other}` });
      }
      g.members = body.members;
    }
    if (body.follow !== undefined) g.follow = !!body.follow;
    if (body.echo !== undefined) g.echo = !!body.echo;
    saveState();
    return json(res, 200, g);
  }
  if (p === '/api/set') {
    // { channel, datapoint, value, event: bool }  — event=true: wie vom Gerät gemeldet (inkl. Gruppe folgt)
    const dev = deviceOf(body.channel);
    if (!dev) return json(res, 404, { error: 'unbekannt' });
    const d = descOf(body.channel)?.[body.datapoint];
    if (!d) return json(res, 400, { error: 'Datenpunkt unbekannt' });
    const corr = ++corrSeq;
    if (d.TYPE === 'ACTION') {
      sendEvent(dev.iface, body.channel, body.datapoint, true, corr);
      log({
        iface: dev.iface,
        dir: 'ui',
        method: 'Aktion',
        params: [body.channel, body.datapoint],
        corr,
      });
    } else if (body.event) {
      log({
        iface: dev.iface,
        dir: 'ui',
        method: 'Setzen + Event',
        params: [body.channel, body.datapoint, body.value],
        corr,
      });
      emit(body.channel, body.datapoint, body.value, { corr });
    } else {
      setVal(body.channel, body.datapoint, body.value);
      log({
        iface: dev.iface,
        dir: 'ui',
        method: 'Setzen',
        params: [body.channel, body.datapoint, body.value],
        corr,
      });
    }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/master') {
    // { address, param, value } oder { address, reset: true } — wie putParamset MASTER
    const dev = deviceOf(body.address);
    if (!dev) return json(res, 404, { error: 'unbekannt' });
    if (body.reset) {
      delete state.master[body.address];
      saveState();
      log({ iface: dev.iface, dir: 'ui', method: 'MASTER zurückgesetzt', params: [body.address] });
      return json(res, 200, { ok: true });
    }
    const corr = ++corrSeq;
    const err = putMaster(body.address, { [body.param]: body.value }, corr);
    if (err) return json(res, 400, { error: err });
    log({
      iface: dev.iface,
      dir: 'ui',
      method: 'MASTER setzen',
      params: [body.address, body.param, body.value],
      corr,
    });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/fault') {
    const f = (state.faults[body.address] ??= {});
    const dev = catalog.get(body.address);
    for (const k of ['unreach', 'failOnce', 'failAlways', 'delayMs'])
      if (body[k] !== undefined) f[k] = k === 'delayMs' ? Number(body[k]) || 0 : !!body[k];
    saveState();
    if (body.unreach !== undefined && dev)
      emit(`${dev.address}:0`, 'UNREACH', !!body.unreach, { corr: ++corrSeq });
    return json(res, 200, f);
  }
  if (p === '/api/global') {
    for (const [k, v] of Object.entries(body))
      if (k in state.global)
        state.global[k] =
          typeof state.global[k] === 'number'
            ? Number(v)
            : typeof state.global[k] === 'boolean'
              ? !!v
              : String(v);
    saveState();
    return json(res, 200, state.global);
  }
  if (p === '/api/restart') {
    const secs = Number(body.seconds ?? state.global.restartSeconds);
    for (const m of Object.values(clients)) m.clear();
    restartUntil = Date.now() + secs * 1000;
    log({ iface: '—', dir: 'info', method: 'CCU-Neustart simuliert', params: [`${secs} s`] });
    say(`CCU-Neustart simuliert: ${secs} s keine Antwort, Anmeldungen verworfen`);
    return json(res, 200, { until: new Date(restartUntil).toISOString() });
  }
  return json(res, 404, { error: 'unbekannt' });
}

function startUi() {
  const uiFile = path.join(here, 'ui.html');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(uiFile));
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  server.listen(uiPort, '127.0.0.1', () => say(`Weboberfläche: http://127.0.0.1:${uiPort}/`));
}

// ---- Start ---------------------------------------------------------------------------
const supported = await supportedChannelTypes();
if (!supported)
  say('Hinweis: dist/ fehlt (npm run build), zeige alle Gerätetypen statt nur unterstützte.');
const stats = loadCatalog(supported);
loadState();
for (const inst of state.instances) {
  try {
    addInstance(inst.template, inst.address);
  } catch (e) {
    say(`Instanz ${inst.address} übersprungen: ${e.message}`);
  }
}
state.selected = state.selected.filter((a) => catalog.has(a));
say(
  `Katalog: ${stats.local} eigene, ${stats.pydevccu} pydevccu, ${stats.virtual} Gruppenvorlagen, ${stats.skipped} ohne unterstützten Kanal ausgelassen; ${state.selected.length} ausgewählt`,
);
for (const iface of Object.values(IFACES)) startRpc(iface);
startUi();

const shutdown = () => {
  clearTimeout(saveTimer);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
