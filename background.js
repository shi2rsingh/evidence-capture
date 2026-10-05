/* ── Evidence Capture – Background Service Worker ── */

if (typeof importScripts === 'function') {
  importScripts('capture-logic.js', 'draft-store.js');
}

const CaptureLogic = globalThis.CaptureLogic || {};
const DraftStore = globalThis.DraftStore;

const state = {
  screenshots: [],       // { name, dataUrl }
  networkLogs: [],       // { method, url, status, type, timestamp, ... }
  videoChunks: [],       // base64 strings
  _videoChunkTransfers: {}, // transferId -> { prefix, totalParts, parts[] }
  _completedVideoTransfers: {},
  sessionName: null,
  networkCapturing: false,
  videoRecording: false,
  videoPending: false,
  debuggeeTabId: null,
  _requestMap: {},       // requestId -> live network entry
  droppedNetworkLogs: 0,
  evidenceBytes: 0,
  captureLimitReached: false,
  pendingBodyRequests: new Set(),
  pendingDraftWrites: new Set(),
  draftIds: new WeakMap(),
  draftSequence: 0,
  draftPersistenceError: null,
  draftHydrated: false,
  debuggerEventListening: false,
};

const MAX_NETWORK_LOGS = 10000;
const MAX_SCREENSHOTS = 250;
const MAX_SCENARIO_BYTES = 150 * 1024 * 1024;
const SESSION_NAME_STORAGE_KEY = 'sessionNameState';
const ACTIVE_CAPTURE_TAB_KEY = 'activeCaptureTab';
const VIDEO_PREF_KEY = 'includeVideo';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_CREATE_REASON = 'USER_MEDIA';

function summarizeScenario(scenario) {
  return {
    id: scenario.id,
    name: scenario.name,
    date: scenario.date,
    screenshotCount: Array.isArray(scenario.screenshots) ? scenario.screenshots.length : 0,
    networkLogCount: Array.isArray(scenario.networkLogs) ? scenario.networkLogs.length : 0,
    videoCount: Array.isArray(scenario.videoChunks) ? scenario.videoChunks.length : 0,
  };
}

function validateCapturableTab(tab, operation) {
  const tabId = CaptureLogic.validateTabId(tab);
  if (typeof tab.url === 'string' && /^(chrome|edge|devtools|chrome-extension):/i.test(tab.url)) {
    throw new Error(`Cannot ${operation} on a browser-internal page. Open a regular website and try again.`);
  }
  return tabId;
}

function reserveEvidenceBytes(value) {
  const bytes = CaptureLogic.estimateEvidenceSize(value);
  if (state.evidenceBytes + bytes > MAX_SCENARIO_BYTES) {
    state.captureLimitReached = true;
    chrome.action.setBadgeText({ text: 'MAX' });
    chrome.runtime.sendMessage({
      action: 'captureLimitReached',
      message: 'Capture paused at the 150 MiB session limit. Save the current evidence before starting another session.',
    }).catch(() => {});
    if (state.networkCapturing) {
      stopNetworkCapture().catch((error) => console.error('Could not stop capture after reaching its size limit:', error));
    }
    return false;
  }
  state.evidenceBytes += bytes;
  return true;
}

let sessionNameHydrated = false;
let creatingOffscreenDocument = null;
let startingCapturePromise = null;
let stoppingCapturePromise = null;
let scenarioSaveQueue = Promise.resolve();
let draftHydrationPromise = null;
let draftWriteQueue = Promise.resolve();

