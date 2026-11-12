// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * homebridge-hap-homematic custom UI.
 *
 * Vanilla ES module + the global `homebridge` object provided by
 * homebridge-config-ui-x. Bootstrap 5 CSS is injected by the host;
 * Bootstrap JS is NOT, so we use class-toggle-only widgets and a
 * navigation-stack model in place of modals (modals don't reliably
 * render inside the host iframe).
 *
 * Architecture
 *   - state.cfg: the single platform-config block of this plugin
 *     (connection only).
 *   - state.devicesFile: devices.json (the mappings), loaded and saved
 *     through the /devices/get and /devices/put endpoints.
 *   - state.view: top-level view, shown as a tab (settings | channels).
 *   - state.nav: optional sub-view stack pushed on top of the base
 *     view. Pushing a sub-view (e.g. "edit channel") swaps the body
 *     until the user pops back. No modals.
 *   - state.ui: per-view persistent search/filter/sort.
 *
 * Saving:
 *   - Mapping changes (add / edit / remove) write devices.json at once.
 *   - Settings changes are staged with updatePluginConfig(); the host's
 *     "Save" button writes config.json.
 */

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
/**
 * Defensive wrapper around homebridge.toast.* — the host's toast API
 * occasionally throws "Cannot read properties of undefined (reading
 * '_postMessage')" when the parent IPC channel is in a transient
 * state (observed mid-modal-resize). Swallow those so a successful
 * /test-connection result still updates the inline status text.
 */
function toast(kind, msg, title) {
  try { homebridge?.toast?.[kind]?.(msg ?? '', title ?? ''); } catch { /* ignore */ }
}
function spinner(on) {
  try { (on ? homebridge?.showSpinner : homebridge?.hideSpinner)?.call(homebridge); } catch { /* ignore */ }
}
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const sortBy = (arr, fn) => [...arr].sort((a, b) => {
  const av = fn(a); const bv = fn(b);
  if (av < bv) return -1; if (av > bv) return 1; return 0;
});

// ---------------------------------------------------------------- state

// Per-page tile count. The host iframe auto-resizes its height to
// fit our content, so a large page forces the parent modal to scroll
// forever and pushes the pager / save buttons out of reach. 10 tiles
// keeps every view a single screen tall on the user's box.
const PAGE_SIZE = 10;

const DEFAULT_BLOCK = () => ({
  platform: 'HapHomematic',
  name: 'HapHomematic',
  ccuIp: '',
  useTls: false,
  interfaces: { bidcosRf: true, hmIpRf: true },
  interfacePorts: {},
  rpcAuth: { enabled: false, username: '', password: '' },
  eventServer: { host: '0.0.0.0', callbackHost: '', port: 9875 },
});

const state = {
  view: 'settings',
  /** Optional drill-down sub-view (replaces base view body until popped). */
  nav: [],
  cfg: DEFAULT_BLOCK(),
  devicesFile: { version: 1, devices: {} },
  /** Errors of an invalid devices.json; editing is blocked while set. */
  devicesErrors: null,
  devicesPath: '',
  /** Local IPv4 addresses of the Homebridge host (callback picker). */
  network: [],
  discovered: { devices: [] },
  services: { channelServices: [] },
  ui: {
    search:     { channels: '',           picker: '' },
    filter:     { channels: 'configured' }, // configured | all | unconfigured
    filterType: { channels: 'all' },        // CCU channel type, e.g. SWITCH_VIRTUAL_RECEIVER, or 'all'
    sort:       { channels: 'name' },       // name | device | address | type
    page:       { channels: 1,            picker: 1 },
    /** false: hide channels that are not worth mapping (see hiddenChannels). */
    showAll: false,
    /** Channels help text expanded (collapsed by default). */
    helpOpen: false,
  },
  /** Last "Test CCU" result as HTML; survives re-renders. */
  testResult: '',
  pluginVersion: 'unknown',
};

// ---------------------------------------------------------------- lookups

function channelLookup() {
  const out = new Map();
  for (const d of state.discovered.devices ?? []) {
    out.set(d.address, { device: d, channel: undefined });
    for (const c of d.channels ?? []) out.set(c.address, { device: d, channel: c });
  }
  return out;
}

const GROUP_RE = /^(SWITCH|SHUTTER|BLIND|DIMMER)_(TRANSMITTER|VIRTUAL_RECEIVER)$/;

/**
 * Addresses of channels that the lists hide unless "Show all channels"
 * is on:
 *   - channels no service can handle (MAINTENANCE, week profiles, …);
 *   - in an HmIP actuator group (one *_TRANSMITTER followed by its
 *     *_VIRTUAL_RECEIVERs) every channel but one. The one kept is the
 *     transmitter if a service handles it, else the first receiver. The
 *     plugin pairs them itself (src/ccu/pairing.ts), so mapping any of
 *     them gives the same accessory;
 *   - the CCU's own virtual remote (HM-RCV-50 / HmIP-RCV-50, 50 keys).
 * Channels already in devices.json are never hidden.
 */
function hiddenChannels(device) {
  const channels = sortBy(device.channels ?? [], (c) => c.index);
  if (/RCV-50$/i.test(device.type ?? '')) return new Set(channels.map((c) => c.address));
  const handled = new Set(state.services.channelServices.flatMap((s) => s.channelTypes));
  const hidden = new Set();
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const m = GROUP_RE.exec(c.type ?? '');
    if (!m || m[2] !== 'TRANSMITTER') {
      // Receivers are handled with their transmitter below; a receiver
      // without a transmitter before it stays visible.
      const inGroup = m && channels.slice(0, i).some((p) => p.type === `${m[1]}_TRANSMITTER`);
      if (!inGroup && !handled.has(c.type)) hidden.add(c.address);
      continue;
    }
    const group = [c];
    for (let j = i + 1; j < channels.length && channels[j].type === `${m[1]}_VIRTUAL_RECEIVER`; j++) group.push(channels[j]);
    const keep = handled.has(c.type) ? c : (group[1] ?? c);
    for (const g of group) if (g !== keep) hidden.add(g.address);
  }
  return hidden;
}

/** Union of hiddenChannels() over all discovered devices, minus mapped ones. */
function hiddenAddresses() {
  if (state.ui.showAll) return new Set();
  const mapped = new Set(configuredChannels().map((c) => c.address));
  const out = new Set();
  for (const d of state.discovered.devices ?? []) {
    for (const a of hiddenChannels(d)) if (!mapped.has(a)) out.add(a);
  }
  return out;
}

