const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../capture-logic.js');

test('cloneEvidenceSnapshot creates independent arrays', () => {
  const evidence = {
    screenshots: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAA' }],
    networkLogs: [{ url: 'https://example.com', status: 200 }],
    videoChunks: ['data:video/webm;base64,first'],
  };

  const snapshot = logic.cloneEvidenceSnapshot(evidence);
  snapshot.screenshots[0].name = 'changed.png';
  snapshot.networkLogs[0].status = 500;
  snapshot.videoChunks[0] = 'data:video/webm;base64,second';

  assert.equal(evidence.screenshots[0].name, 'a.png');
  assert.equal(evidence.networkLogs[0].status, 200);
  assert.equal(evidence.videoChunks[0], 'data:video/webm;base64,first');
});

test('estimateEvidenceSize rejects values that cannot be serialized for storage', () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => logic.estimateEvidenceSize({ networkLogs: [circular] }), /cannot be serialized/);
});

test('validateTabId rejects invalid active tab', () => {
  assert.throws(() => logic.validateTabId(null), /No active tab available/);
  assert.throws(() => logic.validateTabId({}), /No active tab available/);
  assert.equal(logic.validateTabId({ id: 42 }), 42);
});

test('validateStreamId rejects empty or invalid values', () => {
  assert.throws(() => logic.validateStreamId(''), /Invalid tab capture stream ID/);
  assert.throws(() => logic.validateStreamId(null), /Invalid tab capture stream ID/);
  assert.equal(logic.validateStreamId(' stream-123 '), 'stream-123');
});

test('cleanupRequestMap removes tracked request IDs', () => {
  const map = { req1: 0, req2: 1, req3: 2 };
  logic.cleanupRequestMap(map, 'req2');
  assert.deepEqual(map, { req1: 0, req3: 2 });
});

test('mergeVideoTransfer completes when all chunks arrive', () => {
  const transfer = { prefix: 'data:video/webm;base64,', totalParts: 3, parts: ['a', 'b', ''] };
  const result = logic.mergeVideoTransfer(transfer, {
    partIndex: 2,
    part: 'c',
    isLast: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.completed, true);
  assert.equal(result.data, 'data:video/webm;base64,abc');
});

test('mergeVideoTransfer rejects incomplete final chunk payload', () => {
  const transfer = { prefix: 'data:video/webm;base64,', totalParts: 3, parts: ['a', undefined, undefined] };
  const result = logic.mergeVideoTransfer(transfer, {
    partIndex: 1,
    part: 'b',
    isLast: true,
  });

  test('mergeVideoTransfer rejects inconsistent metadata and oversized transfers', () => {
    const initial = logic.mergeVideoTransfer(null, {
      totalParts: 2,
      partIndex: 0,
      part: 'first',
    });
    assert.equal(initial.ok, true);
    const mismatch = logic.mergeVideoTransfer(initial.transfer, {
      totalParts: 3,
      partIndex: 1,
      part: 'second',
    });
    assert.equal(mismatch.ok, false);

    const tooManyParts = logic.mergeVideoTransfer(null, {
      totalParts: 129,
      partIndex: 0,
      part: 'x',
    });
    assert.equal(tooManyParts.ok, false);
  });

  test('estimateEvidenceSize counts complete URLs, bodies, headers, and media payloads', () => {
    const evidence = {
      screenshots: [],
      networkLogs: [{
        url: 'https://example.test/?token=full-value',
        requestHeaders: { authorization: 'Bearer full-value' },
        requestBody: '{"password":"full-value"}',
        responseBody: 'complete response',
      }],
      videoChunks: ['data:video/webm;base64,QUJD'],
    };

    assert.ok(logic.estimateEvidenceSize(evidence) >= JSON.stringify(evidence.networkLogs[0]).length * 2);
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Incomplete video transfer');
});

test('stress: cloneEvidenceSnapshot handles large payloads repeatedly', () => {
  for (let round = 0; round < 200; round += 1) {
    const evidence = {
      screenshots: Array.from({ length: 80 }, (_, index) => ({
        name: `shot-${round}-${index}.png`,
        dataUrl: `data:image/png;base64,${'A'.repeat(200)}`,
      })),
      networkLogs: Array.from({ length: 100 }, (_, index) => ({
        url: `https://example.com/${round}/${index}`,
        status: (index % 10) + 200,
      })),
      videoChunks: Array.from({ length: 20 }, (_, index) => `data:video/webm;base64,${'B'.repeat(1000)}-${round}-${index}`),
    };

    const snapshot = logic.cloneEvidenceSnapshot(evidence);
    assert.equal(snapshot.screenshots.length, 80);
    assert.equal(snapshot.networkLogs.length, 100);
    assert.equal(snapshot.videoChunks.length, 20);
    assert.notEqual(snapshot.screenshots[0], evidence.screenshots[0]);
  }
});
