// The saved analysis: IndexedDB database `jester`, object store `prepared`, keyed by fingerprint.
// Saving is a convenience, so a browser without IndexedDB (or a full disk) just analyses again.

import type { Prepared } from "./analyze.ts";

const DB_NAME = "jester";
const STORE = "prepared";
// 4: thing tracks are rejoined and barely-seen things dropped, so older saved analyses list split things.
const SCHEMA = "prepared/4";

interface PreparedRecord { schema: typeof SCHEMA; fingerprint: string; savedAt: number; prepared: Prepared }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "fingerprint" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** The saved analysis for this fingerprint, or null when there is none (or it was saved by an older schema). */
export async function loadPrepared(fingerprint: string): Promise<Prepared | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(fingerprint);
    await finished(tx);
    db.close();
    const record = request.result as PreparedRecord | undefined;
    if (!record || record.schema !== SCHEMA) return null;
    return { ...record.prepared, fromSaved: true };
  } catch {
    return null;
  }
}

export async function savePrepared(prepared: Prepared): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const record: PreparedRecord = { schema: SCHEMA, fingerprint: prepared.fingerprint, savedAt: Date.now(), prepared: { ...prepared, fromSaved: false } };
    tx.objectStore(STORE).put(record);
    await finished(tx);
    db.close();
  } catch {
    // Not saved; the next open of this clip analyses it again.
  }
}
