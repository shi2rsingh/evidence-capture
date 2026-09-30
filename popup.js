/* ── Evidence Capture – Popup Script ── */

const $ = id => document.getElementById(id);
const status = msg => ($('status').textContent = msg);
const send = msg => chrome.runtime.sendMessage(msg);

let capturing = false;

const VIDEO_PREF_KEY = 'includeVideo';

/* ── Init: restore state ── */
(async () => {
  const pref = await chrome.storage.local.get(VIDEO_PREF_KEY);
  if (typeof pref[VIDEO_PREF_KEY] === 'boolean') {
    $('chkVideo').checked = pref[VIDEO_PREF_KEY];
  }

  const s = await send({ action: 'getStatus' });
  $('ssCount').textContent = s.ssCount;
  $('netCount').textContent = s.netCount;
  if (s.sessionName) {
    $('sessionName').value = s.sessionName;
  }
  capturing = s.networkCapturing;
  if (capturing) setCaptureUI(true);
  $('vidStatus').textContent = s.videoRecording ? 'REC' : 'OFF';
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
  if (_saving) return;
  _saving = true;

  try {
    const st = await send({ action: 'getStatus' }).catch(() => null);

    if (st && st.videoRecording) {
      try {
        const videoRes = await send({ action: 'toggleVideo' });
        if (videoRes && videoRes.error) {
          status('❌ Video stop failed: ' + videoRes.error);
        }
      } catch (error) {
        status('❌ Video stop failed: ' + (error && error.message ? error.message : error));
      }
    }
    $('vidStatus').textContent = 'OFF';

    if (capturing) {
      try {
        await send({ action: 'toggleNetwork' });
      } catch (error) {
        status('❌ Network stop failed: ' + (error && error.message ? error.message : error));
      }
    }

    const evidence = await send({ action: 'getEvidenceReadonly' });
    let saved = false;
    if (evidence && !evidence.error &&
        (evidence.screenshots.length || evidence.networkLogs.length || evidence.videoChunks.length)) {
      const userPrefix = $('sessionName').value.trim();
      const defaultName = `Session ${new Date().toLocaleString()}`;
      const name = userPrefix ? `${userPrefix} - ${defaultName}` : defaultName;
      const saveRes = await send({ action: 'saveScenario', name, evidence });
      if (saveRes && saveRes.error) {
        status('❌ Save failed: ' + saveRes.error);
      } else {
        saved = true;
      }
    }

    if (saved || (evidence && !evidence.error)) {
      await send({ action: 'resetEvidence' }).catch(() => {});
    }
    resetUI();
    chrome.runtime.sendMessage({ action: 'scenarioSaved' }).catch(() => {});
  } catch (error) {
    status('❌ Capture save failed: ' + (error && error.message ? error.message : error));
    resetUI();
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
      const netRes = await send({ action: 'toggleNetwork' });
      if (netRes && netRes.error) { status('❌ ' + netRes.error); return; }

      if ($('chkVideo').checked) {
        const videoRes = await send({ action: 'toggleVideo' });
        if (videoRes && videoRes.error) {
          await send({ action: 'toggleNetwork' }).catch(() => {});
          status('❌ Video: ' + videoRes.error);
          return;
        }
        $('vidStatus').textContent = 'REC';
      } else {
        $('vidStatus').textContent = 'OFF';
      }

      const name = $('sessionName').value.trim();
      await send({ action: 'setSessionName', name });

      setCaptureUI(true);
      $('sessionName').disabled = true;
      status('🟢 Capturing… use Ctrl+Shift+S for screenshots');
    } catch (error) {
      status('❌ Capture start failed: ' + (error && error.message ? error.message : error));
      try {
        await send({ action: 'toggleNetwork' }).catch(() => {});
      } catch (_) {}
      resetUI();
    }
  } else {
    /* ── END ── */
    status('Stopping & saving…');
    await endCaptureAndSave();
    status('⏹️ Capture saved.');
  }
});

/* ── Download: build ZIP from latest saved scenario ── */
$('btnDownload').addEventListener('click', async () => {
  status('Looking for evidence…');

  // If still capturing, end + save first
  if (capturing) {
    await endCaptureAndSave();
  } else {
    // Even if not recording, there may be unsaved screenshots in memory — save them now
    const evidence = await send({ action: 'getEvidenceReadonly' });
    if (evidence && !evidence.error &&
        (evidence.screenshots.length || evidence.networkLogs.length || evidence.videoChunks.length)) {
      const userPrefix = $('sessionName').value.trim();
      const defaultName = `Session ${new Date().toLocaleString()}`;
      const name = userPrefix ? `${userPrefix} - ${defaultName}` : defaultName;
      await send({ action: 'saveScenario', name, evidence });
      await send({ action: 'resetEvidence' });
      $('ssCount').textContent = '0';
      $('netCount').textContent = '0';
      chrome.runtime.sendMessage({ action: 'scenarioSaved' }).catch(() => {});
    }
  }

  const res = await send({ action: 'getScenarios' });
  const scenarios = (res && res.scenarios) || [];
  if (!scenarios.length) {
    status('ℹ️ No saved evidence to download.');
    return;
  }

  const latest = scenarios[0]; // newest first

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
  URL.revokeObjectURL(url);
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
  }
});

/* ── Open Viewer ── */
$('btnViewer').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});
