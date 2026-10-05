if (typeof importScripts === 'function') {
  importScripts('capture-logic.js');
}

const CaptureLogic = globalThis.CaptureLogic || {};
const send = (msg) => chrome.runtime.sendMessage(msg);

let mediaRecorder = null;
let mediaStream = null;
let recordedChunks = [];
let recordedByteLength = 0;
let recordingLimitReached = false;

const VIDEO_CHUNK_PART_SIZE = 700000;
const MAX_RECORDING_BYTES = 50 * 1024 * 1024;

async function sendVideoPart(message) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let timeoutId;
    try {
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Video transfer timed out.')), 15000);
      });
      const response = await Promise.race([send(message), timeout]);
      if (!response || response.error || response.ok === false) {
        const error = new Error(response?.error || 'Video transfer was not accepted.');
        error.permanent = !!response;
        throw error;
      }
      return response;
    } catch (error) {
      if (error.permanent) throw error;
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError || new Error('Video transfer failed.');
}

async function sendVideoDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
    throw new Error('Invalid video data');
  }

  const splitIndex = dataUrl.indexOf(',');
  const prefix = dataUrl.slice(0, splitIndex + 1);
  const payload = dataUrl.slice(splitIndex + 1);

  const transferId = `v_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const totalParts = Math.ceil(payload.length / VIDEO_CHUNK_PART_SIZE);

  for (let partIndex = 0; partIndex < totalParts; partIndex++) {
    const start = partIndex * VIDEO_CHUNK_PART_SIZE;
    const end = Math.min(start + VIDEO_CHUNK_PART_SIZE, payload.length);
    const part = payload.slice(start, end);

    await sendVideoPart({
      action: 'saveVideoChunk',
      transferId,
      partIndex,
      totalParts,
      prefix,
      part,
      isLast: partIndex === totalParts - 1,
    });
  }
}

function cleanupStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  mediaRecorder = null;
  recordedChunks = [];
  recordedByteLength = 0;
  recordingLimitReached = false;
}

async function saveRecordedChunks() {
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  const hasVideo = blob.size > 0;
  if (hasVideo) {
    const dataUrl = await new Promise((done, fail) => {
      const reader = new FileReader();
      reader.onload = () => done(reader.result);
      reader.onerror = () => fail(new Error('Failed reading video blob'));
      reader.readAsDataURL(blob);
    });
    await sendVideoDataUrl(dataUrl);
  }
  return { ok: true, recording: false, hasVideo, limitReached: recordingLimitReached };
}

async function startRecording(streamId) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    return { ok: true, recording: true };
  }

  if (!CaptureLogic.validateStreamId) throw new Error('Tab capture validation is unavailable.');
  const constraintsList = CaptureLogic.getMediaConstraints(streamId);
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('This Chrome context does not support tab video recording.');
  }

  let lastError = null;
  for (const constraints of constraintsList) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (error) {
      lastError = error;
      mediaStream = null;
    }
  }

  if (!mediaStream) {
    throw lastError || new Error('Unable to access tab video stream.');
  }

  try {
    recordedChunks = [];
    const options = MediaRecorder.isTypeSupported?.('video/webm; codecs=vp9')
      ? { mimeType: 'video/webm; codecs=vp9' }
      : undefined;
    mediaRecorder = options ? new MediaRecorder(mediaStream, options) : new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size <= 0) return;
      if (recordedByteLength + event.data.size > MAX_RECORDING_BYTES) {
        recordingLimitReached = true;
        chrome.runtime.sendMessage({
          action: 'videoCaptureLimitReached',
          message: 'Video reached the 50 MiB limit. Stop and save to finalize the captured portion.',
        }).catch(() => {});
        if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
        return;
      }
      recordedChunks.push(event.data);
      recordedByteLength += event.data.size;
    };
    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder failed:', event.error || event);
      chrome.runtime.sendMessage({
        action: 'videoRecorderFailed',
        message: event.error?.message || 'The browser video recorder encountered an error.',
      }).catch(() => {});
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    };
    mediaRecorder.start(1000);
  } catch (error) {
    cleanupStream();
    throw new Error(`Could not start tab video recording: ${error.message}`);
  }

  return { ok: true, recording: true };
}

async function stopRecording() {
  if (!mediaRecorder) {
    cleanupStream();
    return { ok: true, recording: false, hasVideo: false };
  }

  if (mediaRecorder.state !== 'recording') {
    try {
      return await saveRecordedChunks();
    } finally {
      cleanupStream();
    }
  }

  return new Promise((resolve) => {
    const recorder = mediaRecorder;
    recorder.onstop = async () => {
      try {
        resolve(await saveRecordedChunks());
      } catch (error) {
        resolve({ ok: false, error: error.message });
      } finally {
        cleanupStream();
      }
    };

    try {
      recorder.stop();
    } catch (error) {
      cleanupStream();
      resolve({ ok: false, error: `Could not stop tab video recording: ${error.message}` });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.action !== 'string') return false;
  if (msg.action === 'offscreenGetStatus') {
    const recording = mediaRecorder?.state === 'recording';
    sendResponse({
      recording,
      pending: !recording && recordedChunks.length > 0,
    });
    return; // synchronous — channel can close immediately
  }

  if (msg.action === 'offscreenStartVideo') {
    startRecording(msg.streamId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (msg.action === 'offscreenStopVideo') {
    stopRecording()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // Unknown action — no response will be sent.
  return false;
});
