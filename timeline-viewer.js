const send = (msg) => chrome.runtime.sendMessage(msg);

const sessionSearch = document.getElementById('sessionSearch');
const sessionMatchCount = document.getElementById('sessionMatchCount');
const scenarioList = document.getElementById('scenarioList');
const sessionTotal = document.getElementById('sessionTotal');
const zipFileInput = document.getElementById('zipFileInput');
const zipDropzone = document.getElementById('zipDropzone');
const sidebarFeedback = document.getElementById('sidebarFeedback');
const refreshSessionsButton = document.getElementById('refreshSessions');
const videoEl = document.getElementById('video');
const videoWrap = document.getElementById('videoWrap');
const recordingControls = document.getElementById('recordingControls');
const recordingSelect = document.getElementById('recordingSelect');
const playToggle = document.getElementById('playToggle');
const timeReadout = document.getElementById('timeReadout');
const seekBar = document.getElementById('seekBar');
const screenshotBox = document.getElementById('screenshotBox');
const networkTableBody = document.getElementById('networkTableBody');
const detailPanel = document.getElementById('detailPanel');
const networkPagination = document.getElementById('networkPagination');
const modal = document.getElementById('imageModal');
const modalImage = document.getElementById('modalImage');
const openOriginalViewer = document.getElementById('openOriginalViewer');
const urlFilter = document.getElementById('urlFilter');
const methodFilter = document.getElementById('methodFilter');
const statusFilter = document.getElementById('statusFilter');
const mimeFilter = document.getElementById('mimeFilter');
const presetName = document.getElementById('presetName');
const presetPills = document.getElementById('presetPills');
const savePresetBtn = document.getElementById('savePreset');
const copyVisibleLogs = document.getElementById('copyVisibleLogs');
const copySelectedLog = document.getElementById('copySelectedLog');
const closeModal = document.getElementById('closeModal');
const actionStatus = document.getElementById('actionStatus');
const evidenceSummary = document.getElementById('evidenceSummary');
const urlRegexToggle = document.getElementById('urlRegexToggle');
const mimeRegexToggle = document.getElementById('mimeRegexToggle');
const clearFiltersButton = document.getElementById('clearFilters');
const filterErrors = document.getElementById('filterErrors');
const networkCount = document.getElementById('networkCount');
const sharePresetsButton = document.getElementById('sharePresets');
const togglePresetImportButton = document.getElementById('togglePresetImport');
const presetImportArea = document.getElementById('presetImportArea');
const presetImportText = document.getElementById('presetImportText');
const applyPresetImportButton = document.getElementById('applyPresetImport');
const watchToggle = document.getElementById('watchToggle');
const watchContent = document.getElementById('watchContent');
const watchName = document.getElementById('watchName');
const watchSource = document.getElementById('watchSource');
const watchPath = document.getElementById('watchPath');
const watchList = document.getElementById('watchList');
const watchResults = document.getElementById('watchResults');
const watchPresetName = document.getElementById('watchPresetName');
const saveWatchPresetButton = document.getElementById('saveWatchPreset');
const shareWatchPresetsButton = document.getElementById('shareWatchPresets');
const toggleWatchImportButton = document.getElementById('toggleWatchImport');
const watchImportArea = document.getElementById('watchImportArea');
const watchImportText = document.getElementById('watchImportText');
const applyWatchImportButton = document.getElementById('applyWatchImport');
const watchPresetPills = document.getElementById('watchPresetPills');

const PLAY_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const NETWORK_PAGE_SIZE = 100;

const state = {
  scenarios: [],
  scenarioData: {},
  live: { screenshots: [], networkLogs: [], videoChunks: [] },
  zipScenarios: [],
  nextZipId: 1,
  currentScenario: 'live',
  selectedLogId: null,
  videoDuration: 0,
  captureStart: null,
  captureEnd: null,
  currentTimeMs: 0,
  networkPage: 0,
  sort: { col: 'timestamp', asc: true },
  filter: { url: '', method: '', status: '', mime: '' },
  useRegex: { url: false, mime: false },
  regexErrors: { url: '', mime: '' },
  savedPresets: [],
  trackers: [],
  trackerPresets: [],
};

const parseTime = TimelineLogic.parseTime;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function createIcon(pathData) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  return svg;
}

function showActionStatus(message, isError = false) {
  actionStatus.textContent = message;
  actionStatus.classList.toggle('error', isError);
}

function toDisplayData(source) {
  return {
    screenshots: Array.isArray(source?.screenshots) ? source.screenshots : [],
    networkLogs: Array.isArray(source?.networkLogs) ? source.networkLogs : [],
    videoChunks: Array.isArray(source?.videoChunks) ? source.videoChunks : [],
  };
}

function getCurrentData() {
  if (state.currentScenario === 'live') return state.live;
  if (state.currentScenario.startsWith('zip-')) {
    return state.zipScenarios.find((scenario) => `zip-${scenario.id}` === state.currentScenario)?.data || state.live;
  }
  return state.scenarioData[state.currentScenario] || state.live;
}

function updateEvidenceSummary(data = getCurrentData()) {
  const sessionName = state.currentScenario === 'live'
    ? 'Live session'
    : state.zipScenarios.find((scenario) => `zip-${scenario.id}` === state.currentScenario)?.name
      || state.scenarios.find((scenario) => String(scenario.id || scenario.date) === state.currentScenario)?.name
      || 'Saved session';
  const screenshotCount = Array.isArray(data.screenshots) ? data.screenshots.length : 0;
  const requestCount = Array.isArray(data.networkLogs) ? data.networkLogs.length : 0;
  const hasVideo = Array.isArray(data.videoChunks) && data.videoChunks.length > 0;
  evidenceSummary.textContent = `Viewing ${sessionName}: ${screenshotCount} screenshots, ${requestCount} network requests, video ${hasVideo ? 'available' : 'not available'}.`;
}

