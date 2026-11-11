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
 *   - state.blocks: array of platform-config blocks (one per child
 *     bridge — index 0 is the main bridge).
 *   - state.view: top-level view (dashboard | channels | … | settings).
 *   - state.nav: optional sub-view stack pushed on top of the base
 *     view. Pushing a sub-view (e.g. "edit channel") swaps the body
 *     until the user pops back. No modals.
 *   - state.ui: per-view persistent search/filter/sort.
 *
 * Two-level save:
 *   - Sub-view Save buttons commit a single change into state.blocks.
 *   - Footer "Save configuration" pushes state.blocks to homebridge.
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
  interfaces: { bidcosRf: true, hmIpRf: true, bidcosWired: false, virtualDevices: true, cuxd: false },
  interfacePorts: {},
  ccuAuth: { enabled: false, username: '', password: '' },
  eventServer: { host: '0.0.0.0', port: 9875, watchdogSeconds: 300 },
  channels: [],
  variables: [],
  programs: [],
});

const state = {
  view: 'dashboard',
  /** Optional drill-down sub-view (replaces base view body until popped). */
  nav: [],
  blocks: [DEFAULT_BLOCK()],
  otherBlocks: [],
  discovered: { devices: [], variables: [], programs: [], rooms: [] },
  services: { channelServices: [], variableServices: [] },
  ui: {
    search:        { channels: '',           variables: '',           programs: '',           picker: '' },
    filter:        { channels: 'configured', variables: 'configured', programs: 'configured' }, // configured | all | unconfigured
    filterType:    { channels: 'all' },                                                          // CCU channel type, e.g. SWITCH_VIRTUAL_RECEIVER, or 'all'
    filterBridge:  { channels: 'all',        variables: 'all',        programs: 'all' },         // bridge index as string, or 'all'
    sort:          { channels: 'name',       variables: 'name',       programs: 'name' },        // name | address | type | bridge
    page:          { channels: 1,            variables: 1,            programs: 1,            picker: 1 },
  },
  pluginVersion: 'unknown',
};

// ---------------------------------------------------------------- lookups

function channelLookup() {
  const out = new Map();
  for (const d of state.discovered.devices ?? []) {
    for (const c of d.channels ?? []) out.set(c.address, { device: d, channel: c });
  }
  return out;
}
function variableLookup() {
  const m = new Map();
  for (const v of state.discovered.variables ?? []) m.set(v.name, v);
  return m;
}
function programLookup() {
  const m = new Map();
  for (const p of state.discovered.programs ?? []) m.set(p.name, p);
  return m;
}
function allChannelsAcrossBridges() {
  return state.blocks.flatMap((b, bi) => (b.channels ?? []).map((c) => ({ ...c, bridgeIndex: bi })));
}
function allVariablesAcrossBridges() {
  return state.blocks.flatMap((b, bi) => (b.variables ?? []).map((v) => ({ ...v, bridgeIndex: bi })));
}
function allProgramsAcrossBridges() {
  return state.blocks.flatMap((b, bi) => (b.programs ?? []).map((p) => ({ ...p, bridgeIndex: bi })));
}
function totalCount(kind) {
  return state.blocks.reduce((acc, b) => acc + (b[kind]?.length ?? 0), 0);
}

// ---------------------------------------------------------------- nav stack

function navigate(view) {
  state.view = view;
  state.nav = [];
  $('hgui-view-select').value = view;
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
  dashboard: viewDashboard,
  channels:  viewChannels,
  variables: viewVariables,
  programs:  viewPrograms,
  bridges:   viewBridges,
  import:    viewImport,
  settings:  viewSettings,
};

// ---------------------------------------------------------------- dashboard

function viewDashboard(host) {
  const card = (label, value, sub = '') => `
    <div class="col-sm-6 col-md-3 d-flex">
      <div class="hgui-card flex-fill">
        <div class="hgui-meta">${h(label)}</div>
        <div class="display-6">${h(value)}</div>
        <div class="hgui-meta">${h(sub)}</div>
      </div>
    </div>`;
  const discoveryStatus = state.discovered.devices.length
    ? `${state.discovered.devices.length} devices · ${state.discovered.variables.length} variables · ${state.discovered.programs.length} programs · ${state.discovered.rooms.length} rooms`
    : 'No discovery data yet — click "Discover" in the header to load from the CCU.';
  host.innerHTML = `
    <h4 class="my-3">Dashboard</h4>
    <div class="row g-3 mb-3">
      ${card('Channels',  totalCount('channels'),  'across all bridges')}
      ${card('Variables', totalCount('variables'), '')}
      ${card('Programs',  totalCount('programs'),  '')}
      ${card('Bridges',   state.blocks.length,     'main + child bridges')}
    </div>
    <div class="hgui-card">
      <h6>Discovery</h6>
      <p class="hgui-meta mb-0">${h(discoveryStatus)}</p>
    </div>
    <div class="hgui-card">
      <h6>Quick links</h6>
      <div class="d-flex gap-2 flex-wrap">
        <button class="btn btn-outline-primary btn-sm" data-go="channels">Manage channels →</button>
        <button class="btn btn-outline-primary btn-sm" data-go="variables">Manage variables →</button>
        <button class="btn btn-outline-primary btn-sm" data-go="bridges">Manage bridges →</button>
        <button class="btn btn-outline-secondary btn-sm" data-go="import">Import from hap-homematic →</button>
        <button class="btn btn-outline-secondary btn-sm" data-go="settings">Settings →</button>
      </div>
    </div>
  `;
  host.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.go)));
}

// ---------------------------------------------------------------- channels view

