if (typeof importScripts === 'function') {
  importScripts('capture-logic.js');
}

const CaptureLogic = globalThis.CaptureLogic || {};
const send = (msg) => chrome.runtime.sendMessage(msg);

let mediaRecorder = null;
let mediaStream = null;
let recordedChunks = [];

const VIDEO_CHUNK_PART_SIZE = 700000;

async function sendVideoDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
    throw new Error('Invalid video data');
  }

  const splitIndex = dataUrl.indexOf(',');
  const prefix = dataUrl.slice(0, splitIndex + 1);
  const payload = dataUrl.slice(splitIndex + 1);

  if (payload.length <= VIDEO_CHUNK_PART_SIZE) {
    const res = await send({ action: 'saveVideoChunk', chunk: dataUrl });
    if (res?.error) throw new Error(res.error);
    return;
  }

  const transferId = `v_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const totalParts = Math.ceil(payload.length / VIDEO_CHUNK_PART_SIZE);

  for (let partIndex = 0; partIndex < totalParts; partIndex++) {
    const start = partIndex * VIDEO_CHUNK_PART_SIZE;
    const end = Math.min(start + VIDEO_CHUNK_PART_SIZE, payload.length);
    const part = payload.slice(start, end);

    const res = await send({
      action: 'saveVideoChunk',
      transferId,
      partIndex,
      totalParts,
      prefix,
      part,
      isLast: partIndex === totalParts - 1,
    });

    if (res?.error) {
      throw new Error(res.error);
    }
  }
}

function cleanupStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  mediaRecorder = null;
  recordedChunks = [];
}

async function startRecording(streamId) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    return { ok: true, recording: true };
  }

  const constraintsList = CaptureLogic.getMediaConstraints ? CaptureLogic.getMediaConstraints(streamId) : [{
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  }];

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

  recordedChunks = [];
  const options = MediaRecorder.isTypeSupported('video/webm; codecs=vp9')
    ? { mimeType: 'video/webm; codecs=vp9' }
    : undefined;
  mediaRecorder = options ? new MediaRecorder(mediaStream, options) : new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };
  mediaRecorder.start(1000);

  return { ok: true, recording: true };
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') {
    cleanupStream();
    return { ok: true, recording: false, hasVideo: false };
  }

  return new Promise((resolve) => {
    mediaRecorder.onstop = async () => {
      try {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const hasVideo = blob.size > 0;
        if (hasVideo) {
          const dataUrl = await new Promise((done, fail) => {
            const reader = new FileReader();
            reader.onloadend = () => done(reader.result);
            reader.onerror = () => fail(new Error('Failed reading video blob'));
            reader.readAsDataURL(blob);
          });
          await sendVideoDataUrl(dataUrl);
        }
        resolve({ ok: true, recording: false, hasVideo });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      } finally {
        cleanupStream();
      }
    };

    mediaRecorder.stop();
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
});