async function ensureDraftHydrated() {
  if (state.draftHydrated) return;
  if (!draftHydrationPromise) {
    draftHydrationPromise = (async () => {
      const records = await DraftStore.load();
      state.screenshots = [];
      state.networkLogs = [];
      state.videoChunks = [];
      state._requestMap = {};
      state.evidenceBytes = 0;
      state.draftIds = new WeakMap();
      for (const record of records.sort((a, b) => a.id - b.id)) {
        if (!Number.isSafeInteger(record.id) || record.id < 1) continue;
        state.draftSequence = Math.max(state.draftSequence, record.id);
        if (record.kind === 'screenshot' && record.value && typeof record.value === 'object') {
          state.screenshots.push(record.value);
          state.draftIds.set(record.value, record.id);
        } else if (record.kind === 'network' && record.value && typeof record.value === 'object') {
          state.networkLogs.push(record.value);
          state.draftIds.set(record.value, record.id);
          if (record.value.requestId && !record.value.requestCompleted && !record.value.requestFailed) {
            state._requestMap[record.value.requestId] = record.value;
          }
        } else if (record.kind === 'video' && typeof record.value === 'string') {
          state.videoChunks.push(record.value);
        }
      }
      state.evidenceBytes = CaptureLogic.estimateEvidenceSize({
        screenshots: state.screenshots,
        networkLogs: state.networkLogs,
        videoChunks: state.videoChunks,
      });
      const sessionStorage = chrome.storage.session;
      if (sessionStorage) {
        const saved = await sessionStorage.get(ACTIVE_CAPTURE_TAB_KEY);
        const savedTabId = saved[ACTIVE_CAPTURE_TAB_KEY];
        if (Number.isInteger(savedTabId)) {
          const targets = await chrome.debugger.getTargets();
          if (targets.some((target) => target.tabId === savedTabId && target.attached)) {
            state.debuggeeTabId = savedTabId;
            state.networkCapturing = true;
            addDebuggerEventListener();
            try {
              await chrome.debugger.sendCommand({ tabId: savedTabId }, 'Network.enable');
            } catch (error) {
              removeDebuggerEventListener();
              state.debuggeeTabId = null;
              state.networkCapturing = false;
              await sessionStorage.remove(ACTIVE_CAPTURE_TAB_KEY);
              console.error('Could not resume network capture after worker restart:', error);
            }
          } else {
            await sessionStorage.remove(ACTIVE_CAPTURE_TAB_KEY);
          }
        }
      }
      if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
        try {
          const recorder = await chrome.runtime.sendMessage({ action: 'offscreenGetStatus' });
          state.videoPending = recorder?.pending === true;
          state.videoRecording = recorder?.recording === true || state.videoPending;
        } catch (error) {
          console.error('Could not restore offscreen recorder status:', error);
        }
      }
      state.draftHydrated = true;
    })().catch((error) => {
      draftHydrationPromise = null;
      throw error;
    });
  }
  await draftHydrationPromise;
}

function persistDraftInBackground(kind, value) {
  persistDraft(kind, value).catch(() => {});
}

function handleDraftPersistenceFailure(error) {
  state.draftPersistenceError = error?.message || 'Could not persist capture draft.';
  state.captureLimitReached = true;
  console.error('Evidence draft persistence failed:', error);
  chrome.runtime.sendMessage({
    action: 'draftPersistenceFailed',
    message: `${state.draftPersistenceError} Stop and save the evidence before continuing.`,
  }).catch(() => {});
  if (state.networkCapturing) {
    stopNetworkCapture().catch((stopError) => console.error('Could not stop capture after draft persistence failure:', stopError));
  }
}

function persistDraft(kind, value) {
  const id = typeof value === 'object' && value !== null
    ? state.draftIds.get(value) || ++state.draftSequence
    : ++state.draftSequence;
  if (typeof value === 'object' && value !== null) state.draftIds.set(value, id);
  const operation = draftWriteQueue.then(async () => {
    await ensureDraftHydrated();
    await DraftStore.put({ id, kind, value });
  });
  draftWriteQueue = operation.then(() => undefined, () => undefined);
  let tracked;
  tracked = operation
    .catch((error) => {
      handleDraftPersistenceFailure(error);
      throw error;
    })
    .finally(() => state.pendingDraftWrites.delete(tracked));
  state.pendingDraftWrites.add(tracked);
  return tracked;
}

async function waitForDraftWrites() {
  if (!state.pendingDraftWrites.size) return;
  let timeoutId;
  await Promise.race([
    Promise.allSettled([...state.pendingDraftWrites]),
    new Promise((resolve) => { timeoutId = setTimeout(resolve, 10000); }),
  ]);
  clearTimeout(timeoutId);
}

function addDebuggerEventListener() {
  if (state.debuggerEventListening) return;
  chrome.debugger.onEvent.addListener(onDebugEvent);
  state.debuggerEventListening = true;
}

function removeDebuggerEventListener() {
  if (!state.debuggerEventListening) return;
  chrome.debugger.onEvent.removeListener(onDebugEvent);
  state.debuggerEventListening = false;
}

function getSessionStorage() {
  return chrome.storage.session || chrome.storage.local;
}

async function readPersistedSessionName() {
  const storage = getSessionStorage();
  const result = await storage.get(SESSION_NAME_STORAGE_KEY);
  const stored = result[SESSION_NAME_STORAGE_KEY];

  if (typeof stored === 'string') {
    const trimmed = stored.trim();
    return trimmed || null;
  }

  // Backward compatibility with previous object format.
  if (stored && typeof stored.name === 'string') {
    const trimmed = stored.name.trim();
    return trimmed || null;
  }

  return null;
}