const deviceMode = (dev) => dev.mode ?? (dev.service ? 'device' : 'perChannel');
const splitKey = (key) => { const i = key.indexOf(':'); return [key.slice(0, i), key.slice(i + 1)]; };
// Same fallback as the plugin: HmIP serials are 14 hex digits.
const guessInterface = (serial) => (/^[0-9A-F]{14}$/i.test(serial) ? 'HmIP-RF' : 'BidCos-RF');

/**
 * devices.json flattened to one row per accessory. Per-channel mappings
 * get address `SERIAL:N`, device mappings (e.g. irrigation) the bare
 * serial.
 */
function configuredChannels() {
  const out = [];
  for (const [key, dev] of Object.entries(state.devicesFile?.devices ?? {})) {
    const [intf, serial] = splitKey(key);
    const devOn = dev.enabled !== false;
    if (deviceMode(dev) === 'device') {
      out.push({ address: serial, interface: intf, kind: 'device', name: dev.name, service: dev.service,
        subtype: dev.variant, enabled: devOn, options: dev.options ?? {}, channels: dev.channels ?? {} });
      continue;
    }
    for (const [idx, ch] of Object.entries(dev.channels ?? {})) {
      out.push({ address: `${serial}:${idx}`, interface: intf, kind: 'channel', name: ch.name, service: ch.service,
        subtype: ch.variant, enabled: devOn && ch.enabled !== false, options: ch.options ?? {} });
    }
  }
  return out;
}

/** Find the devices.json entry for a row address (`SERIAL` or `SERIAL:N`). */
function findDeviceKey(serial) {
  return Object.keys(state.devicesFile.devices).find((k) => splitKey(k)[1] === serial);
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''
  && !(typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)));

/** Per-channel mapping `SERIAL:N`; keeps unknown fields of the entry. */
function saveChannelMapping(address, intf, fields) {
  const [serial, idx] = address.split(':');
  const devices = state.devicesFile.devices;
  const key = findDeviceKey(serial) ?? `${intf}:${serial}`;
  const dev = devices[key] ?? { channels: {} };
  if (deviceMode(dev) === 'device') {
    throw new Error('This device is mapped as a whole; remove that mapping first.');
  }
  dev.channels = dev.channels ?? {};
  dev.channels[idx] = clean({ ...(dev.channels[idx] ?? {}), ...fields });
  devices[key] = dev;
}

/** Whole-device mapping; replaces any per-channel mappings of the device. */
function saveDeviceMapping(serial, intf, fields) {
  const devices = state.devicesFile.devices;
  const key = findDeviceKey(serial) ?? `${intf}:${serial}`;
  const old = devices[key] ?? {};
  const keep = old.enabled === false ? { enabled: false } : {};
  devices[key] = clean({ ...keep, ...fields });
}

function removeMapping(address) {
  const [serial, idx] = address.split(':');
  const key = findDeviceKey(serial);
  if (!key) return;
  const dev = state.devicesFile.devices[key];
  if (idx === undefined || deviceMode(dev) === 'device') {
    delete state.devicesFile.devices[key];
    return;
  }
  delete dev.channels?.[idx];
  if (!Object.keys(dev.channels ?? {}).length) delete state.devicesFile.devices[key];
}

async function loadDevices() {
  try {
    const r = await homebridge.request('/devices/get');
    state.devicesPath = r.path ?? '';
    if (r.ok) {
      state.devicesFile = r.file;
      state.devicesErrors = null;
    } else {
      state.devicesErrors = r.errors ?? ['unknown error'];
    }
  } catch (err) {
    state.devicesErrors = [err.message];
  }
}

async function saveDevices(successMsg) {
  spinner(true);
  try {
    await homebridge.request('/devices/put', { file: state.devicesFile });
    toast('success', `${successMsg}. Restart the child bridge to apply.`, 'devices.json');
    return true;
  } catch (err) {
    toast('error', err.message, 'devices.json');
    await loadDevices(); // back to what is on disk
    return false;
  } finally { spinner(false); }
}

function devicesErrorHTML() {
  if (!state.devicesErrors) return '';
  return `<div class="alert alert-danger"><strong>devices.json is invalid</strong> — mappings cannot be edited until it is fixed
    ${state.devicesPath ? `(<code>${h(state.devicesPath)}/devices.json</code>)` : ''}:
    <ul class="mb-0">${state.devicesErrors.map((e) => `<li>${h(e)}</li>`).join('')}</ul></div>`;
}

// ---------------------------------------------------------------- nav stack

