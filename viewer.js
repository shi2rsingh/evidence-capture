/* ── Evidence Viewer – Preact App ── */
const { h, render } = preact;
const { useState, useEffect, useMemo, useCallback, useRef } = preactHooks;
const html = htm.bind(h);

const send = msg => chrome.runtime.sendMessage(msg);

/* ── Extract a value from an object by dot-notation path ── */
function extractByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((o, key) => {
    if (o == null) return undefined;
    const m = key.match(/^(\w+)\[(\d+)\]$/);
    if (m) return o[m[1]]?.[+m[2]];
    return o[key];
  }, obj);
}

function tryParseJson(str) {
  if (!str || typeof str !== 'string') return null;
  try { return JSON.parse(str); } catch { return null; }
}

const TABS = [
  { id: 'network', icon: '🌐', label: 'Network' },
  { id: 'screenshots', icon: '📸', label: 'Screenshots' },
  { id: 'videos', icon: '🎥', label: 'Videos' },
];

const PAGE_SIZE = 50;

/* ════════════════════════════════════════════
   ZIP file parser (shared helper)
   ════════════════════════════════════════════ */
async function parseZipFile(file) {
  const zip = await JSZip.loadAsync(file);
  const data = { screenshots: [], networkLogs: [], videoChunks: [], metadata: null };

  // Read metadata if present
  const metaFile = zip.file('metadata.json');
  if (metaFile) {
    try { data.metadata = JSON.parse(await metaFile.async('string')); } catch { }
  }

  const networkJson = zip.file('network_logs.json');
  if (networkJson) {
    data.networkLogs = JSON.parse(await networkJson.async('string'));
  }

  const ssFolder = zip.folder('screenshots');
  if (ssFolder) {
    const ssFiles = [];
    ssFolder.forEach((path, f) => { if (!f.dir) ssFiles.push({ path, file: f }); });
    for (const { path, file: f } of ssFiles) {
      const base64 = await f.async('base64');
      const ext = path.split('.').pop().toLowerCase();
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      data.screenshots.push({ name: path, dataUrl: 'data:' + mime + ';base64,' + base64 });
    }
  }

  const vidFolder = zip.folder('videos');
  if (vidFolder) {
    const vidFiles = [];
    vidFolder.forEach((path, f) => { if (!f.dir) vidFiles.push({ path, file: f }); });
    for (const { path, file: f } of vidFiles) {
      const base64 = await f.async('base64');
      data.videoChunks.push('data:video/webm;base64,' + base64);
    }
  }

  return data;
}

/* ════════════════════════════════════════════
   Root App — Dual Sidebar Layout
   ════════════════════════════════════════════ */
