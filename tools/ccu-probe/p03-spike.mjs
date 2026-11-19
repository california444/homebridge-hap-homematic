#!/usr/bin/env node
// p03-spike.mjs: meldet sich per init bei der CCU an, protokolliert alle Events,
// prüft PONG-Antworten je Interface und beobachtet Events von VirtualDevices-Gruppen (INT…).
// Läuft auf jedem Rechner im LAN, den die CCU erreichen kann. Ohne --group wird nichts geschaltet.
//
// Aufruf:
//   node p03-spike.mjs --host <CCU-IP> --callback <eigene-LAN-IP> [--port 9875]
//                      [--interfaces rf,ip,groups]          (Standard: rf,ip)
//                      [--rf-port 2001] [--ip-port 2010] [--groups-port 9292] [--groups-path /groups]
//                      [--ports 2001,2010]                  (alt, Alias für --rf-port/--ip-port)
//                      [--watch INT,000…]                   (Alias: --filter; nur diese Adressen anzeigen)
//                      [--group INT0000001]                 (aktiviert Taste g = Sollwert an Gruppe schreiben)
//                      [--log <Datei>] [--report <Datei>] [--virtual-dump <Datei>]   (Standard: out/ neben dem Skript)
//
// Tasten während des Laufs:  p = sofort pingen   i = erneut anmelden (init)
//                            g = Sollwert an --group schreiben (nur mit --group)
//                            q / Strg+C = Bericht schreiben, sauber abmelden und beenden

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
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
if (!args.host || !args.callback) {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.error(
    'Fehlt: --host <CCU-IP> --callback <eigene IP>.  Lokale IPv4-Adressen: ' + ips.join(', '),
  );
  process.exit(1);
}

// ---- Optionen ----------------------------------------------------------------
const port = Number(args.port ?? 9875);
const [legacyRf, legacyIp] = args.ports ? String(args.ports).split(',').map(Number) : [];
const watchArg = args.watch ?? args.filter;
const watch = watchArg && watchArg !== true ? String(watchArg).split(',').filter(Boolean) : null;
// Ausgaben standardmäßig nach tools/ccu-probe/out/ (steht in .gitignore, enthält Adressen der eigenen Geräte)
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(outDir, { recursive: true });
const logFile = String(args.log ?? path.join(outDir, 'events.jsonl'));
const reportFile = String(args.report ?? path.join(outDir, 'report.json'));
const virtualFile = String(args['virtual-dump'] ?? path.join(outDir, 'virtual-devices.json'));
const groupAddr =
  args.group && args.group !== true ? String(args.group).replace(/:\d+$/, '') : null;
const callbackUrl = `http://${args.callback}:${port}`;

const ALL = {
  rf: {
    key: 'rf',
    name: 'BidCos-RF',
    port: Number(args['rf-port'] ?? legacyRf ?? 2001),
    path: '/',
    id: 'p03-spike:BidCos-RF',
    pingId: 'p03-spike-rf',
  },
  ip: {
    key: 'ip',
    name: 'HmIP-RF',
    port: Number(args['ip-port'] ?? legacyIp ?? 2010),
    path: '/',
    id: 'p03-spike:HmIP-RF',
    pingId: 'p03-spike-ip',
  },
  groups: {
    key: 'groups',
    name: 'VirtualDevices',
    port: Number(args['groups-port'] ?? 9292),
    path: String(args['groups-path'] ?? '/groups'),
    id: 'p03-spike:VirtualDevices',
    pingId: 'p03-spike-groups',
  },
};
const selected = String(args.interfaces ?? 'rf,ip')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const k of selected) {
  if (!ALL[k]) {
    console.error(`Unbekanntes Interface "${k}". Erlaubt: ${Object.keys(ALL).join(', ')}`);
    process.exit(1);
  }
}
const IFACES = selected.map((k) => ALL[k]);
const hasGroups = selected.includes('groups');
if (groupAddr && !hasGroups) {
  console.error('--group braucht --interfaces mit "groups", sonst kommen keine Gruppen-Events an.');
  process.exit(1);
}
const byId = Object.fromEntries(Object.values(ALL).map((i) => [i.id, i]));
const byPingId = Object.fromEntries(Object.values(ALL).map((i) => [i.pingId, i]));

