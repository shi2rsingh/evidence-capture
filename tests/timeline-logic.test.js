const test = require('node:test');
const assert = require('node:assert/strict');
const timeline = require('../timeline-logic.js');

const baseTime = Date.parse('2026-10-01T00:00:00.000Z');
const at = (offsetMs) => new Date(baseTime + offsetMs).toISOString();

test('network visibility follows the playback cursor and reveals unknown-time rows at the end', () => {
  const data = {
    networkLogs: [
      { requestId: 'first', timestamp: at(0), url: '/zero' },
      { requestId: 'future', timestamp: at(1), url: '/future' },
      { requestId: 'unknown', timestamp: 'not a timestamp', url: '/unknown-time' },
    ],
  };

  const visible = timeline.getVisibleNetworkEntries(data, baseTime);

  assert.deepEqual(visible.map(({ log }) => log.url), ['/zero']);
  assert.deepEqual(
    timeline.getVisibleNetworkEntries(data, baseTime + 0.5).map(({ log }) => log.url),
    ['/zero'],
  );
  assert.deepEqual(
    timeline.getVisibleNetworkEntries(data, baseTime + 1).map(({ log }) => log.url),
    ['/zero', '/future', '/unknown-time'],
  );
});

test('network logs without usable timestamps remain visible for timestamp-free captures', () => {
  const data = {
    networkLogs: [
      { url: '/missing-time' },
      { timestamp: 'not a timestamp', url: '/invalid-time' },
    ],
  };

  assert.deepEqual(
    timeline.getVisibleNetworkEntries(data, 0).map(({ log }) => log.url),
    ['/missing-time', '/invalid-time'],
  );
});

test('duplicate request IDs and sorted/filter results retain original-row keys', () => {
  const data = {
    networkLogs: [
      { requestId: 'same-id', timestamp: at(200), url: '/later', method: 'GET' },
      { requestId: 'same-id', timestamp: at(100), url: '/earlier', method: 'POST' },
      { requestId: 'other', timestamp: at(150), url: '/middle', method: 'GET' },
    ],
  };

  const visible = timeline.getVisibleNetworkEntries(data, baseTime + 200, { method: 'GET' });

  assert.deepEqual(visible.map(({ rowKey, log }) => [rowKey, log.url]), [
    ['row-2', '/middle'],
    ['row-0', '/later'],
  ]);
  assert.equal(data.networkLogs[Number(visible[1].rowKey.slice(4))].url, '/later');
});

test('network filters combine case-insensitively and status buckets respect boundaries', () => {
  const data = {
    networkLogs: [
      { timestamp: at(0), url: 'https://EXAMPLE.test/api/items', method: 'GET', status: 200, mimeType: 'application/json' },
      { timestamp: at(1), url: 'https://example.test/api/items', method: 'GET', status: 299, mimeType: 'application/json' },
      { timestamp: at(2), url: 'https://example.test/api/items', method: 'GET', status: 300, mimeType: 'application/json' },
      { timestamp: at(3), url: 'https://example.test/api/items', method: 'POST', status: 500, mimeType: 'text/plain' },
    ],
  };

  const success = timeline.getVisibleNetworkEntries(data, baseTime + 3, {
    url: '/API/',
    method: 'get',
    status: '2xx',
    mime: 'APPLICATION/JSON',
  });
  const redirects = timeline.getVisibleNetworkEntries(data, baseTime + 3, { status: '3xx' });
  const serverErrors = timeline.getVisibleNetworkEntries(data, baseTime + 3, { status: '5xx' });

  assert.deepEqual(success.map(({ log }) => log.status), [200, 299]);
  assert.deepEqual(redirects.map(({ log }) => log.status), [300]);
  assert.deepEqual(serverErrors.map(({ log }) => log.status), [500]);
});

test('URL and MIME regex filters work while invalid expressions remain non-destructive', () => {
  const data = {
    networkLogs: [
      { timestamp: at(0), url: 'https://example.test/api/users/42', mimeType: 'application/json' },
      { timestamp: at(1), url: 'https://example.test/assets/main.js', mimeType: 'application/javascript' },
    ],
  };

  const regexMatches = timeline.getVisibleNetworkEntries(data, baseTime + 1, {
    url: '^https://example\\.test/api/users/\\d+$',
    mime: 'application/(json|javascript)',
    useRegex: { url: true, mime: true },
  });
  const invalidRegexMatches = timeline.getVisibleNetworkEntries(data, baseTime + 1, {
    url: '[',
    useRegex: { url: true, mime: false },
  });

  assert.deepEqual(regexMatches.map(({ log }) => log.url), ['https://example.test/api/users/42']);
  assert.equal(invalidRegexMatches.length, 2);
});

test('latest screenshot is selected by timestamp rather than storage order', () => {
  const data = {
    screenshots: [
      { name: 'latest', timestamp: at(20) },
      { name: 'earliest', timestamp: at(0) },
      { name: 'middle', timestamp: at(10) },
      { name: 'invalid', timestamp: 'invalid' },
    ],
  };

  assert.equal(timeline.getVisibleScreenshot(data, baseTime + 15).name, 'middle');
  assert.equal(timeline.getVisibleScreenshot(data, baseTime - 1), null);
  assert.equal(timeline.getVisibleScreenshot(data, baseTime + 20).name, 'latest');
});

test('timeline windows and seek calculations handle empty, zero-length, and clamped positions', () => {
  assert.deepEqual(timeline.getTimelineWindow({ screenshots: [], networkLogs: [] }), { start: 0, end: 0 });
  const window = timeline.getTimelineWindow({
    screenshots: [{ timestamp: at(100) }],
    networkLogs: [{ timestamp: at(0) }, { timestamp: 'invalid' }],
  });

  assert.deepEqual(window, { start: baseTime, end: baseTime + 100 });
  assert.equal(timeline.getSeekRatio(baseTime + 25, window), 0.25);
  assert.equal(timeline.getSeekRatio(baseTime - 25, window), 0);
  assert.equal(timeline.getSeekRatio(baseTime + 125, window), 1);
  assert.equal(timeline.getTimeAtSeekRatio(-2, window), baseTime);
  assert.equal(timeline.getTimeAtSeekRatio(2, window), baseTime + 100);
  assert.equal(timeline.getSeekRatio(baseTime, { start: baseTime, end: baseTime }), 0);
});

test('stress: filters and sorts a large request log without mutating source data', () => {
  const networkLogs = Array.from({ length: 20000 }, (_, index) => ({
    requestId: `request-${index % 5}`,
    timestamp: at(index),
    url: `https://example.test/api/${index}`,
    method: index % 2 ? 'GET' : 'POST',
    status: index % 3 ? 200 : 500,
    mimeType: 'application/json',
  }));
  const originalFirst = networkLogs[0];
  const visible = timeline.getVisibleNetworkEntries(
    { networkLogs },
    baseTime + 15000,
    { method: 'GET', status: '2xx', mime: 'json' },
  );

  assert.equal(visible.length, 5000);
  assert.equal(visible[0].index, 1);
  assert.equal(visible.at(-1).index, 14999);
  assert.strictEqual(networkLogs[0], originalFirst);
  assert.equal(networkLogs[0].url, 'https://example.test/api/0');
});
