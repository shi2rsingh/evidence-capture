/* ── Evidence Capture – Popup Script ── */

const $ = id => document.getElementById(id);
const status = msg => ($('status').textContent = msg);
const send = msg => chrome.runtime.sendMessage(msg);

let capturing = false;

const VIDEO_PREF_KEY = 'includeVideo';

/* ── Init: restore state ── */
(async () => {
  try {
    const pref = await chrome.storage.local.get(VIDEO_PREF_KEY);
    if (typeof pref[VIDEO_PREF_KEY] === 'boolean') {
      $('chkVideo').checked = pref[VIDEO_PREF_KEY];
    }

    const s = await send({ action: 'getStatus' });
    if (!s || s.error) throw new Error(s?.error || 'Could not read capture status.');
    $('ssCount').textContent = s.ssCount;
    $('netCount').textContent = s.netCount;
    if (s.sessionName) $('sessionName').value = s.sessionName;
    capturing = s.networkCapturing || s.videoRecording;
    if (capturing) setCaptureUI(true);
    $('vidStatus').textContent = s.videoPending ? 'READY' : s.videoRecording ? 'REC' : 'OFF';
    if (s.draftPersistenceError) status('❌ ' + s.draftPersistenceError);
    else if (s.captureLimitReached) status('⚠️ Session reached the capture size limit. Save retained evidence.');
  } catch (error) {
    status('❌ Could not restore capture status: ' + error.message);
  }
})();

$('chkVideo').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ [VIDEO_PREF_KEY]: !!e.target.checked });
});

let _sessionNameTimer = null;
function persistSessionNameInput() {
  const name = $('sessionName').value.trim();
  send({ action: 'setSessionName', name }).catch(() => {});
}

$('sessionName').addEventListener('input', () => {
  clearTimeout(_sessionNameTimer);
  _sessionNameTimer = setTimeout(persistSessionNameInput, 300);
});

$('sessionName').addEventListener('blur', () => {
  clearTimeout(_sessionNameTimer);
  persistSessionNameInput();
});

function setCaptureUI(active) {
  capturing = active;
  const btn = $('btnCapture');
  btn.textContent = active ? '⏹️' : '▶️';
  btn.title = active ? 'End Capture (Ctrl+Shift+E)' : 'Start Capture (Ctrl+Shift+E)';
  btn.classList.toggle('active', active);
  $('chkVideo').disabled = active;
}

function resetUI() {
  setCaptureUI(false);
  $('sessionName').disabled = false;
  $('ssCount').textContent = '0';
  $('netCount').textContent = '0';
  $('vidStatus').textContent = 'OFF';
}

/* ── End capture: stop everything → save scenario → reset ── */
let _saving = false;
async function endCaptureAndSave() {
  if (_saving) return false;
  _saving = true;

  try {
    const result = await send({ action: 'stopCapture' });
    if (!result || result.error || result.ok === false) {
      throw new Error(result?.error || 'Could not stop and save the capture.');
    }
    resetUI();
    $('vidStatus').textContent = 'OFF';
    if (result.captureLimitReached) status(`⚠️ Evidence saved up to the capture limit; ${result.droppedNetworkLogs || 0} network entries were omitted.`);
    else if (result.droppedNetworkLogs) status(`⚠️ Evidence saved; ${result.droppedNetworkLogs} network entries were omitted.`);
    return result;
  } catch (error) {
    status('❌ Capture save failed: ' + (error && error.message ? error.message : error));
    const current = await send({ action: 'getStatus' }).catch(() => null);
    if (current && !current.error) {
      setCaptureUI(current.networkCapturing || current.videoRecording);
      $('sessionName').disabled = current.networkCapturing || current.videoRecording;
      $('vidStatus').textContent = current.videoPending ? 'READY' : current.videoRecording ? 'REC' : 'OFF';
    }
    return false;
  } finally {
    _saving = false;
  }
}

/* ── Screenshot button ── */
$('btnScreenshot').addEventListener('click', async () => {
  status('📸 Capturing screenshot…');
  const res = await send({ action: 'captureScreenshot' });
  if (res && res.error) {
    status('❌ ' + res.error);
  } else {
    $('ssCount').textContent = res.count;
    status('📸 Screenshot captured! (#' + res.count + ')');
  }
});