async function persistSessionName(name) {
  const storage = getSessionStorage();
  const trimmed = (name || '').trim();
  if (!trimmed) {
    await storage.remove(SESSION_NAME_STORAGE_KEY);
    return;
  }
  await storage.set({ [SESSION_NAME_STORAGE_KEY]: trimmed });
}

async function ensureSessionNameHydrated() {
  if (sessionNameHydrated) return;
  state.sessionName = await readPersistedSessionName();
  sessionNameHydrated = true;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error('Offscreen API is not available in this Chrome version.');
  }

  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [OFFSCREEN_CREATE_REASON],
      justification: 'Record tab video in MV3 while popup is closed.',
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }

  await creatingOffscreenDocument;
}

async function startVideoCapture(tabId) {
  if (state.videoRecording) {
    return { ok: true, recording: true };
  }

  const targetTabId = tabId ?? state.debuggeeTabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!Number.isInteger(targetTabId)) throw new Error('No active tab available for video capture.');
  let targetTab;
  try {
    targetTab = await chrome.tabs.get(targetTabId);
  } catch (_) {
    throw new Error('The tab selected for video capture is no longer available.');
  }
  validateCapturableTab(targetTab, 'capture video');

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
  if (CaptureLogic.validateStreamId) {
    CaptureLogic.validateStreamId(streamId);
  }
  const startRes = await chrome.runtime.sendMessage({ action: 'offscreenStartVideo', streamId });
  if (!startRes || startRes.error || startRes.ok === false) {
    throw new Error(startRes?.error || 'Offscreen recorder did not start.');
  }

  state.videoRecording = true;
  state.videoPending = false;
  return { ok: true, recording: true };
}

async function stopVideoCapture() {
  if (!state.videoRecording) {
    return { ok: true, recording: false };
  }

  try {
    await ensureOffscreenDocument();
    const stopRes = await chrome.runtime.sendMessage({ action: 'offscreenStopVideo' });
    if (stopRes?.error) {
      throw new Error(stopRes.error);
    }
  } finally {
    state.videoRecording = false;
    state.videoPending = false;
  }

  return { ok: true, recording: false };
}

async function stopCaptureAndSaveScenario() {
  await ensureDraftHydrated();
  await ensureSessionNameHydrated();

  const stopErrors = [];
  if (state.videoRecording) {
    try {
      const result = await stopVideoCapture();
      if (result?.ok === false || result?.error) throw new Error(result.error || 'Video could not be finalized.');
    } catch (error) {
      stopErrors.push(`Video: ${error.message}`);
    }
  }
  if (state.networkCapturing) {
    try {
      await stopNetworkCapture();
    } catch (error) {
      stopErrors.push(`Network: ${error.message}`);
    }
  }
  if (stopErrors.length) {
    throw new Error(`Capture stopped with errors. Evidence was retained. ${stopErrors.join(' ')}`);
  }
  await waitForDraftWrites();

  const droppedNetworkLogs = state.droppedNetworkLogs;
  const captureLimitReached = state.captureLimitReached;
  let saved = false;
  if (state.networkLogs.length || state.screenshots.length || state.videoChunks.length) {
    const name = state.sessionName
      ? `${state.sessionName} - ${new Date().toLocaleString()}`
      : `Session ${new Date().toLocaleString()}`;
    const evidence = {
      screenshots: [...state.screenshots],
      networkLogs: [...state.networkLogs],
      videoChunks: [...state.videoChunks],
    };
    const saveResult = await handlers.saveScenario({ name, evidence });
    if (!saveResult?.ok) throw new Error(saveResult?.error || 'Could not save the evidence scenario.');
    saved = true;
  }

  chrome.action.setBadgeText({ text: '' });
  await DraftStore.clear();
  state.screenshots = [];
  state.networkLogs = [];
  state.videoChunks = [];
  state._videoChunkTransfers = {};
  state._completedVideoTransfers = {};
  state._requestMap = {};
  state.droppedNetworkLogs = 0;
  state.evidenceBytes = 0;
  state.captureLimitReached = false;
  state.draftPersistenceError = null;
  state.draftSequence = 0;
  state.draftIds = new WeakMap();

  if (saved) chrome.runtime.sendMessage({ action: 'scenarioSaved' }).catch(() => {});
  return { ok: true, saved, droppedNetworkLogs, captureLimitReached };
}