// ---- Zustand -----------------------------------------------------------------
const CORR_DPS = new Set(['SET_POINT_TEMPERATURE', 'SET_POINT_MODE', 'ACTUAL_TEMPERATURE']);
const CORR_WINDOW_MS = 5000;
const PONG_WINDOW_MS = 10000;
const WRITE_WAIT_MS = 10000;

const lastSeen = {};
const stats = Object.fromEntries(
  IFACES.map((i) => [
    i.name,
    {
      pingOk: 0,
      pingErr: 0,
      pong: 0,
      foreignPong: 0,
      firstAddr: null,
      firstValue: null,
      latencies: [],
      lastPingAt: null,
      missing: 0,
    },
  ]),
);
const pongTimers = {};
const counters = new Map(); // `${iface}|${address}|${dp}` → { iface, address, datapoint, count, last }
let groupEventCount = 0;
const groupInfo = { types: {}, channel0: {} }; // Gerätetypen auf VirtualDevices, Kanal 0 je Gruppe
const deviceEvents = []; // HmIP-RF-Events auf CORR_DPS: { t, address, datapoint, value, matched, delta, group }
const writeTests = []; // Ergebnisse der Taste g
const activeWrites = new Set();

const ts = () => new Date().toISOString().slice(11, 23);
const out = fs.createWriteStream(logFile, { flags: 'a' });

