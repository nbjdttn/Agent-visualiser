/**
 * The phone app's on-device database: chat imports in `imports`, automatic
 * updates (the device key and what has been received) in `sync`.
 */

const DB_NAME = 'agent-visualiser';
const VERSION = 2;

export type StoreName = 'imports' | 'sync';

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('imports')) db.createObjectStore('imports', { keyPath: 'info.id' });
      if (!db.objectStoreNames.contains('sync')) db.createObjectStore('sync', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open on-device storage'));
    req.onblocked = () => reject(new Error('Close the app in other tabs and try again'));
  });
}

export async function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = run(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error ?? new Error('Storage error'));
      t.onabort = () => reject(t.error ?? new Error('Storage was full or unavailable'));
    });
  } finally {
    db.close();
  }
}

/** Ask the browser not to clear this data under storage pressure. */
export function persistStorage() {
  void navigator.storage?.persist?.().catch(() => false);
}
