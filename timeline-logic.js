(function (global) {
  function parseTime(value) {
    if (value == null || value === '') return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function getTimelineWindow(data) {
    let start = Infinity;
    let end = -Infinity;
    const collections = [
      Array.isArray(data?.screenshots) ? data.screenshots : [],
      Array.isArray(data?.networkLogs) ? data.networkLogs : [],
    ];
    for (const collection of collections) {
      for (const item of collection) {
        const timestamp = parseTime(item?.timestamp);
        if (timestamp == null) continue;
        start = Math.min(start, timestamp);
        end = Math.max(end, timestamp);
      }
    }
    return start === Infinity ? { start: 0, end: 0 } : { start, end };
  }

  function getVisibleNetworkEntries(data, currentTimeMs, filters = {}) {
    const logs = Array.isArray(data?.networkLogs) ? data.networkLogs : [];
    const timelineEnd = getTimelineWindow(data).end;
    const urlFilter = String(filters.url || '').toLowerCase();
    const methodFilter = String(filters.method || '').toUpperCase();
    const statusFilter = String(filters.status || '');
    const mimeFilter = String(filters.mime || '').toLowerCase();
    let urlRegex = null;
    let mimeRegex = null;
    if (filters.useRegex?.url && filters.url) {
      try { urlRegex = new RegExp(filters.url, 'i'); } catch (_) { /* Invalid regex leaves this filter inactive. */ }
    }
    if (filters.useRegex?.mime && filters.mime) {
      try { mimeRegex = new RegExp(filters.mime, 'i'); } catch (_) { /* Invalid regex leaves this filter inactive. */ }
    }

    return logs
      .map((log, index) => ({ log, index, rowKey: `row-${index}` }))
      .filter(({ log }) => log && typeof log === 'object')
      .filter(({ log }) => {
        const timestamp = parseTime(log.timestamp);
        if (timestamp == null && currentTimeMs < timelineEnd) return false;
        if (timestamp != null && timestamp > currentTimeMs) return false;

        if (urlFilter && filters.useRegex?.url) {
          if (urlRegex && !urlRegex.test(String(log.url || ''))) return false;
        } else if (urlFilter && !String(log.url || '').toLowerCase().includes(urlFilter)) return false;
        if (methodFilter && String(log.method || '').toUpperCase() !== methodFilter) return false;
        if (mimeFilter && filters.useRegex?.mime) {
          if (mimeRegex && !mimeRegex.test(String(log.mimeType || ''))) return false;
        } else if (mimeFilter && !String(log.mimeType || '').toLowerCase().includes(mimeFilter)) return false;

        if (statusFilter) {
          const status = Number(log.status || 0);
          if (statusFilter === '2xx' && !(status >= 200 && status < 300)) return false;
          if (statusFilter === '3xx' && !(status >= 300 && status < 400)) return false;
          if (statusFilter === '4xx' && !(status >= 400 && status < 500)) return false;
          if (statusFilter === '5xx' && !(status >= 500 && status < 600)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aTime = parseTime(a.log.timestamp);
        const bTime = parseTime(b.log.timestamp);
        if (aTime == null) return bTime == null ? a.index - b.index : 1;
        if (bTime == null) return -1;
        return aTime - bTime || a.index - b.index;
      });
  }

  function getVisibleScreenshot(data, currentTimeMs) {
    const shots = Array.isArray(data?.screenshots) ? data.screenshots : [];
    let latest = null;
    let latestTime = -Infinity;
    for (const shot of shots) {
      const timestamp = parseTime(shot?.timestamp);
      // Use <= so first-in-array wins when timestamps are equal (deterministic).
      if (timestamp == null || timestamp > currentTimeMs || timestamp <= latestTime) continue;
      latest = shot;
      latestTime = timestamp;
    }
    return latest;
  }

  function getSeekRatio(currentTimeMs, timelineWindow) {
    const range = timelineWindow.end - timelineWindow.start;
    if (!(range > 0)) return 0;
    return Math.min(Math.max((currentTimeMs - timelineWindow.start) / range, 0), 1);
  }

  function getTimeAtSeekRatio(ratio, timelineWindow) {
    const safeRatio = Math.min(Math.max(Number(ratio) || 0, 0), 1);
    return timelineWindow.start + safeRatio * (timelineWindow.end - timelineWindow.start);
  }

  const api = {
    parseTime,
    getTimelineWindow,
    getVisibleNetworkEntries,
    getVisibleScreenshot,
    getSeekRatio,
    getTimeAtSeekRatio,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TimelineLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