function call(iface, method, params, timeoutMs = 15000) {
  const c = xmlrpc.createClient({ host: args.host, port: iface.port, path: iface.path });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout bei ${method}`)), timeoutMs);
    c.methodCall(method, params, (err, val) => {
      clearTimeout(t);
      if (err) reject(err);
      else resolve(val);
    });
  });
}

// ---- Event-Verarbeitung ------------------------------------------------------
function isShown(address) {
  const a = String(address);
  if (!watch) return true;
  if (a.startsWith('CENTRAL')) return true;
  if (hasGroups && a.startsWith('INT')) return true;
  return watch.some((f) => a.startsWith(f));
}

function onPong(iface, address, value) {
  const now = Date.now();
  const st = stats[iface.name];
  const owner = byPingId[value];
  if (!st) {
    console.log(
      `${ts()} PONG ${iface.name} Adresse=${address} Wert=${JSON.stringify(value)} (Interface nicht gewählt)`,
    );
    return;
  }
  if (value !== iface.pingId) {
    st.foreignPong++;
    const hint = owner ? `ID von ${owner.name}` : 'fremd';
    console.log(
      `${ts()} PONG ${iface.name} Adresse=${address} Wert=${JSON.stringify(value)} (${hint})`,
    );
    return;
  }
  st.pong++;
  if (st.firstAddr === null) {
    st.firstAddr = String(address);
    st.firstValue = value;
  }
  const delta = st.lastPingAt ? now - st.lastPingAt : null;
  if (delta !== null) st.latencies.push(delta);
  clearTimeout(pongTimers[iface.name]);
  delete pongTimers[iface.name];
  console.log(
    `${ts()} PONG ${iface.name} Adresse=${address} Wert=${JSON.stringify(value)}${delta !== null ? ` nach ${delta} ms` : ''}`,
  );
}

function correlate(address, datapoint, value) {
  const now = Date.now();
  for (const d of deviceEvents) {
    if (d.matched || d.datapoint !== datapoint || now - d.t > CORR_WINDOW_MS) continue;
    d.matched = true;
    d.delta = now - d.t;
    d.group = String(address);
    console.log(
      `${ts()} GRUPPE folgt: ${d.address} → ${address}, ${datapoint} = ${JSON.stringify(value)}, Δ ${d.delta} ms`,
    );
  }
}

function onEvent(ifaceId, address, datapoint, value) {
  const iface = byId[ifaceId] ?? { name: String(ifaceId) };
  lastSeen[iface.name] = Date.now();
  out.write(
    JSON.stringify({ t: new Date().toISOString(), iface: iface.name, address, datapoint, value }) +
      '\n',
  );

  if (datapoint === 'PONG') return onPong(iface, address, value);

  const key = `${iface.name}|${address}|${datapoint}`;
  const c = counters.get(key) ?? {
    iface: iface.name,
    address: String(address),
    datapoint,
    count: 0,
    last: undefined,
  };
  c.count++;
  c.last = value;
  counters.set(key, c);

  if (iface.key === 'groups') {
    groupEventCount++;
    if (CORR_DPS.has(datapoint)) correlate(address, datapoint, value);
  } else if (iface.key === 'ip' && CORR_DPS.has(datapoint)) {
    deviceEvents.push({
      t: Date.now(),
      address: String(address),
      datapoint,
      value,
      matched: false,
      delta: null,
      group: null,
    });
  }
  for (const w of activeWrites) {
    if (iface.key === 'groups' && String(address).startsWith(w.group))
      w.groupEvents.push({ address: String(address), datapoint, value, afterMs: Date.now() - w.t });
    if (iface.key === 'ip')
      w.memberEvents.push({
        address: String(address),
        datapoint,
        value,
        afterMs: Date.now() - w.t,
      });
  }

  if (!isShown(address)) return;
  console.log(
    `${ts()} EVENT ${iface.name.padEnd(14)} ${String(address).padEnd(18)} ${datapoint} = ${JSON.stringify(value)}`,
  );
}

// ---- Callback-Server ---------------------------------------------------------
const server = xmlrpc.createServer({ host: '0.0.0.0', port }, () =>
  console.log(`${ts()} Callback-Server lauscht auf 0.0.0.0:${port}, CCU ruft ${callbackUrl}`),
);
server.on('event', (err, p, cb) => {
  onEvent(...p);
  cb(null, '');
});
server.on('system.multicall', (err, p, cb) => {
  for (const c of p[0] ?? []) {
    if (c.methodName === 'event') onEvent(...c.params);
    else console.log(`${ts()} multicall: ${c.methodName}`);
  }
  cb(
    null,
    (p[0] ?? []).map(() => ['']),
  );
});
server.on('listDevices', (err, p, cb) => {
  console.log(`${ts()} CCU → listDevices (${p[0]})  ← Rückweg funktioniert`);
  cb(null, []);
});
server.on('newDevices', (err, p, cb) => {
  console.log(`${ts()} CCU → newDevices (${p[0]}, ${p[1]?.length ?? 0} Einträge)`);
  cb(null, '');
});
server.on('deleteDevices', (err, p, cb) => {
  console.log(`${ts()} CCU → deleteDevices (${p[0]})`);
  cb(null, '');
});
server.on('setReadyConfig', (err, p, cb) => {
  console.log(`${ts()} CCU → setReadyConfig (${p[0]})`);
  cb(null, '');
});
server.on('updateDevice', (err, p, cb) => cb(null, ''));
server.on('readdedDevice', (err, p, cb) => cb(null, ''));
server.on('replaceDevice', (err, p, cb) => cb(null, ''));
server.on('system.listMethods', (err, p, cb) =>
  cb(null, [
    'system.multicall',
    'system.listMethods',
    'event',
    'listDevices',
    'newDevices',
    'deleteDevices',
    'updateDevice',
    'readdedDevice',
    'replaceDevice',
  ]),
);
server.on('NotFound', (method) => console.log(`${ts()} unbekannte Methode von CCU: ${method}`));

// ---- Anmelden, Ping ----------------------------------------------------------
async function initAll() {
  for (const i of IFACES) {
    try {
      await call(i, 'init', [callbackUrl, i.id]);
      console.log(`${ts()} init OK  ${i.name} (${i.port}${i.path})`);
    } catch (e) {
      console.error(`${ts()} init FEHLER ${i.name}: ${e.message}`);
    }
  }
}
async function deinitAll() {
  for (const i of IFACES) {
    try {
      await call(i, 'init', [callbackUrl, ''], 5000);
      console.log(`${ts()} abgemeldet ${i.name}`);
    } catch (e) {
      console.error(`${ts()} Abmelden FEHLER ${i.name}: ${e.message}`);
    }
  }
}

function pingOne(i) {
  const st = stats[i.name];
  st.lastPingAt = Date.now();
  let status = 'ausstehend';
  clearTimeout(pongTimers[i.name]);
  pongTimers[i.name] = setTimeout(() => {
    delete pongTimers[i.name];
    st.missing++;
    console.log(`${ts()} KEIN PONG ${i.name} (Ping-Aufruf: ${status})`);
  }, PONG_WINDOW_MS);
  call(i, 'ping', [i.pingId])
    .then(() => {
      status = 'OK';
      st.pingOk++;
    })
    .catch((e) => {
      status = 'FEHLER';
      st.pingErr++;
      console.log(`${ts()} ping ${i.name} FEHLER ${e.message}`);
    });
}
const pingAll = () => IFACES.forEach(pingOne);

// ---- Startwerte der Gruppen --------------------------------------------------
// Alle Geräte/Kanäle von VirtualDevices mit Beschreibung und Werten (VALUES) → virtualFile.
// Enthält nur INT…-Adressen, keine Seriennummern. Grundlage für catalog/virtual/ im Mock.
async function dumpVirtual(devices) {
  const outDevs = [];
  for (const d of devices) {
    const entry = { ...d };
    if (d.PARENT) {
      try {
        entry.VALUES_DESCRIPTION = await call(ALL.groups, 'getParamsetDescription', [
          d.ADDRESS,
          'VALUES',
        ]);
        entry.VALUES = await call(ALL.groups, 'getParamset', [d.ADDRESS, 'VALUES']);
      } catch (e) {
        entry.ERROR = e.message;
      }
      console.log(
        `${ts()}   ${String(d.ADDRESS).padEnd(14)} ${String(d.TYPE).padEnd(36)} ` +
          (entry.ERROR
            ? `FEHLER ${entry.ERROR}`
            : `${Object.keys(entry.VALUES_DESCRIPTION ?? {}).length} Datenpunkte`),
      );
    } else {
      console.log(
        `${ts()} ${d.ADDRESS} ${d.TYPE} FW ${d.FIRMWARE ?? '?'}, Kanäle ${(d.CHILDREN ?? []).length}`,
      );
    }
    outDevs.push(entry);
  }
  try {
    fs.writeFileSync(
      virtualFile,
      JSON.stringify({ created: new Date().toISOString(), devices: outDevs }, null, 2) + '\n',
    );
    console.log(`${ts()} VirtualDevices-Dump geschrieben: ${virtualFile}`);
  } catch (e) {
    console.error(`${ts()} VirtualDevices-Dump FEHLER ${e.message}`);
  }
}

async function readGroupStart() {
  if (!hasGroups) return;
  let devices;
  try {
    devices = await call(ALL.groups, 'listDevices', []);
  } catch (e) {
    console.log(`${ts()} listDevices VirtualDevices FEHLER ${e.message}`);
    return;
  }
  const parents = (devices ?? []).filter((d) => d && !d.PARENT);
  for (const d of parents) groupInfo.types[d.TYPE] = (groupInfo.types[d.TYPE] ?? 0) + 1;
  console.log(`${ts()} VirtualDevices: Gerätetypen ${JSON.stringify(groupInfo.types)}`);
  const groups = parents.filter((d) => String(d.ADDRESS).startsWith('INT'));
  console.log(
    `${ts()} VirtualDevices: ${groups.length} Gruppe(n): ${groups.map((g) => `${g.ADDRESS} (${g.TYPE})`).join(', ') || '—'}`,
  );
  await dumpVirtual(devices ?? []);
  for (const g of groups) {
    const ch0 = { channelType: null, description: null, values: null, error: null };
    ch0.channelType = (devices ?? []).find((d) => d.ADDRESS === `${g.ADDRESS}:0`)?.TYPE ?? null;
    try {
      ch0.description = await call(ALL.groups, 'getParamsetDescription', [
        `${g.ADDRESS}:0`,
        'VALUES',
      ]);
      ch0.values = await call(ALL.groups, 'getParamset', [`${g.ADDRESS}:0`, 'VALUES']);
    } catch (e) {
      ch0.error = e.message;
    }
    groupInfo.channel0[g.ADDRESS] = ch0;
    const dps = ch0.description ? Object.keys(ch0.description) : [];
    console.log(
      `${ts()} Kanal 0 ${g.ADDRESS}:0 (${ch0.channelType ?? '?'}): ` +
        (ch0.error
          ? `FEHLER ${ch0.error}`
          : `${dps.length} Datenpunkte, LOW_BAT/LOWBAT ${dps.includes('LOW_BAT') || dps.includes('LOWBAT') ? 'JA' : 'NEIN'}, UNREACH ${dps.includes('UNREACH') ? 'JA' : 'NEIN'}`),
    );
    if (!ch0.error)
      console.log(`${ts()} Kanal 0 ${g.ADDRESS}:0 Werte ${JSON.stringify(ch0.values)}`);
    try {
      const v = await call(ALL.groups, 'getParamset', [`${g.ADDRESS}:1`, 'VALUES']);
      console.log(`${ts()} Startwerte ${g.ADDRESS}:1 ${JSON.stringify(v)}`);
    } catch (e) {
      console.log(`${ts()} Startwerte ${g.ADDRESS}:1 FEHLER ${e.message}`);
    }
  }
}

// ---- Schreibtest an die Gruppe (nur mit --group) -----------------------------
const fmtVal = (v) => (v === null || v === undefined ? '—' : JSON.stringify(v));
const readBackVerdict = (w) =>
  w.readBack === null
    ? ''
    : Math.abs(Number(w.readBack) - w.value) < 0.05
      ? ' (gespeichert)'
      : ' (NICHT gespeichert)';
async function readGroupSetPoint() {
  try {
    return await call(ALL.groups, 'getValue', [`${groupAddr}:1`, 'SET_POINT_TEMPERATURE']);
  } catch (e) {
    console.log(`${ts()} getValue ${groupAddr}:1 vorher FEHLER ${e.message}`);
    return null;
  }
}
async function writeGroup(value) {
  const w = {
    group: groupAddr,
    value,
    t: Date.now(),
    ok: null,
    error: null,
    before: null,
    readBack: null,
    readBackError: null,
    groupEvents: [],
    memberEvents: [],
  };
  w.before = await readGroupSetPoint();
  activeWrites.add(w);
  console.log(`${ts()} SCHREIBE ${groupAddr}:1 SET_POINT_TEMPERATURE = ${value} (double)`);
  try {
    await call(ALL.groups, 'setValue', [
      `${groupAddr}:1`,
      'SET_POINT_TEMPERATURE',
      { explicitDouble: value },
    ]);
    w.ok = true;
  } catch (e) {
    w.ok = false;
    w.error = e.message;
    console.log(`${ts()} setValue FEHLER ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, WRITE_WAIT_MS));
  activeWrites.delete(w);
  try {
    w.readBack = await call(ALL.groups, 'getValue', [`${groupAddr}:1`, 'SET_POINT_TEMPERATURE']);
  } catch (e) {
    w.readBackError = e.message;
  }
  writeTests.push(w);
  const sp = w.groupEvents.filter((e) => e.datapoint === 'SET_POINT_TEMPERATURE');
  const members = [...new Set(w.memberEvents.map((e) => e.address.split(':')[0]))];
  console.log(
    `${ts()} ERGEBNIS Schreibtest ${groupAddr} = ${value}: setValue ${w.ok ? 'OK' : 'FEHLER'}, ` +
      `Gruppen-Events ${w.groupEvents.length} (davon SET_POINT_TEMPERATURE ${sp.length}${sp[0] ? `, erstes nach ${sp[0].afterMs} ms, Wert ${sp[0].value}` : ''}), ` +
      `HmIP-RF-Events ${w.memberEvents.length} von ${members.length} Gerät(en)${members.length ? ': ' + members.join(', ') : ''}, ` +
      `getValue vorher ${fmtVal(w.before)}, nachher ${w.readBackError ? 'FEHLER ' + w.readBackError : fmtVal(w.readBack)}${readBackVerdict(w)}`,
  );
}