function navigate(view) {
  state.view = view;
  state.nav = [];
  document.querySelectorAll('#hgui-tabs [data-tab]').forEach((t) => {
    const on = t.dataset.tab === view;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  rerender();
}

function pushNav(entry) { state.nav.push(entry); rerender(); }
function popNav() { state.nav.pop(); rerender(); }

function rerender() {
  const host = $('hgui-view-host');
  host.innerHTML = '';
  if (state.nav.length > 0) {
    const top = state.nav[state.nav.length - 1];
    SUBVIEWS[top.kind]?.(host, top.props ?? {});
    return;
  }
  VIEWS[state.view]?.(host);
}

// ---------------------------------------------------------------- top-level views

const VIEWS = {
  settings:  viewSettings,
  channels:  viewChannels,
};

// ---------------------------------------------------------------- channels view

function viewChannels(host) {
  // Build the persistent toolbar + an empty rows host. Crucially we
  // attach event handlers ONCE here. Subsequent state changes only
  // call drawChannelRows(), which mutates the rows host — so the
  // search input never gets recreated, never loses focus.
  // Build the type filter option list from the discovered device tree
  // so the dropdown reflects what's actually on this CCU.
  const hidden = hiddenAddresses();
  const channelTypes = new Set();
  for (const d of state.discovered.devices) {
    for (const c of d.channels) if (c.type && c.index !== 0 && !hidden.has(c.address)) channelTypes.add(c.type);
  }

  const discovered = state.discovered.devices.length;
  host.innerHTML = `
    <div class="hgui-stats mt-3">
      ${statHTML('Channels', configuredChannels().length, 'in HomeKit')}
      ${statHTML('Devices', discovered, discoverySourceText())}
      <div class="hgui-card d-flex flex-column justify-content-center gap-1">
        <button class="btn btn-primary" id="hgui-discover-btn">Discover</button>
        <div class="hgui-meta">Reload devices and channels from the CCU.</div>
      </div>
    </div>
    <details class="hgui-card" id="hgui-help" ${state.ui.helpOpen ? 'open' : ''}>
      <summary>Which channels go to HomeKit?</summary>
      <ol class="hgui-meta mb-2 ps-3">
        <li>Click <strong>Discover</strong> to load the devices from the CCU.</li>
        <li>Switch the filter to <em>Not in HomeKit</em>, pick a channel and click <strong>+ Add</strong>.
          Give it a HomeKit name and choose the service (switch, outlet, light, blind, …).</li>
        <li>Restart the child bridge to apply the changes.</li>
      </ol>
      <p class="hgui-meta mb-0">Only the channels worth mapping are listed. An HmIP actuator shows one
        channel per output (e.g. HmIP-BROLL channel 3, HmIP-PS channel 2, HmIP-DRSI4 channels 5 / 9 / 13 / 17);
        the plugin reads the state there and sends commands to the matching receiver channel itself.
        Choose the channel and service once: changing either later creates a new accessory in Home.</p>
    </details>
    <div class="hgui-toolbar">
      <input type="search" class="form-control" id="hgui-search-channels"
             placeholder="Search by HomeKit name, CCU name, address, type…"
             value="${h(state.ui.search.channels)}" />
      <select class="form-select" id="hgui-filter-channels" title="Filter">
        <option value="configured">Configured</option>
        <option value="all">All discovered</option>
        <option value="unconfigured">Not in HomeKit</option>
      </select>
      <select class="form-select" id="hgui-filterType-channels" title="Filter by channel type">
        <option value="all">All types</option>
        ${Array.from(channelTypes).sort().map((t) => `<option value="${h(t)}">${h(t)}</option>`).join('')}
      </select>
      <select class="form-select" id="hgui-sort-channels" title="Sort by">
        <option value="name">Sort: HomeKit name</option>
        <option value="device">Sort: Device name</option>
        <option value="address">Sort: Address</option>
        <option value="type">Sort: Channel type</option>
      </select>
      <div class="form-check mb-0">
        <input class="form-check-input" type="checkbox" id="hgui-showall-channels" ${state.ui.showAll ? 'checked' : ''} />
        <label class="form-check-label" for="hgui-showall-channels">Show all channels</label>
      </div>
      <button class="btn btn-primary ms-auto" id="hgui-add-channel">+ Add channel</button>
      <span class="hgui-meta" id="hgui-channels-count"></span>
    </div>
    ${devicesErrorHTML()}
    <div id="hgui-rows-host"></div>
    <div id="hgui-pager-host"></div>
  `;
  $('hgui-filter-channels').value       = state.ui.filter.channels;
  $('hgui-filterType-channels').value   = channelTypes.has(state.ui.filterType.channels) ? state.ui.filterType.channels : 'all';
  $('hgui-sort-channels').value         = state.ui.sort.channels;

  $('hgui-discover-btn').addEventListener('click', () => onDiscover());
  $('hgui-help').addEventListener('toggle', (e) => { state.ui.helpOpen = e.target.open; });

  $('hgui-search-channels').addEventListener('input', (e) => {
    state.ui.search.channels = e.target.value;
    state.ui.page.channels = 1;
    drawChannelRows();
  });
  $('hgui-filter-channels').addEventListener('change', (e) => {
    state.ui.filter.channels = e.target.value;
    state.ui.page.channels = 1;
    drawChannelRows();
  });
  $('hgui-filterType-channels').addEventListener('change', (e) => {
    state.ui.filterType.channels = e.target.value;
    state.ui.page.channels = 1;
    drawChannelRows();
  });
  $('hgui-sort-channels').addEventListener('change', (e) => {
    state.ui.sort.channels = e.target.value;
    drawChannelRows();
  });
  $('hgui-showall-channels').addEventListener('change', (e) => {
    state.ui.showAll = e.target.checked;
    state.ui.page.channels = 1;
    rerender(); // the type filter list depends on it too
  });
  $('hgui-add-channel').addEventListener('click', () => {
    if (state.devicesErrors) {
      toast('warning', 'Fix devices.json first', 'Add channel'); return;
    }
    if (!state.discovered.devices.length) {
      toast('warning', 'Run "Discover" first', 'Add channel'); return;
    }
    pushNav({ kind: 'pickChannel' });
  });

  drawChannelRows();
}

function drawChannelRows() {
  const host = $('hgui-rows-host');
  const pagerHost = $('hgui-pager-host');
  if (!host) return;
  const cl = channelLookup();
  const configured = configuredChannels();
  const configuredByAddr = new Map(configured.map((c) => [c.address, c]));

  // Build candidate set based on filter mode.
  let rows;
  const filter = state.ui.filter.channels;
  if (filter === 'configured') {
    rows = configured.map((c) => ({ ...c, _info: cl.get(c.address), isConfigured: true }));
  } else {
    // 'all' or 'unconfigured' both need discovered data.
    const hidden = hiddenAddresses();
    rows = [];
    for (const d of state.discovered.devices) {
      // A whole-device mapping (e.g. irrigation) is one card, not N channels.
      const whole = configuredByAddr.get(d.address);
      if (whole) {
        if (filter !== 'unconfigured') rows.push({ ...whole, _info: { device: d, channel: undefined }, isConfigured: true });
        continue;
      }
      for (const c of d.channels) {
        if (c.index === 0) continue; // MAINTENANCE: not mappable
        if (hidden.has(c.address)) continue;
        const existing = configuredByAddr.get(c.address);
        const isConfigured = !!existing;
        if (filter === 'unconfigured' && isConfigured) continue;
        rows.push({
          address: c.address,
          name: existing?.name ?? c.name,
          service: existing?.service,
          subtype: existing?.subtype,
          options: existing?.options,
          kind: existing?.kind,
          enabled: existing?.enabled,
          isConfigured,
          _info: { device: d, channel: c },
        });
      }
    }
  }

  // Type filter.
  const ftype = state.ui.filterType.channels;
  if (ftype && ftype !== 'all') {
    rows = rows.filter((r) => r._info?.channel?.type === ftype);
  }
  // Search.
  const q = state.ui.search.channels.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => {
      const t = [
        r.address, r.name, r._info?.channel?.name, r._info?.device?.name,
        r._info?.device?.type, r._info?.channel?.type, r.service, r.subtype,
      ].filter(Boolean).join(' ').toLowerCase();
      return t.includes(q);
    });
  }

  // Sort.
  const sortKey = state.ui.sort.channels;
  rows = sortBy(rows, (r) => {
    switch (sortKey) {
      case 'device':  return (r._info?.device?.name ?? '').toLowerCase();
      case 'address': return r.address.toLowerCase();
      case 'type':    return (r._info?.channel?.type ?? '').toLowerCase();
      default:        return (r.name ?? r._info?.channel?.name ?? r.address).toLowerCase();
    }
  });

  $('hgui-channels-count').textContent = `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`;

  // Pagination.
  let page = state.ui.page.channels;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pageCount) page = state.ui.page.channels = 1;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (rows.length === 0) {
    host.innerHTML = `<div class="hgui-empty">No channels match. ${
      filter === 'configured' && configured.length === 0
        ? 'Click "+ Add channel" to add one.'
        : 'Try clearing the search or switching the filter.'}</div>`;
    pagerHost.innerHTML = '';
    return;
  }

  host.innerHTML = `<div class="hgui-tiles">${slice.map(channelTileHTML).join('')}</div>`;
  pagerHost.innerHTML = pagerHTML('channels', page, pageCount);
  host.querySelectorAll('[data-edit-channel]').forEach((b) =>
    b.addEventListener('click', () => pushNav({ kind: 'editChannel', props: { address: b.dataset.editChannel, mode: 'edit' } })));
  host.querySelectorAll('[data-add-from]').forEach((b) =>
    b.addEventListener('click', () => pushNav({ kind: 'editChannel', props: { address: b.dataset.addFrom, mode: 'add' } })));
  pagerHost.querySelectorAll('[data-pager]').forEach((b) =>
    b.addEventListener('click', () => { state.ui.page.channels = parseInt(b.dataset.pager, 10); drawChannelRows(); }));
}

