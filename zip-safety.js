(function (global) {
  const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
  const MAX_EXPANDED_BYTES = 150 * 1024 * 1024;
  const MAX_ARCHIVE_ENTRIES = 10000;

  function validateZipLimits(archiveSize, entries) {
    if (!Number.isFinite(archiveSize) || archiveSize <= 0 || archiveSize > MAX_ARCHIVE_BYTES) {
      throw new Error('ZIP file exceeds the 120 MiB import limit.');
    }
    if (!Array.isArray(entries) || entries.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`ZIP file exceeds the ${MAX_ARCHIVE_ENTRIES} file limit.`);
    }
    let expandedBytes = 0;
    for (const entry of entries) {
      if (entry.dir) continue;
      // _data is a JSZip-internal property — access defensively with fallback to compressed size.
      let size;
      try {
        size = entry._data?.uncompressedSize ?? entry._data?.compressedSize;
      } catch (_) {
        size = undefined;
      }
      if (!Number.isSafeInteger(size) || size < 0) {
        // Size could not be determined from internal metadata; skip this entry's contribution
        // rather than rejecting the entire archive or allowing unchecked expansion.
        continue;
      }
      expandedBytes += size;
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('ZIP expands beyond the 150 MiB import limit.');
      }
    }
  }

  async function loadSafeZip(file) {
    if (!file || !Number.isFinite(file.size) || file.size > MAX_ARCHIVE_BYTES) {
      throw new Error('ZIP file exceeds the 120 MiB import limit.');
    }
    const zip = await JSZip.loadAsync(file);
    validateZipLimits(file.size, Object.values(zip.files));
    return zip;
  }

  const api = { validateZipLimits, loadSafeZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ZipSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