// ---- Abschlussbericht --------------------------------------------------------
const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);

function buildReport() {
  const interfaces = IFACES.map((i) => {
    const s = stats[i.name];
    return {
      interface: i.name,
      path: i.path,
      pingOk: s.pingOk,
      pingError: s.pingErr,
      pong: s.pong,
      pongMissing: s.missing,
      foreignPong: s.foreignPong,
      pongAddress: s.firstAddr,
      pongValue: s.firstValue,
      pongAvgMs: avg(s.latencies),
    };
  });
  const groupEvents = [...counters.values()]
    .filter((c) => c.iface === 'VirtualDevices')
    .map(({ address, datapoint, count, last }) => ({ address, datapoint, count, last }));
  const sp = deviceEvents.filter((d) => d.datapoint === 'SET_POINT_TEMPERATURE');
  const spMatched = sp.filter((d) => d.matched);
  const correlation = {
    windowMs: CORR_WINDOW_MS,
    setPointEvents: sp.length,
    setPointFollowedByGroup: spMatched.length,
    setPointAvgDeltaMs: avg(spMatched.map((d) => d.delta)),
    events: deviceEvents.map(({ address, datapoint, value, matched, delta, group }) => ({
      address,
      datapoint,
      value,
      followedByGroup: matched,
      group,
      deltaMs: delta,
    })),
  };
  return {
    script: 'p03-spike.mjs',
    created: new Date().toISOString(),
    interfaces,
    virtualDeviceTypes: groupInfo.types,
    groupChannel0: groupInfo.channel0,
    groupEventCount,
    groupEvents,
    correlation,
    writeTests: writeTests.map(
      ({
        group,
        value,
        ok,
        error,
        before,
        readBack,
        readBackError,
        groupEvents: ge,
        memberEvents: me,
      }) => ({
        group,
        value,
        ok,
        error,
        before,
        readBack,
        readBackError,
        readBackMatches: readBack === null ? null : Math.abs(Number(readBack) - value) < 0.05,
        groupEvents: ge,
        memberEvents: me,
      }),
    ),
  };
}