function effectiveHkName(r) {
  // Same precedence as the platform: chosen name, then the placeholder
  // channel name from discovery, then the address.
  if (typeof r.name === 'string' && r.name.length) return r.name;
  return r._info?.channel?.name || r.address;
}

function channelTileHTML(r) {
  const info = r._info;
  const inHK = r.isConfigured ?? r.service !== undefined;
  const hkName = effectiveHkName(r);
  // Subtitle: prefer device name/type from discovery; if discovery
  // hasn't run, show a hint so the user knows to click Discover for
  // the rich data. The address always shows in the meta line.
  const subtitle = info?.device
    ? `${h(info.device.name ?? '')}${info.device.type && !String(info.device.name ?? '').startsWith(info.device.type) ? ` · ${h(info.device.type)}` : ''}${info.channel?.name && info.channel.name !== hkName ? ` · ch ${h(info.channel.name)}` : ''}`
    : '<span class="hgui-meta">discovery data not loaded — click "Discover" for device + CCU names</span>';
  const channelType = info?.channel?.type ?? '';
  return `
    <div class="hgui-tile ${inHK ? '' : 'muted'}">
      <div class="hgui-tile-head">
        <div class="hgui-tile-name">${h(hkName)}</div>
        <div class="hgui-tile-actions">
          ${inHK
            ? `<button class="btn btn-sm btn-outline-primary" data-edit-channel="${h(r.address)}">Edit</button>`
            : `<button class="btn btn-sm btn-primary" data-add-from="${h(r.address)}">+ Add</button>`}
        </div>
      </div>
      <div class="hgui-tile-sub">${subtitle}</div>
      <div class="hgui-tile-meta"><code>${h(r.address)}</code>${channelType ? ` · ${h(channelType)}` : ''}</div>
      ${r.kind === 'device' && Object.keys(r.channels ?? {}).length ? `
        <div class="hgui-tile-meta">${Object.entries(r.channels).map(([i, c]) => `<span class="me-2">${h(i)}: ${h(c.name ?? '—')}${c.valveType ? ` (${h(c.valveType)})` : ''}</span>`).join('')}</div>` : ''}
      <div class="hgui-tile-pills">
        ${inHK ? `<span class="hgui-pill primary">${h(r.service ?? '?')}</span>` : '<span class="hgui-pill muted">not in HomeKit</span>'}
        ${r.subtype ? `<span class="hgui-pill">${h(r.subtype)}</span>` : ''}
        ${r.kind === 'device' ? '<span class="hgui-pill">whole device</span>' : ''}
        ${Object.entries(r.options ?? {}).filter(([, v]) => v !== false).map(([k, v]) => `<span class="hgui-pill">${h(k)}${v === true ? '' : `=${h(v)}`}</span>`).join('')}
        ${r.enabled === false ? '<span class="hgui-pill warning">disabled</span>' : ''}
      </div>
    </div>`;
}

function pagerHTML(kind, page, pageCount) {
  if (pageCount <= 1) return '';
  const win = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pageCount, page + 2); p++) win.push(p);
  return `
    <div class="hgui-pager">
      <button class="btn btn-sm btn-outline-secondary" ${page === 1 ? 'disabled' : ''} data-pager="${page - 1}">‹ prev</button>
      ${win.map((p) => `<button class="btn btn-sm ${p === page ? 'btn-primary' : 'btn-outline-secondary'}" data-pager="${p}">${p}</button>`).join('')}
      <button class="btn btn-sm btn-outline-secondary" ${page === pageCount ? 'disabled' : ''} data-pager="${page + 1}">next ›</button>
      <span class="ms-2 hgui-meta">page ${page} / ${pageCount}</span>
    </div>`;
}

// ---------------------------------------------------------------- settings view

function statHTML(label, value, sub) {
  return `
    <div class="hgui-card">
      <div class="hgui-meta">${h(label)}</div>
      <div class="hgui-stat-value">${h(value)}</div>
      <div class="hgui-meta">${h(sub)}</div>
    </div>`;
}

