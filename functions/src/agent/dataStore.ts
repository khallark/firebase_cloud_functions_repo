// functions/src/agent/dataStore.ts
//
// Per-invocation in-memory store for query results.
// Instantiated fresh inside each onAgentMessageCreated execution — never at module level.
// Handles are UUIDs; data is never sent to Gemini, only the handle + schema.

import { randomUUID } from 'crypto';

export type HandleType = 'docs' | 'groups';

interface StoreEntry {
  type: HandleType;
  data: any[];
}

export class DataStore {
  private store = new Map<string, StoreEntry>();

  /** Store data and return a new handle. */
  put(data: any[], type: HandleType): string {
    const handle = randomUUID();
    this.store.set(handle, { type, data });
    return handle;
  }

  /** Get raw entry (type + data). */
  get(handle: string): StoreEntry | undefined {
    return this.store.get(handle);
  }

  /** Get docs array. Throws if handle missing or wrong type. */
  getDocs(handle: string): any[] {
    const entry = this.store.get(handle);
    if (!entry) throw new Error(`Handle not found: "${handle}". Valid handles: [${[...this.store.keys()].join(', ')}]`);
    if (entry.type !== 'docs') throw new Error(`Handle "${handle}" is type "${entry.type}", expected "docs".`);
    return entry.data;
  }

  /** Get groups array. Throws if handle missing or wrong type. */
  getGroups(handle: string): any[] {
    const entry = this.store.get(handle);
    if (!entry) throw new Error(`Handle not found: "${handle}". Valid handles: [${[...this.store.keys()].join(', ')}]`);
    if (entry.type !== 'groups') throw new Error(`Handle "${handle}" is type "${entry.type}", expected "groups".`);
    return entry.data;
  }

  has(handle: string): boolean {
    return this.store.has(handle);
  }

  /** How many handles are stored (for debugging). */
  size(): number {
    return this.store.size;
  }
}