/* ── Message router ── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.action !== 'string') {
    sendResponse({ error: 'Invalid extension message.' });
    return;
  }
  const handler = handlers[msg.action];
  if (handler) {
    ensureDraftHydrated()
      .then(() => handler(msg, sender))
      .then(sendResponse)
      .catch(err => sendResponse({ error: err?.message || 'Extension operation failed.' }));
    return true; // async
  } else {
    sendResponse({ error: `Unknown action: ${msg.action}` });
  }
});

const handlers = {
  /* 1. Screenshot – full page via CDP */
  async captureScreenshot() {
    await ensureDraftHydrated();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = validateCapturableTab(tab, 'capture a screenshot');
    const alreadyAttached = state.networkCapturing && state.debuggeeTabId === tabId;

    if (!alreadyAttached) {
      await chrome.debugger.attach({ tabId }, '1.3');
    }

    let overrideSet = false;
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      const width = Math.ceil(metrics.cssContentSize.width);
      const height = Math.ceil(metrics.cssContentSize.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1
        || width > 16384 || height > 16384 || width * height > 16_000_000) {
        throw new Error('This page is too large to capture as a full-page screenshot.');
      }
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      overrideSet = true;
      const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      const dataUrl = 'data:image/png;base64,' + result.data;
      if (state.screenshots.length >= MAX_SCREENSHOTS) {
        throw new Error(`Screenshot limit reached (${MAX_SCREENSHOTS}). Save this session before capturing more.`);
      }
      const screenshot = { name: `screenshot_${timestamp()}.png`, dataUrl, timestamp: new Date().toISOString() };
      if (!reserveEvidenceBytes({ screenshots: [screenshot] })) {
        throw new Error('Session evidence size limit reached (150 MiB). Save this session before capturing more.');
      }
      state.screenshots.push(screenshot);
      await persistDraft('screenshot', screenshot);
      return { ok: true, count: state.screenshots.length };
    } finally {
      if (overrideSet) {
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
        } catch (_) { /* The target may have navigated or detached. */ }
      }
      if (!alreadyAttached) await chrome.debugger.detach({ tabId });
    }
  },

  /* 2. Network – toggle */
  async toggleNetwork() {
    if (state.networkCapturing) {
      await stopNetworkCapture();
      chrome.action.setBadgeText({ text: '' });
      return { ok: true, capturing: false, count: state.networkLogs.length };
    } else {
      await startNetworkCapture();
      chrome.action.setBadgeBackgroundColor({ color: '#f38ba8' });
      chrome.action.setBadgeText({ text: 'REC' });
      return { ok: true, capturing: true };
    }
  },

  /* 3. Video – toggle */
  async toggleVideo(msg) {
    if (state.videoRecording) {
      return stopVideoCapture();
    } else {
      return startVideoCapture(msg?.tabId);
    }
  },

  async startCapture(msg) {
    await ensureDraftHydrated();
    if (state.captureLimitReached || state.draftPersistenceError) {
      throw new Error(state.draftPersistenceError || 'Save retained evidence before starting a new capture.');
    }
    if (state.networkCapturing || state.videoRecording) {
      return { ok: true, capturing: true, videoRecording: state.videoRecording };
    }
    if (!startingCapturePromise) {
      startingCapturePromise = (async () => {
        await startNetworkCapture();
        try {
          if (msg.includeVideo) await startVideoCapture(state.debuggeeTabId);
        } catch (error) {
          await stopNetworkCapture();
          chrome.action.setBadgeText({ text: '' });
          throw error;
        }
        chrome.action.setBadgeBackgroundColor({ color: '#f38ba8' });
        chrome.action.setBadgeText({ text: 'REC' });
        return { ok: true, capturing: true, videoRecording: state.videoRecording };
      })().finally(() => {
        // Clear only after full settlement so no second caller can race in during error rollback.
        startingCapturePromise = null;
      });
    }
    return startingCapturePromise;
  },

  async stopCapture() {
    await ensureDraftHydrated();
    if (startingCapturePromise) await startingCapturePromise;
    if (!stoppingCapturePromise) stoppingCapturePromise = stopCaptureAndSaveScenario();
    try {
      return await stoppingCapturePromise;
    } finally {
      stoppingCapturePromise = null;
    }
  },

  async videoCaptureLimitReached(msg) {
    state.captureLimitReached = true;
    state.videoPending = true;
    chrome.action.setBadgeText({ text: 'MAX' });
    if (state.networkCapturing) await stopNetworkCapture();
    chrome.runtime.sendMessage({
      action: 'captureLimitReached',
      message: msg.message || 'Video capture reached its size limit and was stopped.',
    }).catch(() => {});
    return { ok: true };
  },

  async videoRecorderFailed(msg) {
    state.videoRecording = false;
    state.videoPending = true;
    chrome.runtime.sendMessage({
      action: 'captureLimitReached',
      message: msg.message || 'Video recorder stopped unexpectedly. Use Stop & Save / Recover to save the captured portion.',
    }).catch(() => {});
    return { ok: true };
  },

  /* Save video chunks from popup */
  async saveVideoChunk(msg) {
    if (msg.transferId) {
      const transferId = msg.transferId;
      const completedAt = state._completedVideoTransfers[transferId];
      if (completedAt && Date.now() - completedAt < 120000) {
        return { ok: true, completed: true, duplicate: true };
      }
      // Clean up any expired completion record for this transferId before reuse.
      if (completedAt) delete state._completedVideoTransfers[transferId];
      if (!state._videoChunkTransfers[transferId]) {
        state._videoChunkTransfers[transferId] = {
          prefix: msg.prefix || 'data:video/webm;base64,',
          totalParts: msg.totalParts || 0,
          parts: [],
        };
      }

      const transfer = state._videoChunkTransfers[transferId];
      const result = CaptureLogic.mergeVideoTransfer ? CaptureLogic.mergeVideoTransfer(transfer, {
        prefix: msg.prefix,
        totalParts: msg.totalParts,
        partIndex: msg.partIndex,
        part: msg.part,
        isLast: msg.isLast,
      }) : null;

      if (result && result.transfer) {
        state._videoChunkTransfers[transferId] = result.transfer;
      }

      if (result && result.ok === false) {
        return { ok: false, error: result.error };
      }

      if (result && result.completed === true) {
        if (!reserveEvidenceBytes({ videoChunks: [result.data] })) {
          delete state._videoChunkTransfers[transferId];
          return { ok: false, error: 'Session evidence size limit reached (150 MiB). Stop and save this session.' };
        }
        state.videoChunks.push(result.data);
        await persistDraft('video', result.data);
        delete state._videoChunkTransfers[transferId];
        state._completedVideoTransfers[transferId] = Date.now();
        for (const [id, time] of Object.entries(state._completedVideoTransfers)) {
          if (Date.now() - time >= 120000) delete state._completedVideoTransfers[id];
        }
        return { ok: true, completed: true };
      }

      return { ok: true, completed: false };
    }

    if (typeof msg.chunk !== 'string' || !msg.chunk.startsWith('data:video/webm;base64,')) {
      throw new Error('Invalid video chunk.');
    }
    if (!reserveEvidenceBytes({ videoChunks: [msg.chunk] })) {
      throw new Error('Session evidence size limit reached (150 MiB). Stop and save this session.');
    }
    state.videoChunks.push(msg.chunk);
    await persistDraft('video', msg.chunk);
    return { ok: true };
  },

  /* 4. Gather all evidence for ZIP */
  async getEvidence() {
    await ensureDraftHydrated();
    // stop any running captures first
    if (state.networkCapturing) await stopNetworkCapture();
    if (state.videoRecording) await stopVideoCapture();
    await waitForDraftWrites();

    return {
      ok: true,
      screenshots: [...state.screenshots],
      networkLogs: [...state.networkLogs],
      videoChunks: [...state.videoChunks],
    };
  },

  /* Reset */
  async resetEvidence() {
    await ensureDraftHydrated();
    if (state.networkCapturing || state.videoRecording) {
      throw new Error('Stop the active capture before clearing evidence.');
    }
    await waitForDraftWrites();
    await DraftStore.clear();
    state.screenshots = [];
    state.networkLogs = [];
    state.videoChunks = [];
    state._videoChunkTransfers = {};
    state._completedVideoTransfers = {};
    state._requestMap = {};
    state.droppedNetworkLogs = 0;
    state.evidenceBytes = 0;
    state.captureLimitReached = false;
    state.draftPersistenceError = null;
    state.draftSequence = 0;
    state.draftIds = new WeakMap();
    return { ok: true };
  },

  /* Read-only evidence for viewer (doesn't stop captures) */
  async getEvidenceReadonly() {
    await ensureDraftHydrated();
    await waitForDraftWrites();
    return {
      ok: true,
      screenshots: [...state.screenshots],
      networkLogs: [...state.networkLogs],
      videoChunks: [...state.videoChunks],
    };
  },

  async setSessionName(msg) {
    const name = (msg.name || '').trim();
    state.sessionName = name || null;
    await persistSessionName(state.sessionName);
    return { ok: true };
  },

  async saveScenario(msg) {
    const persist = async () => {
      const MAX_SCENARIOS = 50;
      const MAX_STORED_BYTES = 500 * 1024 * 1024;
      const snapshot = CaptureLogic.cloneEvidenceSnapshot(msg.evidence);
      const scenario = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : 'Evidence session',
        date: new Date().toISOString(),
        screenshots: snapshot.screenshots,
        networkLogs: snapshot.networkLogs,
        videoChunks: snapshot.videoChunks,
      };
      const evidenceBytes = CaptureLogic.estimateEvidenceSize(snapshot);
      if (evidenceBytes > MAX_SCENARIO_BYTES) {
        throw new Error('This session exceeds the 150 MiB save limit. Export smaller sessions to avoid storage failures.');
      }
      const stored = await chrome.storage.local.get('scenarios');
      const list = Array.isArray(stored.scenarios) ? stored.scenarios : [];
      list.unshift(scenario);
      let storedBytes = 0;
      let keepCount = 0;
      for (const candidate of list) {
        const candidateBytes = CaptureLogic.estimateEvidenceSize(candidate);
        if (keepCount >= MAX_SCENARIOS || storedBytes + candidateBytes > MAX_STORED_BYTES) break;
        storedBytes += candidateBytes;
        keepCount += 1;
      }
      list.length = keepCount;
      await chrome.storage.local.set({ scenarios: list });
      return { ok: true };
    };
    const pending = scenarioSaveQueue.then(persist, persist);
    scenarioSaveQueue = pending.then(() => undefined, () => undefined);
    return pending;
  },

  async getScenarios() {
    const r = await chrome.storage.local.get('scenarios');
    const scenarios = Array.isArray(r.scenarios) ? r.scenarios : [];
    return { ok: true, scenarios: scenarios.map(summarizeScenario) };
  },

  async getScenario(msg) {
    const r = await chrome.storage.local.get('scenarios');
    const scenario = (Array.isArray(r.scenarios) ? r.scenarios : [])
      .find((item) => String(item.id || item.date) === String(msg.id));
    if (!scenario) throw new Error('The requested saved session no longer exists.');
    return { ok: true, scenario };
  },

  async getLatestScenario() {
    const r = await chrome.storage.local.get('scenarios');
    const scenario = Array.isArray(r.scenarios) ? r.scenarios[0] : null;
    return { ok: true, scenario };
  },

  async deleteScenario(msg) {
    const r = await chrome.storage.local.get('scenarios');
    const list = (r.scenarios || []).filter(s => (s.id || s.date) !== msg.id);
    await chrome.storage.local.set({ scenarios: list });
    return { ok: true, scenarios: list.map(summarizeScenario) };
  },

  async getStatus() {
    await ensureDraftHydrated();
    await ensureSessionNameHydrated();
    return {
      ssCount: state.screenshots.length,
      networkCapturing: state.networkCapturing,
      netCount: state.networkLogs.length,
      videoRecording: state.videoRecording,
      videoPending: state.videoPending,
      sessionName: state.sessionName || '',
      droppedNetworkLogs: state.droppedNetworkLogs,
      captureLimitReached: state.captureLimitReached,
      draftPersistenceError: state.draftPersistenceError,
    };
  },
};

