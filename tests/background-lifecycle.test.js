const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const captureLogic = require('../capture-logic.js');

function createBackgroundHarness(options = {}) {
  const listeners = {};
  const calls = [];
  const storage = { scenarios: [] };
  const sessionStore = options.sessionStore || {};
  const draftRecords = options.draftRecords || [];
  const draftStore = options.draftStore || {
    load: async () => structuredClone(draftRecords),
    put: async (record) => {
      const index = draftRecords.findIndex((item) => item.id === record.id);
      if (index < 0) draftRecords.push(structuredClone(record));
      else draftRecords[index] = structuredClone(record);
    },
    clear: async () => { draftRecords.length = 0; },
  };
  let attached = false;
  const runtimeMessageListeners = [];
  const context = {
    CaptureLogic: captureLogic,
    DraftStore: draftStore,
    console,
    Date,
    Math,
    URL,
    setTimeout,
    clearTimeout,
    globalThis: null,
    importScripts: () => {},
  };
  context.globalThis = context;
  context.chrome = {
    runtime: {
      onMessage: { addListener: (listener) => runtimeMessageListeners.push(listener) },
      sendMessage: async (message) => {
        calls.push(['runtime.sendMessage', message]);
        if (options.videoStartError && message.action === 'offscreenStartVideo') {
          return { ok: false, error: 'Video permission denied' };
        }
        if (options.videoStopError && message.action === 'offscreenStopVideo') {
          return { ok: false, error: 'Video could not be finalized' };
        }
        if (message.action === 'offscreenGetStatus') {
          return { recording: false, pending: options.offscreenPending === true };
        }
        return { ok: true };
      },
    },
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionStore[key] }),
        set: async (values) => Object.assign(sessionStore, values),
        remove: async (key) => { delete sessionStore[key]; },
      },
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (values) => {
          if (options.storageError && 'scenarios' in values) throw new Error('Storage quota exceeded');
          Object.assign(storage, values);
        },
      },
    },
    tabs: {
      query: async () => [{ id: 3, url: options.url || 'https://example.test/' }],
      get: async (id) => ({ id, url: options.url || 'https://example.test/' }),
    },
    debugger: {
      getTargets: async () => options.targets || [],
      attach: async () => {
        calls.push(['debugger.attach']);
        if (options.attachError) throw new Error('Debugger attach denied');
        attached = true;
      },
      detach: async () => {
        calls.push(['debugger.detach']);
        attached = false;
      },
      sendCommand: async (_target, method) => {
        calls.push(['debugger.sendCommand', method]);
        if (method === 'Network.getResponseBody') {
          return { body: 'FULL_RESPONSE_'.repeat(15000), base64Encoded: false };
        }
        if (method === 'Page.getLayoutMetrics') {
          return { cssContentSize: { width: 800, height: 600 } };
        }
        if (method === 'Page.captureScreenshot') return { data: 'c2NyZWVuc2hvdA==' };
        return {};
      },
      onEvent: {
        addListener: (listener) => { listeners.debuggerEvent = listener; },
        removeListener: () => { delete listeners.debuggerEvent; },
      },
      onDetach: { addListener: (listener) => { listeners.debuggerDetach = listener; } },
    },
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    tabCapture: { getMediaStreamId: async () => 'stream-id' },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    commands: { onCommand: { addListener: (listener) => { listeners.command = listener; } } },
  };

  const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'background.js' });

  async function message(payload) {
    return new Promise((resolve) => {
      const listener = runtimeMessageListeners[0];
      const asyncResponse = listener(payload, { id: 'test' }, resolve);
      if (asyncResponse !== true) resolve(undefined);
    });
  }

  return { message, calls, listeners, storage, sessionStore, draftRecords, get attached() { return attached; } };
}

test('failed debugger attach leaves no false active state and does not detach another session', async () => {
  const harness = createBackgroundHarness({ attachError: true });
  const result = await harness.message({ action: 'startCapture', includeVideo: false });

  assert.match(result.error, /Debugger attach denied/);
  assert.equal(harness.calls.filter(([name]) => name === 'debugger.detach').length, 0);
  assert.equal(harness.attached, false);
});