function getTimelineWindow(data) {
  return TimelineLogic.getTimelineWindow(data);
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function safeCopyText(value) {
  if (!value && value !== 0) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function setVideoSource(data, selectedIndex = 0) {
  videoEl.pause();
  const chunks = data.videoChunks || [];
  const recordings = chunks.filter((chunk) => typeof chunk === 'string' && chunk.length > 0);
  recordingControls.hidden = recordings.length < 2;
  recordingSelect.innerHTML = '';
  recordings.forEach((_, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `Recording ${index + 1}`;
    recordingSelect.appendChild(option);
  });
  const source = recordings[selectedIndex] || recordings.find((chunk) => chunk.includes('data:video')) || recordings[0] || null;
  if (!source) {
    videoEl.removeAttribute('src');
    videoEl.load();
    videoWrap.classList.add('no-video');
    videoEl.style.display = 'none';
    playToggle.disabled = true;
    state.videoDuration = 0;
    updatePlaybackState();
    return;
  }

  videoWrap.classList.remove('no-video');
  videoEl.style.display = 'block';
  playToggle.disabled = false;
  recordingSelect.value = String(Math.max(0, recordings.indexOf(source)));
  videoEl.src = source;
  videoEl.load();
  videoEl.currentTime = 0;
  state.videoDuration = 0;
  state.currentTimeMs = 0;
  videoEl.onloadedmetadata = () => {
    state.videoDuration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
    updatePlaybackState();
  };
}

function getVisibleLogs(data = getCurrentData()) {
  return TimelineLogic.getVisibleNetworkEntries(data, state.currentTimeMs, { ...state.filter, useRegex: state.useRegex })
    .map(({ log }) => log);
}

function getVisibleScreenshot(data = getCurrentData()) {
  return TimelineLogic.getVisibleScreenshot(data, state.currentTimeMs);
}

function renderTimelineMini() {
  const visibleScreenshot = getVisibleScreenshot();

  if (!visibleScreenshot) {
    screenshotBox.className = 'shot-frame empty';
    screenshotBox.textContent = 'No screenshot available';
    screenshotBox.onclick = null;
    screenshotBox.onkeydown = null;
    screenshotBox.removeAttribute('role');
    screenshotBox.removeAttribute('tabindex');
    screenshotBox.removeAttribute('aria-label');
  } else {
    screenshotBox.className = 'shot-frame';
    screenshotBox.innerHTML = '';
    const image = document.createElement('img');
    image.src = visibleScreenshot.dataUrl;
    image.alt = visibleScreenshot.name || 'Screenshot';
    screenshotBox.appendChild(image);
    screenshotBox.onclick = () => openModal(visibleScreenshot.dataUrl);
    screenshotBox.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openModal(visibleScreenshot.dataUrl);
      }
    };
    screenshotBox.setAttribute('role', 'button');
    screenshotBox.tabIndex = 0;
    screenshotBox.setAttribute('aria-label', `Open screenshot ${visibleScreenshot.name || ''} full screen`);
  }
}

function renderNetworkTable() {
  const data = getCurrentData();
  const visible = TimelineLogic.getVisibleNetworkEntries(data, state.currentTimeMs, { ...state.filter, useRegex: state.useRegex });
  visible.sort((a, b) => compareNetworkValues(a.log, b.log, state.sort));
  networkCount.textContent = `${visible.length} of ${(data.networkLogs || []).length} requests visible at this timeline position.`;

  if (!visible.length) {
    networkTableBody.innerHTML = '<tr><td colspan="6"><div class="empty-message">No network entries match the current filters.</div></td></tr>';
    detailPanel.innerHTML = '<div class="empty-message">Nothing selected.</div>';
    networkPagination.textContent = '';
    state.selectedLogId = null;
    state.networkPage = 0;
    renderWatchResults([]);
    return;
  }

  if (state.selectedLogId == null || !visible.some(({ rowKey }) => rowKey === state.selectedLogId)) {
    state.selectedLogId = visible[visible.length - 1].rowKey;
  }

  const selectedIndex = visible.findIndex(({ rowKey }) => rowKey === state.selectedLogId);
  const pageCount = Math.ceil(visible.length / NETWORK_PAGE_SIZE);
  state.networkPage = Math.min(Math.max(state.networkPage, 0), pageCount - 1);
  if (selectedIndex >= 0) state.networkPage = Math.floor(selectedIndex / NETWORK_PAGE_SIZE);
  const pageStart = state.networkPage * NETWORK_PAGE_SIZE;
  const pageEntries = visible.slice(pageStart, pageStart + NETWORK_PAGE_SIZE);

  networkTableBody.innerHTML = pageEntries.map(({ log, rowKey }) => {
    const selected = rowKey === (state.selectedLogId || '');
    const statusCode = log.status || 0;
    let cls = '';
    if (statusCode >= 200 && statusCode < 300) cls = 'status-2xx';
    else if (statusCode >= 300 && statusCode < 400) cls = 'status-3xx';
    else if (statusCode >= 400 && statusCode < 500) cls = 'status-4xx';
    else if (statusCode >= 500 && statusCode < 600) cls = 'status-5xx';
    return `
      <tr class="clickable ${selected ? 'selected-row' : ''}" data-row-key="${rowKey}" tabindex="0" aria-label="Select ${escapeHtml(log.method || 'GET')} request to ${escapeHtml(log.url || 'Unknown URL')}" aria-selected="${selected}" style="${selected ? 'background: rgba(255,255,255,0.08);' : ''}">
        <td>${parseTime(log.timestamp) != null ? escapeHtml(new Date(log.timestamp).toLocaleTimeString()) : '—'}</td>
        <td><span class="method ${escapeHtml(log.method || 'GET')}">${escapeHtml(log.method || 'GET')}</span></td>
        <td title="${escapeHtml(log.url || '')}">${escapeHtml(log.url || 'Unknown URL')}</td>
        <td><span class="status-pill ${cls}">${statusCode || '—'}</span></td>
        <td>${escapeHtml(log.mimeType || '—')}</td>
        <td>${escapeHtml(log.resourceType || '—')}</td>
      </tr>
    `;
  }).join('');

  networkTableBody.querySelectorAll('tr.clickable').forEach((row) => {
    const selectRow = () => {
      state.selectedLogId = row.dataset.rowKey;
      renderNetworkTable();
    };
    row.addEventListener('click', selectRow);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectRow();
      }
    });
  });

  const pageEnd = Math.min(pageStart + pageEntries.length, visible.length);
  networkPagination.innerHTML = `
    <span>Showing ${pageStart + 1}–${pageEnd} of ${visible.length}</span>
    <button id="previousNetworkPage" class="secondary-btn" type="button" ${state.networkPage === 0 ? 'disabled' : ''} aria-label="Previous network page">Previous</button>
    <span>Page ${state.networkPage + 1} of ${pageCount}</span>
    <button id="nextNetworkPage" class="secondary-btn" type="button" ${state.networkPage >= pageCount - 1 ? 'disabled' : ''} aria-label="Next network page">Next</button>
  `;
  networkPagination.querySelector('#previousNetworkPage').addEventListener('click', () => changeNetworkPage(-1, visible));
  networkPagination.querySelector('#nextNetworkPage').addEventListener('click', () => changeNetworkPage(1, visible));
  document.querySelectorAll('.sortable-heading').forEach((heading) => {
    const column = heading.dataset.sort;
    const arrow = state.sort.col === column ? (state.sort.asc ? ' ▲' : ' ▼') : '';
    heading.textContent = `${{ timestamp: 'Time', method: 'Method', url: 'URL', status: 'Status', mimeType: 'MIME', resourceType: 'Type' }[column]}${arrow}`;
    heading.setAttribute('aria-sort', state.sort.col === column ? (state.sort.asc ? 'ascending' : 'descending') : 'none');
    heading.onclick = () => {
      state.sort = {
        col: column,
        asc: state.sort.col === column ? !state.sort.asc : true,
      };
      state.networkPage = 0;
      updatePlaybackState();
    };
  });

  renderNetworkDetail();
  renderWatchResults(visible.map(({ log }) => log));
}

