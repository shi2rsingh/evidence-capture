const test = require('node:test');
const assert = require('node:assert/strict');
const safety = require('../zip-safety.js');

test('ZIP safety accepts archives within compressed and expanded bounds', () => {
  assert.doesNotThrow(() => safety.validateZipLimits(1024, [
    { dir: true },
    { dir: false, _data: { uncompressedSize: 2048 } },
  ]));
});

test('ZIP safety rejects oversized archives, decompression bombs, and excessive entries', () => {
  assert.throws(() => safety.validateZipLimits(121 * 1024 * 1024, []), /120 MiB/);
  assert.throws(() => safety.validateZipLimits(1024, [
    { dir: false, _data: { uncompressedSize: 151 * 1024 * 1024 } },
  ]), /150 MiB/);
  assert.throws(
    () => safety.validateZipLimits(1024, Array.from({ length: 10001 }, () => ({ dir: true }))),
    /10000 file limit/,
  );
});

test('ZIP safety skips entries whose uncompressed size cannot be verified', () => {
  // Entries with missing or invalid _data are skipped rather than rejecting the whole archive.
  assert.doesNotThrow(() => safety.validateZipLimits(1024, [{ dir: false, _data: {} }]));
  assert.doesNotThrow(() => safety.validateZipLimits(1024, [{ dir: false }]));
  // But a valid entry with known large size still triggers the expansion limit.
  assert.throws(() => safety.validateZipLimits(1024, [
    { dir: false, _data: {} },
    { dir: false, _data: { uncompressedSize: 151 * 1024 * 1024 } },
  ]), /150 MiB/);
});