function viewSettings(host) {
  const m = state.cfg;
  host.innerHTML = `
    <div class="hgui-card mt-3">
      <h6>CCU connection</h6>
      <div class="row g-2 mb-2">
        <div class="col-md-6">
          <label class="form-label">CCU IP / hostname</label>
          <input class="form-control" id="cf-ccu-ip" value="${h(m.ccuIp)}" />
        </div>
        <div class="col-md-3">
          <label class="form-label">Event server port</label>
          <input class="form-control" type="number" min="1024" max="65535" id="cf-event-port" value="${h(m.eventServer.port)}" />
        </div>
        <div class="col-md-3 d-flex align-items-end">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="cf-tls" ${m.useTls ? 'checked' : ''} />
            <label class="form-check-label" for="cf-tls">Use TLS (42001 / 42010)</label>
          </div>
        </div>
      </div>
      <div class="row g-2 mb-2">
        <div class="col-md-6">
          <label class="form-label">Callback address (required)</label>
          <input class="form-control" id="cf-callback-host" list="cf-callback-list" placeholder="192.168.0.13" value="${h(m.eventServer.callbackHost ?? '')}" />
          <datalist id="cf-callback-list">${state.network.map((n) => `<option value="${h(n.address)}">${h(n.name)}</option>`).join('')}</datalist>
          <div class="hgui-hint">IP of this Homebridge host as seen from the CCU. The CCU sends its events to <code>http://&lt;address&gt;:&lt;port&gt;</code>.</div>
          ${state.network.length ? `<div class="hgui-hint"><details>
            <summary>Local addresses of this host (${state.network.length})</summary>
            <div class="mt-1">${state.network.map((n) => `<a href="#" data-pick-ip="${h(n.address)}">${h(n.address)}</a> (${h(n.name)})`).join(', ')}</div>
            <div class="mt-1">Click one to use it. In Docker these are container addresses — use the host's IP instead.</div>
          </details></div>` : ''}
        </div>
      </div>
    </div>
    <div class="hgui-card">
      <h6>XML-RPC authentication</h6>
      <p class="hgui-meta">Only if authentication is enabled on the CCU (Settings → Control Panel → Security).</p>
      <div class="row g-2">
        <div class="col-md-3 d-flex align-items-end">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="cf-auth-enabled" ${m.rpcAuth.enabled ? 'checked' : ''} />
            <label class="form-check-label" for="cf-auth-enabled">Use authentication</label>
          </div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Username</label>
          <input class="form-control" id="cf-auth-user" autocomplete="off" value="${h(m.rpcAuth.username || '')}" />
        </div>
        <div class="col-md-5">
          <label class="form-label">Password</label>
          <input class="form-control" type="password" id="cf-auth-pass" autocomplete="new-password" value="${h(m.rpcAuth.password || '')}" />
        </div>
      </div>
    </div>
    <div class="hgui-card">
      <h6>Interfaces</h6>
      <div class="row g-2">
        ${[['bidcosRf','BidCos-RF'],['hmIpRf','HmIP-RF']]
          .map(([k,label]) => `
            <div class="col-md-3 form-check">
              <input class="form-check-input" type="checkbox" id="cf-if-${k}" ${m.interfaces[k] ? 'checked' : ''} />
              <label class="form-check-label" for="cf-if-${k}">${h(label)}</label>
            </div>`).join('')}
      </div>
    </div>
    <div class="hgui-card">
      <h6>XML-RPC ports</h6>
      <p class="hgui-meta">Leave blank for the defaults <code>2001</code> (BidCos-RF) and <code>2010</code> (HmIP-RF), with TLS <code>42001</code> / <code>42010</code>.</p>
      <div class="row g-2">
        ${[['BidCos-RF','2001'],['HmIP-RF','2010']]
          .map(([k,ph]) => `
            <div class="col-md-3">
              <label class="form-label">${h(k)}</label>
              <input class="form-control" type="number" id="cf-port-${h(k)}" placeholder="${ph}" value="${h(m.interfacePorts?.[k] ?? '')}" />
            </div>`).join('')}
      </div>
    </div>
    <div class="hgui-card d-flex align-items-center gap-2 flex-wrap">
      <button class="btn btn-outline-primary" id="hgui-test-btn">Test CCU</button>
      <span class="small" id="hgui-test-result">${state.testResult
        || '<span class="hgui-meta">Checks the connection with the settings above (not saved yet is fine).</span>'}</span>
    </div>
  `;
  $('hgui-test-btn').addEventListener('click', onTestConnection);
  const propagate = (mut) => { mut(state.cfg); pushConfig(); };
  $('cf-ccu-ip').addEventListener('input', (e) => propagate((b) => b.ccuIp = e.target.value.trim()));
  $('cf-event-port').addEventListener('input', (e) => propagate((b) => b.eventServer.port = parseInt(e.target.value, 10) || 9875));
  $('cf-tls').addEventListener('change', (e) => propagate((b) => b.useTls = e.target.checked));
  $('cf-callback-host').addEventListener('input', (e) => propagate((b) => b.eventServer.callbackHost = e.target.value.trim()));
  host.querySelectorAll('[data-pick-ip]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    $('cf-callback-host').value = a.dataset.pickIp;
    propagate((b) => b.eventServer.callbackHost = a.dataset.pickIp);
  }));
  $('cf-auth-enabled').addEventListener('change', (e) => propagate((b) => b.rpcAuth.enabled = e.target.checked));
  $('cf-auth-user').addEventListener('input', (e) => propagate((b) => b.rpcAuth.username = e.target.value));
  $('cf-auth-pass').addEventListener('input', (e) => propagate((b) => b.rpcAuth.password = e.target.value));
  for (const k of ['bidcosRf','hmIpRf']) {
    $(`cf-if-${k}`).addEventListener('change', (e) => propagate((b) => b.interfaces[k] = e.target.checked));
  }
  for (const k of ['BidCos-RF','HmIP-RF']) {
    $(`cf-port-${k}`).addEventListener('input', (e) => {
      const v = e.target.value.trim();
      propagate((b) => {
        b.interfacePorts = { ...b.interfacePorts };
        if (v === '') delete b.interfacePorts[k];
        else b.interfacePorts[k] = parseInt(v, 10);
      });
    });
  }
}

// ---------------------------------------------------------------- subviews

const SUBVIEWS = {
  pickChannel:  subPickChannel,
  editChannel:  subEditChannel,
};

function subviewHeader(host, title, breadcrumb) {
  host.innerHTML = `
    <div class="d-flex align-items-center gap-2 my-3">
      <button class="btn btn-outline-secondary btn-sm" id="hgui-back">← Back</button>
      <h5 class="mb-0">${h(title)}</h5>
      ${breadcrumb ? `<span class="hgui-meta ms-2">${h(breadcrumb)}</span>` : ''}
    </div>
    <div id="hgui-sub-body"></div>
    <div id="hgui-sub-footer" class="hgui-floating-bar"></div>
  `;
  $('hgui-back').addEventListener('click', popNav);
}