function printReport(r) {
  console.log(`\n${ts()} ===== Bericht =====`);
  const w = Math.max(...r.interfaces.map((i) => i.interface.length)) + 1;
  for (const i of r.interfaces) {
    const pong = i.pong
      ? `PONG ${i.pong}× (Adresse ${i.pongAddress}, Wert ${i.pongValue}${i.pongAvgMs !== null ? `, Ø ${i.pongAvgMs} ms` : ''})`
      : 'KEIN PONG';
    const extra = [
      i.pongMissing ? `${i.pongMissing}× kein PONG` : '',
      i.foreignPong ? `${i.foreignPong}× fremd` : '',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(
      `${(i.interface + ':').padEnd(w + 1)}Ping-Aufrufe ${i.pingOk} OK / ${i.pingError} Fehler, ${pong}${extra ? `, ${extra}` : ''}`,
    );
  }
  if (hasGroups) {
    console.log(
      `Gerätetypen:    ${
        Object.entries(r.virtualDeviceTypes)
          .map(([t, n]) => `${t} ${n}×`)
          .join(', ') || '—'
      }`,
    );
    for (const [a, c] of Object.entries(r.groupChannel0)) {
      const dps = c.description ? Object.keys(c.description) : [];
      console.log(
        `Kanal 0:        ${a}:0 ${c.error ? `FEHLER ${c.error}` : `${dps.join(', ') || 'keine Datenpunkte'} → LOW_BAT/LOWBAT ${dps.includes('LOW_BAT') || dps.includes('LOWBAT') ? 'ja' : 'nein'}`}`,
      );
    }
    const byAddr = {};
    for (const g of r.groupEvents) (byAddr[g.address] ??= []).push(`${g.datapoint} ${g.count}×`);
    const lines = Object.entries(byAddr).map(([a, l]) => `${a} ${l.join(', ')}`);
    console.log(`Gruppen-Events: ${lines.length ? lines.join(' | ') : 'keine'}`);
    const c = r.correlation;
    console.log(
      `Korrelation:    ${c.setPointFollowedByGroup} von ${c.setPointEvents} Sollwert-Änderungen am Gerät wurden von der Gruppe gemeldet` +
        (c.setPointAvgDeltaMs !== null ? ` (Ø Δ ${c.setPointAvgDeltaMs} ms)` : ''),
    );
  }
  for (const t of r.writeTests) {
    const sp = t.groupEvents.filter((e) => e.datapoint === 'SET_POINT_TEMPERATURE');
    console.log(
      `Schreibtest:    ${t.group}:1 = ${t.value} → setValue ${t.ok ? 'OK' : 'FEHLER'}, Gruppe meldete ${sp.length ? `SET_POINT_TEMPERATURE nach ${sp[0].afterMs} ms` : 'kein SET_POINT_TEMPERATURE'}, ` +
        `${new Set(t.memberEvents.map((e) => e.address.split(':')[0])).size} HmIP-RF-Gerät(e) mit Events, ` +
        `getValue ${fmtVal(t.before)} → ${t.readBackError ? 'FEHLER' : fmtVal(t.readBack)}${t.readBackMatches === null ? '' : t.readBackMatches ? ' (gespeichert)' : ' (NICHT gespeichert)'}`,
    );
  }
}

// ---- Ablauf ------------------------------------------------------------------
let stopping = false;
let pinger;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(pinger);
  for (const t of Object.values(pongTimers)) clearTimeout(t);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const r = buildReport();
  printReport(r);
  try {
    fs.writeFileSync(reportFile, JSON.stringify(r, null, 2) + '\n');
    console.log(`${ts()} Bericht geschrieben: ${reportFile}\n`);
  } catch (e) {
    console.error(`${ts()} Bericht FEHLER ${e.message}`);
  }
  await deinitAll();
  server.httpServer.close();
  out.end();
  process.exit(0);
}

