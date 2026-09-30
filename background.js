/* ── Evidence Capture – Background Service Worker ── */

if (typeof importScripts === 'function') {
  importScripts('capture-logic.js');
}

const CaptureLogic = globalThis.CaptureLogic || {};

const state = {
  screenshots: [],       // { name, dataUrl }
  networkLogs: [],       // { method, url, status, type, timestamp, ... }
  videoChunks: [],       // base64 strings
  _videoChunkTransfers: {}, // transferId -> { prefix, totalParts, parts[] }
  sessionName: null,
  networkCapturing: false,
  videoRecording: false,
  debuggeeTabId: null,
  _requestMap: {},       // requestId -> index in networkLogs (for correlating response bodies)
};

const SESSION_NAME_STORAGE_KEY = 'sessionNameState';
const VIDEO_PREF_KEY = 'includeVideo';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_CREATE_REASON = 'USER_MEDIA';

let sessionNameHydrated = false;
let creatingOffscreenDocument = null;

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
  if (CaptureLogic.validateTabId) {
    CaptureLogic.validateTabId({ id: targetTabId });
  } else if (targetTabId == null) {
    throw new Error('No active tab available for video capture.');
  }

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
  if (CaptureLogic.validateStreamId) {
    CaptureLogic.validateStreamId(streamId);
  }
  const startRes = await chrome.runtime.sendMessage({ action: 'offscreenStartVideo', streamId });
  if (startRes?.error) {
    throw new Error(startRes.error);
  }

  state.videoRecording = true;
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
  }

  return { ok: true, recording: false };
}

async function stopCaptureAndSaveScenario() {
  await ensureSessionNameHydrated();

  if (state.videoRecording) {
    await stopVideoCapture();
  }
  if (state.networkCapturing) {
    await stopNetworkCapture();
  }

  chrome.action.setBadgeText({ text: '' });

  if (state.networkLogs.length || state.screenshots.length || state.videoChunks.length) {
    const name = state.sessionName
      ? `${state.sessionName} - ${new Date().toLocaleString()}`
      : `Session ${new Date().toLocaleString()}`;
    const evidence = {
      screenshots: [...state.screenshots],
      networkLogs: [...state.networkLogs],
      videoChunks: [...state.videoChunks],
    };
    await handlers.saveScenario({ name, evidence });
  }

  state.screenshots = [];
  state.networkLogs = [];
  state.videoChunks = [];
  state._videoChunkTransfers = {};
  state._requestMap = {};

  chrome.runtime.sendMessage({ action: 'scenarioSaved' }).catch(() => {});
}

/* ── Message router ── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg.action];
  if (handler) {
    handler(msg, sender).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true; // async
  }
});

const handlers = {
  /* 1. Screenshot – full page via CDP */
  async captureScreenshot() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = CaptureLogic.validateTabId ? CaptureLogic.validateTabId(tab) : tab?.id;
    const alreadyAttached = state.networkCapturing && state.debuggeeTabId === tabId;

    if (!alreadyAttached) {
      await chrome.debugger.attach({ tabId }, '1.3');
    }

    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      const width = Math.ceil(metrics.cssContentSize.width);
      const height = Math.ceil(metrics.cssContentSize.height);
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
      const dataUrl = 'data:image/png;base64,' + result.data;
      const name = `screenshot_${timestamp()}.png`;
      state.screenshots.push({ name, dataUrl });
      return { ok: true, count: state.screenshots.length };
    } finally {
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

  /* Save video chunks from popup */
  async saveVideoChunk(msg) {
    if (msg.transferId) {
      const transferId = msg.transferId;
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
        state.videoChunks.push(result.data);
        delete state._videoChunkTransfers[transferId];
        return { ok: true, completed: true };
      }

      return { ok: true, completed: false };
    }

    state.videoChunks.push(msg.chunk);
    return { ok: true };
  },

  /* 4. Gather all evidence for ZIP */
  async getEvidence() {
    // stop any running captures first
    if (state.networkCapturing) await stopNetworkCapture();
    if (state.videoRecording) await stopVideoCapture();

    return {
      ok: true,
      screenshots: [...state.screenshots],
      networkLogs: [...state.networkLogs],
      videoChunks: [...state.videoChunks],
    };
  },

  /* Reset */
  async resetEvidence() {
    state.screenshots = [];
    state.networkLogs = [];
    state.videoChunks = [];
    state._videoChunkTransfers = {};
    state._requestMap = {};
    return { ok: true };
  },

  /* Read-only evidence for viewer (doesn't stop captures) */
  async getEvidenceReadonly() {
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
    const MAX_SCENARIOS = 50;
    const snapshot = CaptureLogic.cloneEvidenceSnapshot ? CaptureLogic.cloneEvidenceSnapshot(msg.evidence) : {
      screenshots: Array.isArray(msg.evidence?.screenshots) ? [...msg.evidence.screenshots] : [],
      networkLogs: Array.isArray(msg.evidence?.networkLogs) ? [...msg.evidence.networkLogs] : [],
      videoChunks: Array.isArray(msg.evidence?.videoChunks) ? [...msg.evidence.videoChunks] : [],
    };

    const scenario = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: msg.name,
      date: new Date().toISOString(),
      screenshots: snapshot.screenshots,
      networkLogs: snapshot.networkLogs,
      videoChunks: snapshot.videoChunks,
    };
    const r = await chrome.storage.local.get('scenarios');
    const list = r.scenarios || [];
    list.unshift(scenario);
    // Auto-prune oldest entries beyond the cap
    if (list.length > MAX_SCENARIOS) {
      list.length = MAX_SCENARIOS;
    }
    await chrome.storage.local.set({ scenarios: list });
    return { ok: true };
  },

  async getScenarios() {
    const r = await chrome.storage.local.get('scenarios');
    return { ok: true, scenarios: r.scenarios || [] };
  },

  async deleteScenario(msg) {
    const r = await chrome.storage.local.get('scenarios');
    const list = (r.scenarios || []).filter(s => (s.id || s.date) !== msg.id);
    await chrome.storage.local.set({ scenarios: list });
    return { ok: true, scenarios: list };
  },

  async getStatus() {
    await ensureSessionNameHydrated();
    return {
      ssCount: state.screenshots.length,
      networkCapturing: state.networkCapturing,
      netCount: state.networkLogs.length,
      videoRecording: state.videoRecording,
      sessionName: state.sessionName || '',
    };
  },
};