// --- pickChannel: searchable picker

function subPickChannel(host) {
  subviewHeader(host, 'Add channel — pick from CCU',
    state.ui.showAll ? 'all channels' : 'channels worth mapping ("Show all channels" lists every one)');
  const body = $('hgui-sub-body');
  body.innerHTML = `
    <div class="hgui-toolbar">
      <input type="search" id="hgui-picker-search" class="form-control"
             placeholder="Search by name, address, type…" autofocus
             value="${h(state.ui.search.picker)}" />
      <span class="hgui-meta ms-auto" id="hgui-picker-count"></span>
    </div>
    <div id="hgui-picker-host"></div>
    <div id="hgui-picker-pager"></div>
  `;
  $('hgui-picker-search').addEventListener('input', (e) => {
    state.ui.search.picker = e.target.value;
    state.ui.page.picker = 1;
    drawPicker();
  });
  drawPicker();
}

function drawPicker() {
  const host = $('hgui-picker-host');
  const pagerHost = $('hgui-picker-pager');
  const configuredByAddr = new Map(configuredChannels().map((c) => [c.address, c]));
  const hidden = hiddenAddresses();
  const all = [];
  for (const d of state.discovered.devices) {
    for (const c of d.channels) {
      if (c.index === 0 || hidden.has(c.address)) continue;
      all.push({ device: d, channel: c });
    }
  }
  const q = state.ui.search.picker.trim().toLowerCase();
  let rows = q
    ? all.filter((x) => `${x.device.name} ${x.device.type} ${x.channel.name} ${x.channel.address} ${x.channel.type}`.toLowerCase().includes(q))
    : all;
  rows = sortBy(rows, (x) => `${x.device.name} ${x.channel.address}`.toLowerCase());

  let page = state.ui.page.picker;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pageCount) page = state.ui.page.picker = 1;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  $('hgui-picker-count').textContent = `${rows.length} candidates`;

  if (rows.length === 0) {
    host.innerHTML = '<div class="hgui-empty">No channels match.</div>';
    pagerHost.innerHTML = '';
    return;
  }
  host.innerHTML = `<div class="hgui-tiles">${slice.map((x) => {
    const isAdded = configuredByAddr.has(x.channel.address);
    return `
      <div class="hgui-tile ${isAdded ? 'muted' : ''}">
        <div class="hgui-tile-head">
          <div class="hgui-tile-name">${h(x.channel.name || x.channel.address)}</div>
          <div class="hgui-tile-actions">
            ${isAdded
              ? '<span class="hgui-pill warning">already added</span>'
              : `<button class="btn btn-sm btn-primary" data-pick="${h(x.channel.address)}">Select</button>`}
          </div>
        </div>
        <div class="hgui-tile-sub">${h(x.device.name)} · ${h(x.device.type)}</div>
        <div class="hgui-tile-meta"><code>${h(x.channel.address)}</code> · ${h(x.channel.type)}</div>
      </div>`;
  }).join('')}</div>`;
  pagerHost.innerHTML = pagerHTML('picker', page, pageCount);
  host.querySelectorAll('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      // Replace the picker on the nav stack with the editor so Back returns
      // to the channels list rather than the picker.
      state.nav.pop();
      state.nav.push({ kind: 'editChannel', props: { address: b.dataset.pick, mode: 'add' } });
      rerender();
    }));
  pagerHost.querySelectorAll('[data-pager]').forEach((b) =>
    b.addEventListener('click', () => { state.ui.page.picker = parseInt(b.dataset.pager, 10); drawPicker(); }));
}

// --- editChannel: form