console.log(`${ts()} Interfaces: ${IFACES.map((i) => `${i.name} ${i.port}${i.path}`).join(', ')}`);
await initAll();
await readGroupStart();
pingAll();
pinger = setInterval(pingAll, 30000);
setInterval(() => {
  const s = IFACES.map(
    (i) =>
      `${i.name}: ${lastSeen[i.name] ? Math.round((Date.now() - lastSeen[i.name]) / 1000) + ' s' : 'nie'}`,
  ).join(' | ');
  console.log(
    `${ts()} letztes Event — ${s}${hasGroups ? ` | Gruppen-Events: ${groupEventCount}` : ''}`,
  );
}, 60000);

// Tastatur; bei Taste g wird eine Zeile für den Sollwert gesammelt.
let prompt = null;
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (str, key) => {
  if (key?.ctrl && key.name === 'c') return shutdown();
  if (prompt !== null) {
    if (key?.name === 'return' || key?.name === 'enter') {
      const input = prompt.trim().replace(',', '.');
      prompt = null;
      process.stdout.write('\n');
      const v = input === '' ? 21.0 : Number(input);
      if (!Number.isFinite(v) || v < 4.5 || v > 30.5)
        return console.log(
          `${ts()} Ungültiger Sollwert "${input}" (erlaubt 4,5–30,5), abgebrochen.`,
        );
      writeGroup(v);
    } else if (key?.name === 'escape') {
      prompt = null;
      process.stdout.write('\n');
      console.log(`${ts()} abgebrochen.`);
    } else if (key?.name === 'backspace') {
      if (prompt.length) {
        prompt = prompt.slice(0, -1);
        process.stdout.write('\b \b');
      }
    } else if (str && /^[0-9.,]$/.test(str)) {
      prompt += str;
      process.stdout.write(str);
    }
    return;
  }
  if (str === 'q') return shutdown();
  if (str === 'p') return pingAll();
  if (str === 'i') return initAll();
  if (str === 'g') {
    if (!groupAddr) return console.log(`${ts()} Schreibtest ist aus. Mit --group <INT…> starten.`);
    prompt = '';
    process.stdout.write(`Sollwert für ${groupAddr}:1 [21.0], Enter = senden, Esc = abbrechen: `);
  }
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
const keys = [
  '[p] pingen',
  '[i] init',
  groupAddr ? `[g] Sollwert → ${groupAddr}` : null,
  '[q] Ende',
].filter(Boolean);
console.log(`${ts()} Läuft. ${keys.join('  ')}. Log: ${logFile}, Bericht: ${reportFile}`);
