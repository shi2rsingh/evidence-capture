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
    } catch (error) {
      throw new Error(`Evidence cannot be copied safely: ${error.message}`);
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
    ];
  }

  function cleanupRequestMap(requestMap, requestId) {
    if (!requestMap || requestId == null) return;
    delete requestMap[requestId];
  }

  function estimateEvidenceSize(evidence) {
    const snapshot = evidence && typeof evidence === 'object' ? evidence : {};
    let size = 0;
    for (const value of [
      ...(Array.isArray(snapshot.screenshots) ? snapshot.screenshots : []),
      ...(Array.isArray(snapshot.networkLogs) ? snapshot.networkLogs : []),
      ...(Array.isArray(snapshot.videoChunks) ? snapshot.videoChunks : []),
    ]) {
      try {
        size += typeof value === 'string' ? value.length * 2 : JSON.stringify(value).length * 2;
      } catch (_) {
        throw new Error('Evidence contains data that cannot be serialized.');
      }
    }
    return size;
  }

  function mergeVideoTransfer(transfer, update) {
    const next = transfer || { prefix: 'data:video/webm;base64,', totalParts: 0, parts: [] };
    const totalParts = update.totalParts ?? next.totalParts;
    if (!Number.isInteger(totalParts) || totalParts < 1 || totalParts > 128
      || !Number.isInteger(update.partIndex) || update.partIndex < 0 || update.partIndex >= totalParts
      || typeof update.part !== 'string' || update.part.length > 700000) {
      return { ok: false, error: 'Invalid video transfer part', transfer: next };
    }
    if (next.totalParts > 0 && next.totalParts !== totalParts) {
      return { ok: false, error: 'Video transfer size changed during transfer', transfer: next };
    }
    const existingSize = next.parts.reduce((total, part) => total + (typeof part === 'string' ? part.length : 0), 0);
    if (existingSize + update.part.length > 128 * 700000) {
      return { ok: false, error: 'Video transfer exceeds the supported size limit', transfer: next };
    }
    if (typeof update.prefix === 'string') {
      if (update.prefix !== 'data:video/webm;base64,') {
        return { ok: false, error: 'Unsupported video format', transfer: next };
      }
      next.prefix = update.prefix;
    }
    next.totalParts = totalParts;
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
    estimateEvidenceSize,
    mergeVideoTransfer,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.CaptureLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
