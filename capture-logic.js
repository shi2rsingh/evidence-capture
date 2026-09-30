(function (global) {
  function deepClone(value) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch (_) {
        // Fall through to JSON clone for older / restricted environments.
      }
    }

    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function cloneEvidenceSnapshot(evidence) {
    const source = evidence && typeof evidence === 'object' ? evidence : {};
    return {
      screenshots: Array.isArray(source.screenshots) ? deepClone(source.screenshots) : [],
      networkLogs: Array.isArray(source.networkLogs) ? deepClone(source.networkLogs) : [],
      videoChunks: Array.isArray(source.videoChunks) ? deepClone(source.videoChunks) : [],
    };
  }

  function validateTabId(tab) {
    if (!tab || typeof tab !== 'object' || !Number.isInteger(tab.id)) {
      throw new Error('No active tab available for this operation.');
    }
    return tab.id;
  }

  function validateStreamId(streamId) {
    if (typeof streamId !== 'string' || !streamId.trim()) {
      throw new Error('Invalid tab capture stream ID.');
    }
    return streamId.trim();
  }

  function getMediaConstraints(streamId) {
    const normalized = validateStreamId(streamId);
    return [
      {
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: normalized } },
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: normalized } },
      },
      {
        audio: { chromeMediaSource: 'tab', chromeMediaSourceId: normalized },
        video: { chromeMediaSource: 'tab', chromeMediaSourceId: normalized },
      },
    ];
  }

  function cleanupRequestMap(requestMap, requestId) {
    if (!requestMap || requestId == null) return;
    delete requestMap[requestId];
  }

  function mergeVideoTransfer(transfer, update) {
    const next = transfer || { prefix: 'data:video/webm;base64,', totalParts: 0, parts: [] };
    if (typeof update.prefix === 'string') {
      next.prefix = update.prefix;
    }
    if (Number.isInteger(update.totalParts) && update.totalParts > 0) {
      next.totalParts = update.totalParts;
    }
    if (typeof update.partIndex === 'number' && update.part !== undefined) {
      next.parts[update.partIndex] = update.part;
    }

    if (update.isLast === true) {
      const hasAllParts = next.totalParts > 0
        && next.parts.length === next.totalParts
        && next.parts.every((part) => typeof part === 'string');
      if (!hasAllParts) {
        return { ok: false, error: 'Incomplete video transfer', transfer: next };
      }
      return { ok: true, completed: true, data: next.prefix + next.parts.join('') };
    }

    return { ok: true, completed: false, transfer: next };
  }

  const api = {
    cloneEvidenceSnapshot,
    validateTabId,
    validateStreamId,
    getMediaConstraints,
    cleanupRequestMap,
    mergeVideoTransfer,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.CaptureLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