/* ── Network capture via chrome.debugger ── */
async function startNetworkCapture() {
  if (state.networkCapturing) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = validateCapturableTab(tab, 'capture network activity');

  if (!Number.isInteger(tabId)) {
    throw new Error('No active tab available for network capture.');
  }

  state.debuggeeTabId = tabId;
  let attached = false;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    addDebuggerEventListener();
    state.networkCapturing = true;
    if (chrome.storage.session) {
      await chrome.storage.session.set({ [ACTIVE_CAPTURE_TAB_KEY]: tabId });
    }
  } catch (error) {
    removeDebuggerEventListener();
    if (attached) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) { /* Target detached during setup. */ }
    }
    state.debuggeeTabId = null;
    state.networkCapturing = false;
    if (chrome.storage.session) {
      try { await chrome.storage.session.remove(ACTIVE_CAPTURE_TAB_KEY); } catch (_) { /* Best-effort rollback. */ }
    }
    throw error;
  }
}

async function stopNetworkCapture() {
  // Keep networkCapturing true while draining so in-flight CDP events are still handled.
  if (state.pendingBodyRequests.size) {
    let timeoutId;
    await Promise.race([
      Promise.allSettled([...state.pendingBodyRequests]),
      new Promise((resolve) => { timeoutId = setTimeout(resolve, 10000); }),
    ]);
    clearTimeout(timeoutId);
  }
  state.networkCapturing = false;
  if (state.debuggeeTabId != null) {
    try {
      removeDebuggerEventListener();
      await chrome.debugger.detach({ tabId: state.debuggeeTabId });
    } catch (_) { /* already detached */ }
    state.debuggeeTabId = null;
  }
  if (chrome.storage.session) {
    try { await chrome.storage.session.remove(ACTIVE_CAPTURE_TAB_KEY); }
    catch (error) { console.error('Could not clear persisted capture state:', error); }
  }
  Object.keys(state._requestMap).forEach((requestId) => {
    if (CaptureLogic.cleanupRequestMap) {
      CaptureLogic.cleanupRequestMap(state._requestMap, requestId);
    } else {
      delete state._requestMap[requestId];
    }
  });
}