function viewChannels(host) {
  // Build the persistent toolbar + an empty rows host. Crucially we
  // attach event handlers ONCE here. Subsequent state changes only
  // call drawChannelRows(), which mutates the rows host — so the
  // search input never gets recreated, never loses focus.
  // Build the per-tab type/bridge filter option lists. Channel types
  // are taken from the discovered device tree so the dropdown reflects
  // what's actually on this CCU (not a static list); bridges from the
  // current state.blocks so child bridges added later show up.
  const channelTypes = new Set();
  for (const d of state.discovered.devices) for (const c of d.channels) if (c.type) channelTypes.add(c.type);

  host.innerHTML = `
    <h4 class="my-3">Channels</h4>
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
      <select class="form-select" id="hgui-filterBridge-channels" title="Filter by bridge">
        <option value="all">All bridges</option>
        ${state.blocks.map((b, bi) => `<option value="${bi}">${h(b.name)}${bi === 0 ? ' (main)' : ''}</option>`).join('')}
      </select>
      <select class="form-select" id="hgui-sort-channels" title="Sort by">
        <option value="name">Sort: HomeKit name</option>
        <option value="device">Sort: Device name</option>
        <option value="address">Sort: Address</option>
        <option value="type">Sort: Channel type</option>
        <option value="bridge">Sort: Bridge</option>
      </select>
      <button class="btn btn-primary ms-auto" id="hgui-add-channel">+ Add channel</button>
      <span class="hgui-meta" id="hgui-channels-count"></span>
    </div>
    <div id="hgui-rows-host"></div>
    <div id="hgui-pager-host"></div>
  `;
  $('hgui-filter-channels').value       = state.ui.filter.channels;
  $('hgui-filterType-channels').value   = channelTypes.has(state.ui.filterType.channels) ? state.ui.filterType.channels : 'all';
  $('hgui-filterBridge-channels').value = state.ui.filterBridge.channels;
  $('hgui-sort-channels').value         = state.ui.sort.channels;

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
  $('hgui-filterBridge-channels').addEventListener('change', (e) => {
    state.ui.filterBridge.channels = e.target.value;
    state.ui.page.channels = 1;
    drawChannelRows();
  });
  $('hgui-sort-channels').addEventListener('change', (e) => {
    state.ui.sort.channels = e.target.value;
    drawChannelRows();
  });
  $('hgui-add-channel').addEventListener('click', () => {
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
  const configured = allChannelsAcrossBridges();
  const configuredByAddr = new Map(configured.map((c) => [c.address, c]));

  // Build candidate set based on filter mode.
  let rows;
  const filter = state.ui.filter.channels;
  if (filter === 'configured') {
    rows = configured.map((c) => ({ ...c, _info: cl.get(c.address), isConfigured: true }));
  } else {
    // 'all' or 'unconfigured' both need discovered data.
    rows = [];
    for (const d of state.discovered.devices) {
      for (const c of d.channels) {
        const existing = configuredByAddr.get(c.address);
        const isConfigured = !!existing;
        if (filter === 'unconfigured' && isConfigured) continue;
        rows.push({
          address: c.address,
          name: existing?.name ?? c.name,
          service: existing?.service,
          subtype: existing?.subtype,
          settings: existing?.settings,
          bridgeIndex: existing?.bridgeIndex,
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
  // Bridge filter.
  const fbridge = state.ui.filterBridge.channels;
  if (fbridge && fbridge !== 'all') {
    const bi = parseInt(fbridge, 10);
    rows = rows.filter((r) => r.bridgeIndex === bi);
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
      case 'bridge':  return String(r.bridgeIndex ?? 999);
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
  // Newest imports put the chosen name on `r.name`. Backups taken
  // before v0.1.5 stashed it under `settings.name` — read that as a
  // fallback before falling back to the CCU's channel name and the
  // address. The platform applies the same precedence at runtime.
  if (typeof r.name === 'string' && r.name.length) return r.name;
  if (typeof r.settings?.name === 'string' && r.settings.name.length) return r.settings.name;
  return r._info?.channel?.name || r.address;
}

function channelTileHTML(r) {
  const info = r._info;
  const inHK = r.isConfigured ?? r.service !== undefined;
  const bridgeName = r.bridgeIndex !== undefined ? state.blocks[r.bridgeIndex]?.name : null;
  const hkName = effectiveHkName(r);
  // Subtitle: prefer device name/type from discovery; if discovery
  // hasn't run, show a hint so the user knows to click Discover for
  // the rich data. The address always shows in the meta line.
  const subtitle = info?.device
    ? `${h(info.device.name ?? '')}${info.device.type ? ` · ${h(info.device.type)}` : ''}${info.channel?.name && info.channel.name !== hkName ? ` · ch ${h(info.channel.name)}` : ''}`
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
      <div class="hgui-tile-pills">
        ${inHK ? `<span class="hgui-pill primary">${h(r.service ?? '?')}</span>` : '<span class="hgui-pill muted">not in HomeKit</span>'}
        ${r.subtype ? `<span class="hgui-pill">${h(r.subtype)}</span>` : ''}
        ${bridgeName ? `<span class="hgui-pill">on ${h(bridgeName)}</span>` : ''}
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

// ---------------------------------------------------------------- variables view

function viewVariables(host) {
  host.innerHTML = `
    <h4 class="my-3">Variables</h4>
    <div class="hgui-toolbar">
      <input type="search" class="form-control" id="hgui-search-variables"
             placeholder="Search variables…" value="${h(state.ui.search.variables)}" />
      <select class="form-select" id="hgui-filter-variables">
        <option value="configured">Configured</option>
        <option value="all">All discovered</option>
        <option value="unconfigured">Not in HomeKit</option>
      </select>
      <select class="form-select" id="hgui-filterBridge-variables" title="Filter by bridge">
        <option value="all">All bridges</option>
        ${state.blocks.map((b, bi) => `<option value="${bi}">${h(b.name)}${bi === 0 ? ' (main)' : ''}</option>`).join('')}
      </select>
      <select class="form-select" id="hgui-sort-variables">
        <option value="name">Sort: HomeKit name</option>
        <option value="ccuname">Sort: CCU name</option>
        <option value="bridge">Sort: Bridge</option>
      </select>
      <button class="btn btn-primary ms-auto" id="hgui-add-variable">+ Add variable</button>
      <span class="hgui-meta" id="hgui-variables-count"></span>
    </div>
    <div id="hgui-rows-host"></div>
    <div id="hgui-pager-host"></div>
  `;
  $('hgui-filter-variables').value       = state.ui.filter.variables;
  $('hgui-filterBridge-variables').value = state.ui.filterBridge.variables;
  $('hgui-sort-variables').value         = state.ui.sort.variables;
  $('hgui-search-variables').addEventListener('input', (e) => { state.ui.search.variables = e.target.value; state.ui.page.variables = 1; drawVariableRows(); });
  $('hgui-filter-variables').addEventListener('change', (e) => { state.ui.filter.variables = e.target.value; state.ui.page.variables = 1; drawVariableRows(); });
  $('hgui-filterBridge-variables').addEventListener('change', (e) => { state.ui.filterBridge.variables = e.target.value; state.ui.page.variables = 1; drawVariableRows(); });
  $('hgui-sort-variables').addEventListener('change', (e) => { state.ui.sort.variables = e.target.value; drawVariableRows(); });
  $('hgui-add-variable').addEventListener('click', () => {
    if (!state.discovered.variables.length) { toast('warning', 'Run "Discover" first', 'Add variable'); return; }
    pushNav({ kind: 'pickVariable' });
  });
  drawVariableRows();
}

function drawVariableRows() {
  const host = $('hgui-rows-host');
  const pagerHost = $('hgui-pager-host');
  if (!host) return;
  const vl = variableLookup();
  const configured = allVariablesAcrossBridges();
  const configuredByName = new Map(configured.map((v) => [v.name, v]));
  let rows;
  const filter = state.ui.filter.variables;
  if (filter === 'configured') {
    rows = configured.map((v) => ({ ...v, _info: vl.get(v.name), isConfigured: true }));
  } else {
    rows = state.discovered.variables.map((v) => {
      const existing = configuredByName.get(v.name);
      return { name: v.name, displayName: existing?.displayName, bridgeIndex: existing?.bridgeIndex, isConfigured: !!existing, _info: v };
    });
    if (filter === 'unconfigured') rows = rows.filter((r) => !r.isConfigured);
  }
  const fbridge = state.ui.filterBridge.variables;
  if (fbridge && fbridge !== 'all') {
    const bi = parseInt(fbridge, 10);
    rows = rows.filter((r) => r.bridgeIndex === bi);
  }
  const q = state.ui.search.variables.trim().toLowerCase();
  if (q) rows = rows.filter((r) => (r.name + ' ' + (r.displayName ?? '')).toLowerCase().includes(q));
  const sortKey = state.ui.sort.variables;
  rows = sortBy(rows, (r) => {
    switch (sortKey) {
      case 'ccuname': return r.name.toLowerCase();
      case 'bridge':  return String(r.bridgeIndex ?? 999);
      default:        return (r.displayName ?? r.name).toLowerCase();
    }
  });
  $('hgui-variables-count').textContent = `${rows.length} entries`;

  let page = state.ui.page.variables;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pageCount) page = state.ui.page.variables = 1;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (rows.length === 0) {
    host.innerHTML = '<div class="hgui-empty">No variables match.</div>';
    pagerHost.innerHTML = '';
    return;
  }
  host.innerHTML = `<div class="hgui-tiles">${slice.map(variableTileHTML).join('')}</div>`;
  pagerHost.innerHTML = pagerHTML('variables', page, pageCount);
  host.querySelectorAll('[data-edit-variable]').forEach((b) =>
    b.addEventListener('click', () => pushNav({ kind: 'editVariable', props: { name: b.dataset.editVariable, mode: 'edit' } })));
  host.querySelectorAll('[data-add-variable-from]').forEach((b) =>
    b.addEventListener('click', () => pushNav({ kind: 'editVariable', props: { name: b.dataset.addVariableFrom, mode: 'add' } })));
  pagerHost.querySelectorAll('[data-pager]').forEach((b) =>
    b.addEventListener('click', () => { state.ui.page.variables = parseInt(b.dataset.pager, 10); drawVariableRows(); }));
}

function variableTileHTML(r) {
  const info = r._info;
  const inHK = r.isConfigured ?? true;
  const bridgeName = r.bridgeIndex !== undefined ? state.blocks[r.bridgeIndex]?.name : null;
  return `
    <div class="hgui-tile ${inHK ? '' : 'muted'}">
      <div class="hgui-tile-head">
        <div class="hgui-tile-name">${h(r.displayName ?? r.name)}</div>
        <div class="hgui-tile-actions">
          ${inHK
            ? `<button class="btn btn-sm btn-outline-primary" data-edit-variable="${h(r.name)}">Edit</button>`
            : `<button class="btn btn-sm btn-primary" data-add-variable-from="${h(r.name)}">+ Add</button>`}
        </div>
      </div>
      <div class="hgui-tile-sub">CCU variable</div>
      <div class="hgui-tile-meta"><code>${h(r.name)}</code>${info ? ` · valuetype ${h(info.valuetype)}${info.unit ? ` (${h(info.unit)})` : ''} · current: ${h(String(info.value ?? '?'))}` : ''}</div>
      <div class="hgui-tile-pills">
        ${inHK ? '<span class="hgui-pill success">in HomeKit</span>' : '<span class="hgui-pill muted">not in HomeKit</span>'}
        ${bridgeName ? `<span class="hgui-pill">on ${h(bridgeName)}</span>` : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- programs view

function viewPrograms(host) {
  host.innerHTML = `
    <h4 class="my-3">Programs</h4>
    <div class="hgui-toolbar">
      <input type="search" class="form-control" id="hgui-search-programs"
             placeholder="Search programs…" value="${h(state.ui.search.programs)}" />
      <select class="form-select" id="hgui-filter-programs">
        <option value="configured">Configured</option>
        <option value="all">All discovered</option>
        <option value="unconfigured">Not in HomeKit</option>
      </select>
      <select class="form-select" id="hgui-filterBridge-programs" title="Filter by bridge">
        <option value="all">All bridges</option>
        ${state.blocks.map((b, bi) => `<option value="${bi}">${h(b.name)}${bi === 0 ? ' (main)' : ''}</option>`).join('')}
      </select>
      <select class="form-select" id="hgui-sort-programs">
        <option value="name">Sort: HomeKit name</option>
        <option value="ccuname">Sort: CCU name</option>
        <option value="bridge">Sort: Bridge</option>
      </select>
      <button class="btn btn-primary ms-auto" id="hgui-add-program">+ Add program</button>
      <span class="hgui-meta" id="hgui-programs-count"></span>
    </div>
    <div id="hgui-rows-host"></div>
    <div id="hgui-pager-host"></div>
  `;
  $('hgui-filter-programs').value       = state.ui.filter.programs;
  $('hgui-filterBridge-programs').value = state.ui.filterBridge.programs;
  $('hgui-sort-programs').value         = state.ui.sort.programs;
  $('hgui-search-programs').addEventListener('input', (e) => { state.ui.search.programs = e.target.value; state.ui.page.programs = 1; drawProgramRows(); });
  $('hgui-filter-programs').addEventListener('change', (e) => { state.ui.filter.programs = e.target.value; state.ui.page.programs = 1; drawProgramRows(); });
  $('hgui-filterBridge-programs').addEventListener('change', (e) => { state.ui.filterBridge.programs = e.target.value; state.ui.page.programs = 1; drawProgramRows(); });
  $('hgui-sort-programs').addEventListener('change', (e) => { state.ui.sort.programs = e.target.value; drawProgramRows(); });
  $('hgui-add-program').addEventListener('click', () => {
    if (!state.discovered.programs.length) { toast('warning', 'Run "Discover" first', 'Add program'); return; }
    pushNav({ kind: 'pickProgram' });
  });
  drawProgramRows();
}

function drawProgramRows() {
  const host = $('hgui-rows-host');
  const pagerHost = $('hgui-pager-host');
  if (!host) return;
  const pl = programLookup();
  const configured = allProgramsAcrossBridges();
  const configuredByName = new Map(configured.map((p) => [p.name, p]));
  let rows;
  const filter = state.ui.filter.programs;
  if (filter === 'configured') {
    rows = configured.map((p) => ({ ...p, _info: pl.get(p.name), isConfigured: true }));
  } else {
    rows = state.discovered.programs.map((p) => {
      const existing = configuredByName.get(p.name);
      return { name: p.name, displayName: existing?.displayName, bridgeIndex: existing?.bridgeIndex, isConfigured: !!existing, _info: p };
    });
    if (filter === 'unconfigured') rows = rows.filter((r) => !r.isConfigured);
  }
  const fbridge = state.ui.filterBridge.programs;
  if (fbridge && fbridge !== 'all') {
    const bi = parseInt(fbridge, 10);
    rows = rows.filter((r) => r.bridgeIndex === bi);
  }
  const q = state.ui.search.programs.trim().toLowerCase();
  if (q) rows = rows.filter((r) => (r.name + ' ' + (r.displayName ?? '')).toLowerCase().includes(q));
  const sortKey = state.ui.sort.programs;
  rows = sortBy(rows, (r) => {
    switch (sortKey) {
      case 'ccuname': return r.name.toLowerCase();
      case 'bridge':  return String(r.bridgeIndex ?? 999);
      default:        return (r.displayName ?? r.name).toLowerCase();
    }
  });
  $('hgui-programs-count').textContent = `${rows.length} entries`;

  let page = state.ui.page.programs;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pageCount) page = state.ui.page.programs = 1;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (rows.length === 0) {
    host.innerHTML = '<div class="hgui-empty">No programs match.</div>';
    pagerHost.innerHTML = '';
    return;
  }
  host.innerHTML = `<div class="hgui-tiles">${slice.map(programTileHTML).join('')}</div>`;
  pagerHost.innerHTML = pagerHTML('programs', page, pageCount);
  host.querySelectorAll('[data-edit-program]').forEach((b) =>
    b.addEventListener('click', () => pushNav({ kind: 'editProgram', props: { name: b.dataset.editProgram, mode: 'edit' } })));
  host.querySelectorAll('[data-add-program-from]').forEach((b) =>
    b.addEventListener('click', () => pushNav({ kind: 'editProgram', props: { name: b.dataset.addProgramFrom, mode: 'add' } })));
  pagerHost.querySelectorAll('[data-pager]').forEach((b) =>
    b.addEventListener('click', () => { state.ui.page.programs = parseInt(b.dataset.pager, 10); drawProgramRows(); }));
}

function programTileHTML(r) {
  const inHK = r.isConfigured ?? true;
  const bridgeName = r.bridgeIndex !== undefined ? state.blocks[r.bridgeIndex]?.name : null;
  return `
    <div class="hgui-tile ${inHK ? '' : 'muted'}">
      <div class="hgui-tile-head">
        <div class="hgui-tile-name">${h(r.displayName ?? r.name)}</div>
        <div class="hgui-tile-actions">
          ${inHK
            ? `<button class="btn btn-sm btn-outline-primary" data-edit-program="${h(r.name)}">Edit</button>`
            : `<button class="btn btn-sm btn-primary" data-add-program-from="${h(r.name)}">+ Add</button>`}
        </div>
      </div>
      <div class="hgui-tile-sub">CCU program</div>
      <div class="hgui-tile-meta"><code>${h(r.name)}</code></div>
      <div class="hgui-tile-pills">
        ${inHK ? '<span class="hgui-pill success">in HomeKit</span>' : '<span class="hgui-pill muted">not in HomeKit</span>'}
        ${bridgeName ? `<span class="hgui-pill">on ${h(bridgeName)}</span>` : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- bridges view

function viewBridges(host) {
  host.innerHTML = `
    <h4 class="my-3">Bridges</h4>
    <div class="hgui-toolbar">
      <button class="btn btn-primary ms-auto" id="hgui-add-bridge">+ Add child bridge</button>
    </div>
    <div class="hgui-tiles" id="hgui-bridges-host"></div>
  `;
  $('hgui-add-bridge').addEventListener('click', addChildBridge);
  drawBridges();
}

function drawBridges() {
  const host = $('hgui-bridges-host');
  if (!host) return;
  host.innerHTML = state.blocks.map(bridgeTileHTML).join('');
  host.querySelectorAll('[data-rename-bridge]').forEach((b) =>
    b.addEventListener('click', () => pushNav({ kind: 'editBridge', props: { bridgeIndex: parseInt(b.dataset.renameBridge, 10) } })));
  host.querySelectorAll('[data-remove-bridge]').forEach((b) =>
    b.addEventListener('click', () => pushNav({ kind: 'removeBridge', props: { bridgeIndex: parseInt(b.dataset.removeBridge, 10) } })));
  host.querySelectorAll('[data-regen-bridge]').forEach((b) =>
    b.addEventListener('click', () => regenerateBridgeIdentity(parseInt(b.dataset.regenBridge, 10))));
}

function bridgeTileHTML(b, bi) {
  const isMain = bi === 0;
  // Bridge tiles have up to three action buttons; we put them on
  // their own row below the body so they don't shrink the name column
  // or push the pills row down at narrow widths.
  return `
    <div class="hgui-tile hgui-bridge-tile">
      <div class="hgui-tile-name">${h(b.name)}</div>
      <div class="hgui-tile-sub">${(b.channels ?? []).length} channels · ${(b.variables ?? []).length} vars · ${(b.programs ?? []).length} progs</div>
      <div class="hgui-tile-meta">${b._bridge ? `username <code>${h(b._bridge.username)}</code> · port <code>${h(b._bridge.port)}</code>` : '— uses main bridge identity —'}</div>
      <div class="hgui-tile-pills">
        ${isMain ? '<span class="hgui-pill primary">main</span>' : '<span class="hgui-pill">child</span>'}
      </div>
      <div class="hgui-bridge-buttons">
        <button class="btn btn-sm btn-outline-primary" data-rename-bridge="${bi}">Rename</button>
        ${!isMain ? `<button class="btn btn-sm btn-outline-secondary" data-regen-bridge="${bi}">Regen identity</button>` : ''}
        ${!isMain ? `<button class="btn btn-sm btn-outline-danger" data-remove-bridge="${bi}">Remove</button>` : ''}
      </div>
    </div>`;
}

function addChildBridge() {
  const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const main = state.blocks[0];
  state.blocks.push({
    ...DEFAULT_BLOCK(),
    name: `HapHomematic (${state.blocks.length})`,
    _bridge: { username: identityUsername(seed), port: identityPort(seed) },
    ccuIp: main.ccuIp, useTls: main.useTls,
    interfaces: { ...main.interfaces }, interfacePorts: { ...main.interfacePorts },
    ccuAuth: { ...main.ccuAuth }, eventServer: { ...main.eventServer },
  });
  pushConfig();
  toast('success', 'Added child bridge', 'Bridges');
  rerender();
}
function regenerateBridgeIdentity(bi) {
  const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  state.blocks[bi]._bridge = { username: identityUsername(seed), port: identityPort(seed) };
  pushConfig();
  rerender();
  toast('warning', 'Identity regenerated — accessories on this bridge need to be re-paired in HomeKit', 'Bridges');
}
function identityUsername(seed) {
  const hash = Array.from(seed).reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0xC0FFEE);
  return new Array(6).fill(0).map((_, i) => ((hash >> (i * 4)) & 0xFF).toString(16).padStart(2, '0').toUpperCase()).join(':');
}
function identityPort(seed) {
  const hash = Array.from(seed).reduce((a, c) => (a * 131 + c.charCodeAt(0)) | 0, 0xCAFE);
  return 30000 + (Math.abs(hash) % 5000);
}

// ---------------------------------------------------------------- import view

function viewImport(host) {
  host.innerHTML = `
    <h4 class="my-3">Import from hap-homematic</h4>
    <p class="hgui-meta">Upload a hap-homematic <strong>backup tarball</strong> (.tar.gz) or paste a raw
       <code>config.json</code>. Existing accessories are kept; imported entries are merged on top.</p>
    <div class="hgui-card">
      <div class="row g-2">
        <div class="col-md-6">
          <label class="form-label">Backup tarball</label>
          <input type="file" id="hgui-import-file" class="form-control" accept=".tar.gz,.tgz,application/gzip" />
        </div>
        <div class="col-md-6">
          <label class="form-label">…or paste config.json</label>
          <textarea id="hgui-import-paste" class="form-control font-monospace" rows="3"
                    placeholder='{ "ccuIP": "192.168.1.10", ... }'></textarea>
        </div>
      </div>
      <div class="form-check mt-3">
        <input class="form-check-input" type="checkbox" id="hgui-import-multibridge" />
        <label class="form-check-label" for="hgui-import-multibridge">
          <strong>One Homebridge child bridge per hap-homematic instance</strong>
          <small class="d-block hgui-meta">Replicates the per-room bridge model from hap-homematic.</small>
        </label>
      </div>
      <div class="mt-3">
        <button id="hgui-import-btn" class="btn btn-warning">Import</button>
        <span id="hgui-import-status" class="ms-2"></span>
      </div>
      <div id="hgui-import-warnings" class="mt-3"></div>
      <div id="hgui-bridges-summary" class="mt-3"></div>
    </div>
  `;
  $('hgui-import-btn').addEventListener('click', onImport);
}

// ---------------------------------------------------------------- settings view

function viewSettings(host) {
  const m = state.blocks[0];
  host.innerHTML = `
    <h4 class="my-3">Settings</h4>
    <div class="hgui-card">
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
            <label class="form-check-label" for="cf-tls">Use TLS</label>
          </div>
        </div>
      </div>
    </div>
    <div class="hgui-card">
      <h6>CCU authentication</h6>
      <div class="row g-2">
        <div class="col-md-3 d-flex align-items-end">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="cf-auth-enabled" ${m.ccuAuth.enabled ? 'checked' : ''} />
            <label class="form-check-label" for="cf-auth-enabled">Use CCU auth</label>
          </div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Username</label>
          <input class="form-control" id="cf-auth-user" value="${h(m.ccuAuth.username || '')}" />
        </div>
        <div class="col-md-5">
          <label class="form-label">Password</label>
          <input class="form-control" type="password" id="cf-auth-pass" value="${h(m.ccuAuth.password || '')}" />
        </div>
      </div>
    </div>
    <div class="hgui-card">
      <h6>Interfaces</h6>
      <div class="row g-2">
        ${[['bidcosRf','BidCos-RF'],['hmIpRf','HmIP-RF'],['bidcosWired','BidCos-Wired'],['virtualDevices','VirtualDevices'],['cuxd','CUxD']]
          .map(([k,label]) => `
            <div class="col-md-3 form-check">
              <input class="form-check-input" type="checkbox" id="cf-if-${k}" ${m.interfaces[k] ? 'checked' : ''} />
              <label class="form-check-label" for="cf-if-${k}">${h(label)}</label>
            </div>`).join('')}
      </div>
    </div>
    <div class="hgui-card">
      <h6>XML-RPC port overrides</h6>
      <p class="hgui-meta">Leave blank to auto-discover ports via <code>Interface.listInterfaces</code>.
         Set explicitly only when the auto-discovered port is not reachable from this host (e.g. blocked by the CCU's firewall).
         RaspberryMatic external defaults: <code>32001 / 32010 / 39292</code>; legacy localhost defaults: <code>2001 / 2010 / 9292</code>.</p>
      <div class="row g-2">
        ${[['BidCos-RF','32001'],['HmIP-RF','32010'],['BidCos-Wired','32000'],['VirtualDevices','39292'],['CUxD','8701']]
          .map(([k,ph]) => `
            <div class="col-md-3">
              <label class="form-label">${h(k)}</label>
              <input class="form-control" type="number" id="cf-port-${h(k)}" placeholder="${ph}" value="${h(m.interfacePorts?.[k] ?? '')}" />
            </div>`).join('')}
      </div>
    </div>
  `;
  const propagate = (mut) => { state.blocks.forEach(mut); pushConfig(); };
  $('cf-ccu-ip').addEventListener('input', (e) => propagate((b) => b.ccuIp = e.target.value.trim()));
  $('cf-event-port').addEventListener('input', (e) => propagate((b) => b.eventServer.port = parseInt(e.target.value, 10) || 9875));
  $('cf-tls').addEventListener('change', (e) => propagate((b) => b.useTls = e.target.checked));
  $('cf-auth-enabled').addEventListener('change', (e) => propagate((b) => b.ccuAuth.enabled = e.target.checked));
  $('cf-auth-user').addEventListener('input', (e) => propagate((b) => b.ccuAuth.username = e.target.value));
  $('cf-auth-pass').addEventListener('input', (e) => propagate((b) => b.ccuAuth.password = e.target.value));
  for (const k of ['bidcosRf','hmIpRf','bidcosWired','virtualDevices','cuxd']) {
    $(`cf-if-${k}`).addEventListener('change', (e) => propagate((b) => b.interfaces[k] = e.target.checked));
  }
  for (const k of ['BidCos-RF','HmIP-RF','BidCos-Wired','VirtualDevices','CUxD']) {
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
  pickVariable: subPickVariable,
  editVariable: subEditVariable,
  pickProgram:  subPickProgram,
  editProgram:  subEditProgram,
  editBridge:   subEditBridge,
  removeBridge: subRemoveBridge,
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
  subviewHeader(host, 'Add channel — pick from CCU');
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
  const configuredByAddr = new Map(allChannelsAcrossBridges().map((c) => [c.address, c]));
  const all = [];
  for (const d of state.discovered.devices) {
    for (const c of d.channels) all.push({ device: d, channel: c });
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

  let bridgeIndex = 0;
  let entry = null;
  for (let bi = 0; bi < state.blocks.length; bi++) {
    const found = state.blocks[bi].channels.find((c) => c.address === address);
    if (found) { bridgeIndex = bi; entry = found; break; }
  }

  const candidates = info?.channel
    ? state.services.channelServices.filter((s) => s.channelTypes.includes(info.channel.type))
    : state.services.channelServices;
  const draft = entry
    ? {
        ...entry,
        // Pre-v0.1.5 hap-homematic imports kept the user-chosen name in
        // settings.name. Lift it to top-level `name` so the form is
        // pre-filled and so saving normalises the entry.
        name: effectiveHkName({ ...entry, _info: info }),
      }
    : {
        address,
        name: info?.channel?.name ?? address,
        service: candidates[0]?.key ?? state.services.channelServices[0]?.key ?? 'SwitchAccessory',
        subtype: candidates[0]?.variants?.[0]?.id,
      };
  let target = bridgeIndex;

  subviewHeader(host, mode === 'add' ? 'Add channel' : `Edit: ${draft.name || address}`, address);
  const body = $('hgui-sub-body');
  const draw = () => {
    const def = state.services.channelServices.find((s) => s.key === draft.service);
    const variants = def?.variants ?? [];
    body.innerHTML = `
      <div class="hgui-card">
        <div class="hgui-meta mb-2">
          <code>${h(address)}</code>${info?.channel?.type ? ` · ${h(info.channel.type)}` : ''}${info?.device?.name ? ` · ${h(info.device.name)}` : ''}
        </div>
        <div class="hgui-form-row">
          <label>HomeKit name</label>
          <div>
            <input class="form-control" id="ec-name" value="${h(draft.name ?? '')}" />
            <div class="hgui-hint">Shown in the Home app. Already-paired bridges keep their original pairing name in HomeKit — that's a HomeKit limitation we can't override; rename in the Home app too.</div>
          </div>
        </div>
        <div class="hgui-form-row">
          <label>Service</label>
          <div>
            <select class="form-select" id="ec-service">
              ${(candidates.length ? candidates : state.services.channelServices).map((s) =>
                `<option value="${h(s.key)}" ${s.key === draft.service ? 'selected' : ''}>${h(s.description)} (${h(s.key)})</option>`).join('')}
            </select>
            <div class="hgui-hint">${candidates.length ? 'Filtered to services that support this channel type.' : 'No service explicitly supports this channel type — pick the closest match or leave the default.'}</div>
          </div>
        </div>
        ${variants.length ? `
          <div class="hgui-form-row">
            <label>Variant</label>
            <div>
              <select class="form-select" id="ec-subtype">
                ${variants.map((v) => `<option value="${h(v.id)}" ${v.id === draft.subtype ? 'selected' : ''}>${h(v.label)}</option>`).join('')}
              </select>
              <div class="hgui-hint">Some services support multiple HomeKit shapes — pick the one that fits.</div>
            </div>
          </div>` : ''}
        <div class="hgui-form-row">
          <label>Bridge</label>
          <div>
            <select class="form-select" id="ec-bridge">
              ${state.blocks.map((b, bi) => `<option value="${bi}" ${bi === target ? 'selected' : ''}>${h(b.name)}${bi === 0 ? ' (main)' : ''}</option>`).join('')}
            </select>
            <div class="hgui-hint">Which Homebridge bridge this accessory lives on. Moving an accessory between bridges re-pairs it in HomeKit.</div>
          </div>
        </div>
      </div>
    `;
    body.querySelector('#ec-name').addEventListener('input', (e) => { draft.name = e.target.value; });
    body.querySelector('#ec-service').addEventListener('change', (e) => {
      draft.service = e.target.value;
      const newDef = state.services.channelServices.find((s) => s.key === draft.service);
      draft.subtype = newDef?.variants?.[0]?.id;
      draw();
    });
    if (variants.length) {
      body.querySelector('#ec-subtype').addEventListener('change', (e) => { draft.subtype = e.target.value; });
    }
    body.querySelector('#ec-bridge').addEventListener('change', (e) => { target = parseInt(e.target.value, 10); });
  };
  draw();

  const footer = $('hgui-sub-footer');
  footer.innerHTML = `
    ${mode === 'edit' ? '<button class="btn btn-outline-danger" id="ec-remove">Remove from HomeKit</button>' : ''}
    <button class="btn btn-secondary ms-auto" id="ec-cancel">Cancel</button>
    <button class="btn btn-primary" id="ec-save">${mode === 'add' ? 'Add' : 'Save'}</button>
  `;
  footer.querySelector('#ec-cancel').addEventListener('click', popNav);
  footer.querySelector('#ec-save').addEventListener('click', () => {
    const name = (draft.name ?? '').trim();
    if (!name) { toast('warning', 'HomeKit name cannot be empty'); return; }
    for (const b of state.blocks) {
      const i = b.channels.findIndex((c) => c.address === address);
      if (i !== -1) b.channels.splice(i, 1);
    }
    state.blocks[target].channels.push({
      address, name, service: draft.service,
      ...(draft.subtype ? { subtype: draft.subtype } : {}),
      ...(draft.settings ? { settings: draft.settings } : {}),
    });
    pushConfig();
    toast('success', mode === 'add' ? 'Channel added' : 'Channel updated', 'Channels');
    popNav();
  });
  if (mode === 'edit') {
    footer.querySelector('#ec-remove').addEventListener('click', () => {
      for (const b of state.blocks) {
        const i = b.channels.findIndex((c) => c.address === address);
        if (i !== -1) b.channels.splice(i, 1);
      }
      pushConfig();
      toast('success', 'Channel removed', 'Channels');
      popNav();
    });
  }
}

// --- pickVariable / editVariable

function subPickVariable(host) {
  subviewHeader(host, 'Add variable — pick from CCU');
  const body = $('hgui-sub-body');
  body.innerHTML = `
    <div class="hgui-toolbar">
      <input type="search" id="hgui-picker-search" class="form-control" placeholder="Search variables…"
             value="${h(state.ui.search.picker)}" autofocus />
      <span class="hgui-meta ms-auto" id="hgui-picker-count"></span>
    </div>
    <div id="hgui-picker-host"></div>
  `;
  $('hgui-picker-search').addEventListener('input', (e) => { state.ui.search.picker = e.target.value; drawVariablePicker(); });
  drawVariablePicker();
}
function drawVariablePicker() {
  const host = $('hgui-picker-host');
  const configured = new Set(state.blocks.flatMap((b) => b.variables.map((v) => v.name)));
  const q = state.ui.search.picker.trim().toLowerCase();
  let rows = state.discovered.variables;
  if (q) rows = rows.filter((v) => (v.name + ' ' + (v.unit ?? '')).toLowerCase().includes(q));
  rows = sortBy(rows, (v) => v.name.toLowerCase());
  $('hgui-picker-count').textContent = `${rows.length} candidates`;
  if (!rows.length) { host.innerHTML = '<div class="hgui-empty">No variables match.</div>'; return; }
  host.innerHTML = `<div class="hgui-tiles">${rows.map((v) => `
    <div class="hgui-tile ${configured.has(v.name) ? 'muted' : ''}">
      <div class="hgui-tile-head">
        <div class="hgui-tile-name">${h(v.name)}</div>
        <div class="hgui-tile-actions">
          ${configured.has(v.name)
            ? '<span class="hgui-pill warning">already added</span>'
            : `<button class="btn btn-sm btn-primary" data-pick-var="${h(v.name)}">Select</button>`}
        </div>
      </div>
      <div class="hgui-tile-sub">CCU variable</div>
      <div class="hgui-tile-meta">valuetype ${h(v.valuetype)}${v.unit ? ` (${h(v.unit)})` : ''} · current: ${h(String(v.value ?? '?'))}</div>
    </div>`).join('')}</div>`;
  host.querySelectorAll('[data-pick-var]').forEach((b) =>
    b.addEventListener('click', () => {
      state.nav.pop();
      state.nav.push({ kind: 'editVariable', props: { name: b.dataset.pickVar, mode: 'add' } });
      rerender();
    }));
}

function subEditVariable(host, props) {
  const { name, mode } = props;
  const info = variableLookup().get(name);
  let bridgeIndex = 0;
  let entry = null;
  for (let bi = 0; bi < state.blocks.length; bi++) {
    const found = state.blocks[bi].variables.find((v) => v.name === name);
    if (found) { bridgeIndex = bi; entry = found; break; }
  }
  const draft = entry ? { ...entry } : { name, displayName: info?.name ?? name };
  let target = bridgeIndex;

  subviewHeader(host, mode === 'add' ? 'Add variable' : `Edit variable: ${name}`, name);
  $('hgui-sub-body').innerHTML = `
    <div class="hgui-card">
      <div class="hgui-meta mb-2"><code>${h(name)}</code>${info ? ` · valuetype ${h(info.valuetype)}` : ''}</div>
      <div class="hgui-form-row">
        <label>HomeKit name</label>
        <div>
          <input class="form-control" id="ev-display" value="${h(draft.displayName ?? '')}" />
          <div class="hgui-hint">Defaults to the CCU variable name. Override to taste.</div>
        </div>
      </div>
      <div class="hgui-form-row">
        <label>Bridge</label>
        <div>
          <select class="form-select" id="ev-bridge">
            ${state.blocks.map((b, bi) => `<option value="${bi}" ${bi === target ? 'selected' : ''}>${h(b.name)}${bi === 0 ? ' (main)' : ''}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>
  `;
  $('ev-display').addEventListener('input', (e) => { draft.displayName = e.target.value; });
  $('ev-bridge').addEventListener('change', (e) => { target = parseInt(e.target.value, 10); });

  $('hgui-sub-footer').innerHTML = `
    ${mode === 'edit' ? '<button class="btn btn-outline-danger" id="ev-remove">Remove from HomeKit</button>' : ''}
    <button class="btn btn-secondary ms-auto" id="ev-cancel">Cancel</button>
    <button class="btn btn-primary" id="ev-save">${mode === 'add' ? 'Add' : 'Save'}</button>
  `;
  $('ev-cancel').addEventListener('click', popNav);
  $('ev-save').addEventListener('click', () => {
    for (const b of state.blocks) {
      const i = b.variables.findIndex((v) => v.name === name);
      if (i !== -1) b.variables.splice(i, 1);
    }
    state.blocks[target].variables.push({
      name,
      ...((draft.displayName ?? '').trim() ? { displayName: draft.displayName.trim() } : {}),
    });
    pushConfig();
    toast('success', mode === 'add' ? 'Variable added' : 'Variable updated', 'Variables');
    popNav();
  });
  if (mode === 'edit') {
    $('ev-remove').addEventListener('click', () => {
      for (const b of state.blocks) {
        const i = b.variables.findIndex((v) => v.name === name);
        if (i !== -1) b.variables.splice(i, 1);
      }
      pushConfig();
      toast('success', 'Variable removed', 'Variables');
      popNav();
    });
  }
}

// --- pickProgram / editProgram

function subPickProgram(host) {
  subviewHeader(host, 'Add program — pick from CCU');
  $('hgui-sub-body').innerHTML = `
    <div class="hgui-toolbar">
      <input type="search" id="hgui-picker-search" class="form-control" placeholder="Search programs…"
             value="${h(state.ui.search.picker)}" autofocus />
      <span class="hgui-meta ms-auto" id="hgui-picker-count"></span>
    </div>
    <div id="hgui-picker-host"></div>
  `;
  $('hgui-picker-search').addEventListener('input', (e) => { state.ui.search.picker = e.target.value; drawProgramPicker(); });
  drawProgramPicker();
}
function drawProgramPicker() {
  const host = $('hgui-picker-host');
  const configured = new Set(state.blocks.flatMap((b) => b.programs.map((p) => p.name)));
  const q = state.ui.search.picker.trim().toLowerCase();
  let rows = state.discovered.programs;
  if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));
  rows = sortBy(rows, (p) => p.name.toLowerCase());
  $('hgui-picker-count').textContent = `${rows.length} candidates`;
  if (!rows.length) { host.innerHTML = '<div class="hgui-empty">No programs match.</div>'; return; }
  host.innerHTML = `<div class="hgui-tiles">${rows.map((p) => `
    <div class="hgui-tile ${configured.has(p.name) ? 'muted' : ''}">
      <div class="hgui-tile-head">
        <div class="hgui-tile-name">${h(p.name)}</div>
        <div class="hgui-tile-actions">
          ${configured.has(p.name)
            ? '<span class="hgui-pill warning">already added</span>'
            : `<button class="btn btn-sm btn-primary" data-pick-prog="${h(p.name)}">Select</button>`}
        </div>
      </div>
      <div class="hgui-tile-sub">CCU program</div>
      <div class="hgui-tile-meta">${h(p.name)}</div>
    </div>`).join('')}</div>`;
  host.querySelectorAll('[data-pick-prog]').forEach((b) =>
    b.addEventListener('click', () => {
      state.nav.pop();
      state.nav.push({ kind: 'editProgram', props: { name: b.dataset.pickProg, mode: 'add' } });
      rerender();
    }));
}

function subEditProgram(host, props) {
  const { name, mode } = props;
  let bridgeIndex = 0;
  let entry = null;
  for (let bi = 0; bi < state.blocks.length; bi++) {
    const found = state.blocks[bi].programs.find((p) => p.name === name);
    if (found) { bridgeIndex = bi; entry = found; break; }
  }
  const draft = entry ? { ...entry } : { name, displayName: name };
  let target = bridgeIndex;

  subviewHeader(host, mode === 'add' ? 'Add program' : `Edit program: ${name}`, name);
  $('hgui-sub-body').innerHTML = `
    <div class="hgui-card">
      <div class="hgui-meta mb-2"><code>${h(name)}</code></div>
      <div class="hgui-form-row">
        <label>HomeKit name</label>
        <div><input class="form-control" id="ep-display" value="${h(draft.displayName ?? '')}" /></div>
      </div>
      <div class="hgui-form-row">
        <label>Bridge</label>
        <div>
          <select class="form-select" id="ep-bridge">
            ${state.blocks.map((b, bi) => `<option value="${bi}" ${bi === target ? 'selected' : ''}>${h(b.name)}${bi === 0 ? ' (main)' : ''}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>
  `;
  $('ep-display').addEventListener('input', (e) => { draft.displayName = e.target.value; });
  $('ep-bridge').addEventListener('change', (e) => { target = parseInt(e.target.value, 10); });
  $('hgui-sub-footer').innerHTML = `
    ${mode === 'edit' ? '<button class="btn btn-outline-danger" id="ep-remove">Remove from HomeKit</button>' : ''}
    <button class="btn btn-secondary ms-auto" id="ep-cancel">Cancel</button>
    <button class="btn btn-primary" id="ep-save">${mode === 'add' ? 'Add' : 'Save'}</button>
  `;
  $('ep-cancel').addEventListener('click', popNav);
  $('ep-save').addEventListener('click', () => {
    for (const b of state.blocks) {
      const i = b.programs.findIndex((p) => p.name === name);
      if (i !== -1) b.programs.splice(i, 1);
    }
    state.blocks[target].programs.push({
      name,
      ...((draft.displayName ?? '').trim() ? { displayName: draft.displayName.trim() } : {}),
    });
    pushConfig();
    toast('success', mode === 'add' ? 'Program added' : 'Program updated', 'Programs');
    popNav();
  });
  if (mode === 'edit') {
    $('ep-remove').addEventListener('click', () => {
      for (const b of state.blocks) {
        const i = b.programs.findIndex((p) => p.name === name);
        if (i !== -1) b.programs.splice(i, 1);
      }
      pushConfig();
      toast('success', 'Program removed', 'Programs');
      popNav();
    });
  }
}

// --- editBridge / removeBridge

function subEditBridge(host, props) {
  const { bridgeIndex } = props;
  const b = state.blocks[bridgeIndex];
  let nameDraft = b.name;
  subviewHeader(host, `Rename bridge: ${b.name}`);
  $('hgui-sub-body').innerHTML = `
    <div class="hgui-card">
      <div class="hgui-form-row">
        <label>Bridge name</label>
        <div>
          <input class="form-control" id="eb-name" value="${h(nameDraft)}" />
          <div class="hgui-hint">Shown in the Home app and in Homebridge logs.</div>
        </div>
      </div>
    </div>
  `;
  $('eb-name').addEventListener('input', (e) => { nameDraft = e.target.value; });
  $('hgui-sub-footer').innerHTML = `
    <button class="btn btn-secondary ms-auto" id="eb-cancel">Cancel</button>
    <button class="btn btn-primary" id="eb-save">Save</button>
  `;
  $('eb-cancel').addEventListener('click', popNav);
  $('eb-save').addEventListener('click', () => {
    const v = nameDraft.trim();
    if (!v) { toast('warning', 'Name cannot be empty'); return; }
    b.name = v;
    pushConfig();
    toast('success', 'Renamed bridge', 'Bridges');
    popNav();
  });
}

function subRemoveBridge(host, props) {
  const { bridgeIndex } = props;
  const b = state.blocks[bridgeIndex];
  const accs = (b.channels?.length ?? 0) + (b.variables?.length ?? 0) + (b.programs?.length ?? 0);
  subviewHeader(host, `Remove bridge: ${b.name}`);
  $('hgui-sub-body').innerHTML = `
    <div class="hgui-card">
      <p>This bridge has <strong>${accs}</strong> accessories.
         Removing it deletes all of them from the configuration.
         The HomeKit pairing on the bridge becomes orphaned in the Home app — you'll need to remove the bridge there too.</p>
    </div>
  `;
  $('hgui-sub-footer').innerHTML = `
    <button class="btn btn-secondary ms-auto" id="rb-cancel">Cancel</button>
    <button class="btn btn-danger" id="rb-confirm">Remove bridge</button>
  `;
  $('rb-cancel').addEventListener('click', popNav);
  $('rb-confirm').addEventListener('click', () => {
    state.blocks.splice(bridgeIndex, 1);
    if (state.blocks.length === 0) state.blocks.push(DEFAULT_BLOCK());
    pushConfig();
    toast('success', 'Bridge removed', 'Bridges');
    popNav();
  });
}

// ---------------------------------------------------------------- API actions

async function onTestConnection() {
  $('hgui-test-result').textContent = 'Testing…';
  spinner(true);
  try {
    const res = await homebridge.request('/test-connection', state.blocks[0]);
    $('hgui-test-result').innerHTML = res.ok
      ? `<span class="text-success">✓ ${h(res.message)}</span>`
      : `<span class="text-danger">✗ ${h(res.message)}</span>`;
    toast(res.ok ? 'success' : 'warning', res.message, 'CCU');
  } catch (err) {
    $('hgui-test-result').innerHTML = `<span class="text-danger">✗ ${h(err.message)}</span>`;
    toast('error', err.message, 'CCU');
  } finally { spinner(false); }
}

async function onDiscover() {
  spinner(true);
  try {
    const res = await homebridge.request('/discover', state.blocks[0]);
    state.discovered = res;
    rerender();
    toast('success', 
      `${res.devices.length} devices · ${res.variables.length} variables · ${res.programs.length} programs · ${res.rooms.length} rooms`,
      'Discovery complete');
  } catch (err) {
    toast('error', err.message, 'Discovery');
  } finally { spinner(false); }
}

async function onImport() {
  const file = $('hgui-import-file').files?.[0];
  const pasted = $('hgui-import-paste').value.trim();
  const multi = $('hgui-import-multibridge').checked;
  const status = $('hgui-import-status');
  $('hgui-import-warnings').innerHTML = '';
  $('hgui-bridges-summary').innerHTML = '';
  spinner(true);
  try {
    let report;
    if (file) {
      const buf = await file.arrayBuffer();
      report = await homebridge.request('/import-backup', { tarballBase64: bufToBase64(buf) });
    } else if (pasted.length) {
      report = await homebridge.request('/import-config-json', { configJson: pasted });
    } else {
      toast('warning', 'Provide a backup file or paste a config.json first', 'Import');
      return;
    }
    if (multi) {
      const blocks = await homebridge.request('/split-into-bridges', { report });
      const main = state.blocks[0];
      if (report.meta?.ccuIp && !main.ccuIp) main.ccuIp = report.meta.ccuIp;
      state.blocks = [
        { ...main, channels: blocks[0]?.channels ?? [], variables: blocks[0]?.variables ?? [], programs: blocks[0]?.programs ?? [], name: blocks[0]?.name ?? main.name },
        ...blocks.slice(1).map((bb) => ({
          ...DEFAULT_BLOCK(),
          ccuIp: main.ccuIp, useTls: main.useTls, interfaces: { ...main.interfaces },
          interfacePorts: { ...main.interfacePorts }, ccuAuth: { ...main.ccuAuth }, eventServer: { ...main.eventServer },
          name: bb.name, _bridge: bb.bridge, channels: bb.channels, variables: bb.variables, programs: bb.programs,
        })),
      ];
      $('hgui-bridges-summary').innerHTML = `<div class="alert alert-info">${blocks.length} bridges configured. Review them in the Bridges tab and click "Save configuration".</div>`;
    } else {
      mergeReportIntoMain(report);
    }
    if (report.warnings?.length) {
      $('hgui-import-warnings').innerHTML =
        '<div class="alert alert-warning"><strong>Imported with warnings:</strong><ul class="mb-0">' +
        report.warnings.map((w) => `<li>${h(w)}</li>`).join('') + '</ul></div>';
    }
    status.textContent = `Imported ${report.channels.length} channels, ${report.variables.length} variables, ${report.programs.length} programs.`;
    pushConfig();
    toast('success', 'Import complete — review the changes and click Save at the bottom of the page', 'Import');
    rerender();
  } catch (err) {
    toast('error', err.message, 'Import');
    status.textContent = '✗ ' + err.message;
  } finally { spinner(false); }
}

function mergeReportIntoMain(report) {
  const main = state.blocks[0];
  const cMap = new Map(main.channels.map((c) => [c.address, c]));
  for (const c of report.channels) cMap.set(c.address, c);
  main.channels = Array.from(cMap.values());
  const vMap = new Map(main.variables.map((v) => [v.name, v]));
  for (const v of report.variables) vMap.set(v.name, v);
  main.variables = Array.from(vMap.values());
  const pMap = new Map(main.programs.map((p) => [p.name, p]));
  for (const p of report.programs) pMap.set(p.name, p);
  main.programs = Array.from(pMap.values());
  if (report.meta?.ccuIp && !main.ccuIp) main.ccuIp = report.meta.ccuIp;
}

/**
 * Push the current state.blocks (plus any other-platform blocks we
 * round-trip) to the homebridge UI host. The host's built-in "Save"
 * button at the bottom of the plugin settings page persists this to
 * disk — we deliberately don't call savePluginConfig() ourselves so
 * the user has one canonical Save control, not two.
 */
function pushConfig() {
  try {
    const next = [...state.otherBlocks, ...state.blocks];
    homebridge.updatePluginConfig(next);
  } catch (err) {
    toast('error', `Could not stage config update: ${err.message}`);
  }
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------- init

async function init() {
  // Hide the schema form so the user only sees our custom UI, but keep
  // the host's built-in Save button enabled — it's the single canonical
  // place to persist config. Every mutation calls pushConfig() to stage
  // the change, and the host save button writes it to disk.
  try { homebridge.hideSchemaForm?.(); } catch { /* older host */ }

  try {
    const blocks = await homebridge.getPluginConfig();
    const ours = []; const other = [];
    for (const b of blocks ?? []) {
      if (!b) continue;
      if (b.platform === 'HapHomematic' || b.platform === undefined) ours.push(b);
      else other.push(b);
    }
    if (!ours.length) ours.push(DEFAULT_BLOCK());
    state.blocks = ours.map((b) => ({
      ...DEFAULT_BLOCK(), ...b,
      interfaces: { ...DEFAULT_BLOCK().interfaces, ...(b.interfaces ?? {}) },
      ccuAuth: { ...DEFAULT_BLOCK().ccuAuth, ...(b.ccuAuth ?? {}) },
      eventServer: { ...DEFAULT_BLOCK().eventServer, ...(b.eventServer ?? {}) },
      interfacePorts: { ...(b.interfacePorts ?? {}) },
      channels: b.channels ?? [], variables: b.variables ?? [], programs: b.programs ?? [],
    }));
    state.otherBlocks = other;
  } catch (err) {
    toast('error', `Could not load config: ${err.message}`);
  }

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

  // Header listeners.
  $('hgui-view-select').addEventListener('change', (e) => navigate(e.target.value));
  $('hgui-discover-btn').addEventListener('click', onDiscover);
  $('hgui-test-btn').addEventListener('click', onTestConnection);

  // Esc pops the sub-view stack (back button affordance).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.nav.length) popNav();
  });

  // Initial tab: if the user hasn't configured a CCU yet, drop them
  // straight into Settings. Otherwise show Dashboard and kick off a
  // background Discover so the channels/variables/programs tabs are
  // populated by the time the user clicks them.
  const isConfigured = !!state.blocks[0]?.ccuIp && state.blocks[0].ccuIp.length > 0;
  if (!isConfigured) {
    navigate('settings');
  } else {
    navigate('dashboard');
    // Fire-and-forget; failures fall back to the empty state with a
    // hint already in place. No spinner — user can still navigate.
    onDiscover().catch(() => { /* errors already toasted by onDiscover */ });
  }
}

init();
