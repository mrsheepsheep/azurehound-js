export function createCache(ctx: any) {
  const { state, config, graphOptions, armOptions, recordKindsFor, jsonLimit, boundedEntries, categoryEntries,
    nonnegative, chosen, cachedKinds, add, logCategory } = ctx;
  const cacheKey = (tenantId, category) => `v1:${tenantId.toLowerCase()}:${category}`;
  let cacheDatabasePromise;
  function cacheDatabase() {
    if (!cacheDatabasePromise) cacheDatabasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB is unavailable')); return; }
      const request = indexedDB.open('azurehound-browser-cache', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    });
    return cacheDatabasePromise;
  }
  async function cacheGet(storeName, key) {
    const db = await cacheDatabase();
    return new Promise<any>((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
    });
  }
  async function cacheWrite(storeName, value) {
    const db = await cacheDatabase();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
    });
  }
  async function cachePut(tenantId, category, objectCount) {
    const key = cacheKey(tenantId, category), savedAt = Date.now();
    const batch = `${savedAt}:${Math.random().toString(36).slice(2)}`;
    const previous = await cacheGet('meta', key);
    const chunkLimit = Math.min(jsonLimit(), 8 * 1024 * 1024);
    let records = [], bytes = 0, parts = 0, count = 0;
    const flush = async () => {
      if (!records.length) return;
      await cacheWrite('data', { key: `${key}:${batch}:${parts}`, records });
      parts++; records = []; bytes = 0;
    };
    for (const entry of categoryEntries(category)) {
      for (const piece of boundedEntries(entry, chunkLimit - 128)) {
        if (records.length && bytes + piece.bytes > chunkLimit) await flush();
        records.push(piece.entry); bytes += piece.bytes; count++;
      }
    }
    await flush();
    await cacheWrite('meta', { key, tenantId, category, savedAt, count, objectCount, parts, batch });
    if (previous) {
      const db = await cacheDatabase();
      const transaction = db.transaction('data', 'readwrite'), store = transaction.objectStore('data');
      if (Number.isInteger(previous.parts)) {
        for (let i = 0; i < previous.parts; i++) store.delete(`${key}:${previous.batch}:${i}`);
      } else store.delete(key);
    }
  }
  async function cacheMetadata(tenantId) {
    const categories = [...graphOptions.map(([kind]) => kind), ...armOptions.map(([kind]) => kind), 'AZSubscription'];
    const result = {};
    await Promise.all(categories.map(async category => {
      const meta = await cacheGet('meta', cacheKey(tenantId, category));
      if (meta && Date.now() - meta.savedAt <= nonnegative(config.cacheMaxAgeMs)) result[category] = meta;
    }));
    return result;
  }
  const categoryRecordCount = category => recordKindsFor(category).reduce((sum, kind) =>
    sum + (state.counts[kind] || 0) - (kind === 'AZTenant' ? (state.files.AZTenant || []).filter(entry => entry.data.collected).length : 0), 0);
  async function reuseCache(tenantId, metadata, reuse) {
    if (!reuse || !tenantId) return;
    const categories = [...graphOptions.map(([kind]) => kind), ...armOptions.map(([kind]) => kind)];
    if (categories.some(kind => chosen(kind) && armOptions.some(([armKind]) => armKind === kind))) categories.push('AZSubscription');
    for (const category of categories) {
      if (category !== 'AZSubscription' && !chosen(category)) continue;
      if (!metadata[category]) continue;
      const originalLengths = Object.fromEntries((Object.entries(state.files) as [string, any[]][]).map(([kind, entries]) => [kind, entries.length]));
      try {
        const key = cacheKey(tenantId, category), meta = metadata[category];
        const partCount = Number.isInteger(meta.parts) ? meta.parts : 1;
        for (let i = 0; i < partCount; i++) {
          const partKey = Number.isInteger(meta.parts) ? `${key}:${meta.batch}:${i}` : key;
          const entry = await cacheGet('data', partKey);
          if (!entry || !Array.isArray(entry.records)) throw new Error(`Cached part ${i + 1} is missing`);
          for (const record of entry.records) add(record.kind, record.data);
        }
        cachedKinds.add(category);
        state.cache.reused.push(category);
        state.categories[category] = { completed: 1, total: 1, failed: 0, percent: 100, status: 'cached' };
        logCategory(category);
      } catch (e) {
        for (const [kind, entries] of Object.entries(state.files) as [string, any[]][]) {
          entries.length = originalLengths[kind] || 0;
          state.counts[kind] = entries.length;
        }
        state.cache.errors.push(`${category}: ${e.message}`);
      }
    }
  }
  async function saveCache(tenantId) {
    if (!tenantId) return;
    const categories = [...graphOptions.map(([kind]) => kind), ...armOptions.map(([kind]) => kind)];
    if (armOptions.some(([kind]) => chosen(kind))) categories.push('AZSubscription');
    for (const category of categories) {
      if (category !== 'AZSubscription' && !chosen(category)) continue;
      if (cachedKinds.has(category)) continue;
      const kinds = recordKindsFor(category);
      const statuses = kinds.map(kind => state.categories[kind]?.status).filter(Boolean);
      if (category === 'AZSubscription' && state.categories.AZTenantTrust?.status === 'partial') continue;
      if (!state.categories[category] || statuses.some(status => status === 'partial' || status === 'running')) continue;
      try {
        await cachePut(tenantId, category, state.counts[category] || 0);
        state.cache.saved.push(category);
      } catch (e) { state.cache.errors.push(`${category}: ${e.message}`); }
    }
  }
  return { cacheMetadata, categoryRecordCount, reuseCache, saveCache };
}