function onDebugEvent(source, method, params) {
  if (!state.draftHydrated) {
    ensureDraftHydrated()
      .then(() => onDebugEvent(source, method, params))
      .catch((error) => console.error('Could not restore evidence before handling network data:', error));
    return;
  }
  if (!state.networkCapturing) return;
  const tabId = state.debuggeeTabId;
  if (source?.tabId !== tabId) return;

  if (method === 'Network.requestWillBeSent') {
    const previous = state._requestMap[params.requestId];
    if (params.redirectResponse && previous) {
      const redirect = {
        status: params.redirectResponse.status,
        mimeType: params.redirectResponse.mimeType,
        responseHeaders: params.redirectResponse.headers || {},
        resourceType: params.type,
        redirected: true,
        requestCompleted: true,
      };
      if (reserveEvidenceBytes({ networkLogs: [redirect] })) {
        Object.assign(previous, redirect);
        persistDraftInBackground('network', previous);
      }
      else previous.responseMetadataUnavailable = 'Session evidence size limit reached.';
    }
    if (state.networkLogs.length >= MAX_NETWORK_LOGS) {
      state.droppedNetworkLogs += 1;
      delete state._requestMap[params.requestId];
      return;
    }
    const req = params.request;
    const entry = {
      requestId: params.requestId,
      url: req.url,
      method: req.method,
      resourceType: null,
      status: null,
      mimeType: null,
      timestamp: new Date().toISOString(),
      requestHeaders: req.headers || {},
      requestBody: null,
      responseHeaders: {},
      responseBody: null,
    };
    // Capture POST data if present
    if (req.postData) {
      entry.requestBody = req.postData;
    } else if (req.hasPostData) {
      let task;
      task = chrome.debugger.sendCommand({ tabId }, 'Network.getRequestPostData', { requestId: params.requestId })
        .then(res => {
          const body = res.postData ?? null;
          if (body && state.networkLogs.includes(entry)
            && reserveEvidenceBytes({ networkLogs: [{ requestBody: body }] })) {
            entry.requestBody = body;
            persistDraftInBackground('network', entry);
          }
          else if (body) entry.requestBodyUnavailable = 'Session evidence size limit reached.';
        })
        .catch(error => { entry.requestBodyUnavailable = error?.message || 'Chrome did not return request body data.'; })
        .finally(() => state.pendingBodyRequests.delete(task));
      state.pendingBodyRequests.add(task);
    }
    if (!reserveEvidenceBytes({ networkLogs: [entry] })) {
      state.droppedNetworkLogs += 1;
      delete state._requestMap[params.requestId];
      return;
    }
    state.networkLogs.push(entry);
    state._requestMap[params.requestId] = entry;
    persistDraftInBackground('network', entry);
  } else if (method === 'Network.responseReceived') {
    const r = params.response;
    const entry = state._requestMap[params.requestId];
    if (entry && state.networkLogs.includes(entry)) {
      // Merge response info into the existing request entry
      const metadata = { status: r.status, mimeType: r.mimeType, resourceType: params.type };
      if (reserveEvidenceBytes({ networkLogs: [metadata] })) {
        Object.assign(entry, metadata);
        persistDraftInBackground('network', entry);
      }
      else entry.responseMetadataUnavailable = 'Session evidence size limit reached.';
      const headers = r.headers || {};
      if (reserveEvidenceBytes({ networkLogs: [{ responseHeaders: headers }] })) {
        entry.responseHeaders = headers;
        persistDraftInBackground('network', entry);
      } else {
        entry.responseHeadersUnavailable = 'Session evidence size limit reached.';
      }
    } else {
      // Orphan response (no matching request) – store standalone
      const entry = {
        requestId: params.requestId,
        url: r.url,
        method: r.requestHeaders?.[':method'] || r.requestHeaders?.['method'] || 'UNKNOWN',
        resourceType: params.type,
        status: r.status,
        mimeType: r.mimeType,
        timestamp: new Date().toISOString(),
        requestHeaders: {},
        requestBody: null,
        responseHeaders: r.headers || {},
        responseBody: null,
      };
      if (state.networkLogs.length >= MAX_NETWORK_LOGS) {
        state.droppedNetworkLogs += 1;
        return;
      }
      if (!reserveEvidenceBytes({ networkLogs: [entry] })) {
        state.droppedNetworkLogs += 1;
        return;
      }
      state.networkLogs.push(entry);
      state._requestMap[params.requestId] = entry;
      persistDraftInBackground('network', entry);
    }
  } else if (method === 'Network.loadingFinished') {
    const entry = state._requestMap[params.requestId];
    if (entry && tabId != null) {
      entry.requestCompleted = true;
      persistDraftInBackground('network', entry);
      let task;
      task = chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId })
        .then(res => {
          if (state.networkLogs.includes(entry)) {
            const body = res.body || '';
            const bodyData = {
              responseBody: body,
              responseBodyTruncated: false,
              responseBodyOriginalSize: body.length,
              responseBodyBase64Encoded: !!res.base64Encoded,
            };
            if (!reserveEvidenceBytes({ networkLogs: [bodyData] })) {
              entry.responseBodyUnavailable = 'Session evidence size limit reached.';
              return;
            }
            Object.assign(entry, bodyData);
            persistDraftInBackground('network', entry);
          }
        })
        .catch(error => {
          if (state.networkLogs.includes(entry)) {
            entry.responseBodyUnavailable = error?.message || 'Chrome did not return response body data.';
            persistDraftInBackground('network', entry);
          }
        })
        .finally(() => {
          if (state._requestMap[params.requestId] === entry) delete state._requestMap[params.requestId];
          state.pendingBodyRequests.delete(task);
        });
      state.pendingBodyRequests.add(task);
    } else if (!entry) {
      delete state._requestMap[params.requestId];
    }
  } else if (method === 'Network.loadingFailed') {
    const entry = state._requestMap[params.requestId];
    if (entry) {
      entry.requestFailed = true;
      persistDraftInBackground('network', entry);
    }
    delete state._requestMap[params.requestId];
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Register the CDP event listener unconditionally so it is ready when the service worker
// restarts and hydration re-establishes an active debugger session. onDebugEvent
// short-circuits early when state.networkCapturing is false, so no spurious processing occurs.
addDebuggerEventListener();

chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId !== state.debuggeeTabId) return;
  state.networkCapturing = false;
  state.debuggeeTabId = null;
  state._requestMap = {};
  if (chrome.storage.session) {
    chrome.storage.session.remove(ACTIVE_CAPTURE_TAB_KEY)
      .catch((error) => console.error('Could not clear detached capture state:', error));
  }
  removeDebuggerEventListener();
  chrome.action.setBadgeText({ text: '' });
  chrome.runtime.sendMessage({
    action: 'recordingToggled',
    capturing: state.videoRecording,
    netCount: state.networkLogs.length,
    videoRecording: state.videoRecording,
  }).catch(() => {});
});

