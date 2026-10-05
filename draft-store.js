(function (global) {
  const DATABASE_NAME = 'evidence-capture-draft';
  const DATABASE_VERSION = 1;
  const STORE_NAME = 'records';
  let databasePromise;

  function openDatabase() {
    if (!global.indexedDB) return Promise.reject(new Error('IndexedDB is not available for draft recovery.'));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = global.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open the evidence draft database.'));
        request.onblocked = () => reject(new Error('Evidence draft database upgrade is blocked by another extension page.'));
      }).catch((error) => {
        databasePromise = null;
        throw error;
      });
    }
    return databasePromise;
  }

  async function withStore(mode, callback) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = callback(transaction.objectStore(STORE_NAME));
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error('Evidence draft database operation failed.'));
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error('Evidence draft transaction was aborted.'));
      transaction.onerror = () => reject(transaction.error || new Error('Evidence draft transaction failed.'));
    });
  }

  const api = {
    load: () => withStore('readonly', (store) => store.getAll()),
    put: (record) => withStore('readwrite', (store) => store.put(record)),
    clear: () => withStore('readwrite', (store) => store.clear()),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DraftStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