function subEditChannel(host, props) {
  const { address, mode } = props;
  const cl = channelLookup();
  const info = cl.get(address);
  const [serial] = address.split(':');
  const isDeviceRow = !address.includes(':');
  const device = info?.device ?? cl.get(serial)?.device;
  const entry = configuredChannels().find((c) => c.address === address) ?? null;
  const all = state.services.channelServices;
  const byKey = (k) => all.find((s) => s.key === k);

  // Candidate services: by the channel's type; for a whole-device row by
  // any channel type of the device.
  const types = isDeviceRow
    ? new Set((device?.channels ?? []).map((c) => c.type))
    : new Set(info?.channel?.type ? [info.channel.type] : []);
  let candidates = all.filter((s) => s.channelTypes.some((t) => types.has(t)));
  if (!candidates.length) candidates = all;
  if (entry?.service && !candidates.some((s) => s.key === entry.service) && byKey(entry.service)) {
    candidates = [byKey(entry.service), ...candidates];
  }

  const draft = entry
    ? { ...entry, name: effectiveHkName({ ...entry, _info: info }), options: { ...(entry.options ?? {}) },
        channels: JSON.parse(JSON.stringify(entry.channels ?? {})) }
    : {
        address,
        name: info?.channel?.name ?? device?.name ?? address,
        service: candidates[0]?.key ?? all[0]?.key ?? 'SwitchAccessory',
        subtype: candidates[0]?.variants?.[0]?.id,
        options: {},
        channels: {},
      };
  const originalService = entry?.service;

  /** Channels a whole-device service works on (e.g. irrigation valves). */
  const deviceChannels = (def) => {
    const fromDevice = (device?.channels ?? [])
      .filter((c) => c.index > 0 && def.channelTypes.includes(c.type)).map((c) => String(c.index));
    if (fromDevice.length) return fromDevice;
    const fromEntry = Object.keys(draft.channels ?? {});
    return fromEntry.length ? fromEntry : ['1', '2', '3', '4'];
  };

  const optionInput = (spec, value, id) => {
    const v = value ?? spec.default;
    switch (spec.type) {
      case 'boolean':
        return `<div class="form-check"><input class="form-check-input" type="checkbox" id="${id}" ${v ? 'checked' : ''} />
          <label class="form-check-label" for="${id}">${h(spec.label)}</label></div>`;
      case 'enum':
        return `<select class="form-select" id="${id}">${(spec.values ?? []).map((x) =>
          `<option value="${h(x)}" ${x === v ? 'selected' : ''}>${h(x)}</option>`).join('')}</select>`;
      case 'number':
        return `<input class="form-control" type="number" id="${id}" value="${h(v ?? '')}"
          ${spec.min !== undefined ? `min="${spec.min}"` : ''} ${spec.max !== undefined ? `max="${spec.max}"` : ''} />`;
      default:
        return `<input class="form-control" id="${id}" value="${h(v ?? '')}" />`;
    }
  };
  const readOption = (spec, el) => {
    if (spec.type === 'boolean') return el.checked;
    if (spec.type === 'number') {
      const n = Number(el.value);
      return el.value === '' || !Number.isFinite(n) ? undefined : n;
    }
    return el.value;
  };

  subviewHeader(host, mode === 'add' ? 'Add to HomeKit' : `Edit: ${draft.name || address}`, address);
  const body = $('hgui-sub-body');
  const draw = () => {
    const def = byKey(draft.service);
    const variants = def?.variants ?? [];
    const asDevice = isDeviceRow || def?.scope === 'device';
    const serviceChanged = mode === 'edit' && originalService && draft.service !== originalService;
    const otherChannels = asDevice && !isDeviceRow
      ? configuredChannels().filter((r) => r.kind === 'channel' && r.address.startsWith(`${serial}:`))
      : [];
    const chans = asDevice && def?.channelOptions?.length ? deviceChannels(def) : [];
    body.innerHTML = `
      <div class="hgui-card">
        <div class="hgui-meta mb-2">
          <code>${h(asDevice ? serial : address)}</code>${!asDevice && info?.channel?.type ? ` · ${h(info.channel.type)}` : ''}${device?.type ? ` · ${h(device.type)}` : ''}
          ${asDevice ? '<span class="hgui-pill ms-2">whole device</span>' : ''}
        </div>
        ${serviceChanged ? `<div class="alert alert-warning">Changing the service creates a <strong>new accessory</strong> in Home —
          its room and automations are lost (the accessory identity includes the service).</div>` : ''}
        ${otherChannels.length ? `<div class="alert alert-info">${h(def.key)} maps the whole device. The existing
          channel mappings of this device (${otherChannels.map((r) => h(r.address)).join(', ')}) are replaced.</div>` : ''}
        <div class="hgui-form-row">
          <label>HomeKit name</label>
          <div>
            <input class="form-control" id="ec-name" value="${h(draft.name ?? '')}" />
            <div class="hgui-hint">Shown in the Home app. Already-paired accessories keep the name they had in Home; rename there too.</div>
          </div>
        </div>
        <div class="hgui-form-row">
          <label>Service</label>
          <div>
            <select class="form-select" id="ec-service">
              ${candidates.map((s) =>
                `<option value="${h(s.key)}" ${s.key === draft.service ? 'selected' : ''}>${h(s.description)} (${h(s.key)})</option>`).join('')}
            </select>
          </div>
        </div>
        ${variants.length ? `
          <div class="hgui-form-row">
            <label>Variant</label>
            <div>
              <select class="form-select" id="ec-subtype">
                ${variants.map((v) => `<option value="${h(v.id)}" ${v.id.toLowerCase() === String(draft.subtype ?? '').toLowerCase() ? 'selected' : ''}>${h(v.label)}</option>`).join('')}
              </select>
            </div>
          </div>` : ''}
        ${(def?.options ?? []).map((o, i) => `
          <div class="hgui-form-row">
            <label>${o.type === 'boolean' ? '' : h(o.label)}</label>
            <div>${optionInput(o, draft.options[o.key], `ec-opt-${i}`)}${o.hint ? `<div class="hgui-hint">${h(o.hint)}</div>` : ''}</div>
          </div>`).join('')}
        ${chans.length ? `
          <h6 class="mt-3">Channels</h6>
          ${chans.map((idx) => `
            <div class="hgui-form-row">
              <label>Channel ${h(idx)}</label>
              <div class="d-flex gap-2">${def.channelOptions.map((o, j) =>
                `<div class="flex-fill">${optionInput(o, draft.channels[idx]?.[o.key], `ec-ch-${idx}-${j}`)}</div>`).join('')}</div>
            </div>`).join('')}` : ''}
      </div>
    `;
    body.querySelector('#ec-name').addEventListener('input', (e) => { draft.name = e.target.value; });
    body.querySelector('#ec-service').addEventListener('change', (e) => {
      draft.service = e.target.value;
      draft.subtype = byKey(draft.service)?.variants?.[0]?.id;
      draft.options = {};
      draw();
    });
    if (variants.length) {
      body.querySelector('#ec-subtype').addEventListener('change', (e) => { draft.subtype = e.target.value; });
    }
    (def?.options ?? []).forEach((o, i) => {
      body.querySelector(`#ec-opt-${i}`).addEventListener('change', (e) => { draft.options[o.key] = readOption(o, e.target); });
    });
    for (const idx of chans) {
      def.channelOptions.forEach((o, j) => {
        body.querySelector(`#ec-ch-${idx}-${j}`).addEventListener('change', (e) => {
          draft.channels[idx] = { ...(draft.channels[idx] ?? {}), [o.key]: readOption(o, e.target) };
        });
      });
    }
  };
  draw();

  const footer = $('hgui-sub-footer');
  footer.innerHTML = `
    ${mode === 'edit' ? '<button class="btn btn-outline-danger" id="ec-remove">Remove from HomeKit</button>' : ''}
    <button class="btn btn-secondary ms-auto" id="ec-cancel">Cancel</button>
    <button class="btn btn-primary" id="ec-save">${mode === 'add' ? 'Add' : 'Save'}</button>
  `;
  footer.querySelector('#ec-cancel').addEventListener('click', popNav);
  footer.querySelector('#ec-save').addEventListener('click', async () => {
    if (state.devicesErrors) { toast('warning', 'Fix devices.json first'); return; }
    const name = (draft.name ?? '').trim();
    if (!name) { toast('warning', 'HomeKit name cannot be empty'); return; }
    const def = byKey(draft.service);
    const intf = device?.interface ?? entry?.interface ?? guessInterface(serial);
    const options = clean(draft.options ?? {});
    try {
      if (isDeviceRow || def?.scope === 'device') {
        const channels = {};
        for (const idx of (def?.channelOptions?.length ? deviceChannels(def) : Object.keys(draft.channels ?? {}))) {
          const c = clean(draft.channels?.[idx] ?? {});
          if (Object.keys(c).length) channels[idx] = c;
        }
        saveDeviceMapping(serial, intf, {
          service: draft.service, variant: draft.subtype || undefined, name, options, channels,
        });
      } else {
        saveChannelMapping(address, intf, { name, service: draft.service, variant: draft.subtype || undefined, options });
      }
    } catch (err) {
      toast('warning', err.message); return;
    }
    if (await saveDevices(mode === 'add' ? 'Added' : 'Updated')) popNav();
  });
  if (mode === 'edit') {
    footer.querySelector('#ec-remove').addEventListener('click', async () => {
      removeMapping(address);
      if (await saveDevices('Removed')) popNav();
    });
  }
}