function App() {
  const [tab, setTab] = useState('network');
  const [dataSource, setDataSource] = useState('live'); // 'live' | 'saved' | 'zip'
  const [liveData, setLiveData] = useState({ screenshots: [], networkLogs: [], videoChunks: [] });
  const [viewData, setViewData] = useState(null); // non-null when viewing saved/zip
  const [scenarios, setScenarios] = useState([]);
  const [zipScenarios, setZipScenarios] = useState([]); // { id, name, date, data }
  const [selectedId, setSelectedId] = useState('live'); // 'live' | 'saved-<idx>' | 'zip-<id>'
  const [loading, setLoading] = useState(true);

  // The data shown in the main panel
  const data = viewData || liveData;

  // Drag-drop state for left sidebar
  const [dragover, setDragover] = useState(false);
  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState(null);
  const fileInputRef = useRef(null);

  const refreshLive = useCallback(async () => {
    setLoading(true);
    const ev = await send({ action: 'getEvidenceReadonly' });
    if (ev && !ev.error) setLiveData(ev);
    setLoading(false);
  }, []);

  const refreshScenarios = useCallback(async () => {
    const res = await send({ action: 'getScenarios' });
    if (res && !res.error) setScenarios(res.scenarios || []);
  }, []);

  useEffect(() => {
    refreshLive(); refreshScenarios();
    const onMsg = (msg) => {
      if (msg.action === 'scenarioSaved') { refreshScenarios(); refreshLive(); }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const loadScenario = useCallback((scenario, source, id) => {
    setViewData({
      screenshots: scenario.screenshots || [],
      networkLogs: scenario.networkLogs || [],
      videoChunks: scenario.videoChunks || [],
    });
    setSelectedId(id);
    setDataSource(source);
  }, []);

  const deleteScenario = useCallback(async (scenarioId, e) => {
    e.stopPropagation();
    // Optimistic UI: remove immediately
    setScenarios(prev => prev.filter(s => (s.id || s.date) !== scenarioId));
    if (selectedId === 'saved-' + scenarioId) {
      setSelectedId('live');
      setViewData(null);
      setDataSource('live');
    }
    // Then persist in background
    const delRes = await send({ action: 'deleteScenario', id: scenarioId });
    if (delRes && !delRes.error) setScenarios(delRes.scenarios || []);
  }, [selectedId]);

  const deleteZip = useCallback((id, e) => {
    e.stopPropagation();
    setZipScenarios(zs => zs.filter(z => z.id !== id));
    if (selectedId === 'zip-' + id) {
      setSelectedId('live');
      setViewData(null);
      setDataSource('live');
    }
  }, [selectedId]);

  const loadLive = useCallback(async () => {
    setSelectedId('live');
    setViewData(null);
    setDataSource('live');
    await refreshLive();
  }, [refreshLive]);

  // ZIP handlers — each loaded ZIP is added to the list
  let zipIdCounter = useRef(0);
  const handleZipFile = async (file) => {
    if (!file || !file.name.endsWith('.zip')) { setZipError('Not a ZIP file'); return; }
    setZipLoading(true); setZipError(null);
    try {
      const parsed = await parseZipFile(file);
      const id = ++zipIdCounter.current;
      const zipName = (parsed.metadata && parsed.metadata.name) || file.name.replace('.zip', '');
      const zipDate = (parsed.metadata && parsed.metadata.date) || new Date().toISOString();
      const entry = { id, name: zipName, date: zipDate, data: parsed };
      setZipScenarios(zs => [entry, ...zs]);
      setViewData(parsed);
      setSelectedId('zip-' + id);
      setDataSource('zip');
    } catch (err) { setZipError(err.message); }
    setZipLoading(false);
  };
  const handleDrop = (e) => { e.preventDefault(); setDragover(false); Array.from(e.dataTransfer?.files || []).forEach(f => handleZipFile(f)); };
  const handleDragOver = (e) => { e.preventDefault(); setDragover(true); };

  // Derive selected name (must be before downloadCurrent)
  const selectedName = useMemo(() => {
    if (selectedId === 'live') return null;
    if (selectedId.startsWith('saved-')) {
      const key = selectedId.slice(6); // after 'saved-'
      return (scenarios.find(s => s.id === key) || scenarios.find(s => s.date === key))?.name;
    }
    if (selectedId.startsWith('zip-')) {
      const id = parseInt(selectedId.split('-')[1]);
      return zipScenarios.find(z => z.id === id)?.name;
    }
    return null;
  }, [selectedId, scenarios, zipScenarios]);

  const [downloadError, setDownloadError] = useState(null);

  const downloadCurrent = useCallback(async () => {
    if (!viewData || (!viewData.screenshots.length && !viewData.networkLogs.length && !viewData.videoChunks.length)) return;
    setDownloadError(null);
    try {
      const d = viewData;
      const zip = new JSZip();

      if (d.screenshots.length) {
        const folder = zip.folder('screenshots');
        d.screenshots.forEach(s => {
          const base64 = s.dataUrl.split(',')[1];
          folder.file(s.name, base64, { base64: true });
        });
      }
      if (d.networkLogs.length) {
        zip.file('network_logs.json', JSON.stringify(d.networkLogs, null, 2));
      }
      if (d.videoChunks.length) {
        const folder = zip.folder('videos');
        d.videoChunks.forEach((chunk, i) => {
          const base64 = chunk.split(',')[1];
          folder.file(`recording_${i + 1}.webm`, base64, { base64: true });
        });
      }

      const name = selectedName || 'live_session';
      const exportedAt = new Date().toISOString();
      zip.file('metadata.json', JSON.stringify({
        name, date: exportedAt,
        screenshotCount: d.screenshots.length,
        networkLogCount: d.networkLogs.length,
        videoCount: d.videoChunks.length,
        exportedAt, version: '1.0.0',
      }, null, 2));

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError('Download failed: ' + err.message);
      setTimeout(() => setDownloadError(null), 5000);
    }
  }, [viewData, selectedName]);

  const counts = {
    network: data.networkLogs.length,
    screenshots: data.screenshots.length,
    videos: data.videoChunks.length,
  };

  const sourceLabel = dataSource === 'live' ? html`<span class="source-badge source-live">LIVE</span>`
    : dataSource === 'zip' ? html`<span class="source-badge source-zip">ZIP</span>`
      : html`<span class="source-badge source-saved">SAVED</span>`;

  return html`
    <div class="shell">
      <!-- ═══ LEFT SIDEBAR: Scenarios ═══ -->
      <div class="sidebar-left">
        <div class="sidebar-left-header">
          <span>📁 Scenarios</span>
          <div class="actions">
            <button class="icon-btn" onClick=${loadLive} title="Load live data">📡</button>
            <button class="icon-btn" onClick=${refreshScenarios} title="Refresh scenarios">🔄</button>
          </div>
        </div>

        <div class="scenario-scroll">
          <!-- Live data card -->
          <div class="sc-card ${selectedId === 'live' ? 'active' : ''}" onClick=${loadLive}>
            <div class="info">
              <div class="name">📡 Live Session</div>
              <div class="stats-row">
                <span>📸 ${liveData.screenshots.length}</span>
                <span>🌐 ${liveData.networkLogs.length}</span>
              </div>
            </div>
          </div>

          ${scenarios.map((s, i) => html`
            <div class="sc-card ${selectedId === 'saved-' + (s.id || s.date) ? 'active' : ''}" onClick=${() => loadScenario(s, 'saved', 'saved-' + (s.id || s.date))}>
              <div class="info">
                <div class="name" title=${s.name}>${s.name}</div>
                <div class="date">${new Date(s.date).toLocaleDateString()}</div>
                <div class="stats-row">
                  <span>📸 ${(s.screenshots || []).length}</span>
                  <span>🌐 ${(s.networkLogs || []).length}</span>
                  <span>🎥 ${(s.videoChunks || []).length}</span>
                </div>
              </div>
              <button class="del" onClick=${(e) => deleteScenario(s.id || s.date, e)} title="Delete">🗑️</button>
            </div>
          `)}

          ${zipScenarios.length > 0 && html`
            <div style="padding:6px 8px 2px;font-size:10px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Loaded ZIPs</div>
          `}
          ${zipScenarios.map(z => html`
            <div class="sc-card ${selectedId === 'zip-' + z.id ? 'active' : ''}" onClick=${() => loadScenario(z.data, 'zip', 'zip-' + z.id)} style="border-left:3px solid var(--mauve)">
              <div class="info">
                <div class="name" title=${z.name}>📦 ${z.name}</div>
                <div class="stats-row">
                  <span>📸 ${z.data.screenshots.length}</span>
                  <span>🌐 ${z.data.networkLogs.length}</span>
                  <span>🎥 ${z.data.videoChunks.length}</span>
                </div>
              </div>
              <button class="del" onClick=${(e) => deleteZip(z.id, e)} title="Remove">✕</button>
            </div>
          `)}

          ${scenarios.length === 0 && zipScenarios.length === 0 && html`
            <div style="text-align:center;color:var(--dim);font-size:11px;padding:16px 8px;">No saved scenarios yet</div>
          `}
        </div>

        <!-- Drop zone at bottom -->
        <div
          class="dropzone-mini ${dragover ? 'dragover' : ''}"
          onDrop=${handleDrop}
          onDragOver=${handleDragOver}
          onDragLeave=${() => setDragover(false)}
          onClick=${() => fileInputRef.current?.click()}
        >
          ${zipLoading ? '⏳ Loading…' : '📦 Drop ZIP or click'}
          <div class="hint">Import evidence ZIP</div>
          <input ref=${fileInputRef} type="file" accept=".zip" multiple style="display:none"
            onChange=${(e) => { Array.from(e.target.files || []).forEach(f => handleZipFile(f)); }} />
        </div>
        ${zipError && html`<div style="color:var(--red);font-size:10px;padding:0 8px 8px;text-align:center">${zipError}</div>`}
      </div>

      <!-- ═══ RIGHT SIDEBAR: Tabs ═══ -->
      <aside class="sidebar">
        <div class="sidebar-header">
          <span>🔍 Viewer ${sourceLabel}</span>
          ${dataSource !== 'live' && html`<button class="icon-btn" onClick=${downloadCurrent} title="Download current evidence as ZIP" style="margin-left:auto">⬇️</button>`}
        </div>
        ${downloadError && html`<div style="padding:4px 12px;font-size:11px;color:var(--red);background:rgba(243,139,168,0.1)">${downloadError}</div>`}
        <nav class="sidebar-nav">
          ${TABS.map(t => html`
            <button class="nav-item ${tab === t.id ? 'active' : ''}" onClick=${() => setTab(t.id)}>
              <span>${t.icon}</span> ${t.label}
              <span class="count">${counts[t.id]}</span>
            </button>
          `)}
        </nav>
        ${dataSource === 'saved' && html`
          <div style="padding: 10px 12px; font-size: 11px; border-top: 1px solid var(--overlay); background: rgba(249,226,175,0.08); line-height: 1.5;">
            <div style="font-weight: 700; color: var(--yellow); margin-bottom: 4px;">⚠️ Heads up!</div>
            <div style="color: var(--subtext);">Saved scenarios are automatically cleared after a while. <strong style="color:var(--peach)">Download a copy</strong> to keep your evidence safe.</div>
            <button class="btn btn-primary btn-sm" style="margin-top:8px;width:100%;background:var(--yellow);color:var(--bg);font-weight:600" onClick=${downloadCurrent}>⬇️ Download ZIP</button>
          </div>
        `}
      </aside>

      <!-- ═══ MAIN CONTENT ═══ -->
      <main class="main">
        ${loading
      ? html`<div class="empty"><div class="icon">⏳</div><p>Loading evidence…</p></div>`
      : tab === 'network' ? html`<${NetworkTab} logs=${data.networkLogs} />`
        : tab === 'screenshots' ? html`<${ScreenshotsTab} shots=${data.screenshots} />`
          : html`<${VideosTab} chunks=${data.videoChunks} />`
    }
      </main>
    </div>
  `;
}

/* ════════════════════════════════════════════
   Network Logs Tab (with Regex Filters)
   ════════════════════════════════════════════ */
function NetworkTab({ logs }) {
  const [filter, setFilter] = useState({ url: '', method: '', statusRange: '', mimeType: '' });
  const [useRegex, setUseRegex] = useState({ url: false, mimeType: false });
  const [regexErrors, setRegexErrors] = useState({ url: null, mimeType: null });
  const [sort, setSort] = useState({ col: 'timestamp', asc: false });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);
  const [presets, setPresets] = useState([]);
  const [presetName, setPresetName] = useState('');

  // Tracked variables (lives in NetworkTab)
  const [trackers, setTrackers] = useState([]);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [newTracker, setNewTracker] = useState({ name: '', source: 'responseBody', path: '' });

  useEffect(() => {
    chrome.storage.local.get('trackedVariables', r => setTrackers(r.trackedVariables || []));
  }, []);

  const saveTrackers = (vars) => {
    setTrackers(vars);
    chrome.storage.local.set({ trackedVariables: vars });
  };

  const addTracker = () => {
    if (!newTracker.name.trim() || !newTracker.path.trim()) return;
    const t = { id: Date.now().toString(), name: newTracker.name.trim(), source: newTracker.source, path: newTracker.path.trim() };
    saveTrackers([...trackers, t]);
    setNewTracker({ name: '', source: 'responseBody', path: '' });
  };

  const removeTracker = (id) => saveTrackers(trackers.filter(t => t.id !== id));

  const [shareFeedback, setShareFeedback] = useState(null); // null | 'copied' | 'empty'
  const [importFeedback, setImportFeedback] = useState(null); // null | 'done' | 'error'

  const exportTrackerPresets = () => {
    if (!trackerPresets.length) {
      setShareFeedback('empty');
      setTimeout(() => setShareFeedback(null), 2000);
      return;
    }
    const json = JSON.stringify(trackerPresets);
    const ta = document.createElement('textarea');
    ta.value = json;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    setShareFeedback('copied');
    setTimeout(() => setShareFeedback(null), 2000);
  };

  const [showImportBox, setShowImportBox] = useState(false);
  const [importText, setImportText] = useState('');

  const doImport = () => {
    if (!importText.trim()) return;
    try {
      const arr = JSON.parse(importText.trim());
      if (!Array.isArray(arr)) throw new Error('Not an array');
      setTrackerPresets(arr);
      chrome.storage.local.set({ trackerPresets: arr });
      setActiveTrackerPresetIdx(null);
      setImportText('');
      setShowImportBox(false);
      setImportFeedback('done');
      setTimeout(() => setImportFeedback(null), 2000);
    } catch {
      setImportFeedback('error');
      setTimeout(() => setImportFeedback(null), 2000);
    }
  };

  // Tracker presets (saves filter + trackers together)
  const [trackerPresets, setTrackerPresets] = useState([]);
  const [trackerPresetName, setTrackerPresetName] = useState('');
  const [activeTrackerPresetIdx, setActiveTrackerPresetIdx] = useState(null);

  // Load saved presets
  useEffect(() => {
    chrome.storage.local.get('filterPresets', r => setPresets(r.filterPresets || []));
    chrome.storage.local.get('trackerPresets', r => setTrackerPresets(r.trackerPresets || []));
  }, []);

  const saveTrackerPreset = () => {
    if (!trackerPresetName.trim() || trackers.length === 0) return;
    const next = [...trackerPresets, { name: trackerPresetName.trim(), filter: { ...filter }, useRegex: { ...useRegex }, trackers: [...trackers] }];
    setTrackerPresets(next);
    chrome.storage.local.set({ trackerPresets: next });
    setTrackerPresetName('');
  };

  const deleteTrackerPreset = (i) => {
    const next = trackerPresets.filter((_, idx) => idx !== i);
    setTrackerPresets(next);
    chrome.storage.local.set({ trackerPresets: next });
    if (activeTrackerPresetIdx === i) setActiveTrackerPresetIdx(null);
    else if (activeTrackerPresetIdx !== null && activeTrackerPresetIdx > i) setActiveTrackerPresetIdx(activeTrackerPresetIdx - 1);
  };

  const applyTrackerPreset = (p, idx) => {
    if (activeTrackerPresetIdx === idx) {
      // Toggle off: clear filter & trackers
      setFilter({ url: '', method: '', statusRange: '', mimeType: '' });
      setUseRegex({ url: false, mimeType: false });
      saveTrackers([]);
      setActiveTrackerPresetIdx(null);
      setPage(0);
      return;
    }
    setFilter(p.filter);
    setUseRegex(p.useRegex || { url: false, mimeType: false });
    saveTrackers(p.trackers || []);
    setActiveTrackerPresetIdx(idx);
    setPage(0);
  };

  const savePreset = () => {
    if (!presetName.trim()) return;
    const next = [...presets, { name: presetName.trim(), filter: { ...filter }, useRegex: { ...useRegex } }];
    setPresets(next);
    chrome.storage.local.set({ filterPresets: next });
    setPresetName('');
  };

  const deletePreset = (i) => {
    const next = presets.filter((_, idx) => idx !== i);
    setPresets(next);
    chrome.storage.local.set({ filterPresets: next });
  };

  const applyPreset = (p) => {
    setFilter(p.filter);
    setUseRegex(p.useRegex || { url: false, mimeType: false });
    setPage(0);
  };

  // Compile regexes outside useMemo to avoid setState during render
  const compiledRegex = useMemo(() => {
    const result = { url: null, mimeType: null, errors: { url: null, mimeType: null } };
    if (useRegex.url && filter.url) {
      try { result.url = new RegExp(filter.url, 'i'); } catch (err) { result.errors.url = err.message; }
    }
    if (useRegex.mimeType && filter.mimeType) {
      try { result.mimeType = new RegExp(filter.mimeType, 'i'); } catch (err) { result.errors.mimeType = err.message; }
    }
    return result;
  }, [filter.url, filter.mimeType, useRegex.url, useRegex.mimeType]);

  useEffect(() => {
    setRegexErrors(compiledRegex.errors);
  }, [compiledRegex.errors]);

  // Filter
  const filtered = useMemo(() => {
    const urlRegex = compiledRegex.url;
    const mimeRegex = compiledRegex.mimeType;

    return logs.filter(l => {
      // URL filter
      if (filter.url) {
        if (useRegex.url) {
          if (urlRegex && !urlRegex.test(l.url || '')) return false;
        } else {
          if (!l.url.toLowerCase().includes(filter.url.toLowerCase())) return false;
        }
      }
      // Method filter
      if (filter.method && (l.method || '').toUpperCase() !== filter.method.toUpperCase()) return false;
      // Status filter
      if (filter.statusRange) {
        const s = l.status || 0;
        if (filter.statusRange === '2xx' && (s < 200 || s >= 300)) return false;
        if (filter.statusRange === '3xx' && (s < 300 || s >= 400)) return false;
        if (filter.statusRange === '4xx' && (s < 400 || s >= 500)) return false;
        if (filter.statusRange === '5xx' && (s < 500 || s >= 600)) return false;
      }
      // MIME filter
      if (filter.mimeType) {
        if (useRegex.mimeType) {
          if (mimeRegex && !mimeRegex.test(l.mimeType || '')) return false;
        } else {
          if (!(l.mimeType || '').toLowerCase().includes(filter.mimeType.toLowerCase())) return false;
        }
      }
      return true;
    });
  }, [logs, filter, useRegex]);

  // Sort
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let va = a[sort.col] ?? '', vb = b[sort.col] ?? '';
      if (typeof va === 'number') return sort.asc ? va - vb : vb - va;
      va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
      return sort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    return arr;
  }, [filtered, sort]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageData = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const toggleSort = col => setSort(s => ({ col, asc: s.col === col ? !s.asc : true }));
  const arrow = col => sort.col === col ? html`<span class="arrow">${sort.asc ? '▲' : '▼'}</span>` : '';

  const statusClass = s => {
    if (s >= 200 && s < 300) return 's2xx';
    if (s >= 300 && s < 400) return 's3xx';
    if (s >= 400 && s < 500) return 's4xx';
    if (s >= 500) return 's5xx';
    return '';
  };

  if (!logs.length) return html`<div class="empty"><div class="icon">🌐</div><p>No network logs captured yet.</p></div>`;

  return html`
    <div class="page-header">
      <h2>🌐 Network Logs</h2>
      <span style="font-size:13px;color:var(--subtext)">${filtered.length} of ${logs.length} entries</span>
    </div>

    <!-- Saved Presets -->
    ${presets.length > 0 && html`
      <div class="presets">
        ${presets.map((p, i) => html`
          <span class="chip" onClick=${() => applyPreset(p)}>
            ${p.name}
            <span class="x" onClick=${(e) => { e.stopPropagation(); deletePreset(i); }}>×</span>
          </span>
        `)}
      </div>
    `}

    <!-- Filters -->
    <div class="filter-bar">
      <div style="flex: 1; min-width: 200px; display: flex; flex-direction: column;">
        <div style="display: flex; gap: 4px; align-items: center;">
          <input type="text" placeholder="🔍 Filter by URL…" value=${filter.url} style="flex: 1;"
            onInput=${e => { setFilter(f => ({ ...f, url: e.target.value })); setPage(0); }} />
          <span 
            class="regex-toggle ${useRegex.url ? 'on' : ''}" 
            onClick=${() => setUseRegex(r => ({ ...r, url: !r.url }))}
            title="Toggle regex mode"
          >.*</span>
        </div>
        ${regexErrors.url && useRegex.url && html`<div class="regex-err">${regexErrors.url}</div>`}
      </div>
      <select value=${filter.method} onChange=${e => { setFilter(f => ({ ...f, method: e.target.value })); setPage(0); }}>
        <option value="">All Methods</option>
        <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
        <option>PATCH</option><option>OPTIONS</option><option>HEAD</option>
      </select>
      <select value=${filter.statusRange} onChange=${e => { setFilter(f => ({ ...f, statusRange: e.target.value })); setPage(0); }}>
        <option value="">All Status</option>
        <option value="2xx">2xx Success</option>
        <option value="3xx">3xx Redirect</option>
        <option value="4xx">4xx Client Error</option>
        <option value="5xx">5xx Server Error</option>
      </select>
      <div style="min-width: 120px; display: flex; flex-direction: column;">
        <div style="display: flex; gap: 4px; align-items: center;">
          <input type="text" placeholder="MIME type…" style="flex: 1;" value=${filter.mimeType}
            onInput=${e => { setFilter(f => ({ ...f, mimeType: e.target.value })); setPage(0); }} />
          <span 
            class="regex-toggle ${useRegex.mimeType ? 'on' : ''}" 
            onClick=${() => setUseRegex(r => ({ ...r, mimeType: !r.mimeType }))}
            title="Toggle regex mode"
          >.*</span>
        </div>
        ${regexErrors.mimeType && useRegex.mimeType && html`<div class="regex-err">${regexErrors.mimeType}</div>`}
      </div>
      <button class="btn btn-ghost btn-sm" onClick=${() => { setFilter({ url: '', method: '', statusRange: '', mimeType: '' }); setUseRegex({ url: false, mimeType: false }); setPage(0); }}>Clear</button>
    </div>

    <!-- Save preset row -->
    <div class="filter-bar" style="margin-bottom:12px">
      <input type="text" placeholder="Preset name…" style="max-width:200px" value=${presetName}
        onInput=${e => setPresetName(e.target.value)}
        onKeyDown=${e => e.key === 'Enter' && savePreset()} />
      <button class="btn btn-primary btn-sm" onClick=${savePreset}>💾 Save Filter</button>
    </div>

    <!-- Tracker Section -->
    <div class="tracker-panel" style="margin-bottom:16px">
      <div class="tracker-panel-header" onClick=${() => setTrackerOpen(!trackerOpen)}>
        <span><span class="toggle">${trackerOpen ? '▾' : '▸'}</span> 📊 Watch Expression </span>
        <div style="display:flex;gap:8px;align-items:center">
          ${trackers.length > 0 && html`<span class="tracker-badge">${trackers.length} tracker${trackers.length !== 1 ? 's' : ''}</span>`}
        </div>
      </div>

      ${trackerOpen && html`
        <div class="tracker-panel-body">
          <!-- Tracker presets -->
          ${trackerPresets.length > 0 && html`
            <div class="presets" style="margin-bottom:8px">
              ${trackerPresets.map((p, i) => html`
                <span class="chip ${activeTrackerPresetIdx === i ? 'chip-active' : ''}" style="border-color:var(--teal)" onClick=${() => applyTrackerPreset(p, i)}>
                  📊 ${p.name}
                  <span class="x" onClick=${(e) => { e.stopPropagation(); deleteTrackerPreset(i); }}>×</span>
                </span>
              `)}
            </div>
          `}

          <!-- Add tracker row -->
          <div class="tracker-add-row">
            <input type="text" placeholder="Name" value=${newTracker.name}
              onInput=${e => setNewTracker(t => ({ ...t, name: e.target.value }))} style="max-width:120px" />
            <select value=${newTracker.source}
              onChange=${e => setNewTracker(t => ({ ...t, source: e.target.value }))}>
              <option value="responseBody">Response</option>
              <option value="requestBody">Request</option>
            </select>
            <input type="text" placeholder="JSON paths (comma separated, e.g. data.token, user.id)" value=${newTracker.path}
              onInput=${e => setNewTracker(t => ({ ...t, path: e.target.value }))}
              onKeyDown=${e => e.key === 'Enter' && addTracker()}
              style="flex:1;min-width:200px" />
            <button class="btn btn-ghost btn-sm" onClick=${addTracker}>+ Add</button>
            <span style="border-left:1px solid var(--subtle);height:20px"></span>
            <button class="btn btn-ghost btn-sm" style=${shareFeedback === 'copied' ? 'background:var(--green);color:var(--bg)' : shareFeedback === 'empty' ? 'background:var(--yellow);color:var(--bg)' : ''}
              onClick=${exportTrackerPresets} title="Copy all tracker presets to share">${shareFeedback === 'copied' ? '✅ Copied!' : shareFeedback === 'empty' ? '⚠️ No presets' : '📤 Share'}</button>
            <button class="btn btn-ghost btn-sm" style=${importFeedback === 'done' ? 'background:var(--green);color:var(--bg)' : importFeedback === 'error' ? 'background:var(--red);color:var(--bg)' : ''}
              onClick=${() => setShowImportBox(!showImportBox)} title="Import shared tracker presets">${importFeedback === 'done' ? '✅ Imported!' : importFeedback === 'error' ? '❌ Invalid data' : showImportBox ? '📥 Cancel' : '📥 Import'}</button>
          </div>
          ${showImportBox && html`
            <div style="margin-top:6px;display:flex;gap:6px;align-items:flex-start">
              <textarea style="flex:1;min-height:50px;padding:6px 8px;border-radius:6px;border:1px solid var(--subtle);background:var(--surface);color:var(--text);font-size:11px;font-family:'Cascadia Code',monospace;resize:vertical"
                placeholder="Paste shared preset config here…" value=${importText}
                onInput=${e => setImportText(e.target.value)} />
              <button class="btn btn-primary btn-sm" onClick=${doImport}>✅ Apply</button>
            </div>
          `}

          <!-- Active trackers -->
          ${trackers.length > 0 && html`
            <div class="tracker-list">
              ${trackers.map(t => html`
                <div class="tracker-item">
                  <span class="tracker-name" title=${t.name}>${t.name}</span>
                  <span class="tracker-src">${t.source === 'requestBody' ? 'req' : 'res'}</span>
                  <span class="tracker-path" title=${t.path}>${t.path}</span>
                  <button class="del-tracker" onClick=${() => removeTracker(t.id)} title="Remove">✕</button>
                </div>
              `)}
            </div>
          `}

          <!-- Save tracker preset (filter + trackers) -->
          ${trackers.length > 0 && html`
            <div class="tracker-add-row" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--overlay)">
              <input type="text" placeholder="Tracker preset name…" value=${trackerPresetName}
                onInput=${e => setTrackerPresetName(e.target.value)}
                onKeyDown=${e => e.key === 'Enter' && saveTrackerPreset()}
                style="flex:1;max-width:200px" />
              <button class="btn btn-primary btn-sm" style="background:var(--teal)" onClick=${saveTrackerPreset}>💾 Save Tracker + Filter</button>
            </div>
          `}

          <!-- Tracker Results Table -->
          ${trackers.length > 0 && html`<${TrackerResultsTable} logs=${filtered} trackers=${trackers} />`}
        </div>
      `}
    </div>

    <!-- Table -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th onClick=${() => toggleSort('timestamp')}>Time ${arrow('timestamp')}</th>
            <th onClick=${() => toggleSort('method')}>Method ${arrow('method')}</th>
            <th onClick=${() => toggleSort('url')}>URL ${arrow('url')}</th>
            <th onClick=${() => toggleSort('status')}>Status ${arrow('status')}</th>
            <th onClick=${() => toggleSort('mimeType')}>MIME ${arrow('mimeType')}</th>
            <th onClick=${() => toggleSort('resourceType')}>Type ${arrow('resourceType')}</th>
          </tr>
        </thead>
        <tbody>
          ${pageData.map((l, i) => html`
            <tr style="cursor:pointer" onClick=${() => setSelected(l)}>
              <td>${l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '-'}</td>
              <td><span class="method-badge method-${(l.method || '').toUpperCase()}">${l.method || '-'}</span></td>
              <td title=${l.url}>${truncateUrl(l.url)}</td>
              <td>${l.status ? html`<span class="status-badge ${statusClass(l.status)}">${l.status}</span>` : '-'}</td>
              <td style="color:var(--dim)">${l.mimeType || '-'}</td>
              <td style="color:var(--dim);font-size:11px">${l.resourceType || '-'}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div class="pagination">
      <button disabled=${page === 0} onClick=${() => setPage(p => p - 1)}>← Prev</button>
      <span>Page ${page + 1} of ${totalPages}</span>
      <button disabled=${page >= totalPages - 1} onClick=${() => setPage(p => p + 1)}>Next →</button>
    </div>

    <!-- Detail panel -->
    ${selected && html`<${DetailPanel} entry=${selected} onClose=${() => setSelected(null)} />`}
  `;
}

/* ── Tracker Results Table (columns = paths, rows = logs) ── */
function TrackerResultsTable({ logs, trackers }) {
  // Build flat list of all paths
  const cols = useMemo(() => {
    const c = [];
    for (const t of trackers) {
      const paths = t.path.split(',').map(p => p.trim()).filter(Boolean);
      for (const p of paths) {
        c.push({ name: t.name, source: t.source, path: p, label: paths.length > 1 ? `${t.name} → ${p}` : `${t.name} (${p})` });
      }
    }
    return c;
  }, [trackers]);

  // Only include logs where at least one tracker path matches
  const rows = useMemo(() => {
    return logs.map(log => {
      const values = cols.map(col => {
        const parsed = tryParseJson(log[col.source]);
        if (!parsed) return undefined;
        const val = extractByPath(parsed, col.path);
        if (val === undefined) return undefined;
        return typeof val === 'object' ? JSON.stringify(val) : String(val);
      });
      if (values.every(v => v === undefined)) return null;
      return { log, values };
    }).filter(Boolean);
  }, [logs, cols]);

  if (rows.length === 0) return html`
    <div style="color:var(--dim);font-size:12px;padding:10px 0;text-align:center;margin-top:8px">No matches in filtered results</div>
  `;

  return html`
    <div style="overflow-x:auto;max-height:350px;overflow-y:auto;margin-top:10px;border:1px solid var(--overlay);border-radius:8px">
      <table class="tracker-results-table">
        <thead>
          <tr>
          ${cols.map(c => html`<th style="color:var(--teal)" title=${`${c.source} → ${c.path}`}>${c.label}</th>`)}
          <th>Time</th>
          <th>Method</th>
          <th>URL</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => html`
            <tr>
            ${r.values.map(v => html`
              <td class=${v !== undefined ? 'tv-value' : ''} title=${v || ''}>${v !== undefined ? v : html`<span style="color:var(--dim)">-</span>`}</td>
              `)}
              <td style="color:var(--dim);white-space:nowrap">${r.log.timestamp ? new Date(r.log.timestamp).toLocaleTimeString() : '-'}</td>
              <td style="color:var(--dim)" class="tv-method" title=${r.log.method}>${r.log.method}</td>
              <td style="color:var(--dim)" class="tv-url" title=${r.log.url}>${r.log.url}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

function truncateUrl(url, max = 80) {
  if (!url) return '-';
  try {
    const u = new URL(url);
    const short = u.pathname + u.search;
    return short.length > max ? short.slice(0, max) + '…' : short;
  } catch { return url.length > max ? url.slice(0, max) + '…' : url; }
}

function highlightJson(str) {
  // Tokenize JSON string into styled spans
  const parts = [];
  const re = /("(?:\\.|[^"\\])*")\s*:|"(?:\\.|[^"\\])*"|\b(true|false|null)\b|-?\d+\.?\d*(?:[eE][+-]?\d+)?/g;
  let last = 0, m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) parts.push(str.slice(last, m.index));
    if (m[1]) {
      // key
      parts.push(html`<span style="color:var(--blue)">${m[1]}</span>`);
      parts.push(':');
    } else if (m[0].startsWith('"')) {
      parts.push(html`<span style="color:var(--green,#a6e3a1)">${m[0]}</span>`);
    } else if (m[2]) {
      parts.push(html`<span style="color:var(--mauve,#cba6f7)">${m[0]}</span>`);
    } else {
      parts.push(html`<span style="color:var(--peach,#fab387)">${m[0]}</span>`);
    }
    last = re.lastIndex;
  }
  if (last < str.length) parts.push(str.slice(last));
  return parts;
}

function DetailPanel({ entry, onClose }) {
  const [showReqHeaders, setShowReqHeaders] = useState(false);
  const [showResHeaders, setShowResHeaders] = useState(false);

  const formatBody = (body) => {
    if (!body) return null;
    try {
      const obj = JSON.parse(body);
      return highlightJson(JSON.stringify(obj, null, 2));
    } catch { return html`<span>${body}</span>`; }
  };

  const headerEntries = (headers) => {
    if (!headers || typeof headers !== 'object') return [];
    return Object.entries(headers);
  };

  const reqHeaders = headerEntries(entry.requestHeaders);
  const resHeaders = headerEntries(entry.responseHeaders);
  const reqBody = formatBody(entry.requestBody);
  const resBody = formatBody(entry.responseBody);

  return html`
    <div class="detail-panel">
      <button class="close" onClick=${onClose}>✕</button>
      <h3>${entry.method || 'Request'} ${entry.status ? '→ ' + entry.status : ''}</h3>
      <div class="detail-kv"><span class="k">Method</span> <span class="method-badge method-${(entry.method || '').toUpperCase()}">${entry.method || '-'}</span></div>
      <div class="detail-kv"><span class="k">Status</span> ${entry.status ? html`<span class="status-badge ${entry.status >= 200 && entry.status < 300 ? 's2xx' : entry.status >= 400 && entry.status < 500 ? 's4xx' : entry.status >= 500 ? 's5xx' : 's3xx'}">${entry.status}</span>` : html`<span style="color:var(--dim)">Pending</span>`}</div>
      <div class="detail-kv"><span class="k">MIME</span> ${entry.mimeType || '-'}</div>
      <div class="detail-kv"><span class="k">Type</span> ${entry.resourceType || '-'}</div>
      <div class="detail-kv"><span class="k">Time</span> ${entry.timestamp || '-'}</div>
      <div class="detail-kv"><span class="k">URL</span></div>
      <div class="detail-body" style="margin-bottom:12px">${entry.url}</div>

      ${reqHeaders.length > 0 && html`
        <div class="detail-section" onClick=${() => setShowReqHeaders(!showReqHeaders)}>
          <span class="toggle">${showReqHeaders ? '▾' : '▸'}</span> Request Headers
          <span style="color:var(--dim);font-size:11px;margin-left:6px">(${reqHeaders.length})</span>
        </div>
        ${showReqHeaders && html`
          <div class="detail-body" style="margin-bottom:12px">
            ${reqHeaders.map(([k, v]) => html`<div><span style="color:var(--blue)">${k}:</span> ${v}</div>`)}
          </div>
        `}
      `}

      ${reqBody && html`
        <div class="detail-section">📤 Request Body</div>
        <div class="detail-body" style="margin-bottom:12px">${reqBody}</div>
      `}

      ${resHeaders.length > 0 && html`
        <div class="detail-section" onClick=${() => setShowResHeaders(!showResHeaders)}>
          <span class="toggle">${showResHeaders ? '▾' : '▸'}</span> Response Headers
          <span style="color:var(--dim);font-size:11px;margin-left:6px">(${resHeaders.length})</span>
        </div>
        ${showResHeaders && html`
          <div class="detail-body" style="margin-bottom:12px">
            ${resHeaders.map(([k, v]) => html`<div><span style="color:var(--blue)">${k}:</span> ${v}</div>`)}
          </div>
        `}
      `}

      ${resBody && html`
        <div class="detail-section">📥 Response Body${entry.responseBodyBase64Encoded ? ' (base64)' : ''}${entry.responseBodyTruncated ? html` <span style="color:var(--yellow);font-size:11px">(truncated — original: ${(entry.responseBodyOriginalSize / 1024).toFixed(1)}KB)</span>` : ''}</div>
        <div class="detail-body">${resBody}</div>
      `}

      ${!reqBody && !resBody && !reqHeaders.length && !resHeaders.length && html`
        <div style="color:var(--dim);font-size:12px;margin-top:16px;text-align:center">No body/headers captured for this entry</div>
      `}
    </div>
  `;
}

/* ════════════════════════════════════════════
   Screenshots Tab
   ════════════════════════════════════════════ */
function ScreenshotsTab({ shots }) {
  const [lightbox, setLightbox] = useState(null);

  if (!shots.length) return html`<div class="empty"><div class="icon">📸</div><p>No screenshots captured yet.</p></div>`;

  return html`
    <div class="page-header"><h2>📸 Screenshots</h2></div>
    <div class="ss-grid">
      ${shots.map((s, i) => html`
        <div class="ss-card" onClick=${() => setLightbox(s.dataUrl)}>
          <img src=${s.dataUrl} alt=${s.name} loading="lazy" />
          <div class="meta">${s.name}</div>
        </div>
      `)}
    </div>
    ${lightbox && html`
      <div class="lightbox" onClick=${() => setLightbox(null)}>
        <img src=${lightbox} />
      </div>
    `}
  `;
}

/* ════════════════════════════════════════════
   Videos Tab
   ════════════════════════════════════════════ */
function VideosTab({ chunks }) {
  if (!chunks.length) return html`<div class="empty"><div class="icon">🎥</div><p>No video recordings yet.</p></div>`;

  return html`
    <div class="page-header"><h2>🎥 Video Recordings</h2></div>
    <div class="vid-list">
      ${chunks.map((c, i) => html`
        <div class="vid-card">
          <video controls src=${c}></video>
          <div class="meta">Recording #${i + 1}</div>
        </div>
      `)}
    </div>
  `;
}

/* ── Mount ── */
render(html`<${App} />`, document.getElementById('app'));