/* ── Start / End Capture ── */
$('btnCapture').addEventListener('click', async () => {
  if (!capturing) {
    /* ── START ── */
    status('Starting capture…');

    try {
      const name = $('sessionName').value.trim();
      const nameRes = await send({ action: 'setSessionName', name });
      if (!nameRes || nameRes.error) throw new Error(nameRes?.error || 'Could not set the session name.');
      const result = await send({ action: 'startCapture', includeVideo: $('chkVideo').checked });
      if (!result || result.error || result.ok === false) {
        throw new Error(result?.error || 'Capture did not start.');
      }

      setCaptureUI(true);
      $('sessionName').disabled = true;
      $('vidStatus').textContent = result.videoRecording ? 'REC' : 'OFF';
      status('🟢 Capturing… use Ctrl+Shift+S for screenshots');
    } catch (error) {
      status('❌ Capture start failed: ' + (error && error.message ? error.message : error));
      resetUI();
    }
  } else {
    /* ── END ── */
    status('Stopping & saving…');
    const result = await endCaptureAndSave();
    if (result?.ok && !result.droppedNetworkLogs && !result.captureLimitReached) status('⏹️ Capture saved.');
  }
});

$('btnRecover').addEventListener('click', async () => {
  status('Stopping capture and saving retained evidence…');
  const result = await endCaptureAndSave();
  if (result?.ok && !result.droppedNetworkLogs && !result.captureLimitReached) status('✅ Capture stopped and evidence saved.');
});

/* ── Download: build ZIP from latest saved scenario ── */
$('btnDownload').addEventListener('click', async () => {
  status('Looking for evidence…');

  // Only stop and save if a capture is currently running; otherwise use the latest saved scenario.
  if (capturing) {
    const saveResult = await endCaptureAndSave();
    if (!saveResult?.ok) return;
  }

  const res = await send({ action: 'getLatestScenario' });
  if (!res || res.error) {
    status('❌ Could not load saved evidence: ' + (res?.error || 'unknown error'));
    return;
  }
  const latest = res.scenario;
  if (!latest) {
    status('ℹ️ No saved evidence to download.');
    return;
  }

  status('Creating ZIP…');
  const zip = new JSZip();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  if (latest.screenshots && latest.screenshots.length) {
    const folder = zip.folder('screenshots');
    latest.screenshots.forEach(s => {
      const base64 = s.dataUrl.split(',')[1];
      folder.file(s.name, base64, { base64: true });
    });
  }

  if (latest.networkLogs && latest.networkLogs.length) {
    zip.file('network_logs.json', JSON.stringify(latest.networkLogs, null, 2));
  }

  if (latest.videoChunks && latest.videoChunks.length) {
    const folder = zip.folder('videos');
    latest.videoChunks.forEach((chunk, i) => {
      const base64 = chunk.split(',')[1];
      folder.file(`recording_${i + 1}.webm`, base64, { base64: true });
    });
  }

  zip.file('metadata.json', JSON.stringify({
    name: latest.name,
    date: latest.date,
    screenshotCount: (latest.screenshots || []).length,
    networkLogCount: (latest.networkLogs || []).length,
    videoCount: (latest.videoChunks || []).length,
    exportedAt: new Date().toISOString(),
    version: '1.0.0',
  }, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = latest.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  a.download = `${safeName}_${ts}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('✅ Downloaded: ' + latest.name);
});

/* ── Listen for background notifications ── */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'screenshotTaken') {
    $('ssCount').textContent = msg.count;
    $('ssCount').style.color = '#a6e3a1';
    $('ssCount').style.transform = 'scale(1.3)';
    $('ssCount').style.transition = 'all .2s';
    setTimeout(() => { $('ssCount').style.color = ''; $('ssCount').style.transform = ''; }, 600);
    status('📸 Screenshot captured! (#' + msg.count + ')');
  } else if (msg.action === 'recordingToggled') {
    if (!msg.capturing) {
      resetUI();
      status('⏹️ Capture saved.');
    } else {
      setCaptureUI(true);
      $('sessionName').disabled = true;
      $('vidStatus').textContent = msg.videoRecording ? 'REC' : 'OFF';
      status('🟢 Recording started (Ctrl+Shift+E)');
    }
  } else if (msg.action === 'captureLimitReached') {
    status('⚠️ ' + msg.message);
  } else if (msg.action === 'draftPersistenceFailed') {
    status('❌ ' + msg.message);
  }
});

/* ── Open Viewer ── */
$('btnViewer').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

$('btnTimelineViewer').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('timeline-viewer.html') });
});