function compareNetworkValues(a, b, sort) {
  const left = a[sort.col];
  const right = b[sort.col];
  let result;
  if (sort.col === 'timestamp') {
    const leftTime = parseTime(left);
    const rightTime = parseTime(right);
    if (leftTime == null) return rightTime == null ? 0 : 1;
    if (rightTime == null) return -1;
    result = leftTime - rightTime;
  } else if (sort.col === 'status') {
    result = Number(left || 0) - Number(right || 0);
  } else {
    result = String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base' });
  }
  return (sort.asc ? result : -result);
}

function changeNetworkPage(offset, visible) {
  const nextPage = Math.min(
    Math.max(state.networkPage + offset, 0),
    Math.ceil(visible.length / NETWORK_PAGE_SIZE) - 1,
  );
  if (nextPage === state.networkPage) return;
  state.networkPage = nextPage;
  state.selectedLogId = visible[nextPage * NETWORK_PAGE_SIZE].rowKey;
  renderNetworkTable();
}

function renderNetworkDetail() {
  const data = getCurrentData();
  const logs = Array.isArray(data.networkLogs) ? data.networkLogs : [];
  const selectedIndex = Number(String(state.selectedLogId || '').slice('row-'.length));
  const selected = Number.isInteger(selectedIndex) && selectedIndex >= 0 ? logs[selectedIndex] : null;
  if (!selected) {
    detailPanel.innerHTML = '<div class="empty-message">Select a request row to inspect request and response details.</div>';
    return;
  }

  const formatBody = (value) => {
    if (value == null || value === '') return '';
    if (typeof value !== 'string') return JSON.stringify(value, null, 2);
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  };
  const requestHeaders = safeCopyText(selected.requestHeaders || {});
  const requestBody = formatBody(selected.requestBody);
  const responseHeaders = safeCopyText(selected.responseHeaders || {});
  const responseBody = formatBody(selected.responseBody);
  const bodyMetadata = selected.responseBodyTruncated
    ? `Response body truncated; original size ${(Number(selected.responseBodyOriginalSize || 0) / 1024).toFixed(1)} KB.`
    : '';
  detailPanel.innerHTML = `
    <div class="detail-summary"><strong>${escapeHtml(selected.method || 'UNKNOWN')} ${escapeHtml(selected.url || 'Unknown URL')}</strong> · Status ${escapeHtml(selected.status ?? 'Pending')} · MIME ${escapeHtml(selected.mimeType || '—')} · Type ${escapeHtml(selected.resourceType || '—')} · ${parseTime(selected.timestamp) == null ? 'Time —' : escapeHtml(new Date(selected.timestamp).toLocaleString())}</div>
    <div class="detail-grid">
      <div class="detail-box">
        <h4>Request</h4>
        <pre>${escapeHtml(requestHeaders || 'No request headers captured.')}</pre>
        <h4>Request body</h4>
        <pre>${escapeHtml(requestBody || 'No request body captured.')}</pre>
      </div>
      <div class="detail-box">
        <h4>Response</h4>
        <pre>${escapeHtml(responseHeaders || 'No response headers captured.')}</pre>
        <h4>Response body ${selected.responseBodyBase64Encoded ? '(base64)' : ''} ${selected.responseBodyTruncated ? '(truncated)' : ''}</h4>
        <pre>${escapeHtml(responseBody || 'No response body captured.')}</pre>
        ${bodyMetadata ? `<div class="detail-summary">${escapeHtml(bodyMetadata)}</div>` : ''}
      </div>
    </div>
  `;
}

function updatePlaybackState() {
  const data = getCurrentData();
  const timelineWindow = getTimelineWindow(data);
  state.captureStart = timelineWindow.start;
  state.captureEnd = timelineWindow.end;

  if (state.videoDuration > 0 && state.captureEnd > state.captureStart) {
    const safeRatio = TimelineLogic.getSeekRatio(state.currentTimeMs, timelineWindow);
    seekBar.value = String(Math.round(safeRatio * 1000));
    const currentVideoTime = safeRatio * state.videoDuration;
    timeReadout.textContent = `${formatClock(currentVideoTime * 1000)} / ${formatClock(state.videoDuration * 1000)}`;
  } else {
    const totalRange = Math.max(0, state.captureEnd - state.captureStart);
    seekBar.value = String(Math.round(TimelineLogic.getSeekRatio(state.currentTimeMs, timelineWindow) * 1000));
    timeReadout.textContent = `${formatClock(Math.max(0, state.currentTimeMs - (state.captureStart || 0)))} / ${formatClock(totalRange)}`;
  }

  renderTimelineMini();
  renderNetworkTable();
  renderWatchList();
}

function syncFromVideo() {
  if (state.videoDuration <= 0) {
    return;
  }
  const data = getCurrentData();
  const timelineWindow = getTimelineWindow(data);
  if (timelineWindow.end <= timelineWindow.start) {
    state.currentTimeMs = timelineWindow.start;
  } else {
    const ratio = videoEl.currentTime / state.videoDuration;
    state.currentTimeMs = timelineWindow.start + ratio * (timelineWindow.end - timelineWindow.start);
  }
  updatePlaybackState();
}

function seekToRatio(value) {
  const ratio = Math.min(Math.max(value, 0), 1);
  const data = getCurrentData();
  const timelineWindow = getTimelineWindow(data);
  if (state.videoDuration > 0) {
    videoEl.currentTime = ratio * state.videoDuration;
    syncFromVideo();
  } else if (timelineWindow.end > timelineWindow.start) {
    state.currentTimeMs = TimelineLogic.getTimeAtSeekRatio(ratio, timelineWindow);
    updatePlaybackState();
  }
}

async function loadLiveData() {
  const res = await send({ action: 'getEvidenceReadonly' });
  if (!res || res.error) throw new Error(res?.error || 'No response while loading live evidence.');
  state.live = toDisplayData(res);
  if (state.currentScenario === 'live') {
    setVideoSource(state.live);
    const timelineWindow = getTimelineWindow(state.live);
    state.currentTimeMs = timelineWindow.start || 0;
    updateEvidenceSummary(state.live);
    updatePlaybackState();
  }
}

