import { attachChart, changes, chartMarkup } from './history.js';
import { getLanguage, setLanguage, t, number, translateDocument } from './i18n.js';

const $ = (id) => document.getElementById(id);
const VIEWS = [
  { id: 'all', icon: 'grid' },
  { id: 'cold', icon: 'clock' },
  { id: 'never', icon: 'play' },
  { id: 'cache', icon: 'box' },
  { id: 'offline', icon: 'offline' },
];
const state = { report: null, days: 730, view: 'all', library: null, query: '', sort: 'size', busy: false, expanded: new Set(), status: { key: 'preparing', params: {}, error: false }, scanError: null, toast: null, actionBusy: false, pendingAction: null, history: undefined, historyBusy: false };
const GIB = 1024 ** 3;
let sessionToken = null;
let visibleRows = [];
let toastTimer;

function icon(name, className = '') {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${number(value, unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatPlayed(app) {
  if (app.offline || app.isCache) return t('unavailable');
  if (!app.lastPlayed) return t('noHistory');
  const age = Math.floor((state.report.scannedAt - app.lastPlayed) / 86400);
  if (age < 1) return t('today');
  if (age === 1) return t('yesterday');
  return t('daysAgo', { count: number(age) });
}

function totalBytes(app) {
  return app.isCache ? app.bytes : app.size + app.shader + app.workshop;
}

function cacheRows() {
  if (!state.report) return [];
  return ['shader', 'workshop'].flatMap((kind) => state.report.orphans[kind].map((row) => ({
    ...row, name: row.name || `App ${row.appid}`, isCache: true, kind,
  })));
}

// Steam's Chinese name when the UI is Chinese and Steam has one; "App 123" when no name is known.
function displayName(app) {
  const name = getLanguage() === 'zh-CN' && app.nameZh ? app.nameZh : app.name;
  return name && name !== `App ${app.appid}` ? name : t('app', { id: app.appid });
}

function hasKnownName(app) {
  return Boolean(app.name) && app.name !== `App ${app.appid}`;
}

function viewRows(view = state.view, applyLibrary = true) {
  const report = state.report;
  if (!report) return [];
  let rows = view === 'cache' ? cacheRows() : report.rows.filter((app) => {
    if (view === 'offline') return app.offline;
    if (app.offline || app.redist) return false;
    if (view === 'cold') return app.cold;
    if (view === 'never') return app.never;
    return true;
  });
  if (applyLibrary && state.library !== null) {
    const path = report.libraryRows[state.library]?.path;
    rows = rows.filter((app) => app.library === path);
  }
  return rows;
}

function rowKey(app) { return `${app.library}|${app.appid}|${app.kind || 'game'}`; }

function renderNavigation() {
  $('views').innerHTML = VIEWS.map((view) => {
    const count = !state.report ? '—' : number(view.id === 'offline'
      ? state.report.libraryRows.filter((lib) => !lib.online).length
      : viewRows(view.id, false).length);
    const label = t(`view.${view.id}`);
    return `<button type="button" class="nav-item${state.view === view.id ? ' active' : ''}" data-view="${view.id}" aria-pressed="${state.view === view.id}" title="${label}">${icon(view.icon)}<span class="nav-name">${label}</span><span class="nav-count">${count}</span></button>`;
  }).join('');
  if (!state.report) return;
  $('library-nav').innerHTML = `<button type="button" class="nav-item${state.library === null ? ' active' : ''}" data-library="all" aria-pressed="${state.library === null}" title="${t('allLibraries')}">${icon('drive')}<span class="nav-name">${t('allLibraries')}</span></button>` + state.report.libraryRows.map((lib, index) => `<button type="button" class="nav-item${state.library === index ? ' active' : ''}" data-library="${index}" aria-pressed="${state.library === index}" title="${escapeHtml(lib.path)}${lib.online ? '' : ` (${t('offline')})`}">${icon(lib.online ? 'drive' : 'offline')}<span class="nav-name">${escapeHtml(lib.path)}</span></button>`).join('');
}

function stat(label, value, note, symbol) {
  return `<div><div class="stat-label">${icon(symbol)}${label}</div><div class="stat-value">${formatBytes(value)}</div><div class="stat-note">${escapeHtml(note)}</div></div>`;
}

function renderSummary() {
  const { totals, rows } = state.report;
  const online = rows.filter((app) => !app.offline && !app.redist);
  const inactive = online.filter((app) => app.cold);
  $('review-value').textContent = formatBytes(totals.reclaimable);
  $('review-description').textContent = t('reviewDescription', { games: number(inactive.length), caches: number(cacheRows().length) });
  $('summary-stats').innerHTML = [
    stat(t('installedApps'), totals.installed, t('installedNote', { count: number(online.length) }), 'grid'),
    stat(t('inactiveInstalls'), totals.cold, t('inactiveNote', { days: number(state.days) }), 'clock'),
    stat(t('workshopContent'), totals.workshop, t('workshopNote'), 'box'),
    stat(t('activeDownloads'), totals.downloads, t('downloadsNote'), 'download'),
  ].join('');
  $('review-button').disabled = false;
  $('copy').disabled = false;
}

function renderLibraries() {
  const libraries = state.report.libraryRows;
  const onlineCount = libraries.filter((lib) => lib.online).length;
  $('library-count').textContent = t('libraryCount', { online: number(onlineCount), offline: number(libraries.length - onlineCount) });
  $('libraries').innerHTML = libraries.map((lib, index) => {
    const meterShown = lib.online && lib.total > 0;
    const used = meterShown ? (lib.total - lib.free) / lib.total : 0;
    const low = meterShown && isLowSpace(lib);
    const meta = !lib.online ? t('offlineMeta', { installed: formatBytes(lib.installed), count: number(lib.count) })
      : t(meterShown ? 'onlineMetaTotal' : 'onlineMeta', { installed: formatBytes(lib.installed), free: formatBytes(lib.free), total: formatBytes(lib.total) });
    const usage = t('usedShare', { percent: percent(used), free: formatBytes(lib.free), total: formatBytes(lib.total) });
    const meter = meterShown ? `<span class="drive-meter${low ? ' low' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(used * 100)}" aria-label="${escapeHtml(usage)}"><span data-share="${(used * 100).toFixed(1)}"></span></span><span class="drive-usage">${usage}${low ? ` · <span class="low-label">${t('lowSpace')}</span>` : ''}</span>` : '';
    return `<button type="button" class="library-card${state.library === index ? ' active' : ''}" data-library="${index}" aria-pressed="${state.library === index}" title="${escapeHtml(t('filterLibrary', { path: lib.path }))}"><span class="drive-icon">${icon(lib.online ? 'drive' : 'offline')}</span><span class="drive-details"><span class="drive-heading"><span class="drive-path">${escapeHtml(lib.path)}</span>${lib.online ? '' : `<span class="badge badge-offline">${icon('offline')}${t('offline')}</span>`}</span><span class="drive-meta">${meta}</span>${meter}</span></button>`;
  }).join('');
  // Set through CSSOM: the page CSP blocks inline style attributes.
  for (const bar of $('libraries').querySelectorAll('[data-share]')) bar.style.width = `${bar.dataset.share}%`;
}

function percent(share) {
  return new Intl.NumberFormat(getLanguage(), { style: 'percent', maximumFractionDigits: 0 }).format(share);
}

// Below 10% or 20 GiB free counts as low: large game updates need room to download and unpack.
function isLowSpace(lib) {
  return lib.online && lib.total > 0 && (lib.free < lib.total * 0.1 || lib.free < 20 * GIB);
}

// One entry per drive: several libraries on the same drive share its free space.
function volumes() {
  const byVolume = new Map();
  for (const lib of state.report.libraryRows) {
    if (!lib.online || !lib.total) continue;
    const entry = byVolume.get(lib.volume) || { volume: lib.volume, free: lib.free, total: lib.total, libraries: [] };
    entry.libraries.push(lib);
    byVolume.set(lib.volume, entry);
  }
  return [...byVolume.values()];
}

// Suggests games to move with Steam's own storage manager: inactive games first, then the largest.
function migrationAdvice() {
  const drives = volumes();
  return drives.filter((drive) => isLowSpace(drive.libraries[0])).map((drive) => {
    const target = drives.filter((other) => other !== drive && !isLowSpace(other.libraries[0])).sort((a, b) => b.free - a.free)[0];
    if (!target) return { drive, target: null, games: [] };
    const paths = new Set(drive.libraries.map((lib) => lib.path));
    let room = target.free - Math.max(target.total * 0.1, 20 * GIB);
    const games = [];
    const candidates = state.report.rows.filter((app) => !app.offline && !app.redist && paths.has(app.library))
      .sort((a, b) => (Number(b.cold) - Number(a.cold)) || (b.size - a.size));
    for (const app of candidates) {
      if (games.length === 3) break;
      if (app.size <= room) { games.push(app); room -= app.size; }
    }
    return { drive, target, games };
  });
}

function artwork(app) {
  const initials = Array.from(hasKnownName(app) ? displayName(app) : app.appid).slice(0, 2).join('').toUpperCase();
  return `<span class="game-art" aria-hidden="true"><span>${escapeHtml(initials)}</span><img src="/art/${encodeURIComponent(app.appid)}" alt="" loading="lazy"></span>`;
}

function gameTags(app) {
  const tags = [];
  if (app.offline) tags.push(`<span class="badge badge-offline">${t('offline')}</span>`);
  else if (app.isCache) tags.push(`<span class="badge badge-muted">${t(app.kind === 'shader' ? 'shader' : 'workshopContent')}</span>`);
  else {
    if (app.never) tags.push(`<span class="badge badge-muted">${t('view.never')}</span>`);
    else if (app.cold) tags.push(`<span class="badge badge-cold">${t('inactive')}</span>`);
    if (app.workshop > 0) tags.push(`<span>${t('workshopSize', { size: formatBytes(app.workshop) })}</span>`);
    if (app.installMissing || app.incomplete) tags.push(`<span class="badge badge-warning">${t('checkInstall')}</span>`);
  }
  if (!tags.length || ((app.isCache || app.offline) && hasKnownName(app))) tags.push(`<span>${escapeHtml(t('app', { id: app.appid }))}</span>`);
  return tags.join('');
}

function gameDetails(app) {
  if (app.isCache) return `<div class="detail-path">${escapeHtml(app.library)} / steamapps / ${app.kind === 'shader' ? 'shadercache' : 'workshop / content'} / ${escapeHtml(app.appid)}</div><p class="detail-warning">${t('cacheWarning')}</p>${storeLink(app.appid)}${actionButtons(app)}`;
  if (app.offline) return `<div class="detail-path">${escapeHtml(app.library)}</div><p class="detail-warning">${t('offlineWarning')}</p>${storeLink(app.appid)}${actionButtons(app)}`;
  const warnings = [];
  if (app.installMissing) warnings.push(t('missingInstall'));
  if (app.incomplete) warnings.push(t('incomplete'));
  if (app.missing.length) warnings.push(t('sharedDepots', { ids: app.missing.join(', ') }));
  return `<dl class="breakdown"><div><dt>${t('manifest')}</dt><dd>${formatBytes(app.size)}</dd></div><div><dt>${t('shader')}</dt><dd>${formatBytes(app.shader)}</dd></div><div><dt>${t('workshop')}</dt><dd>${formatBytes(app.workshop)}</dd></div></dl><div class="detail-path">${escapeHtml(app.library)} · ${escapeHtml(t('app', { id: app.appid }))}</div>${warnings.length ? `<p class="detail-warning">${escapeHtml(warnings.join(' '))}</p>` : ''}${storeLink(app.appid)}${actionButtons(app)}`;
}

function storeLink(appid) {
  return `<div class="detail-links"><a href="https://store.steampowered.com/app/${encodeURIComponent(appid)}/" target="_blank" rel="noopener noreferrer">${t('store')}${icon('external')}</a></div>`;
}

function actionButtons(app) {
  const action = app.actions;
  const id = escapeHtml(action?.id || '');
  return `<div class="detail-actions"><button type="button" class="button" data-app-action="open" data-target="${id}" data-eligible="${Boolean(action?.canOpen)}"${action?.canOpen && !state.busy && !state.actionBusy ? '' : ' disabled'}>${icon('drive')}${t('openFolder')}</button><button type="button" class="button button-danger" data-app-action="remove" data-target="${id}" data-eligible="${Boolean(action?.canRemove)}"${action?.canRemove && !state.busy && !state.actionBusy ? '' : ' disabled'}>${icon('trash')}${t(app.isCache ? 'removeCache' : 'uninstall')}</button></div>`;
}

function renderActionControls() {
  $('rescan').disabled = state.busy || state.actionBusy;
  $('quit').disabled = state.actionBusy;
  for (const button of document.querySelectorAll('[data-app-action]')) button.disabled = button.dataset.eligible !== 'true' || state.busy || state.actionBusy || state.scanError !== null;
  const pending = state.pendingAction;
  if (!pending) return;
  $('action-title').textContent = t(pending.mode === 'recycle' ? 'confirmCache' : 'confirmGame');
  $('action-description').textContent = t(pending.mode === 'recycle' ? 'cacheConfirmBody' : 'gameConfirmBody');
  $('action-name').textContent = pending.name;
  $('action-path').textContent = pending.folder;
  $('action-confirm').textContent = t(state.actionBusy ? 'actionPending' : pending.mode === 'recycle' ? 'confirmRecycle' : 'confirmUninstall');
  $('action-confirm').disabled = state.actionBusy || !$('action-ack').checked || Boolean(pending.error);
  $('action-cancel').disabled = state.actionBusy;
  $('action-ack').disabled = state.actionBusy;
  $('action-error').hidden = !pending.error;
  $('action-error').textContent = pending.error ? t(pending.error) : '';
}

const actionErrorCodes = new Set(['staleTarget', 'unsafePath', 'unavailableTarget', 'scanIncomplete', 'cacheInUse', 'steamRunning', 'steamUnavailable', 'confirmationRequired', 'confirmationExpired', 'actionBusy', 'forbidden', 'cancelled', 'operationFailed', 'invalidRequest']);

async function authenticatedPost(url, body) {
  if (!sessionToken) {
    const response = await fetch('/api/session');
    const session = await response.json();
    if (!response.ok || !session.token) throw new Error('forbidden');
    sessionToken = session.token;
  }
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Disk-Bill-Token': sessionToken }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    if (result.code === 'forbidden') sessionToken = null;
    throw new Error(actionErrorCodes.has(result.code) ? result.code : 'operationFailed');
  }
  return result;
}

function actionErrorKey(error) {
  return `action.${actionErrorCodes.has(error.message) ? error.message : 'operationFailed'}`;
}

async function requestAction(operation, id) {
  if (state.busy || state.actionBusy) return;
  state.actionBusy = true;
  renderActionControls();
  try {
    const result = await authenticatedPost('/api/action', { operation: operation === 'remove' ? 'prepare' : 'open', id });
    if (operation === 'open') showToast('folderOpened');
    else {
      state.pendingAction = { ...result, id };
      state.actionBusy = false;
      $('action-ack').checked = false;
      renderActionControls();
      $('action-dialog').showModal();
      $('action-cancel').focus();
    }
  } catch (error) { showToast(actionErrorKey(error)); }
  finally { state.actionBusy = false; renderActionControls(); }
}

async function commitAction() {
  const pending = state.pendingAction;
  if (!pending || state.actionBusy || !$('action-ack').checked || pending.error) return;
  state.actionBusy = true;
  renderActionControls();
  let refresh = false;
  try {
    const result = await authenticatedPost('/api/action', { operation: 'commit', id: pending.id, ticket: pending.ticket, confirmed: true });
    state.pendingAction = null;
    $('action-dialog').close();
    refresh = result.result === 'cacheRemoved';
    showToast(refresh ? 'cacheRemoved' : 'uninstallRequested');
  } catch (error) { pending.error = actionErrorKey(error); }
  finally { state.actionBusy = false; renderActionControls(); }
  if (refresh) await load();
}

function renderList() {
  if (!state.report) return;
  const view = VIEWS.find((item) => item.id === state.view);
  $('list-heading').textContent = t(`view.${state.view}`);
  $('view-description').textContent = t(`description.${state.view}`, { days: number(state.days) });
  const needle = state.query.trim().toLocaleLowerCase();
  visibleRows = viewRows().filter((app) => !needle || [app.name, app.nameZh, displayName(app)].some((name) => name?.toLocaleLowerCase().includes(needle)) || app.appid.includes(needle));
  visibleRows.sort((a, b) => {
    if (state.sort === 'name') return displayName(a).localeCompare(displayName(b), getLanguage());
    if (state.sort === 'played') return (b.lastPlayed || 0) - (a.lastPlayed || 0);
    return totalBytes(b) - totalBytes(a);
  });
  $('result-count').textContent = number(visibleRows.length);
  if (!visibleRows.length) {
    $('game-rows').innerHTML = `<tr><td colspan="4"><div class="empty-state">${icon(state.query ? 'search' : view.icon)}<strong>${t(state.query ? 'noMatches' : 'emptyView')}</strong><span>${t(state.query ? 'searchHint' : 'viewHint')}</span></div></td></tr>`;
    return;
  }
  $('game-rows').innerHTML = visibleRows.map((app, index) => {
    const expanded = state.expanded.has(rowKey(app));
    const title = displayName(app);
    return `<tr class="game-row${expanded ? ' expanded' : ''}"><td><div class="game-cell">${artwork(app)}<div class="game-info"><button type="button" class="game-name" data-expand="${index}" aria-expanded="${expanded}" aria-controls="detail-${index}">${escapeHtml(title)}</button><div class="game-meta">${gameTags(app)}</div></div></div></td><td class="size-cell">${formatBytes(totalBytes(app))}</td><td class="played-cell">${formatPlayed(app)}</td><td class="expand-cell"><button class="expand-button" data-expand="${index}" type="button" aria-label="${escapeHtml(t('detailsFor', { name: title }))}" aria-expanded="${expanded}" aria-controls="detail-${index}">${icon('arrow')}</button></td></tr><tr id="detail-${index}" class="game-details"${expanded ? '' : ' hidden'}><td colspan="4">${gameDetails(app)}</td></tr>`;
  }).join('');
}

function renderNotes() {
  const { totals, rows, errors } = state.report;
  const tools = rows.filter((app) => app.redist && !app.offline);
  $('migration-notes').innerHTML = migrationAdvice().map(({ drive, target, games }) => {
    const params = { volume: drive.volume, free: formatBytes(drive.free), total: formatBytes(drive.total) };
    let body = t('migrationNoTarget', params);
    if (target && games.length) body = t('migrationMove', { ...params, target: target.libraries[0].path, targetFree: formatBytes(target.free), games: games.map((app) => `${displayName(app)} (${formatBytes(app.size)})`).join(t('listSeparator')) });
    else if (target) body = t('migrationNoFit', { ...params, target: target.libraries[0].path, targetFree: formatBytes(target.free) });
    return `<div class="note-row note-warning">${icon('drive')}<div><strong>${t('migrationTitle', params)}</strong> ${escapeHtml(body)}</div></div>`;
  }).join('');
  const notes = [];
  if (totals.downloads > 0 || totals.temp > 0) notes.push(`<div class="note-row">${icon('download')}<div><strong>${t('downloadsTitle')}</strong> ${t('downloading', { size: formatBytes(totals.downloads) })}${totals.temp ? ` · ${t('staging', { size: formatBytes(totals.temp) })}` : ''}. ${t('excluded')}</div></div>`);
  if (tools.length || totals.emptyShaderDirs) notes.push(`<div class="note-row">${icon('info')}<div>${tools.length ? t('toolsNote', { count: number(tools.length), size: formatBytes(tools.reduce((sum, app) => sum + app.size, 0)) }) : ''} ${totals.emptyShaderDirs ? t('emptyShaders', { count: number(totals.emptyShaderDirs) }) : ''}</div></div>`);
  if (errors.length) notes.push(`<div class="note-row">${icon('info')}<details><summary>${t('scanWarnings', { count: number(errors.length) })}</summary>${errors.map((error) => `<p>${escapeHtml(error)}</p>`).join('')}</details></div>`);
  $('scan-notes').innerHTML = notes.join('');
}

function renderFailure() {
  $('game-rows').innerHTML = `<tr><td colspan="4"><div class="empty-state">${icon('info')}<strong>${t('couldNotRead')}</strong><span>${escapeHtml(state.scanError || t('scanFailed'))}</span><span>${t('retryHint')}</span></div></td></tr>`;
  $('summary-stats').textContent = t('scanUnavailable');
  $('libraries').innerHTML = `<div class="muted">${t('noLibraryData')}</div>`;
  $('library-count').textContent = t('notAvailable');
}

function renderStatus() {
  const { key, params, error } = state.status;
  const translatedParams = error ? { ...params, error: params.error || t('scanFailed') } : params;
  $('status').textContent = t(key, translatedParams);
  $('status-dot').classList.toggle('busy', state.busy);
  $('status-dot').classList.toggle('error', error);
  $('rescan').querySelector('span').textContent = t(state.busy ? 'scanning' : 'scan');
  const report = state.report;
  $('scan-time').textContent = report ? t('lastScan', { time: new Date(report.scannedAt * 1000).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' }) }) : t('localOnly');
  if (state.toast) $('toast').textContent = t(state.toast);
  renderActionControls();
}

function render() {
  renderNavigation();
  renderStatus();
  if (!state.report) {
    if (state.scanError !== null) renderFailure();
    return;
  }
  renderSummary();
  renderLibraries();
  renderList();
  renderNotes();
  renderHistory();
  renderActionControls();
}

function formatDate(seconds) {
  return new Date(seconds * 1000).toLocaleDateString(getLanguage(), { month: 'short', day: 'numeric' });
}

function formatTime(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
}

function signedBytes(bytes) {
  return `${bytes > 0 ? '+' : bytes < 0 ? '−' : '±'}${formatBytes(Math.abs(bytes))}`;
}

function renderHistory() {
  const history = state.history;
  const panel = $('history-body');
  if (history === undefined) return;
  $('history-toggle').checked = Boolean(history?.enabled);
  $('history-toggle').disabled = !history || state.historyBusy;
  $('history-clear').hidden = !history?.entries.length;
  $('history-clear').disabled = state.historyBusy;
  if (!history) { panel.innerHTML = `<p class="muted">${t('historyUnavailable')}</p>`; return; }
  const location = `<p class="history-location">${escapeHtml(t('historyLocation', { location: history.location, limit: number(history.limit) }))}</p>`;
  const entries = history.entries;
  if (!history.enabled && !entries.length) { panel.innerHTML = `<p class="muted">${escapeHtml(t('historyOff', { location: history.location }))}</p>`; return; }
  if (!entries.length) { panel.innerHTML = `<p class="muted">${t('historyEmpty')}</p>${location}`; return; }
  panel.innerHTML = '<div class="history-grid"><div class="history-chart"></div><div class="history-summary"></div></div>';
  const chartBox = panel.querySelector('.history-chart');
  const width = Math.max(260, Math.round(chartBox.clientWidth || 600));
  // Several scans on one day are told apart by time rather than repeating the date.
  const sameDay = new Date(entries[0].scannedAt * 1000).toDateString() === new Date(entries.at(-1).scannedAt * 1000).toDateString();
  chartBox.innerHTML = chartMarkup(entries, { formatGib: (bytes, decimals) => `${number(bytes / GIB, decimals)} GiB`, formatDate: sameDay ? formatTime : formatDate, label: escapeHtml(t('historyChart', { count: number(entries.length), first: formatDate(entries[0].scannedAt), last: formatDate(entries.at(-1).scannedAt) })) }, width);
  const diff = changes(entries);
  let summary = `<p class="muted">${t('historyOne')}</p>`;
  if (diff) {
    const lead = diff.delta === 0 && !diff.rows.length ? t('historyNoChange', { date: formatDate(diff.previous.scannedAt) })
      : t('historySince', { date: formatDate(diff.previous.scannedAt), delta: signedBytes(diff.delta) });
    const rows = diff.rows.map((row) => `<tr><td>${escapeHtml(row.name)}${row.kind === 'changed' ? '' : ` <span class="badge badge-muted">${t(row.kind === 'added' ? 'historyAdded' : 'historyRemoved')}</span>`}</td><td class="size-cell">${signedBytes(row.delta)}</td></tr>`).join('');
    summary = `<p class="history-lead">${lead}</p>${rows ? `<table class="history-table"><thead><tr><th scope="col">${t('gameHeader')}</th><th scope="col" class="size-column">${t('historyChange')}</th></tr></thead><tbody>${rows}</tbody></table>` : ''}${diff.more ? `<p class="muted">${t('historyMore', { count: number(diff.more) })}</p>` : ''}`;
  }
  panel.querySelector('.history-summary').innerHTML = summary;
  panel.insertAdjacentHTML('beforeend', `${history.enabled ? '' : `<p class="muted">${t('historyPaused')}</p>`}${location}`);
  attachChart(chartBox, entries, (entry, previous) => t('historyTooltip', { date: `${formatDate(entry.scannedAt)} ${formatTime(entry.scannedAt)}`, size: formatBytes(entry.installed) }) + (previous ? ` · ${signedBytes(entry.installed - previous.installed)}` : ''));
}

async function loadHistory() {
  try {
    const response = await fetch('/api/history');
    const result = await response.json();
    state.history = response.ok && result.ok ? result : null;
  } catch {
    state.history = null;
  }
  renderHistory();
}

async function updateHistory(url, body) {
  if (state.historyBusy) return;
  state.historyBusy = true;
  // Keep the switch where the user put it while the request runs.
  if (typeof body.enabled === 'boolean' && state.history) state.history = { ...state.history, enabled: body.enabled };
  renderHistory();
  try {
    state.history = await authenticatedPost(url, body);
    if (url.endsWith('/clear')) showToast('historyCleared');
  } catch {
    showToast('historyError');
    await loadHistory();
  } finally {
    state.historyBusy = false;
    renderHistory();
  }
}

// Polls the server while a scan runs so the status bar names the folder being read.
function watchProgress() {
  const timer = setInterval(async () => {
    try {
      const result = await (await fetch('/api/progress')).json();
      if (!state.busy || !result.progress) return;
      const { step, library, index, count } = result.progress;
      setStatus(step === 'names' ? 'progressNames' : step === 'caches' ? 'progressCaches' : 'progressManifests', { path: library, index: number(index), count: number(count) });
    } catch {
      // Progress is only a hint; the scan request itself reports failures.
    }
  }, 400);
  return () => clearInterval(timer);
}

function selectView(view) {
  state.view = view;
  if (view === 'offline' && state.library !== null && state.report?.libraryRows[state.library]?.online) state.library = null;
  render();
}

function selectLibrary(value) {
  state.library = value === 'all' ? null : Number(value);
  if (state.library !== null && !state.report.libraryRows[state.library].online) state.view = 'offline';
  else if (state.view === 'offline') state.view = 'all';
  render();
}

function changeDays(days) {
  state.days = days;
  for (const button of document.querySelectorAll('[data-days]')) {
    const active = Number(button.dataset.days) === days;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (!state.report) return;
  const report = state.report;
  report.coldDays = days;
  for (const app of report.rows) app.cold = !app.offline && !app.redist && (app.never || report.scannedAt - app.lastPlayed >= days * 86400);
  report.totals.cold = report.rows.filter((app) => app.cold).reduce((sum, app) => sum + app.size, 0);
  report.totals.reclaimable = report.totals.cold + report.totals.orphanShader + report.totals.orphanWorkshop;
  render();
}

function setStatus(key, params = {}, error = false) {
  state.status = { key, params, error };
  renderStatus();
}

function showToast(key) {
  clearTimeout(toastTimer);
  state.toast = key;
  $('toast').textContent = t(key);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; state.toast = null; }, 3500);
}

async function load() {
  if (state.busy || state.actionBusy) return;
  state.busy = true;
  document.body.classList.add('scanning');
  $('rescan').disabled = true;
  for (const button of document.querySelectorAll('[data-days]')) button.disabled = true;
  setStatus('scanningStatus');
  const stopProgress = watchProgress();
  try {
    const response = await fetch(`/api/scan?days=${state.days}`);
    const report = await response.json();
    if (!response.ok || report.ok === false) {
      state.scanError = report.error || '';
      throw new Error(state.scanError);
    }
    state.report = report;
    state.scanError = null;
    if (state.library !== null && !report.libraryRows[state.library]) state.library = null;
    document.body.classList.add('has-report');
    state.busy = false;
    stopProgress();
    setStatus('completeStatus', { seconds: number(report.elapsedMs / 1000, 1), path: report.steamPath });
    render();
    loadHistory();
  } catch (error) {
    stopProgress();
    state.busy = false;
    state.scanError = error instanceof Error ? error.message : '';
    setStatus(state.report ? 'previousStatus' : 'failedStatus', { error: state.scanError }, true);
    if (!state.report) renderFailure();
  } finally {
    state.busy = false;
    document.body.classList.remove('scanning');
    $('rescan').disabled = false;
    renderStatus();
    for (const button of document.querySelectorAll('[data-days]')) button.disabled = false;
  }
}

async function copyReport() {
  const report = state.report;
  if (!report) return;
  const lines = [
    t('reportTitle', { days: number(report.coldDays) }),
    t('reportReview', { size: formatBytes(report.totals.reclaimable) }),
    t('reportInstalled', { size: formatBytes(report.totals.installed) }),
    '', t('reportInactive'),
    ...report.rows.filter((app) => app.cold).map((app) => `- ${displayName(app)} (${app.appid}) ${formatBytes(app.size)} · ${app.library}`),
    '', t('reportCaches'),
    ...cacheRows().map((row) => `- ${t(row.kind)} · ${displayName(row)} (${row.appid}): ${formatBytes(row.bytes)} · ${row.library}`),
    '', t('reportOffline'),
    ...report.libraryRows.filter((lib) => !lib.online).map((lib) => `- ${lib.path}: ${formatBytes(lib.installed)}`),
  ];
  try { await navigator.clipboard.writeText(lines.join('\n')); showToast('copied'); }
  catch { showToast('clipboardUnavailable'); }
}

$('language').addEventListener('change', (event) => {
  setLanguage(event.target.value);
  translateDocument();
  if (state.status.key === 'completeStatus') state.status.params.seconds = number(state.report.elapsedMs / 1000, 1);
  render();
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.appAction) requestAction(button.dataset.appAction, button.dataset.target);
  else if (button.dataset.view) selectView(button.dataset.view);
  else if (button.dataset.library) selectLibrary(button.dataset.library);
  else if (button.dataset.days) changeDays(Number(button.dataset.days));
  else if (button.dataset.expand !== undefined) {
    const index = Number(button.dataset.expand);
    const app = visibleRows[index];
    if (!app) return;
    const key = rowKey(app);
    const expanded = !state.expanded.has(key);
    if (expanded) state.expanded.add(key); else state.expanded.delete(key);
    const detail = $(`detail-${index}`);
    detail.hidden = !expanded;
    detail.previousElementSibling.classList.toggle('expanded', expanded);
    for (const control of detail.previousElementSibling.querySelectorAll('[data-expand]')) control.setAttribute('aria-expanded', String(expanded));
  }
});
document.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement) event.target.remove();
}, true);
$('search').addEventListener('input', (event) => { state.query = event.target.value; renderList(); });
$('sort').addEventListener('change', (event) => { state.sort = event.target.value; renderList(); });
$('rescan').addEventListener('click', load);
$('copy').addEventListener('click', copyReport);
$('review-button').addEventListener('click', () => { state.library = null; selectView('cold'); $('list-heading').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('action-ack').addEventListener('change', renderActionControls);
$('action-confirm').addEventListener('click', commitAction);
$('action-cancel').addEventListener('click', () => { if (!state.actionBusy) { state.pendingAction = null; $('action-dialog').close(); } });
$('action-dialog').addEventListener('cancel', (event) => { if (state.actionBusy) event.preventDefault(); else state.pendingAction = null; });
$('history-toggle').addEventListener('change', (event) => updateHistory('/api/history/settings', { enabled: event.target.checked }));
$('history-clear').addEventListener('click', () => { if (window.confirm(t('historyClearConfirm'))) updateHistory('/api/history/clear', {}); });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderHistory, 150); });
$('quit').addEventListener('click', async () => {
  try { await authenticatedPost('/api/shutdown', {}); window.close(); setStatus('stopped'); }
  catch { showToast('alreadyStopped'); }
});
setInterval(() => { fetch('/api/heartbeat', { method: 'POST' }).catch(() => {}); }, 2000);
translateDocument();
render();
loadHistory();
load();