test('stop saves immutable full response bodies and clears in-memory capture state', async () => {
  const harness = createBackgroundHarness();
  assert.equal((await harness.message({ action: 'startCapture', includeVideo: false })).ok, true);

  harness.listeners.debuggerEvent(
    { tabId: 3 },
    'Network.requestWillBeSent',
    { requestId: 'request-1', request: { url: 'https://example.test/data?token=full-value', method: 'GET', headers: {} } },
  );
  harness.listeners.debuggerEvent(
    { tabId: 3 },
    'Network.responseReceived',
    { requestId: 'request-1', type: 'Fetch', response: { url: 'https://example.test/data', status: 200, mimeType: 'application/json', headers: {} } },
  );
  harness.listeners.debuggerEvent({ tabId: 3 }, 'Network.loadingFinished', { requestId: 'request-1' });

  const stop = await harness.message({ action: 'stopCapture' });
  assert.equal(stop.ok, true);
  assert.equal(stop.saved, true);
  const saved = harness.storage.scenarios[0];
  assert.equal(saved.networkLogs[0].url, 'https://example.test/data?token=full-value');
  assert.equal(saved.networkLogs[0].responseBody, 'FULL_RESPONSE_'.repeat(15000));
  assert.equal(harness.attached, false);
  const status = await harness.message({ action: 'getStatus' });
  assert.equal(status.netCount, 0);
});

test('internal browser pages are rejected before debugger attach', async () => {
  const harness = createBackgroundHarness({ url: 'chrome://settings/' });
  const result = await harness.message({ action: 'captureScreenshot' });

  assert.match(result.error, /browser-internal page/);
  assert.equal(harness.calls.some(([name]) => name === 'debugger.attach'), false);
});

test('video start failure rolls back the network debugger attach', async () => {
  const harness = createBackgroundHarness({ videoStartError: true });
  const result = await harness.message({ action: 'startCapture', includeVideo: true });

  assert.match(result.error, /Video permission denied/);
  assert.equal(harness.attached, false);
  assert.equal(harness.calls.filter(([name]) => name === 'debugger.detach').length, 1);
});

test('failed video finalization retains captured evidence for recovery', async () => {
  const harness = createBackgroundHarness({ videoStopError: true });
  await harness.message({ action: 'startCapture', includeVideo: true });
  await harness.message({ action: 'captureScreenshot' });

  const result = await harness.message({ action: 'stopCapture' });
  assert.match(result.error, /Video could not be finalized/);
  const evidence = await harness.message({ action: 'getEvidenceReadonly' });
  assert.equal(evidence.screenshots.length, 1);
  assert.equal(harness.storage.scenarios.length, 0);
});

test('storage failure does not clear captured evidence', async () => {
  const harness = createBackgroundHarness({ storageError: true });
  await harness.message({ action: 'startCapture', includeVideo: false });
  await harness.message({ action: 'captureScreenshot' });

  const result = await harness.message({ action: 'stopCapture' });
  assert.match(result.error, /Storage quota exceeded/);
  const evidence = await harness.message({ action: 'getEvidenceReadonly' });
  assert.equal(evidence.screenshots.length, 1);
});

test('evidence draft survives a service-worker restart and resumes an attached network session', async () => {
  const first = createBackgroundHarness();
  await first.message({ action: 'startCapture', includeVideo: false });
  await first.message({ action: 'captureScreenshot' });
  assert.equal(first.draftRecords.length, 1);
  assert.equal(first.sessionStore.activeCaptureTab, 3);

  const restarted = createBackgroundHarness({
    draftRecords: first.draftRecords,
    sessionStore: first.sessionStore,
    targets: [{ tabId: 3, attached: true }],
  });

  test('worker recovery exposes finalized offscreen video for saving', async () => {
    const restarted = createBackgroundHarness({ offscreenPending: true });
    const status = await restarted.message({ action: 'getStatus' });

    assert.equal(status.videoRecording, true);
    assert.equal(status.videoPending, true);
  });

  test('saved-session listing returns metadata only and content is fetched on demand', async () => {
    const harness = createBackgroundHarness();
    await harness.message({
      action: 'saveScenario',
      name: 'full evidence',
      evidence: {
        screenshots: [{ name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' }],
        networkLogs: [{ url: 'https://example.test/?token=full-value', responseBody: 'full body' }],
        videoChunks: ['data:video/webm;base64,QUJD'],
      },
    });

    const list = await harness.message({ action: 'getScenarios' });
    assert.equal(list.scenarios.length, 1);
    assert.equal(list.scenarios[0].screenshotCount, 1);
    assert.equal(Object.hasOwn(list.scenarios[0], 'networkLogs'), false);

    const latest = await harness.message({ action: 'getLatestScenario' });
    const loaded = await harness.message({ action: 'getScenario', id: latest.scenario.id });
    assert.equal(loaded.scenario.networkLogs[0].url, 'https://example.test/?token=full-value');
    assert.equal(loaded.scenario.networkLogs[0].responseBody, 'full body');
  });
  const status = await restarted.message({ action: 'getStatus' });
  const evidence = await restarted.message({ action: 'getEvidenceReadonly' });

  assert.equal(status.networkCapturing, true);
  assert.equal(evidence.screenshots.length, 1);
  assert.equal(evidence.screenshots[0].name, first.draftRecords[0].value.name);
});