async function loadScenarios() {
  const res = await send({ action: 'getScenarios' });
  if (!res || res.error) throw new Error(res?.error || 'No response while loading saved sessions.');
  if (!Array.isArray(res.scenarios)) throw new Error('The saved sessions response was invalid.');
  state.scenarios = res.scenarios;

  const validCurrent = state.currentScenario === 'live'
    || state.scenarios.some((sc) => String(sc.id || sc.date) === state.currentScenario)
    || state.zipScenarios.some((sc) => `zip-${sc.id}` === state.currentScenario);
  state.currentScenario = validCurrent ? state.currentScenario : 'live';
  renderScenarioList();
}

function renderScenarioList() {
  const query = sessionSearch.value.trim().toLowerCase();
  const matchingScenarios = state.scenarios.filter((scenario) => {
    const localizedDate = scenario.date ? new Date(scenario.date).toLocaleString() : '';
    const searchable = `${scenario.name || 'Saved scenario'} ${scenario.date || ''} ${localizedDate} ${scenario.id || ''}`.toLowerCase();
    return searchable.includes(query);
  });
  const matchingZips = state.zipScenarios.filter((scenario) => `${scenario.name} ${scenario.date || ''}`.toLowerCase().includes(query));
  const savedCurrent = state.scenarios.find((scenario) => String(scenario.id || scenario.date) === state.currentScenario);
  const zipCurrent = state.zipScenarios.find((scenario) => `zip-${scenario.id}` === state.currentScenario);
  const currentIsMatching = matchingScenarios.some((scenario) => String(scenario.id || scenario.date) === state.currentScenario)
    || matchingZips.some((scenario) => scenario.id === zipCurrent?.id);
  const scenariosToShow = [...matchingScenarios];
  if (savedCurrent && !currentIsMatching) scenariosToShow.unshift(savedCurrent);
  const zipsToShow = [...matchingZips];
  if (zipCurrent && !currentIsMatching) zipsToShow.unshift(zipCurrent);

  sessionTotal.textContent = String(state.scenarios.length + state.zipScenarios.length);
  scenarioList.innerHTML = '';
  scenarioList.appendChild(createSessionCard({
    id: 'live',
    name: 'Live Session',
    date: '',
    data: state.live,
    active: state.currentScenario === 'live',
    isLive: true,
  }));
  for (const scenario of scenariosToShow) {
    scenarioList.appendChild(createSessionCard({
      ...scenario,
      id: String(scenario.id || scenario.date),
      data: scenario,
      active: String(scenario.id || scenario.date) === state.currentScenario,
      type: 'saved',
      pinned: String(scenario.id || scenario.date) === state.currentScenario
        && !matchingScenarios.some((match) => String(match.id || match.date) === state.currentScenario),
    }));
  }
  for (const scenario of zipsToShow) {
    scenarioList.appendChild(createSessionCard({
      ...scenario,
      id: `zip-${scenario.id}`,
      active: `zip-${scenario.id}` === state.currentScenario,
      type: 'zip',
      pinned: scenario.id === zipCurrent?.id && !matchingZips.some((match) => match.id === scenario.id),
    }));
  }

  sessionMatchCount.textContent = query
    ? `${matchingScenarios.length + matchingZips.length} of ${state.scenarios.length + state.zipScenarios.length} sessions match${!currentIsMatching && state.currentScenario !== 'live' ? ' · current session stays pinned' : ''}.`
    : `${state.scenarios.length + state.zipScenarios.length} sessions`;
  if (query && matchingScenarios.length === 0 && matchingZips.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = 'No sessions match this search.';
    scenarioList.appendChild(empty);
  }
}

function createSessionCard({ id, name, date, data, active, isLive = false, pinned = false, type = 'saved' }) {
  const entry = document.createElement('div');
  entry.className = 'session-entry';
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `session-card session-card-select${active ? ' active' : ''}`;
  card.setAttribute('aria-pressed', String(active));
  card.setAttribute('aria-label', `View ${name || 'Saved session'} evidence`);

  const title = document.createElement('span');
  title.className = 'session-card-name';
  title.textContent = name || 'Saved scenario';
  card.appendChild(title);

  const screenshots = Array.isArray(data?.screenshots) ? data.screenshots.length : 0;
  const requests = Array.isArray(data?.networkLogs) ? data.networkLogs.length : 0;
  const videos = Array.isArray(data?.videoChunks) ? data.videoChunks.length : 0;
  const stats = document.createElement('span');
  stats.className = 'session-card-stats';
  const screenshotCount = data?.screenshotCount ?? screenshots;
  const requestCount = data?.networkLogCount ?? requests;
  const videoCount = data?.videoCount ?? videos;
  stats.textContent = `${screenshotCount} screenshots · ${requestCount} requests · ${videoCount ? 'video' : 'no video'}`;
  card.appendChild(stats);

  if (date) {
    const dateLabel = document.createElement('span');
    dateLabel.className = 'session-card-date';
    const parsedDate = new Date(date);
    dateLabel.textContent = Number.isNaN(parsedDate.getTime()) ? String(date) : parsedDate.toLocaleString();
    card.appendChild(dateLabel);
  }
  if (isLive) {
    const liveLabel = document.createElement('span');
    liveLabel.className = 'session-card-current';
    liveLabel.textContent = 'Current live evidence';
    card.appendChild(liveLabel);
  } else if (pinned) {
    const currentLabel = document.createElement('span');
    currentLabel.className = 'session-card-current';
    currentLabel.textContent = 'Current selection · outside search';
    card.appendChild(currentLabel);
  }

  card.addEventListener('click', () => applyScenarioSelection(isLive ? 'live' : id));
  entry.appendChild(card);
  if (!isLive) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'session-delete';
    remove.appendChild(createIcon('m18.3 5.7-1.4-1.4L12 9.2 7.1 4.3 5.7 5.7l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z'));
    remove.setAttribute('aria-label', `${type === 'zip' ? 'Remove imported ZIP' : 'Delete saved session'} ${name || ''}`);
    remove.title = type === 'zip' ? 'Remove imported ZIP' : 'Delete saved session';
    remove.addEventListener('click', async () => {
      if (type === 'zip') {
        state.zipScenarios = state.zipScenarios.filter((scenario) => `zip-${scenario.id}` !== id);
      } else {
        try {
          const result = await send({ action: 'deleteScenario', id });
          if (result?.error) throw new Error(result.error);
          state.scenarios = result?.scenarios || state.scenarios.filter((scenario) => String(scenario.id || scenario.date) !== id);
        } catch (error) {
          sidebarFeedback.textContent = `Could not delete session: ${error.message}`;
          return;
        }
      }
      if (state.currentScenario === id) applyScenarioSelection('live');
      else renderScenarioList();
    });
    entry.appendChild(remove);
  }
  return entry;
}