/* ── Network capture via chrome.debugger ── */
async function startNetworkCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = CaptureLogic.validateTabId ? CaptureLogic.validateTabId(tab) : tab?.id;

  if (!Number.isInteger(tabId)) {
    throw new Error('No active tab available for network capture.');
  }

  state.debuggeeTabId = tabId;
  state.networkCapturing = false;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    chrome.debugger.onEvent.addListener(onDebugEvent);
    state.networkCapturing = true;
  } catch (error) {
    try {
      chrome.debugger.onEvent.removeListener(onDebugEvent);
      await chrome.debugger.detach({ tabId });
    } catch (_) { /* already detached */ }
    state.debuggeeTabId = null;
    state.networkCapturing = false;
    throw error;
  }
}

async function stopNetworkCapture() {
  state.networkCapturing = false;
  if (state.debuggeeTabId != null) {
    try {
      chrome.debugger.onEvent.removeListener(onDebugEvent);
      await chrome.debugger.detach({ tabId: state.debuggeeTabId });
    } catch (_) { /* already detached */ }
    state.debuggeeTabId = null;
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
  if (!state.networkCapturing) return;
  const tabId = state.debuggeeTabId;

  if (method === 'Network.requestWillBeSent') {
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
      chrome.debugger.sendCommand({ tabId }, 'Network.getRequestPostData', { requestId: params.requestId })
        .then(res => { entry.requestBody = res.postData; })
        .catch(() => {});
    }
    const idx = state.networkLogs.push(entry) - 1;
    state._requestMap[params.requestId] = idx;
  } else if (method === 'Network.responseReceived') {
    const r = params.response;
    const idx = state._requestMap[params.requestId];
    if (idx !== undefined && state.networkLogs[idx]) {
      // Merge response info into the existing request entry
      const entry = state.networkLogs[idx];
      entry.status = r.status;
      entry.mimeType = r.mimeType;
      entry.resourceType = params.type;
      entry.responseHeaders = r.headers || {};
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
      const newIdx = state.networkLogs.push(entry) - 1;
      state._requestMap[params.requestId] = newIdx;
    }
  } else if (method === 'Network.loadingFinished') {
    const idx = state._requestMap[params.requestId];
    if (idx !== undefined && tabId != null) {
      chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId })
        .then(res => {
          if (state.networkLogs[idx]) {
            const MAX_BODY = 100000;
            const body = res.body || '';
            const truncated = body.length > MAX_BODY;
            state.networkLogs[idx].responseBody = truncated ? body.slice(0, MAX_BODY) : body;
            state.networkLogs[idx].responseBodyTruncated = truncated;
            state.networkLogs[idx].responseBodyOriginalSize = body.length;
            state.networkLogs[idx].responseBodyBase64Encoded = !!res.base64Encoded;
          }
        })
        .catch(() => {})
        .finally(() => {
          if (CaptureLogic.cleanupRequestMap) {
            CaptureLogic.cleanupRequestMap(state._requestMap, params.requestId);
          } else {
            delete state._requestMap[params.requestId];
          }
        });
    } else if (CaptureLogic.cleanupRequestMap) {
      CaptureLogic.cleanupRequestMap(state._requestMap, params.requestId);
    } else {
      delete state._requestMap[params.requestId];
    }
  } else if (method === 'Network.loadingFailed') {
    if (CaptureLogic.cleanupRequestMap) {
      CaptureLogic.cleanupRequestMap(state._requestMap, params.requestId);
    } else {
      delete state._requestMap[params.requestId];
    }
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

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
      if (state.networkCapturing) {
        await stopCaptureAndSaveScenario();
      } else {
        await startNetworkCapture();
        const pref = await chrome.storage.local.get(VIDEO_PREF_KEY);
        const includeVideo = pref[VIDEO_PREF_KEY] !== false;
        if (includeVideo) {
          try {
            await startVideoCapture(state.debuggeeTabId);
          } catch (videoError) {
            console.error('Shortcut video start failed:', videoError);
          }
        }
        chrome.action.setBadgeBackgroundColor({ color: '#f38ba8' });
        chrome.action.setBadgeText({ text: 'REC' });
      }
      // Notify popup to update UI
      chrome.runtime.sendMessage({
        action: 'recordingToggled',
        capturing: state.networkCapturing,
        netCount: state.networkLogs.length,
        videoRecording: state.videoRecording,
      }).catch(() => {});
    } catch (err) {
      console.error('Toggle recording shortcut failed:', err);
    }
  }
});