// ---------------------------------------------------------------- API actions

async function onTestConnection() {
  // The result element only exists while Settings is shown.
  const show = (html) => {
    state.testResult = html;
    const el = $('hgui-test-result');
    if (el) el.innerHTML = html;
  };
  show('Testing…');
  spinner(true);
  try {
    const res = await homebridge.request('/test-connection', state.cfg);
    show(res.ok
      ? `<span class="text-success">✓ ${h(res.message)}</span>`
      : `<span class="text-danger">✗ ${h(res.message)}</span>`);
    toast(res.ok ? 'success' : 'warning', res.message, 'CCU');
  } catch (err) {
    show(`<span class="text-danger">✗ ${h(err.message)}</span>`);
    toast('error', err.message, 'CCU');
  } finally { spinner(false); }
}

/**
 * Live discovery from the CCU (listDevices, no radio traffic).
 * `quiet`: no spinner and no success toast (automatic fallback on open);
 * errors are always shown.
 */
async function onDiscover({ quiet = false } = {}) {
  if (!quiet) spinner(true);
  try {
    const res = await homebridge.request('/discover', state.cfg);
    state.discovered = res;
    rerender();
    if (!quiet) toast('success', `${res.devices.length} devices`, 'Discovery complete');
  } catch (err) {
    toast('error', err.message, 'Discovery');
  } finally { if (!quiet) spinner(false); }
}

/**
 * The device list the plugin saved at its last start. Returns false if
 * there is none, so the caller can fall back to a live discovery.
 */
async function loadCachedDiscovery() {
  try {
    const res = await homebridge.request('/discover/cached');
    if (!res?.devices?.length) return false;
    state.discovered = res;
    rerender();
    return true;
  } catch {
    return false;
  }
}

/** "live, 22:05" / "saved by the plugin, 12.11. 22:05" for the Devices box. */
function discoverySourceText() {
  const d = state.discovered;
  if (!d.devices?.length) return 'not discovered yet';
  const at = d.fetchedAt ? new Date(d.fetchedAt) : null;
  const when = at && !Number.isNaN(at.getTime())
    ? at.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  return d.source === 'cache'
    ? `saved by the plugin${when ? `, ${when}` : ''}`
    : `live from the CCU${when ? `, ${when}` : ''}`;
}

/**
 * Push state.cfg to the homebridge UI host. The host's built-in "Save"
 * button at the bottom of the plugin settings page persists this to
 * disk — we deliberately don't call savePluginConfig() ourselves so
 * the user has one canonical Save control, not two.
 */
function pushConfig() {
  try {
    homebridge.updatePluginConfig([state.cfg]);
  } catch (err) {
    toast('error', `Could not stage config update: ${err.message}`);
  }
}

// ---------------------------------------------------------------- init

async function init() {
  // Hide the schema form so the user only sees our custom UI, but keep
  // the host's built-in Save button enabled — it's the single canonical
  // place to persist config. Every mutation calls pushConfig() to stage
  // the change, and the host save button writes it to disk.
  try { homebridge.hideSchemaForm?.(); } catch { /* older host */ }

  try {
    // One platform block only (config.schema.json is `singular`).
    const blocks = (await homebridge.getPluginConfig() ?? []).filter(Boolean);
    if (blocks.length > 1) {
      toast('warning', `Found ${blocks.length} platform blocks; only the first is kept when you save.`, 'Config');
    }
    const b = blocks[0] ?? {};
    const def = DEFAULT_BLOCK();
    state.cfg = {
      ...def, ...b,
      platform: 'HapHomematic',
      interfaces: {
        bidcosRf: b.interfaces?.bidcosRf ?? def.interfaces.bidcosRf,
        hmIpRf: b.interfaces?.hmIpRf ?? def.interfaces.hmIpRf,
      },
      rpcAuth: { ...def.rpcAuth, ...(b.rpcAuth ?? {}) },
      eventServer: { ...def.eventServer, ...(b.eventServer ?? {}) },
      interfacePorts: { ...(b.interfacePorts ?? {}) },
    };
    // Fields of removed features; channel mappings now live in devices.json.
    // `_bridge` (child bridge settings incl. debugModeEnabled) is kept as is.
    for (const k of ['ccuAuth', 'variables', 'programs', 'channels']) delete state.cfg[k];
    delete state.cfg.eventServer.watchdogSeconds; // replaced by per-interface ping/PONG
  } catch (err) {
    toast('error', `Could not load config: ${err.message}`);
  }

  await loadDevices();
  try {
    state.network = (await homebridge.request('/network')).addresses ?? [];
  } catch { /* optional */ }

  try {
    const r = await homebridge.request('/services');
    state.services = r;
    if (r.pluginVersion) {
      state.pluginVersion = r.pluginVersion;
      $('hgui-version-banner').textContent = `v${r.pluginVersion}`;
    }
  } catch (err) {
    toast('error', `Could not load services: ${err.message}`);
  }

  // Tab listeners.
  document.querySelectorAll('#hgui-tabs [data-tab]').forEach((t) =>
    t.addEventListener('click', () => navigate(t.dataset.tab)));

  // Esc pops the sub-view stack (back button affordance).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.nav.length) popNav();
  });

  // Initial tab: Settings until a CCU is configured, then Channels. The
  // device list comes from the plugin's discovery.json (no CCU call);
  // only if there is none (plugin never started) a quiet live discovery
  // runs. The Discover button always asks the CCU.
  const isConfigured = !!state.cfg.ccuIp && state.cfg.ccuIp.length > 0;
  if (!isConfigured) {
    navigate('settings');
  } else {
    navigate('channels');
    loadCachedDiscovery()
      .then((ok) => (ok ? undefined : onDiscover({ quiet: true })))
      .catch(() => { /* errors already toasted by onDiscover */ });
  }
}

init();