async function applyScenarioSelection(scenarioId = state.currentScenario) {
  if (scenarioId !== 'live' && !scenarioId.startsWith('zip-') && !state.scenarioData[scenarioId]) {
    sidebarFeedback.textContent = 'Loading saved evidence…';
    try {
      const response = await send({ action: 'getScenario', id: scenarioId });
      if (!response || response.error) throw new Error(response?.error || 'Could not load saved evidence.');
      state.scenarioData[scenarioId] = toDisplayData(response.scenario);
    } catch (error) {
      sidebarFeedback.textContent = `Could not load saved evidence: ${error.message}`;
      return;
    }
  }
  state.currentScenario = scenarioId;
  const data = getCurrentData();
  updateEvidenceSummary(data);
  setVideoSource(data);
  const timelineWindow = getTimelineWindow(data);
  state.currentTimeMs = timelineWindow.start || 0;
  state.selectedLogId = null;
  state.networkPage = 0;
  renderScenarioList();
  updatePlaybackState();
}

async function refreshEvidenceSessions() {
  sidebarFeedback.textContent = 'Refreshing evidence sessions…';
  try {
    await Promise.all([loadLiveData(), loadScenarios()]);
    renderScenarioList();
    sidebarFeedback.textContent = 'Evidence sessions refreshed.';
  } catch (error) {
    sidebarFeedback.textContent = `Could not refresh sessions: ${error.message}`;
  }
}