/* ── Keyboard shortcut: Ctrl+Shift+S for screenshot ── */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-screenshot') {
    try {
      await handlers.captureScreenshot();
      // Flash badge to notify user
      chrome.action.setBadgeBackgroundColor({ color: '#a6e3a1' });
      chrome.action.setBadgeText({ text: `📸${state.screenshots.length}` });
      setTimeout(() => {
        if (state.networkCapturing) {
          chrome.action.setBadgeBackgroundColor({ color: '#f38ba8' });
          chrome.action.setBadgeText({ text: 'REC' });
        } else {
          chrome.action.setBadgeText({ text: '' });
        }
      }, 1500);
      // Also notify any open popup / content via message
      chrome.runtime.sendMessage({ action: 'screenshotTaken', count: state.screenshots.length }).catch(() => {});
    } catch (err) {
      console.error('Screenshot shortcut failed:', err);
    }
  } else if (command === 'toggle-recording') {
    try {
      if (state.networkCapturing || state.videoRecording) {
        await handlers.stopCapture();
      } else {
        const pref = await chrome.storage.local.get(VIDEO_PREF_KEY);
        const includeVideo = pref[VIDEO_PREF_KEY] !== false;
        await handlers.startCapture({ includeVideo });
      }
      // Notify popup to update UI
      chrome.runtime.sendMessage({
        action: 'recordingToggled',
        capturing: state.networkCapturing || state.videoRecording,
        netCount: state.networkLogs.length,
        videoRecording: state.videoRecording,
      }).catch(() => {});
    } catch (err) {
      console.error('Toggle recording shortcut failed:', err);
    }
  }
});