async function parseEvidenceZip(file) {
  const zip = await ZipSafety.loadSafeZip(file);
  const evidence = { screenshots: [], networkLogs: [], videoChunks: [] };
  const networkFile = zip.file('network_logs.json');
  if (networkFile) {
    try {
      const parsedLogs = JSON.parse(await networkFile.async('string'));
      if (!Array.isArray(parsedLogs)) {
        throw new Error('network_logs.json must contain an array.');
      }
      evidence.networkLogs = parsedLogs;
    } catch (error) {
      throw new Error(`Invalid network_logs.json in ZIP: ${error.message}`);
    }
  }

  const screenshotFolder = zip.folder('screenshots');
  if (screenshotFolder) {
    const files = [];
    screenshotFolder.forEach((path, entry) => {
      if (!entry.dir) files.push({ path, entry });
    });
    for (const { path, entry } of files) {
      const extension = path.split('.').pop()?.toLowerCase();
      const mime = extension === 'png' ? 'image/png' : ['jpg', 'jpeg'].includes(extension) ? 'image/jpeg' : null;
      if (!mime) throw new Error(`Unsupported screenshot format: ${path}`);
      evidence.screenshots.push({
        name: path,
        dataUrl: `data:${mime};base64,${await entry.async('base64')}`,
      });
    }
  }

  const videoFolder = zip.folder('videos');
  if (videoFolder) {
    const files = [];
    videoFolder.forEach((path, entry) => {
      if (!entry.dir) files.push({ path, entry });
    });
    for (const { path, entry } of files) {
      if (!path.toLowerCase().endsWith('.webm')) throw new Error(`Unsupported video format: ${path}`);
      evidence.videoChunks.push(`data:video/webm;base64,${await entry.async('base64')}`);
    }
  }

  const metadataFile = zip.file('metadata.json');
  let metadata = {};
  if (metadataFile) {
    try {
      const parsed = JSON.parse(await metadataFile.async('string'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('metadata.json must contain an object.');
      }
      metadata = parsed;
    } catch (error) {
      throw new Error(`Invalid metadata.json in ZIP: ${error.message}`);
    }
  }
  return {
    name: metadata.name || file.name.replace(/\.zip$/i, ''),
    date: metadata.date || new Date().toISOString(),
    data: evidence,
  };
}

async function importEvidenceFiles(files) {
  for (const file of Array.from(files || [])) {
    if (!/\.zip$/i.test(file.name)) {
      sidebarFeedback.textContent = `${file.name}: choose a ZIP file.`;
      continue;
    }
    sidebarFeedback.textContent = `Importing ${file.name}…`;
    try {
      const imported = await parseEvidenceZip(file);
      const id = state.nextZipId++;
      state.zipScenarios.unshift({ id, ...imported });
        await applyScenarioSelection(`zip-${id}`);
      sidebarFeedback.textContent = `Imported ${file.name}.`;
    } catch (error) {
      sidebarFeedback.textContent = `Could not import ${file.name}: ${error.message}`;
    }
  }
  zipFileInput.value = '';
}

async function downloadCurrentEvidence() {
  const data = getCurrentData();
  if (!data.screenshots.length && !data.networkLogs.length && !data.videoChunks.length) {
    showActionStatus('This session has no evidence to export.', true);
    return;
  }
  try {
    const zip = new JSZip();
    const screenshotFolder = zip.folder('screenshots');
    for (const [index, shot] of data.screenshots.entries()) {
      const [, mime = 'image/png', base64 = ''] = String(shot.dataUrl || '').match(/^data:([^;]+);base64,(.*)$/s) || [];
      if (!base64) continue;
      const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
      screenshotFolder.file(shot.name || `screenshot-${index + 1}.${ext}`, base64, { base64: true });
    }
    if (data.networkLogs.length) zip.file('network_logs.json', JSON.stringify(data.networkLogs, null, 2));
    const videoFolder = zip.folder('videos');
    for (const [index, chunk] of data.videoChunks.entries()) {
      const match = String(chunk).match(/^data:[^;]+;base64,(.*)$/s);
      if (match) videoFolder.file(`recording_${index + 1}.webm`, match[1], { base64: true });
    }
    zip.file('metadata.json', JSON.stringify({
      name: state.currentScenario === 'live' ? 'live_session' : state.scenarios.find((scenario) => String(scenario.id || scenario.date) === state.currentScenario)?.name
        || state.zipScenarios.find((scenario) => `zip-${scenario.id}` === state.currentScenario)?.name || 'evidence',
      date: new Date().toISOString(),
      screenshotCount: data.screenshots.length,
      networkLogCount: data.networkLogs.length,
      videoCount: data.videoChunks.length,
      version: '1.0.0',
    }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'evidence-session.zip';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showActionStatus('Evidence ZIP downloaded.');
  } catch (error) {
    showActionStatus(`Evidence ZIP could not be created: ${error.message}`, true);
  }
}

async function getStoredValue(key) {
  if (chrome.storage?.local) {
    const stored = await chrome.storage.local.get(key);
    return stored[key];
  }
  const serialized = localStorage.getItem(key);
  return serialized == null ? null : JSON.parse(serialized);
}

async function setStoredValues(values) {
  if (chrome.storage?.local) {
    await chrome.storage.local.set(values);
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    localStorage.setItem(key, JSON.stringify(value));
  }
}

function normalizeFilterPreset(preset) {
  if (!preset || typeof preset.name !== 'string' || !preset.filter || typeof preset.filter !== 'object') return null;
  return {
    name: preset.name,
    filter: {
      url: String(preset.filter.url || ''),
      method: String(preset.filter.method || ''),
      status: String(preset.filter.status || preset.filter.statusRange || ''),
      mime: String(preset.filter.mime || preset.filter.mimeType || ''),
    },
    useRegex: {
      url: Boolean(preset.useRegex?.url),
      mime: Boolean(preset.useRegex?.mime || preset.useRegex?.mimeType),
    },
  };
}

async function loadSavedPresets() {
  try {
    const stored = await getStoredValue('filterPresets');
    if (Array.isArray(stored)) {
      state.savedPresets = stored.map(normalizeFilterPreset).filter(Boolean);
    } else {
      const legacy = JSON.parse(localStorage.getItem('timeline-presets') || '[]');
      state.savedPresets = Array.isArray(legacy) ? legacy.map(normalizeFilterPreset).filter(Boolean) : [];
    }
    renderPresetChips();
  } catch (error) {
    state.savedPresets = [];
    renderPresetChips();
    showActionStatus(`Saved filters could not be loaded: ${error.message}`, true);
  }
}

function applyFilterPreset(preset) {
  const normalized = normalizeFilterPreset(preset);
  if (!normalized) {
    showActionStatus('This saved filter is invalid.', true);
    return;
  }
  state.filter = { ...normalized.filter };
  state.useRegex = { ...normalized.useRegex };
  urlFilter.value = state.filter.url;
  methodFilter.value = state.filter.method;
  statusFilter.value = state.filter.status;
  mimeFilter.value = state.filter.mime;
  updateRegexToggles();
  state.networkPage = 0;
  state.selectedLogId = null;
  showActionStatus(`Loaded filter "${normalized.name}".`);
  updatePlaybackState();
}

async function deletePreset(index) {
  const next = state.savedPresets.filter((_, savedIndex) => savedIndex !== index);
  try {
    await setStoredValues({ filterPresets: next });
    state.savedPresets = next;
    renderPresetChips();
    showActionStatus('Saved filter removed.');
  } catch (error) {
    showActionStatus(`Saved filter could not be removed: ${error.message}`, true);
  }
}

function renderPresetChips() {
  const saved = state.savedPresets;
  presetPills.innerHTML = '';
  if (!saved.length) {
    const empty = document.createElement('span');
    empty.className = 'chip-btn';
    empty.textContent = 'No saved filters';
    presetPills.appendChild(empty);
    return;
  }

  saved.forEach((preset, index) => {
    const chip = document.createElement('span');
    chip.className = 'preset-chip';
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'chip-btn';
    load.textContent = preset.name;
    load.addEventListener('click', () => applyFilterPreset(preset));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-preset';
    remove.appendChild(createIcon('m18.3 5.7-1.4-1.4L12 9.2 7.1 4.3 5.7 5.7l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z'));
    remove.setAttribute('aria-label', `Delete filter preset ${preset.name}`);
    remove.addEventListener('click', () => deletePreset(index));
    chip.append(load, remove);
    presetPills.appendChild(chip);
  });
}

async function savePreset() {
  const name = (presetName.value || '').trim();
  if (!name) {
    showActionStatus('Enter a name before saving this filter.', true);
    presetName.focus();
    return;
  }
  try {
    const saved = [...state.savedPresets];
    const record = { name, filter: { ...state.filter }, useRegex: { ...state.useRegex } };
    const existing = saved.findIndex((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0) saved[existing] = record;
    else saved.push(record);
    await setStoredValues({ filterPresets: saved });
    state.savedPresets = saved;
    presetName.value = '';
    renderPresetChips();
    showActionStatus(`Saved filter "${name}".`);
  } catch (error) {
    showActionStatus(`Filter could not be saved: ${error.message}`, true);
  }
}

async function shareFilterPresets() {
  if (!state.savedPresets.length) {
    showActionStatus('There are no filter presets to share.', true);
    return;
  }
  await copyTextToClipboard(JSON.stringify(state.savedPresets, null, 2));
}

async function importFilterPresets() {
  try {
    const imported = JSON.parse(presetImportText.value);
    if (!Array.isArray(imported)) throw new Error('Preset data must be a JSON array.');
    const normalized = imported.map(normalizeFilterPreset);
    if (normalized.some((preset) => !preset)) throw new Error('Every preset needs a name and filter object.');
    await setStoredValues({ filterPresets: normalized });
    state.savedPresets = normalized;
    presetImportText.value = '';
    presetImportArea.hidden = true;
    renderPresetChips();
    showActionStatus(`Imported ${normalized.length} filter presets.`);
  } catch (error) {
    showActionStatus(`Filter presets could not be imported: ${error.message}`, true);
  }
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

function extractJsonPath(value, path) {
  if (!path) return undefined;
  return path.split('.').reduce((current, segment) => {
    if (current == null) return undefined;
    const match = segment.match(/^([^\[]+)\[(\d+)\]$/);
    return match ? current[match[1]]?.[Number(match[2])] : current[segment];
  }, value);
}

async function loadWatchFeatures() {
  try {
    const [trackers, trackerPresets] = await Promise.all([
      getStoredValue('trackedVariables'),
      getStoredValue('trackerPresets'),
    ]);
    state.trackers = Array.isArray(trackers) ? trackers : [];
    state.trackerPresets = Array.isArray(trackerPresets) ? trackerPresets : [];
    renderWatchList();
    renderWatchPresets();
    updatePlaybackState();
  } catch (error) {
    showActionStatus(`Watch expressions could not be loaded: ${error.message}`, true);
  }
}

function renderWatchList() {
  watchList.innerHTML = '';
  for (const tracker of state.trackers) {
    const item = document.createElement('span');
    item.className = 'watch-item';
    item.textContent = `${tracker.name} · ${tracker.source === 'requestBody' ? 'request' : 'response'} · ${tracker.path}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.appendChild(createIcon('m18.3 5.7-1.4-1.4L12 9.2 7.1 4.3 5.7 5.7l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z'));
    remove.setAttribute('aria-label', `Remove watch ${tracker.name}`);
    remove.addEventListener('click', () => updateTrackers(state.trackers.filter((entry) => entry.id !== tracker.id)));
    item.appendChild(remove);
    watchList.appendChild(item);
  }
  if (!state.trackers.length) {
    const empty = document.createElement('span');
    empty.className = 'session-empty';
    empty.textContent = 'No watch expressions yet.';
    watchList.appendChild(empty);
  }
  watchToggle.textContent = `Watch expressions${state.trackers.length ? ` (${state.trackers.length})` : ''}`;
}

async function updateTrackers(trackers) {
  try {
    await setStoredValues({ trackedVariables: trackers });
    state.trackers = trackers;
    renderWatchList();
    updatePlaybackState();
  } catch (error) {
    showActionStatus(`Watch expressions could not be saved: ${error.message}`, true);
  }
}

function addWatchExpression() {
  const name = watchName.value.trim();
  const path = watchPath.value.trim();
  if (!name || !path) {
    showActionStatus('Enter a variable name and JSON path for the watch.', true);
    return;
  }
  const tracker = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    path,
    source: watchSource.value,
  };
  updateTrackers([...state.trackers, tracker]);
  watchName.value = '';
  watchPath.value = '';
}

function renderWatchPresets() {
  watchPresetPills.innerHTML = '';
  state.trackerPresets.forEach((preset, index) => {
    const chip = document.createElement('span');
    chip.className = 'preset-chip';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'chip-btn';
    apply.textContent = preset.name;
    apply.addEventListener('click', async () => {
      if (!Array.isArray(preset.trackers)) {
        showActionStatus('This watch preset is invalid.', true);
        return;
      }
      const normalizedFilter = normalizeFilterPreset({ name: preset.name, filter: preset.filter || {}, useRegex: preset.useRegex });
      if (normalizedFilter) {
        state.filter = normalizedFilter.filter;
        state.useRegex = normalizedFilter.useRegex;
        urlFilter.value = state.filter.url;
        methodFilter.value = state.filter.method;
        statusFilter.value = state.filter.status;
        mimeFilter.value = state.filter.mime;
        updateRegexToggles();
      }
      await updateTrackers(preset.trackers);
      showActionStatus(`Loaded watch preset "${preset.name}".`);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-preset';
    remove.appendChild(createIcon('m18.3 5.7-1.4-1.4L12 9.2 7.1 4.3 5.7 5.7l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z'));
    remove.setAttribute('aria-label', `Delete watch preset ${preset.name}`);
    remove.addEventListener('click', () => {
      const next = state.trackerPresets.filter((_, presetIndex) => presetIndex !== index);
      saveWatchPresets(next);
    });
    chip.append(apply, remove);
    watchPresetPills.appendChild(chip);
  });
}

async function saveWatchPresets(presets) {
  try {
    await setStoredValues({ trackerPresets: presets });
    state.trackerPresets = presets;
    renderWatchPresets();
  } catch (error) {
    showActionStatus(`Watch presets could not be saved: ${error.message}`, true);
  }
}

async function saveWatchPreset() {
  const name = watchPresetName.value.trim();
  if (!name || !state.trackers.length) {
    showActionStatus('Name the watch preset and add at least one watch expression.', true);
    return;
  }
  const preset = {
    name,
    filter: { ...state.filter, statusRange: state.filter.status, mimeType: state.filter.mime },
    useRegex: { url: state.useRegex.url, mimeType: state.useRegex.mime },
    trackers: [...state.trackers],
  };
  const next = [...state.trackerPresets.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase()), preset];
  await saveWatchPresets(next);
  watchPresetName.value = '';
  showActionStatus(`Saved watch preset "${name}".`);
}

async function shareWatchPresets() {
  if (!state.trackerPresets.length) {
    showActionStatus('There are no watch presets to share.', true);
    return;
  }
  await copyTextToClipboard(JSON.stringify(state.trackerPresets, null, 2));
}

async function importWatchPresets() {
  try {
    const parsed = JSON.parse(watchImportText.value);
    if (!Array.isArray(parsed) || parsed.some((preset) => !preset || typeof preset.name !== 'string' || !Array.isArray(preset.trackers))) {
      throw new Error('Expected an array of named watch presets.');
    }
    await saveWatchPresets(parsed);
    watchImportText.value = '';
    watchImportArea.hidden = true;
    showActionStatus(`Imported ${parsed.length} watch presets.`);
  } catch (error) {
    showActionStatus(`Watch presets could not be imported: ${error.message}`, true);
  }
}

function renderWatchResults(logs = []) {
  watchResults.innerHTML = '';
  if (!state.trackers.length) return;
  const rows = [];
  for (const log of logs) {
    const values = state.trackers.map((tracker) => {
      const parsed = parseJsonValue(log[tracker.source]);
      const paths = String(tracker.path || '').split(',').map((path) => path.trim()).filter(Boolean);
      return paths.map((path) => extractJsonPath(parsed, path));
    });
    if (values.every((trackerValues) => trackerValues.every((value) => value === undefined))) continue;
    rows.push({ log, values });
  }
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-message';
    empty.textContent = 'No watched values found in network entries visible at this time.';
    watchResults.appendChild(empty);
    return;
  }
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const tracker of state.trackers) {
    const cell = document.createElement('th');
    cell.textContent = `${tracker.name} (${tracker.source === 'requestBody' ? 'request' : 'response'}: ${tracker.path})`;
    headerRow.appendChild(cell);
  }
  for (const label of ['Time', 'Method', 'URL']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    headerRow.appendChild(cell);
  }
  head.appendChild(headerRow);
  table.appendChild(head);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    row.values.forEach((values) => {
      const cell = document.createElement('td');
      cell.textContent = values.map((value) => value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)).join(' · ');
      tr.appendChild(cell);
    });
    for (const value of [
      parseTime(row.log.timestamp) == null ? '—' : new Date(row.log.timestamp).toLocaleTimeString(),
      row.log.method || '—',
      row.log.url || '—',
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tr.appendChild(cell);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  watchResults.appendChild(table);
}

function updateRegexToggles() {
  urlRegexToggle.classList.toggle('active', state.useRegex.url);
  urlRegexToggle.setAttribute('aria-pressed', String(state.useRegex.url));
  mimeRegexToggle.classList.toggle('active', state.useRegex.mime);
  mimeRegexToggle.setAttribute('aria-pressed', String(state.useRegex.mime));
}

function validateRegexFilters() {
  const errors = [];
  for (const [key, label, enabled, value] of [
    ['url', 'URL', state.useRegex.url, state.filter.url],
    ['mime', 'MIME', state.useRegex.mime, state.filter.mime],
  ]) {
    state.regexErrors[key] = '';
    if (!enabled || !value) continue;
    try { new RegExp(value, 'i'); } catch (error) {
      state.regexErrors[key] = `${label}: ${error.message}`;
      errors.push(state.regexErrors[key]);
    }
  }
  filterErrors.textContent = errors.join(' · ');
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    } else {
      const fallback = document.createElement('textarea');
      fallback.value = text;
      fallback.setAttribute('readonly', '');
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      let copied;
      try {
        fallback.select();
        copied = document.execCommand('copy');
      } finally {
        fallback.remove();
      }
      if (!copied) throw new Error('Clipboard access was denied.');
    }
    showActionStatus('Copied to clipboard.');
  } catch (error) {
    showActionStatus(`Could not copy to clipboard: ${error.message}`, true);
  }
}

function copyVisibleNetwork() {
  const data = getCurrentData();
  const logs = getVisibleLogs(data);
  return copyTextToClipboard(JSON.stringify(logs, null, 2));
}

function copySelectedRequest() {
  const data = getCurrentData();
  const logs = data.networkLogs || [];
  const selectedIndex = Number(String(state.selectedLogId || '').slice('row-'.length));
  const selected = Number.isInteger(selectedIndex) && selectedIndex >= 0 ? logs[selectedIndex] : null;
  if (!selected) {
    showActionStatus('Select a request before copying its details.', true);
    return;
  }
  return copyTextToClipboard(JSON.stringify({
    request: selected.requestHeaders || {},
    requestBody: selected.requestBody || null,
    response: selected.responseHeaders || {},
    responseBody: selected.responseBody || null,
    status: selected.status,
    url: selected.url,
    method: selected.method,
  }, null, 2));
}

let modalReturnFocus = null;

function openModal(src, trigger = document.activeElement) {
  modalReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  modalImage.src = src;
  modal.classList.add('open');
  closeModal.focus();
}

function closeImageModal() {
  modal.classList.remove('open');
  modalImage.src = '';
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function updatePlayButton(playing) {
  playToggle.innerHTML = `${playing ? PAUSE_ICON : PLAY_ICON}<span>${playing ? 'Pause' : 'Play'}</span>`;
  playToggle.setAttribute('aria-label', playing ? 'Pause video' : 'Play video');
}

playToggle.addEventListener('click', async () => {
  if (!videoEl.src) return;
  if (videoEl.paused) {
    try {
      await videoEl.play();
    } catch (error) {
      showActionStatus(`Video could not be played: ${error.message}`, true);
    }
  } else {
    videoEl.pause();
  }
});

videoEl.addEventListener('play', () => updatePlayButton(true));
videoEl.addEventListener('pause', () => updatePlayButton(false));
videoEl.addEventListener('timeupdate', syncFromVideo);
videoEl.addEventListener('loadedmetadata', () => {
  state.videoDuration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  syncFromVideo();
});

recordingSelect.addEventListener('change', () => {
  const data = getCurrentData();
  setVideoSource(data, Number(recordingSelect.value));
  const timelineWindow = getTimelineWindow(data);
  state.currentTimeMs = timelineWindow.start || 0;
  updatePlaybackState();
});

seekBar.addEventListener('input', (event) => {
  const value = Number(event.target.value) / 1000;
  seekToRatio(value);
});

sessionSearch.addEventListener('input', renderScenarioList);
refreshSessionsButton.addEventListener('click', refreshEvidenceSessions);
zipDropzone.addEventListener('click', () => zipFileInput.click());
zipDropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    zipFileInput.click();
  }
});
zipFileInput.addEventListener('change', (event) => importEvidenceFiles(event.target.files));
zipDropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  zipDropzone.classList.add('dragover');
});
zipDropzone.addEventListener('dragleave', () => zipDropzone.classList.remove('dragover'));
zipDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  zipDropzone.classList.remove('dragover');
  importEvidenceFiles(event.dataTransfer?.files);
});
document.getElementById('downloadEvidence').addEventListener('click', downloadCurrentEvidence);
openOriginalViewer.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

function bindFilterInputs() {
  const onFilterChange = () => {
    validateRegexFilters();
    state.networkPage = 0;
    state.selectedLogId = null;
    updatePlaybackState();
  };
  urlFilter.addEventListener('input', (e) => {
    state.filter.url = e.target.value;
    onFilterChange();
  });
  methodFilter.addEventListener('change', (e) => {
    state.filter.method = e.target.value;
    onFilterChange();
  });
  statusFilter.addEventListener('change', (e) => {
    state.filter.status = e.target.value;
    onFilterChange();
  });
  mimeFilter.addEventListener('input', (e) => {
    state.filter.mime = e.target.value;
    onFilterChange();
  });
}

urlRegexToggle.addEventListener('click', () => {
  state.useRegex.url = !state.useRegex.url;
  updateRegexToggles();
  validateRegexFilters();
  state.selectedLogId = null;
  state.networkPage = 0;
  updatePlaybackState();
});
mimeRegexToggle.addEventListener('click', () => {
  state.useRegex.mime = !state.useRegex.mime;
  updateRegexToggles();
  validateRegexFilters();
  state.selectedLogId = null;
  state.networkPage = 0;
  updatePlaybackState();
});
clearFiltersButton.addEventListener('click', () => {
  state.filter = { url: '', method: '', status: '', mime: '' };
  state.useRegex = { url: false, mime: false };
  urlFilter.value = '';
  methodFilter.value = '';
  statusFilter.value = '';
  mimeFilter.value = '';
  updateRegexToggles();
  validateRegexFilters();
  state.selectedLogId = null;
  state.networkPage = 0;
  updatePlaybackState();
});

copyVisibleLogs.addEventListener('click', copyVisibleNetwork);
copySelectedLog.addEventListener('click', copySelectedRequest);
savePresetBtn.addEventListener('click', savePreset);
sharePresetsButton.addEventListener('click', shareFilterPresets);
togglePresetImportButton.addEventListener('click', () => { presetImportArea.hidden = !presetImportArea.hidden; });
applyPresetImportButton.addEventListener('click', importFilterPresets);
watchToggle.addEventListener('click', () => {
  watchContent.hidden = !watchContent.hidden;
  watchToggle.setAttribute('aria-expanded', String(!watchContent.hidden));
});
document.getElementById('addWatch').addEventListener('click', addWatchExpression);
watchPath.addEventListener('keydown', (event) => { if (event.key === 'Enter') addWatchExpression(); });
saveWatchPresetButton.addEventListener('click', saveWatchPreset);
shareWatchPresetsButton.addEventListener('click', shareWatchPresets);
toggleWatchImportButton.addEventListener('click', () => { watchImportArea.hidden = !watchImportArea.hidden; });
applyWatchImportButton.addEventListener('click', importWatchPresets);
closeModal.addEventListener('click', closeImageModal);
modal.addEventListener('click', (event) => {
  if (event.target === modal) closeImageModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modal.classList.contains('open')) closeImageModal();
});

async function init() {
  bindFilterInputs();
  updateRegexToggles();
  validateRegexFilters();
  await Promise.all([loadSavedPresets(), loadWatchFeatures()]);
  const results = await Promise.allSettled([loadLiveData(), loadScenarios()]);
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason?.message || 'An unknown error occurred.');
  if (failures.length) {
    sidebarFeedback.textContent = `Could not load evidence sessions: ${failures.join('; ')}`;
  }
  applyScenarioSelection();
  updatePlaybackState();
}

init();
