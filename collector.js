/* AzureHound browser collector. GPL-3.0-or-later; see ../AzureHound/LICENSE.md. Build with npm run build. */
(() => {
  // src/constants.ts
  var resourceDefinitions = [
    ["AZResourceGroup", (sid) => `/subscriptions/${sid}/resourcegroups`, "2021-04-01"],
    ["AZVM", (sid) => `/subscriptions/${sid}/providers/Microsoft.Compute/virtualMachines`, "2024-07-01"],
    ["AZVMScaleSet", (sid) => `/subscriptions/${sid}/providers/Microsoft.Compute/virtualMachineScaleSets`, "2024-07-01"],
    ["AZKeyVault", (sid) => `/subscriptions/${sid}/providers/Microsoft.KeyVault/vaults`, "2023-07-01"],
    ["AZStorageAccount", (sid) => `/subscriptions/${sid}/providers/Microsoft.Storage/storageAccounts`, "2023-01-01"],
    ["AZAutomationAccount", (sid) => `/subscriptions/${sid}/providers/Microsoft.Automation/automationAccounts`, "2023-11-01"],
    ["AZLogicApp", (sid) => `/subscriptions/${sid}/providers/Microsoft.Logic/workflows`, "2019-05-01"],
    ["AZFunctionApp", (sid) => `/subscriptions/${sid}/providers/Microsoft.Web/sites`, "2023-12-01", (item) => item.kind?.toLowerCase() === "functionapp"],
    ["AZWebApp", (sid) => `/subscriptions/${sid}/providers/Microsoft.Web/sites`, "2023-12-01", (item) => item.kind?.toLowerCase() === "app"],
    ["AZContainerRegistry", (sid) => `/subscriptions/${sid}/providers/Microsoft.ContainerRegistry/registries`, "2023-07-01"],
    ["AZManagedCluster", (sid) => `/subscriptions/${sid}/providers/Microsoft.ContainerService/managedClusters`, "2024-05-01"]
  ];
  var roleIds = {
    owner: "8e3af657-a8ff-443c-a75c-2fe8c4bcb635",
    contributor: "b24988ac-6180-42a0-ab88-20f7382dd24c",
    userAccessAdmin: "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9",
    kvContributor: "f25e0fa2-a7c8-4377-a976-54943a77a395",
    avereContributor: "4f8fab4f-1852-4a58-a46a-8eaf358af14a",
    adminLogin: "1c0163c0-47e6-4577-8991-ea5c82e286e4",
    vmContributor: "9980e02c-c2be-4d73-94e8-173b1dc7cf3c"
  };
  var derivedRoles = {
    AZSubscriptionRoleAssignment: [["AZSubscriptionOwner", "owner", "owners"], ["AZSubscriptionContributor", "contributor", "contributors"], ["AZSubscriptionUserAccessAdmin", "userAccessAdmin", "userAccessAdmins"]],
    AZManagementGroupRoleAssignment: [["AZManagementGroupOwner", "owner", "owners"], ["AZManagementGroupContributor", "contributor", "contributors"], ["AZManagementGroupUserAccessAdmin", "userAccessAdmin", "userAccessAdmins"]],
    AZResourceGroupRoleAssignment: [["AZResourceGroupOwner", "owner", "owners"], ["AZResourceGroupContributor", "contributor", "contributors"], ["AZResourceGroupUserAccessAdmin", "userAccessAdmin", "userAccessAdmins"]],
    AZKeyVaultRoleAssignment: [["AZKeyVaultOwner", "owner", "owners"], ["AZKeyVaultContributor", "contributor", "contributors"], ["AZKeyVaultUserAccessAdmin", "userAccessAdmin", "userAccessAdmins"], ["AZKeyVaultKVContributor", "kvContributor", "kvContributors"]],
    AZVMRoleAssignment: [["AZVMOwner", "owner", "owners"], ["AZVMContributor", "contributor", "contributors"], ["AZVMUserAccessAdmin", "userAccessAdmin", "userAccessAdmins"], ["AZVMAvereContributor", "avereContributor", "avereContributors"], ["AZVMAdminLogin", "adminLogin", "adminLogins"], ["AZVMVMContributor", "vmContributor", "vmContributors"]]
  };
  var graphRecordKinds = {
    AZUser: ["AZUser"],
    AZGroup: ["AZGroup", "AZGroupMember", "AZGroupOwner"],
    AZApp: ["AZApp", "AZAppOwner", "AZFederatedIdentityCredential"],
    AZServicePrincipal: ["AZServicePrincipal", "AZServicePrincipalOwner", "AZAppRoleAssignment"],
    AZDevice: ["AZDevice"],
    AZRole: ["AZRole", "AZRoleAssignment", "AZRoleEligibilityScheduleInstance", "AZRoleManagementPolicyAssignment"]
  };
  function recordKindsFor(category) {
    if (graphRecordKinds[category]) return graphRecordKinds[category];
    if (category === "AZSubscription") return [
      "AZSubscription",
      "AZSubscriptionRoleAssignment",
      ...(derivedRoles.AZSubscriptionRoleAssignment || []).map(([kind]) => kind),
      "AZTenant"
    ];
    if (category === "AZManagementGroup") return [
      "AZManagementGroup",
      "AZManagementGroupDescendant",
      "AZManagementGroupRoleAssignment",
      ...(derivedRoles.AZManagementGroupRoleAssignment || []).map(([kind]) => kind)
    ];
    const roleKind = category === "AZVM" ? "AZVMRoleAssignment" : `${category}RoleAssignment`;
    return [
      category,
      roleKind,
      ...(derivedRoles[roleKind] || []).map(([kind]) => kind),
      ...category === "AZKeyVault" ? ["AZKeyVaultAccessPolicy"] : [],
      ...category === "AZStorageAccount" ? ["AZStorageContainer"] : []
    ];
  }
  var graphOptions = [
    ["AZUser", "Users"],
    ["AZGroup", "Groups, members, and owners"],
    ["AZApp", "Registered applications, owners, and credentials"],
    ["AZServicePrincipal", "Service principals, owners, and app roles"],
    ["AZDevice", "Devices"],
    ["AZRole", "Directory roles, assignments, and policies"]
  ];
  var armOptions = [
    ["AZManagementGroup", "Management groups"],
    ...resourceDefinitions.map(([kind]) => [kind, kind.replace(/^AZ/, "").replace(/([a-z])([A-Z])/g, "$1 $2")])
  ];
  var graphCountQueries = [
    ["AZUser", "/v1.0/users", {}],
    ["AZGroup", "/v1.0/groups", { "$filter": "securityEnabled eq true" }],
    ["AZApp", "/v1.0/applications", {}],
    ["AZServicePrincipal", "/v1.0/servicePrincipals", {}],
    ["AZDevice", "/v1.0/devices", {}],
    ["AZRole", "/v1.0/roleManagement/directory/roleDefinitions", {}]
  ];
  var armResourceTypes = {
    AZVM: "microsoft.compute/virtualmachines",
    AZVMScaleSet: "microsoft.compute/virtualmachinescalesets",
    AZKeyVault: "microsoft.keyvault/vaults",
    AZStorageAccount: "microsoft.storage/storageaccounts",
    AZAutomationAccount: "microsoft.automation/automationaccounts",
    AZLogicApp: "microsoft.logic/workflows",
    AZFunctionApp: "microsoft.web/sites",
    AZWebApp: "microsoft.web/sites",
    AZContainerRegistry: "microsoft.containerregistry/registries",
    AZManagedCluster: "microsoft.containerservice/managedclusters"
  };

  // src/zip.ts
  var crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ 3988292384 & -(value & 1);
    return value >>> 0;
  });
  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) crc = crc >>> 8 ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ -1) >>> 0;
  }
  async function zip(entries, jsonPartContent, colors) {
    if (entries.length > 65535) throw new Error("ZIP contains too many files");
    const encoder = new TextEncoder();
    const parts = [], central = [];
    let offset = 0, centralLength = 0;
    const u16 = (view, at, n) => view.setUint16(at, n, true);
    const u32 = (view, at, n) => view.setUint32(at, n >>> 0, true);
    for (const [name, part] of entries) {
      const filename = encoder.encode(name), raw = encoder.encode(jsonPartContent(part)), crc = crc32(raw);
      if (raw.length !== part.bytes) throw new Error(`JSON size changed while exporting ${name}`);
      let bytes = raw, method = 0;
      if (typeof CompressionStream !== "undefined") {
        try {
          const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
          bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          method = 8;
        } catch (e) {
          console.warn("%cAzureHound warning%c  DEFLATE unavailable; using stored ZIP entry: %s", colors.partial, colors.text, e.message);
        }
      }
      if (filename.length > 65535 || raw.length > 4294967295 || bytes.length > 4294967295) throw new Error(`ZIP entry too large: ${name}`);
      const local = new Uint8Array(30 + filename.length), lv = new DataView(local.buffer);
      u32(lv, 0, 67324752);
      u16(lv, 4, 20);
      u16(lv, 6, 2048);
      u16(lv, 8, method);
      u32(lv, 14, crc);
      u32(lv, 18, bytes.length);
      u32(lv, 22, raw.length);
      u16(lv, 26, filename.length);
      local.set(filename, 30);
      parts.push(local, bytes);
      const header = new Uint8Array(46 + filename.length), hv = new DataView(header.buffer);
      u32(hv, 0, 33639248);
      u16(hv, 4, 20);
      u16(hv, 6, 20);
      u16(hv, 8, 2048);
      u16(hv, 10, method);
      u32(hv, 16, crc);
      u32(hv, 20, bytes.length);
      u32(hv, 24, raw.length);
      u16(hv, 28, filename.length);
      u32(hv, 42, offset);
      header.set(filename, 46);
      central.push(header);
      centralLength += header.length;
      offset += local.length + bytes.length;
    }
    if (offset + centralLength > 4294967295) throw new Error("ZIP exceeds the ZIP32 size limit");
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    u32(ev, 0, 101010256);
    u16(ev, 8, entries.length);
    u16(ev, 10, entries.length);
    u32(ev, 12, centralLength);
    u32(ev, 16, offset);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  // src/export.ts
  function createExporter(ctx) {
    const { state, config, recordKindsFor: recordKindsFor2, graphOptions: graphOptions2, armOptions: armOptions2, delay, colors } = ctx;
    const encoder = new TextEncoder();
    const jsonPrefix = '{"data":[';
    const jsonSuffix = (count) => `],"meta":{"type":"azure","version":5,"count":${count}}}`;
    const jsonLimit = () => Math.min(4294967295 - 4096, Math.floor(Number(config.maxJsonBytes)));
    const zipLimit = () => Math.min(4294967295 - 4096, Math.floor(Number(config.maxZipBytes)));
    const tenantRecord = () => state.files.AZTenant?.find((entry) => entry.data.collected);
    function* allEntries() {
      for (const records of Object.values(state.files)) for (const entry of records) {
        if (entry.kind !== "AZTenant" || !entry.data.collected) yield entry;
      }
    }
    function* categoryEntries(category) {
      for (const kind of recordKindsFor2(category)) for (const entry of state.files[kind] || []) {
        if (kind !== "AZTenant" || !entry.data.collected) yield entry;
      }
    }
    const relationArrays = /* @__PURE__ */ new Set([
      "members",
      "owners",
      "fics",
      "roleAssignments",
      "assignees",
      "contributors",
      "admins",
      "userAccessAdmins",
      "kvContributors",
      "avereContributors",
      "adminLogins",
      "vmContributors"
    ]);
    function* boundedEntries(entry, maxBytes) {
      const arrayKey = Object.keys(entry.data || {}).find((key) => relationArrays.has(key) && Array.isArray(entry.data[key]) && entry.data[key].length > 1);
      if (arrayKey && entry.data[arrayKey].length > 128) {
        const values = entry.data[arrayKey];
        for (let index = 0; index < values.length; index += 128) {
          yield* boundedEntries({ kind: entry.kind, data: { ...entry.data, [arrayKey]: values.slice(index, index + 128) } }, maxBytes);
        }
        return;
      }
      const bytes = encoder.encode(JSON.stringify(entry)).length;
      if (bytes <= maxBytes) {
        yield { entry, bytes };
        return;
      }
      if (arrayKey) {
        const values = entry.data[arrayKey], middle = Math.ceil(values.length / 2);
        yield* boundedEntries({ kind: entry.kind, data: { ...entry.data, [arrayKey]: values.slice(0, middle) } }, maxBytes);
        yield* boundedEntries({ kind: entry.kind, data: { ...entry.data, [arrayKey]: values.slice(middle) } }, maxBytes);
        return;
      }
      throw new Error(`${entry.kind} has one record larger than the JSON part limit; raise maxJsonBytes or omit that category`);
    }
    async function planJson(entries, baseName) {
      const tenant = tenantRecord();
      if (!tenant) throw new Error("No collected tenant is available for JSON export");
      const limit = jsonLimit(), tenantBytes = encoder.encode(JSON.stringify(tenant)).length;
      if (!Number.isSafeInteger(limit) || limit < tenantBytes + 128) throw new Error("maxJsonBytes is too small for the tenant envelope");
      const prefixBytes = encoder.encode(jsonPrefix).length;
      const sizeOf = (recordBytes2, count2) => prefixBytes + recordBytes2 + count2 - 1 + encoder.encode(jsonSuffix(count2)).length;
      const maxRecordBytes = limit - sizeOf(tenantBytes, 1) - 2;
      const parts = [];
      let records = [], recordBytes = tenantBytes, count = 1;
      const flush = () => {
        parts.push({ records, count, bytes: sizeOf(recordBytes, count) });
        records = [];
        recordBytes = tenantBytes;
        count = 1;
      };
      let processed = 0;
      for (const entry of entries) {
        for (const piece of boundedEntries(entry, maxRecordBytes)) {
          if (sizeOf(recordBytes + piece.bytes, count + 1) > limit) flush();
          records.push(piece.entry);
          recordBytes += piece.bytes;
          count++;
        }
        if (++processed % 1e3 === 0) await delay(0);
      }
      if (records.length || !parts.length) flush();
      for (let i = 0; i < parts.length; i++) parts[i].name = parts.length === 1 ? `${baseName}.json` : `${baseName}-part-${String(i + 1).padStart(3, "0")}.json`;
      return parts;
    }
    function jsonPartContent(part) {
      const pieces = [jsonPrefix, JSON.stringify(tenantRecord())];
      for (const entry of part.records) pieces.push(",", JSON.stringify(entry));
      pieces.push(jsonSuffix(part.count));
      return pieces.join("");
    }
    function jsonBlob(part) {
      const blob = new Blob([jsonPartContent(part)], { type: "application/json" });
      if (blob.size !== part.bytes) throw new Error(`JSON size changed while exporting ${part.name}`);
      return blob;
    }
    let exportPlanPromise;
    async function exportPlan() {
      if (!exportPlanPromise) exportPlanPromise = (async () => {
        const issues = state.validate();
        if (issues.length) throw new Error(`Cannot build a BloodHound collection: ${issues.join("; ")}. Inspect window.AzureHound.errors.`);
        const jsonParts = await planJson(allEntries(), "azurehound");
        const maxZip = zipLimit();
        if (!Number.isSafeInteger(maxZip) || maxZip <= 0) throw new Error("maxZipBytes must be a positive integer");
        const zipParts = [];
        let group = [], estimated = 22;
        for (const part of jsonParts) {
          const entryBytes = part.bytes + 264 + Math.ceil(part.bytes / 16384) * 5 + encoder.encode(part.name).length * 2;
          if (entryBytes + 22 > maxZip) throw new Error("maxZipBytes is too small for one JSON part; raise maxZipBytes or lower maxJsonBytes");
          if (group.length && (estimated + entryBytes > maxZip || group.length >= 65535)) {
            zipParts.push({ files: group, estimatedBytes: estimated });
            group = [];
            estimated = 22;
          }
          group.push(part);
          estimated += entryBytes;
        }
        if (group.length) zipParts.push({ files: group, estimatedBytes: estimated });
        const summary = {
          jsonFiles: jsonParts.length,
          jsonBytes: jsonParts.reduce((sum, part) => sum + part.bytes, 0),
          zipFiles: zipParts.length,
          estimatedZipBytes: zipParts.reduce((sum, part) => sum + part.estimatedBytes, 0)
        };
        state.exportEstimate = summary;
        return { jsonParts, zipParts, summary };
      })();
      return exportPlanPromise;
    }
    state.estimateExport = async () => (await exportPlan()).summary;
    state.makeZipPart = async (index) => {
      const plan = await exportPlan(), group = plan.zipParts[index];
      if (!group) throw new Error(`Unknown ZIP part ${index + 1}`);
      const blob = await zip(group.files.map((part) => [part.name, part]), jsonPartContent, colors);
      if (blob.size > zipLimit()) throw new Error(`ZIP part ${index + 1} exceeds maxZipBytes after compression`);
      return blob;
    };
    state.makeZip = async () => {
      const plan = await exportPlan();
      if (plan.zipParts.length !== 1) throw new Error(`Collection requires ${plan.zipParts.length} ZIP files; use makeZipPart(index) or download()`);
      return state.makeZipPart(0);
    };
    const categoryPlans = /* @__PURE__ */ new Map();
    const categoryPlan = (category) => {
      if (![...graphOptions2.map(([kind]) => kind), ...armOptions2.map(([kind]) => kind), "AZSubscription"].includes(category)) {
        throw new Error(`Unknown collection category: ${category}`);
      }
      if (!categoryPlans.has(category)) categoryPlans.set(category, planJson(categoryEntries(category), `azurehound-${category.toLowerCase()}`));
      return categoryPlans.get(category);
    };
    state.listJsonParts = async (category) => (await categoryPlan(category)).map((part, index) => ({ index, name: part.name, bytes: part.bytes, count: part.count }));
    state.makeJsonPart = async (category, index) => {
      const part = (await categoryPlan(category))[index];
      if (!part) throw new Error(`Unknown ${category} JSON part ${index + 1}`);
      return jsonBlob(part);
    };
    state.makeJson = async (category) => {
      const parts = await categoryPlan(category);
      if (parts.length !== 1) throw new Error(`${category} requires ${parts.length} JSON files; use makeJsonPart(category, index)`);
      return jsonBlob(parts[0]);
    };
    const triggerDownload = (blob, filename) => {
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url;
      a.download = filename;
      (document.body || document.documentElement).append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5e3);
      return blob;
    };
    state.downloadJsonPart = async (category, index) => {
      const parts = await categoryPlan(category), part = parts[index];
      if (!part) throw new Error(`Unknown ${category} JSON part ${index + 1}`);
      return triggerDownload(jsonBlob(part), part.name);
    };
    state.downloadJson = async (category) => {
      const parts = await categoryPlan(category);
      for (let i = 0; i < parts.length; i++) {
        await state.downloadJsonPart(category, i);
        if (i < parts.length - 1) await delay(5500);
      }
      return parts.length;
    };
    state.downloadZipPart = async (index) => {
      const plan = await exportPlan(), suffix = plan.zipParts.length === 1 ? "" : `-part-${String(index + 1).padStart(3, "0")}`;
      return triggerDownload(await state.makeZipPart(index), `azurehound-${state.startedAt.replace(/[:.]/g, "-")}${suffix}.zip`);
    };
    state.download = async () => {
      const plan = await exportPlan();
      for (let i = 0; i < plan.zipParts.length; i++) {
        await state.downloadZipPart(i);
        if (i < plan.zipParts.length - 1) await delay(5500);
      }
      return plan.zipParts.length;
    };
    return { jsonLimit, boundedEntries, categoryEntries };
  }

  // src/cache.ts
  function createCache(ctx) {
    const {
      state,
      config,
      graphOptions: graphOptions2,
      armOptions: armOptions2,
      recordKindsFor: recordKindsFor2,
      jsonLimit,
      boundedEntries,
      categoryEntries,
      nonnegative,
      chosen,
      cachedKinds,
      add,
      logCategory
    } = ctx;
    const cacheKey = (tenantId, category) => `v1:${tenantId.toLowerCase()}:${category}`;
    let cacheDatabasePromise;
    function cacheDatabase() {
      if (!cacheDatabasePromise) cacheDatabasePromise = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) {
          reject(new Error("IndexedDB is unavailable"));
          return;
        }
        const request = indexedDB.open("azurehound-browser-cache", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("data")) db.createObjectStore("data", { keyPath: "key" });
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
      });
      return cacheDatabasePromise;
    }
    async function cacheGet(storeName, key) {
      const db = await cacheDatabase();
      return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
      });
    }
    async function cacheWrite(storeName, value) {
      const db = await cacheDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(value);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB write failed"));
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB write aborted"));
      });
    }
    async function cachePut(tenantId, category, objectCount) {
      const key = cacheKey(tenantId, category), savedAt = Date.now();
      const batch = `${savedAt}:${Math.random().toString(36).slice(2)}`;
      const previous = await cacheGet("meta", key);
      const chunkLimit = Math.min(jsonLimit(), 8 * 1024 * 1024);
      let records = [], bytes = 0, parts = 0, count = 0;
      const flush = async () => {
        if (!records.length) return;
        await cacheWrite("data", { key: `${key}:${batch}:${parts}`, records });
        parts++;
        records = [];
        bytes = 0;
      };
      for (const entry of categoryEntries(category)) {
        for (const piece of boundedEntries(entry, chunkLimit - 128)) {
          if (records.length && bytes + piece.bytes > chunkLimit) await flush();
          records.push(piece.entry);
          bytes += piece.bytes;
          count++;
        }
      }
      await flush();
      await cacheWrite("meta", { key, tenantId, category, savedAt, count, objectCount, parts, batch });
      if (previous) {
        const db = await cacheDatabase();
        const transaction = db.transaction("data", "readwrite"), store = transaction.objectStore("data");
        if (Number.isInteger(previous.parts)) {
          for (let i = 0; i < previous.parts; i++) store.delete(`${key}:${previous.batch}:${i}`);
        } else store.delete(key);
      }
    }
    async function cacheMetadata(tenantId) {
      const categories = [...graphOptions2.map(([kind]) => kind), ...armOptions2.map(([kind]) => kind), "AZSubscription"];
      const result = {};
      await Promise.all(categories.map(async (category) => {
        const meta = await cacheGet("meta", cacheKey(tenantId, category));
        if (meta && Date.now() - meta.savedAt <= nonnegative(config.cacheMaxAgeMs)) result[category] = meta;
      }));
      return result;
    }
    const categoryRecordCount = (category) => recordKindsFor2(category).reduce((sum, kind) => sum + (state.counts[kind] || 0) - (kind === "AZTenant" ? (state.files.AZTenant || []).filter((entry) => entry.data.collected).length : 0), 0);
    async function reuseCache(tenantId, metadata, reuse) {
      if (!reuse || !tenantId) return;
      const categories = [...graphOptions2.map(([kind]) => kind), ...armOptions2.map(([kind]) => kind)];
      if (categories.some((kind) => chosen(kind) && armOptions2.some(([armKind]) => armKind === kind))) categories.push("AZSubscription");
      for (const category of categories) {
        if (category !== "AZSubscription" && !chosen(category)) continue;
        if (!metadata[category]) continue;
        const originalLengths = Object.fromEntries(Object.entries(state.files).map(([kind, entries]) => [kind, entries.length]));
        try {
          const key = cacheKey(tenantId, category), meta = metadata[category];
          const partCount = Number.isInteger(meta.parts) ? meta.parts : 1;
          for (let i = 0; i < partCount; i++) {
            const partKey = Number.isInteger(meta.parts) ? `${key}:${meta.batch}:${i}` : key;
            const entry = await cacheGet("data", partKey);
            if (!entry || !Array.isArray(entry.records)) throw new Error(`Cached part ${i + 1} is missing`);
            for (const record of entry.records) add(record.kind, record.data);
          }
          cachedKinds.add(category);
          state.cache.reused.push(category);
          state.categories[category] = { completed: 1, total: 1, failed: 0, percent: 100, status: "cached" };
          logCategory(category);
        } catch (e) {
          for (const [kind, entries] of Object.entries(state.files)) {
            entries.length = originalLengths[kind] || 0;
            state.counts[kind] = entries.length;
          }
          state.cache.errors.push(`${category}: ${e.message}`);
        }
      }
    }
    async function saveCache(tenantId) {
      if (!tenantId) return;
      const categories = [...graphOptions2.map(([kind]) => kind), ...armOptions2.map(([kind]) => kind)];
      if (armOptions2.some(([kind]) => chosen(kind))) categories.push("AZSubscription");
      for (const category of categories) {
        if (category !== "AZSubscription" && !chosen(category)) continue;
        if (cachedKinds.has(category)) continue;
        const kinds = recordKindsFor2(category);
        const statuses = kinds.map((kind) => state.categories[kind]?.status).filter(Boolean);
        if (category === "AZSubscription" && state.categories.AZTenantTrust?.status === "partial") continue;
        if (!state.categories[category] || statuses.some((status) => status === "partial" || status === "running")) continue;
        try {
          await cachePut(tenantId, category, state.counts[category] || 0);
          state.cache.saved.push(category);
        } catch (e) {
          state.cache.errors.push(`${category}: ${e.message}`);
        }
      }
    }
    return { cacheMetadata, categoryRecordCount, reuseCache, saveCache };
  }

  // src/preflight.ts
  function createPreflight(ctx) {
    const {
      state,
      config,
      request,
      targetTenant,
      graphTenant,
      tenantSource,
      tokens,
      audience,
      isTenantId,
      armTenant,
      tokenMismatch,
      cacheMetadata
    } = ctx;
    async function countDirectoryObjects(result) {
      await Promise.all(graphCountQueries.map(async ([kind, path, filter]) => {
        try {
          const response = await request(
            "graph",
            path,
            { ...filter, "$count": "true", "$top": 1 },
            { retries: 0, timeoutMs: config.preflightTimeoutMs, headers: { ConsistencyLevel: "eventual" } }
          );
          const count = Number(response?.["@odata.count"]);
          if (Number.isSafeInteger(count) && count >= 0) result.counts[kind] = count;
          else if (Array.isArray(response?.value) && response.value.length === 0 && !response["@odata.nextLink"]) result.counts[kind] = 0;
          else result.countNotes.push(`${kind}: count not returned`);
        } catch (e) {
          result.countNotes.push(`${kind}: ${e.message}`);
        }
      }));
    }
    async function countAzureResources(result, subscriptions) {
      const ids = subscriptions.value.map((item) => item.subscriptionId).filter(Boolean);
      result.counts.AZSubscription = ids.length;
      if (subscriptions.nextLink) result.countNotes.push("Azure resource counts cover the first subscription page only");
      if (!ids.length) return;
      const countQuery = async (query) => {
        const response = await request(
          "arm",
          "/providers/Microsoft.ResourceGraph/resources",
          { "api-version": "2024-04-01" },
          {
            method: "POST",
            body: { subscriptions: ids, query, options: { resultFormat: "objectArray" } },
            retries: 0,
            timeoutMs: config.preflightTimeoutMs
          }
        );
        if (!Array.isArray(response?.data)) throw new Error("Resource Graph returned no count rows");
        return response.data;
      };
      const outcomes = await Promise.allSettled([
        countQuery("Resources | summarize total=count() by type, kind"),
        countQuery("ResourceContainers | summarize total=count() by type")
      ]);
      if (outcomes[0].status === "fulfilled") {
        for (const kind of Object.keys(armResourceTypes)) result.counts[kind] = 0;
        for (const row of outcomes[0].value) {
          const type = String(row.type || "").toLowerCase(), resourceKind = String(row.kind || "").toLowerCase();
          const count = Number(row.total);
          if (!Number.isSafeInteger(count) || count < 0) continue;
          for (const [kind, expectedType] of Object.entries(armResourceTypes)) {
            if (type !== expectedType) continue;
            if (kind === "AZFunctionApp" && resourceKind !== "functionapp") continue;
            if (kind === "AZWebApp" && resourceKind !== "app") continue;
            result.counts[kind] += count;
          }
        }
      } else result.countNotes.push(`Azure resources: ${outcomes[0].reason.message}`);
      if (outcomes[1].status === "fulfilled") {
        result.counts.AZResourceGroup = outcomes[1].value.filter((row) => String(row.type || "").toLowerCase() === "microsoft.resources/subscriptions/resourcegroups").reduce((sum, row) => sum + (Number(row.total) || 0), 0);
        const groupRows = outcomes[1].value.filter((row) => String(row.type || "").toLowerCase() === "microsoft.management/managementgroups");
        if (groupRows.length) result.counts.AZManagementGroup = groupRows.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
      } else result.countNotes.push(`Azure containers: ${outcomes[1].reason.message}`);
    }
    async function runPreflight() {
      const result = {
        page: location.origin,
        tenantId: targetTenant || graphTenant || null,
        tenantSource,
        graphToken: !!tokens.graph,
        armToken: !!tokens.arm,
        graphPermissions: audience(tokens.graph || "")?.permissions || [],
        graphStatus: "Unavailable",
        armStatus: "Unavailable",
        issues: [],
        counts: {},
        countNotes: []
      };
      if (!config.graph || !tokens.graph) result.issues.push("A Microsoft Graph token is required for the tenant and core directory objects.");
      const graphAmbiguous = !config.graphToken && !targetTenant && (state.availableTenantIds?.length || 0) > 1;
      const graphMismatch = targetTenant && graphTenant && targetTenant.toLowerCase() !== graphTenant.toLowerCase();
      const armMismatch = targetTenant && armTenant && targetTenant.toLowerCase() !== armTenant.toLowerCase() || tokenMismatch;
      if (graphAmbiguous) result.issues.push("Several tenant tokens are cached and no active tenant was identified.");
      if (graphMismatch) result.issues.push("The Graph token belongs to another tenant.");
      if (armMismatch) {
        result.armStatus = "Tenant mismatch";
        result.issues.push("The Resource Manager token belongs to another tenant. Azure resource collection is unavailable.");
      }
      if (config.graph && tokens.graph && !graphAmbiguous && !graphMismatch) {
        try {
          const organization = await request("graph", "/v1.0/organization", {}, { retries: 0, timeoutMs: config.preflightTimeoutMs });
          const id = organization?.value?.[0]?.id;
          if (!isTenantId(id)) throw new Error("Organization response did not contain a tenant ID");
          if (result.tenantId && id.toLowerCase() !== result.tenantId.toLowerCase()) throw new Error("Organization tenant differs from the selected tenant");
          result.organization = organization;
          result.tenantId = id;
          if (!targetTenant && !graphTenant) result.tenantSource = "Graph organization";
          result.graphStatus = "Ready";
          await countDirectoryObjects(result);
        } catch (e) {
          result.graphStatus = `Failed: ${e.message}`;
          result.issues.push(`Graph check failed: ${e.message}`);
        }
      }
      if (config.arm && tokens.arm && !armMismatch) {
        try {
          const subscriptions = await request("arm", "/subscriptions", { "api-version": "2020-01-01" }, { retries: 0, timeoutMs: config.preflightTimeoutMs });
          if (!Array.isArray(subscriptions.value)) throw new Error("Subscriptions response was invalid");
          result.armStatus = `Ready (${subscriptions.value.length} subscriptions on first page)`;
          result.armReady = true;
          await countAzureResources(result, subscriptions);
        } catch (e) {
          result.armStatus = `Failed: ${e.message}`;
        }
      }
      result.cacheMetadata = {};
      if (result.tenantId) {
        if (config.useCache !== false) {
          try {
            result.cacheMetadata = await cacheMetadata(result.tenantId);
            result.cacheStatus = `${Object.keys(result.cacheMetadata).length} fresh categories available`;
          } catch (e) {
            result.cacheStatus = `Unavailable: ${e.message}`;
            state.cache.errors.push(e.message);
          }
        }
        if (!Array.isArray(config.categories)) {
          try {
            const saved = JSON.parse(localStorage.getItem(`azurehound:last-selection:${result.tenantId.toLowerCase()}`));
            if (Array.isArray(saved)) result.previousSelection = saved;
          } catch {
          }
        }
      }
      state.preflight = result;
      return result;
    }
    return runPreflight;
  }

  // src/popup.ts
  function createPopup(ctx) {
    const { state, config, graphOptions: graphOptions2, armOptions: armOptions2, chosen, elapsed, recordKindsFor: recordKindsFor2, categoryRecordCount, error } = ctx;
    function showPreflight(result) {
      return new Promise((resolve) => {
        const host = document.createElement("div");
        host.id = "azurehound-preflight";
        const shadow = host.attachShadow({ mode: "open" });
        const stylesheet = document.createElement("style");
        stylesheet.textContent = `
        :host{all:initial} .backdrop{position:fixed;inset:0;z-index:2147483647;background:rgba(8,13,28,.82);display:grid;place-items:center;font:14px/1.45 system-ui, sans-serif;color:#e2e8f0}
        .panel{box-sizing:border-box;width:min(760px,calc(100vw - 28px));max-height:min(90vh,900px);overflow:auto;background:#111827;border:1px solid #475569;border-radius:14px;box-shadow:0 24px 80px #0009;padding:24px}
        h2{margin:0 0 4px;font-size:22px;color:#c4b5fd} h3{font-size:15px;margin:20px 0 8px;color:#c4b5fd} p{margin:6px 0 14px;color:#cbd5e1}
        .facts{display:grid;grid-template-columns:140px 1fr;gap:5px 12px;padding:12px;background:#1e293b;border-radius:8px;word-break:break-word}
        .label{color:#94a3b8}.ok{color:#86efac}.bad{color:#fca5a5}.note{color:#fcd34d}
        .choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px} label.choice{display:flex;gap:8px;align-items:flex-start;cursor:pointer}
        input{accent-color:#a78bfa;margin-top:4px} label.choice:has(input:disabled){opacity:.5;cursor:not-allowed}
        .issues{padding:10px 12px;border-radius:8px;background:#451a1a;color:#fecaca;margin-top:12px;white-space:pre-line}
        .actions{display:flex;justify-content:flex-end;gap:10px;align-items:center;margin-top:22px} button{font:inherit;padding:9px 16px;border-radius:8px;cursor:pointer}
        #cancel{background:#334155;border:1px solid #64748b;color:#e2e8f0} #start{background:#7c3aed;border:1px solid #a78bfa;color:white;font-weight:700}
        #start:disabled{opacity:.45;cursor:not-allowed} #hint{margin-right:auto;color:#fcd34d;font-size:12px}
        .cacheChoice{display:flex;align-items:center;gap:8px;margin:12px 0;color:#cbd5e1}
        .settings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:10px 0}.setting{display:grid;gap:4px;color:#cbd5e1}
        .setting input{box-sizing:border-box;width:100%;padding:7px;background:#1e293b;border:1px solid #64748b;border-radius:6px;color:#e2e8f0;font:inherit}
        .estimate{padding:9px 12px;background:#1e293b;border-radius:7px;color:#e2e8f0;margin:12px 0}.estimate small{display:block;color:#94a3b8}
        .progress-list{max-height:48vh;overflow:auto;display:grid;gap:7px;margin:16px 0}
        .progress-row,.download-row{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#1e293b;border-radius:7px;padding:7px 10px}
        .progress-row span:last-child{color:#94a3b8;white-space:nowrap}.download-list{display:grid;gap:7px;max-height:48vh;overflow:auto;margin:12px 0}
        .download-row button,.actions button{font:inherit;padding:7px 12px;border-radius:7px;cursor:pointer}
        .download-row button{background:#334155;border:1px solid #64748b;color:#e2e8f0}.download-row small{color:#94a3b8}
        @media(max-width:600px){.choices,.settings{grid-template-columns:1fr}.facts{grid-template-columns:100px 1fr}.panel{padding:16px}}
      `;
        const element = (tag, id, className, label) => {
          const node = document.createElement(tag);
          if (id) node.id = id;
          if (className) node.className = className;
          if (label) node.textContent = label;
          return node;
        };
        const backdrop = element("div", null, "backdrop");
        const panel = element("section", null, "panel");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-labelledby", "title");
        panel.append(element("h2", "title", null, "AzureHound browser collection"));
        panel.append(element("p", null, null, "Review the detected session and choose what to collect."));
        panel.append(element("div", "facts", "facts"));
        const issuesBox = element("div", "issues", "issues");
        issuesBox.hidden = true;
        panel.append(issuesBox);
        panel.append(element("h3", null, null, "Directory"));
        panel.append(element("div", "graph", "choices"));
        panel.append(element("h3", null, null, "Azure resources"));
        panel.append(element("p", null, null, "Subscriptions and their role assignments are included when any Azure resource is selected."));
        panel.append(element("div", "arm", "choices"));
        const actions = element("div", null, "actions");
        actions.append(element("span", "hint"));
        const cancelButton = element("button", "cancel", null, "Cancel");
        const startButton = element("button", "start", null, "Start collection");
        cancelButton.type = "button";
        startButton.type = "button";
        actions.append(cancelButton, startButton);
        panel.append(actions);
        backdrop.append(panel);
        shadow.append(stylesheet, backdrop);
        const facts = shadow.getElementById("facts");
        const fact = (label, value, className = "") => {
          const a = document.createElement("span"), b = document.createElement("span");
          a.className = "label";
          a.textContent = label;
          b.className = className;
          b.textContent = value;
          facts.append(a, b);
        };
        fact("Page", result.page);
        fact("Tenant", result.tenantId ? `${result.tenantId} (${result.tenantSource})` : "Not detected", result.tenantId ? "ok" : "bad");
        fact("Graph", result.graphStatus, result.graphStatus === "Ready" ? "ok" : "bad");
        fact("Resource Manager", result.armStatus, result.armReady ? "ok" : "note");
        fact("Graph permissions", result.graphPermissions.join(", ") || "Not visible in token");
        fact("Cached results", result.cacheStatus || "Unavailable", Object.keys(result.cacheMetadata || {}).length ? "ok" : "note");
        fact("Object counts", `${Object.keys(result.counts).length} categories counted`, Object.keys(result.counts).length ? "ok" : "note");
        const cacheChoice = element("label", null, "cacheChoice");
        const cacheCheckbox = element("input", "reuse-cache");
        cacheCheckbox.type = "checkbox";
        cacheCheckbox.checked = config.useCache !== false;
        cacheCheckbox.disabled = !Object.keys(result.cacheMetadata || {}).length;
        cacheChoice.append(cacheCheckbox, element("span", null, null, "Reuse fresh cached categories from earlier runs"));
        facts.after(cacheChoice);
        const settings = element("div", "settings", "settings");
        const numberField = (id, label, value, min, max) => {
          const field = element("label", null, "setting", label), input = element("input", id);
          input.type = "number";
          input.min = String(min);
          input.max = String(max);
          input.step = "1";
          input.value = String(value);
          field.append(input);
          settings.append(field);
          return input;
        };
        const concurrencyInput = numberField("concurrency", "Concurrent workers", config.concurrency, 1, 16);
        const gapInput = numberField("throttle-ms", "Minimum request gap (ms)", config.throttleMs, 0, 6e4);
        const rateInput = numberField("requests-per-minute", "Requests per minute (0 = unlimited)", config.requestsPerMinute, 0, 6e4);
        const estimateBox = element("div", "estimate", "estimate");
        cacheChoice.after(element("h3", null, null, "Request limits"), settings, estimateBox);
        if (result.issues.length) {
          const issues = shadow.getElementById("issues");
          issues.hidden = false;
          issues.textContent = result.issues.join("\n");
        }
        const boxes = [];
        const addOptions = (containerId, options, enabled) => {
          const container = shadow.getElementById(containerId);
          for (const [kind, label] of options) {
            const row = document.createElement("label"), checkbox = document.createElement("input"), name = document.createElement("span");
            row.className = "choice";
            checkbox.type = "checkbox";
            checkbox.dataset.kind = kind;
            checkbox.checked = enabled && (result.previousSelection ? result.previousSelection.includes(kind) : chosen(kind));
            checkbox.disabled = !enabled;
            name.textContent = label;
            const count = result.counts[kind];
            name.textContent += Number.isSafeInteger(count) ? ` \xB7 ${count.toLocaleString()} ${count === 1 ? "object" : "objects"}` : " \xB7 count unavailable";
            if (result.cacheMetadata?.[kind]) name.textContent += ` \xB7 cached ${new Date(result.cacheMetadata[kind].savedAt).toLocaleString()}`;
            row.append(checkbox, name);
            container.append(row);
            boxes.push(checkbox);
          }
        };
        addOptions("graph", graphOptions2, result.graphStatus === "Ready");
        addOptions("arm", armOptions2, !!result.armReady);
        const start = shadow.getElementById("start"), hint = shadow.getElementById("hint");
        const settingsValue = () => ({
          concurrency: Number(concurrencyInput.value),
          throttleMs: Number(gapInput.value),
          requestsPerMinute: Number(rateInput.value)
        });
        const validSettings = (value) => Number.isInteger(value.concurrency) && value.concurrency >= 1 && value.concurrency <= 16 && Number.isInteger(value.throttleMs) && value.throttleMs >= 0 && value.throttleMs <= 6e4 && Number.isInteger(value.requestsPerMinute) && value.requestsPerMinute >= 0 && value.requestsPerMinute <= 6e4 && concurrencyInput.value !== "" && gapInput.value !== "" && rateInput.value !== "";
        const duration = (ms) => ms < 6e4 ? `${Math.max(1, Math.ceil(ms / 1e3))} sec` : ms < 36e5 ? `${Math.ceil(ms / 6e4)} min` : `${(ms / 36e5).toFixed(1)} hr`;
        const update = () => {
          const checked = new Set(boxes.filter((box) => box.checked).map((box) => box.dataset.kind));
          const core = ["AZUser", "AZGroup", "AZApp", "AZServicePrincipal"].some((kind) => checked.has(kind));
          const limits = settingsValue(), valid = validSettings(limits);
          start.disabled = result.graphStatus !== "Ready" || !core || !valid;
          hint.textContent = result.graphStatus !== "Ready" ? "Graph access is required." : !core ? "Select at least one core directory category." : !valid ? "Enter valid request limits." : "";
          const uncached = [...checked].filter((kind) => !cacheCheckbox.checked || !result.cacheMetadata?.[kind]);
          const unknown = uncached.filter((kind) => !Number.isSafeInteger(result.counts[kind]));
          const subscriptions = Math.max(1, result.counts.AZSubscription || 1);
          const requestCount = (kind) => {
            const count = Number.isSafeInteger(result.counts[kind]) ? result.counts[kind] : 10;
            const pageSize = { AZUser: 500, AZGroup: 99, AZApp: 99, AZServicePrincipal: 999, AZDevice: 999 }[kind] || 100;
            if (graphOptions2.some(([item]) => item === kind)) {
              const pages = Math.max(1, Math.ceil(count / pageSize));
              if (kind === "AZGroup" || kind === "AZApp") return pages + count * 2;
              if (kind === "AZServicePrincipal") return pages + count + Math.ceil(count / 4);
              if (kind === "AZRole") return pages + count + 2;
              return pages;
            }
            if (kind === "AZManagementGroup") return 1 + count * 2;
            return subscriptions + count * (kind === "AZStorageAccount" || kind === "AZKeyVault" ? 3 : 2);
          };
          const armSelected = uncached.some((kind) => armOptions2.some(([item]) => item === kind));
          const assumedRequests = (uncached.length || armSelected ? 1 : 0) + uncached.reduce((sum, kind) => sum + requestCount(kind), 0) + (armSelected && (!cacheCheckbox.checked || !result.cacheMetadata?.AZSubscription) ? 2 + subscriptions : 0);
          if (valid && core) {
            const spacing = Math.max(limits.throttleMs, limits.requestsPerMinute ? 6e4 / limits.requestsPerMinute : 0);
            const baseline = Math.max((assumedRequests - 1) * spacing, Math.ceil(assumedRequests / limits.concurrency) * 250);
            estimateBox.replaceChildren(
              element("strong", null, null, `Estimated collection: ${duration(baseline)}\u2013${duration(baseline * 3)}`),
              element("small", null, null, `Based on ${assumedRequests.toLocaleString()} estimated requests from initial object counts and the selected limits. ${unknown.length ? `Count unavailable for ${unknown.join(", ")}; using 10 objects each. ` : ""}Pagination, retries, and API delays can take longer.`)
            );
          } else estimateBox.textContent = "Select categories and enter valid request limits to see an estimate.";
        };
        shadow.addEventListener("change", update);
        shadow.addEventListener("input", update);
        update();
        let started = false;
        const cancel = () => {
          if (!started) {
            state.cancel();
            host.remove();
            resolve(null);
          } else state.cancel();
        };
        shadow.getElementById("cancel").addEventListener("click", cancel);
        start.addEventListener("click", () => {
          if (start.disabled || started) return;
          started = true;
          const kinds = boxes.filter((box) => box.checked).map((box) => box.dataset.kind);
          const limits = settingsValue();
          const title = element("h2", "title", null, "Collecting Azure data");
          const summary = element("p", "progress-summary", null, "Starting collection\u2026");
          const rows = element("div", "progress-rows", "progress-list");
          const controls = element("div", null, "actions");
          const stop = element("button", "stop", null, "Stop collection");
          stop.type = "button";
          stop.addEventListener("click", () => state.cancel());
          controls.append(stop);
          panel.replaceChildren(title, summary, rows, controls);
          state.popup = {
            update() {
              if (!host.isConnected || !state.running) return;
              const progress = state.progress();
              summary.textContent = `${elapsed(progress.elapsedSeconds)} \xB7 ${progress.records.toLocaleString()} records \xB7 ${progress.requests.completed} requests \xB7 ${progress.errors} errors`;
              rows.replaceChildren();
              for (const kind of [...kinds, ...kinds.some((item) => armOptions2.some(([armKind]) => armKind === item)) ? ["AZSubscription"] : []]) {
                const related = recordKindsFor2(kind).map((item) => progress.categories[item]).filter(Boolean);
                const category = related.length ? {
                  percent: Math.round(related.reduce((sum, item) => sum + item.percent, 0) / related.length),
                  status: related.every((item) => ["complete", "cached", "skipped"].includes(item.status)) ? "complete" : related.some((item) => item.status === "partial") ? "partial" : "running",
                  records: categoryRecordCount(kind)
                } : null;
                const row = element("div", null, "progress-row");
                row.append(element("span", null, null, kind), element(
                  "span",
                  null,
                  null,
                  category ? `${category.percent}% \xB7 ${category.records} records \xB7 ${category.status}` : "Waiting"
                ));
                rows.append(row);
              }
            },
            finish() {
              if (!host.isConnected) return;
              const issues = state.validate(), title2 = element(
                "h2",
                "title",
                null,
                issues.length ? "Collection stopped" : "Collection complete"
              );
              const report = state.progress();
              const message = element("p", null, null, `${report.records.toLocaleString()} records \xB7 ${report.requests.completed} requests \xB7 ${report.errors} errors`);
              const details = element(
                "p",
                null,
                issues.length ? "bad" : "ok",
                issues.length ? issues.join("; ") : "Estimating JSON sizes and preparing ZIP parts\u2026"
              );
              const downloads = element("div", null, "download-list");
              const controls2 = element("div", null, "actions");
              if (!issues.length) {
                state.estimateExport().then((estimate) => {
                  if (!host.isConnected) return;
                  const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;
                  details.textContent = `${estimate.jsonFiles} JSON files \xB7 ${mib(estimate.jsonBytes)} total uncompressed \xB7 ${estimate.zipFiles} ZIP ${estimate.zipFiles === 1 ? "file" : "files"}.`;
                  for (let index = 0; index < estimate.zipFiles; index++) {
                    const button = element(
                      "button",
                      estimate.zipFiles === 1 ? "download-zip" : `download-zip-${index + 1}`,
                      null,
                      estimate.zipFiles === 1 ? "Download ZIP" : `Download ZIP ${index + 1}/${estimate.zipFiles}`
                    );
                    button.type = "button";
                    button.addEventListener("click", () => state.downloadZipPart(index).catch((e) => error("ZIP download", e)));
                    controls2.prepend(button);
                  }
                }).catch((e) => {
                  details.className = "bad";
                  details.textContent = `Export preparation failed: ${e.message}`;
                  error("Export preparation", e);
                });
                for (const kind of [...kinds, ...kinds.some((item) => armOptions2.some(([armKind]) => armKind === item)) ? ["AZSubscription"] : []]) {
                  const row = element("div", null, "download-row");
                  row.append(element("span", null, null, `${kind} \xB7 ${categoryRecordCount(kind)} records`));
                  const button = element("button", null, null, "Download JSON");
                  button.type = "button";
                  button.addEventListener("click", async () => {
                    try {
                      const parts = await state.listJsonParts(kind);
                      if (parts.length === 1) {
                        await state.downloadJsonPart(kind, 0);
                        return;
                      }
                      button.remove();
                      let insertionPoint = row;
                      for (const part of parts) {
                        const partRow = element("div", null, "download-row");
                        partRow.append(element("small", null, null, `${part.name} \xB7 ${(part.bytes / 1048576).toFixed(1)} MiB`));
                        const partButton = element("button", null, null, "Download JSON");
                        partButton.type = "button";
                        partButton.addEventListener("click", () => state.downloadJsonPart(kind, part.index).catch((e) => error("JSON download", e)));
                        partRow.append(partButton);
                        insertionPoint.after(partRow);
                        insertionPoint = partRow;
                      }
                    } catch (e) {
                      error("JSON download", e);
                    }
                  });
                  row.append(button);
                  downloads.append(row);
                }
              }
              if (state.cache.errors.length) downloads.append(element("p", null, "note", `Cache: ${state.cache.errors.join("; ")}`));
              const close = element("button", "close", null, "Close");
              close.type = "button";
              close.addEventListener("click", () => host.remove());
              controls2.append(close);
              panel.replaceChildren(title2, message, details, downloads, controls2);
            }
          };
          state.popup.update();
          resolve({ kinds, reuse: cacheCheckbox.checked, limits });
        });
        shadow.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            if (!started) cancel();
            else state.cancel();
          }
        });
        (document.body || document.documentElement).append(host);
        shadow.getElementById("cancel").focus();
      });
    }
    return showPreflight;
  }

  // src/main.ts
  var completion = (async function azureHoundBrowserCollector() {
    "use strict";
    if (window.AzureHound && window.AzureHound.running) throw new Error("AzureHound collection is already running");
    const previousCacheReady = window.AzureHound?.cacheReady;
    const config = Object.assign({
      concurrency: 4,
      retries: 4,
      pageTimeoutMs: 12e4,
      preflightTimeoutMs: 15e3,
      throttleMs: 0,
      requestsPerMinute: 0,
      progressIntervalMs: 1e4,
      graph: true,
      arm: true,
      download: true,
      interactive: true,
      useCache: true,
      cacheMaxAgeMs: 864e5,
      maxJsonBytes: 16 * 1024 * 1024,
      maxZipBytes: 128 * 1024 * 1024
    }, window.AzureHoundConfig || {});
    const state = { running: true, startedAt: (/* @__PURE__ */ new Date()).toISOString(), errors: [], counts: {}, abortController: new AbortController(), files: {} };
    window.AzureHound = state;
    state.cancel = () => state.abortController.abort();
    let selectedKinds = Array.isArray(config.categories) ? new Set(config.categories) : null;
    const cachedKinds = /* @__PURE__ */ new Set();
    const chosen = (kind) => !selectedKinds || selectedKinds.has(kind);
    const selected = (kind) => chosen(kind) && !cachedKinds.has(kind);
    state.cache = { reused: [], saved: [], errors: [] };
    state.requests = { started: 0, completed: 0, failed: 0, retried: 0, throttled: 0, active: 0, lastEndpoint: null };
    state.categories = {};
    const beginCategory = (kind, total = null, status = "running") => {
      state.categories[kind] = { completed: 0, total, failed: 0, percent: 0, status };
    };
    const advanceCategory = (kind, failed = false) => {
      const category = state.categories[kind];
      if (!category) return;
      category.completed++;
      if (failed) category.failed++;
      if (category.total === null) category.total = category.completed;
      category.percent = category.total ? Math.min(100, Math.round(100 * category.completed / category.total)) : 100;
      category.status = category.completed >= category.total ? category.failed ? "partial" : "complete" : "running";
      if (category.status !== "running") logCategory(kind);
    };
    const nonnegative = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    let requestSpacingMs = Math.max(
      nonnegative(config.throttleMs),
      nonnegative(config.requestsPerMinute) ? 6e4 / nonnegative(config.requestsPerMinute) : 0
    );
    let nextRequestAt = 0;
    async function waitForRequestSlot() {
      if (!requestSpacingMs) return;
      const now = performance.now();
      const slot = Math.max(now, nextRequestAt);
      nextRequestAt = slot + requestSpacingMs;
      if (slot > now) {
        state.requests.throttled++;
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Collection cancelled"));
          };
          const timer = setTimeout(() => {
            state.abortController.signal.removeEventListener("abort", onAbort);
            resolve();
          }, slot - now);
          state.abortController.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (state.abortController.signal.aborted) throw new Error("Collection cancelled");
    }
    state.progress = () => ({
      elapsedSeconds: Math.round((Date.now() - Date.parse(state.startedAt)) / 1e3),
      requests: { ...state.requests },
      records: Object.values(state.counts).reduce((sum, count) => sum + count, 0),
      errors: state.errors.length,
      counts: { ...state.counts },
      percentages: Object.fromEntries(Object.entries(state.categories).map(([kind, category]) => [kind, category.percent])),
      categories: Object.fromEntries(Object.entries(state.categories).map(([kind, category]) => [kind, { ...category, records: state.counts[kind] || 0 }]))
    });
    const colors = {
      brand: "color:#a78bfa;font-weight:bold",
      running: "color:#60a5fa;font-weight:bold",
      complete: "color:#4ade80;font-weight:bold",
      partial: "color:#fbbf24;font-weight:bold",
      skipped: "color:#94a3b8;font-weight:bold",
      cached: "color:#86efac;font-weight:bold",
      blocked: "color:#f87171;font-weight:bold",
      text: "color:#cbd5e1",
      muted: "color:#94a3b8"
    };
    const loggedCategories = /* @__PURE__ */ new Map();
    const elapsed = (seconds) => `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    function logCategory(kind, force = false) {
      const category = state.categories[kind];
      if (!category || category.status === "pending") return;
      const signature = `${category.percent}:${category.status}:${category.completed}:${category.failed}`;
      if (!force && loggedCategories.get(kind) === signature) return;
      loggedCategories.set(kind, signature);
      const color = colors[category.status] || colors.running;
      const bars = Math.round(category.percent / 10);
      const bar = "\u2588".repeat(bars) + "\u2591".repeat(10 - bars);
      const units = category.total === null ? "pages ongoing" : `${category.completed}/${category.total} units`;
      const records = state.counts[kind] || 0;
      console.info(
        `%c${bar} ${String(category.percent).padStart(3)}% %c${kind}%c  ${units} \xB7 ${records.toLocaleString()} records \xB7 ${category.status}`,
        color,
        "font-weight:bold;color:#e2e8f0",
        colors.muted
      );
      state.popup?.update?.();
    }
    function logProgress(forceCategories = false) {
      const progress = state.progress();
      const status = state.running ? "RUNNING" : state.abortController.signal.aborted ? "CANCELLED" : state.validate().length ? "BLOCKED" : state.warnings().length ? "PARTIAL" : "DONE";
      const statusColor = status === "DONE" ? colors.complete : status === "CANCELLED" ? colors.skipped : colors[status.toLowerCase()] || colors.running;
      console.info(
        `%cAzureHound%c ${status}%c  ${elapsed(progress.elapsedSeconds)} \xB7 ${progress.records.toLocaleString()} records \xB7 ${progress.requests.completed} requests \xB7 ${progress.requests.active} active \xB7 ${progress.errors} errors`,
        colors.brand,
        statusColor,
        colors.text
      );
      for (const kind of Object.keys(state.categories)) logCategory(kind, forceCategories);
      state.popup?.update?.();
    }
    const upper = (value) => typeof value === "string" ? value.toUpperCase() : value;
    const idUpper = (object) => {
      if (!object || typeof object !== "object") return object;
      const copy = { ...object };
      for (const key of ["id", "appId", "tenantId", "onPremisesSecurityIdentifier", "principalId", "roleDefinitionId", "scope", "resourceId"]) {
        if (key in copy) copy[key] = upper(copy[key]);
      }
      return copy;
    };
    const add = (kind, data) => {
      (state.files[kind] ||= []).push({ kind, data });
      state.counts[kind] = state.files[kind].length;
    };
    const error = (area, e) => {
      const message = e instanceof Error ? e.message : String(e);
      state.errors.push({ area, message });
      console.warn("%cAzureHound warning%c  %s: %s", colors.partial, colors.text, area, message);
    };
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const audience = (token) => {
      try {
        const body = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        return {
          aud: String(body.aud || "").toLowerCase(),
          exp: Number(body.exp || 0),
          tid: body.tid,
          permissions: [...String(body.scp || "").split(" "), ...Array.isArray(body.roles) ? body.roles : []].filter(Boolean)
        };
      } catch {
        return null;
      }
    };
    function cachedToken(resource, tenantId) {
      const audiences = resource === "graph" ? ["graph.microsoft.com", "00000003-0000-0000-c000-000000000000"] : ["management.azure.com", "management.core.windows.net"];
      const now = Date.now() / 1e3 + 120;
      const candidates = [];
      for (const storage of [sessionStorage, localStorage]) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !/(accesstoken|access_token|msal|adal|token)/i.test(key)) continue;
          let raw;
          try {
            raw = storage.getItem(key);
          } catch {
            continue;
          }
          const tokenCandidates = [];
          if (raw && raw.split(".").length === 3) tokenCandidates.push(raw);
          try {
            const entry = JSON.parse(raw);
            for (const value of [entry.accessToken, entry.secret, entry.token, entry.credential]) {
              if (typeof value === "string") tokenCandidates.push(value);
            }
          } catch {
          }
          for (const token of tokenCandidates) {
            const claims = audience(token);
            if (claims && claims.exp > now && audiences.some((aud) => claims.aud.includes(aud))) {
              const scopes = claims.permissions.map((permission) => permission.toLowerCase());
              const score = scopes.length + (scopes.includes("directory.read.all") ? 10 : 0) + (scopes.includes("rolemanagement.read.directory") ? 10 : 0) + (scopes.includes("rolemanagement.read.all") ? 10 : 0) + (scopes.includes("application.read.all") ? 3 : 0);
              candidates.push({ token, tid: claims.tid, exp: claims.exp, score });
            }
          }
        }
      }
      const tenantIds = [...new Set(candidates.map((candidate) => candidate.tid?.toLowerCase()).filter(Boolean))];
      if (resource === "graph") state.availableTenantIds = tenantIds;
      if (!tenantId && tenantIds.length > 1) return null;
      return candidates.filter((candidate) => !tenantId || candidate.tid?.toLowerCase() === tenantId.toLowerCase()).sort((a, b) => b.score - a.score || b.exp - a.exp)[0]?.token || null;
    }
    const isTenantId = (value) => typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
    const portalTenant = (() => {
      const candidates = [new URLSearchParams(location.search), new URLSearchParams(location.hash.split("?")[1] || "")];
      for (const params of candidates) {
        const value = params.get("tenantId") || params.get("tenant");
        if (isTenantId(value)) return value;
      }
      const pathTenant = location.pathname.match(/^\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i)?.[1];
      if (isTenantId(pathTenant)) return pathTenant;
      return null;
    })();
    const activeAccountTenant = (() => {
      const entries = [];
      for (const storage of [sessionStorage, localStorage]) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !/msal\..*active.account(?:.filters)?$/i.test(key)) continue;
          try {
            const filters = JSON.parse(storage.getItem(key));
            if (!filters || typeof filters !== "object") continue;
            if (isTenantId(filters.tenantId)) {
              entries.push(filters.tenantId);
              continue;
            }
            for (let j = 0; j < storage.length; j++) {
              const accountKey = storage.key(j);
              if (!accountKey || accountKey === key) continue;
              let account;
              try {
                account = JSON.parse(storage.getItem(accountKey));
              } catch {
                continue;
              }
              if (!account || !isTenantId(account.realm)) continue;
              if (filters.localAccountId && account.localAccountId === filters.localAccountId || filters.homeAccountId && account.homeAccountId === filters.homeAccountId || filters.username && account.username === filters.username) entries.push(account.realm);
            }
          } catch {
          }
        }
      }
      const unique = [...new Set(entries.map((value) => value.toLowerCase()))];
      return unique.length === 1 ? unique[0] : null;
    })();
    const targetTenant = config.tenantId || portalTenant || activeAccountTenant;
    const tenantSource = config.tenantId ? "config" : portalTenant ? "portal URL" : activeAccountTenant ? "active MSAL account" : "Graph token";
    const graphToken = config.graphToken || cachedToken("graph", targetTenant);
    const tokenTenant = targetTenant || audience(graphToken || "")?.tid;
    const tokens = {
      graph: graphToken,
      arm: config.armToken || cachedToken("arm", tokenTenant)
    };
    const graphTenant = audience(tokens.graph || "")?.tid;
    const armTenant = audience(tokens.arm || "")?.tid;
    const tokenMismatch = graphTenant && armTenant && graphTenant.toLowerCase() !== armTenant.toLowerCase();
    function urlFor(service, path, params = {}) {
      const root = service === "graph" ? "https://graph.microsoft.com" : "https://management.azure.com";
      const url = new URL(path, root);
      if (url.origin !== root) throw new Error(`Unexpected ${service} pagination origin: ${url.origin}`);
      for (const [key, value] of Object.entries(params)) if (value !== void 0 && value !== "") url.searchParams.set(key, String(value));
      return url;
    }
    async function request(service, path, params = {}, options = {}) {
      const token = tokens[service];
      if (!token) throw new Error(`No ${service} access token. Set window.AzureHoundConfig.${service === "graph" ? "graphToken" : "armToken"} to a token for the respective API and evaluate again.`);
      const url = urlFor(service, path, params);
      const retries = options.retries ?? config.retries;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (state.abortController.signal.aborted) throw new Error("Collection cancelled");
        await waitForRequestSlot();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? config.pageTimeoutMs);
        const cancel = () => controller.abort();
        state.abortController.signal.addEventListener("abort", cancel, { once: true });
        state.requests.started++;
        state.requests.active++;
        state.requests.lastEndpoint = `${service.toUpperCase()} ${url.pathname}`;
        try {
          const response = await fetch(url, {
            method: options.method || "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              ...options.body ? { "Content-Type": "application/json" } : {},
              ...options.headers || {}
            },
            ...options.body ? { body: JSON.stringify(options.body) } : {},
            signal: controller.signal,
            credentials: "omit"
          });
          if ((response.status === 429 || response.status >= 500) && attempt < retries) {
            state.requests.retried++;
            const retryAfter = Number(response.headers.get("Retry-After"));
            await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1e3 : Math.min(3e4, 1e3 * 2 ** attempt));
            continue;
          }
          if (!response.ok) {
            let detail = "";
            try {
              const body = await response.json();
              detail = body.error?.message || body.error?.code || "";
            } catch {
            }
            throw new Error(`${response.status} ${url.pathname}: ${detail}`);
          }
          return await response.json();
        } catch (e) {
          state.requests.failed++;
          if (e.name === "TypeError") throw new Error(`Browser request failed for ${url.origin}. Check portal CORS policy and token audience: ${e.message}`);
          throw e;
        } finally {
          state.requests.active--;
          state.requests.completed++;
          if (state.requests.completed % 25 === 0) logProgress();
          clearTimeout(timer);
          state.abortController.signal.removeEventListener("abort", cancel);
        }
      }
    }
    async function list(service, path, params = {}) {
      const items = [];
      let next = path;
      let query = params;
      const seen = /* @__PURE__ */ new Set();
      while (next) {
        const url = urlFor(service, next, query);
        if (seen.has(url.href)) throw new Error(`Pagination loop: ${url.href}`);
        seen.add(url.href);
        const result = await request(service, next, query);
        if (!Array.isArray(result.value)) throw new Error(`Missing value array: ${url.pathname}`);
        items.push(...result.value);
        next = result["@odata.nextLink"] || result.nextLink || null;
        query = {};
      }
      return items;
    }
    async function scanList(service, path, params, onItem) {
      let next = path, query = params;
      const seen = /* @__PURE__ */ new Set();
      while (next) {
        const url = urlFor(service, next, query);
        if (seen.has(url.href)) throw new Error(`Pagination loop: ${url.href}`);
        seen.add(url.href);
        const result = await request(service, next, query);
        if (!Array.isArray(result.value)) throw new Error(`Missing value array: ${url.pathname}`);
        for (const item of result.value) onItem(item);
        next = result["@odata.nextLink"] || result.nextLink || null;
        query = {};
      }
    }
    async function safe(area, work) {
      try {
        return await work();
      } catch (e) {
        error(area, e);
        return null;
      }
    }
    async function each(items, area, work) {
      beginCategory(area, items.length);
      if (!items.length) {
        state.categories[area].percent = 100;
        state.categories[area].status = "skipped";
        logCategory(area);
        return;
      }
      const concurrency = Math.max(1, Math.min(16, Number(config.concurrency) || 4));
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length && !state.abortController.signal.aborted) {
          const item = items[cursor++];
          const errorCount = state.errors.length;
          await safe(`${area} ${item.id || item.name || item.appId || ""}`, () => work(item));
          advanceCategory(area, state.errors.length > errorCount);
        }
      }));
    }
    async function collectGraph() {
      if (!tokens.graph) {
        error("Graph", "No Graph token found");
        return;
      }
      beginCategory("AZTenant");
      const org = state.preflight?.organization || await safe("organization", () => request("graph", "/v1.0/organization"));
      const tenant = org?.value?.[0];
      if (tenant?.id && graphTenant && tenant.id.toLowerCase() !== graphTenant.toLowerCase()) {
        throw new Error(`Graph organization tenant ${tenant.id} does not match Graph token tenant ${graphTenant}`);
      }
      if (tenant?.id && targetTenant && tenant.id.toLowerCase() !== targetTenant.toLowerCase()) {
        throw new Error(`Graph organization tenant ${tenant.id} does not match selected tenant ${targetTenant}`);
      }
      const tenantId = upper(tenant?.id || targetTenant || graphTenant || "");
      const tenantName = upper(tenant?.displayName || "");
      if (tenant?.id) {
        const domains = (tenant?.verifiedDomains || []).map((domain) => domain.name);
        add("AZTenant", {
          id: upper(`/tenants/${tenantId}`),
          tenantId,
          displayName: tenantName,
          country: tenant?.country,
          countryCode: tenant?.countryLetterCode,
          defaultDomain: tenant?.verifiedDomains?.find((domain) => domain.isDefault)?.name || "",
          domains,
          tenantType: tenant?.tenantType,
          collected: true
        });
      }
      advanceCategory("AZTenant", !tenant?.id);
      const entity = (item) => ({
        ...idUpper(item),
        displayName: upper(item.displayName),
        deviceId: upper(item.deviceId),
        appOwnerOrganizationId: upper(item.appOwnerOrganizationId),
        tenantId,
        tenantName
      });
      const definitions = [
        ["AZUser", "/v1.0/users", { "$top": 999, "$select": "id,accountEnabled,createdDateTime,displayName,jobTitle,lastPasswordChangeDateTime,mail,onPremisesSecurityIdentifier,onPremisesSyncEnabled,userPrincipalName,userType,signInActivity" }],
        ["AZGroup", "/v1.0/groups", { "$top": 99, "$filter": "securityEnabled eq true" }],
        ["AZApp", "/v1.0/applications", { "$top": 99 }],
        ["AZServicePrincipal", "/v1.0/servicePrincipals", { "$top": 999 }],
        ["AZDevice", "/v1.0/devices", { "$top": 999 }],
        ["AZRole", "/v1.0/roleManagement/directory/roleDefinitions", {}],
        ["AZRoleEligibilityScheduleInstance", "/v1.0/roleManagement/directory/roleEligibilityScheduleInstances", {}],
        ["AZRoleManagementPolicyAssignment", "/v1.0/policies/roleManagementPolicyAssignments", {
          "$filter": "scopeId eq '/' and scopeType eq 'Directory'",
          "$expand": "policy($expand=rules)"
        }]
      ];
      const collections = {};
      const enabledDefinitions = definitions.filter(([kind]) => selected(
        kind === "AZRoleEligibilityScheduleInstance" || kind === "AZRoleManagementPolicyAssignment" ? "AZRole" : kind
      ));
      for (const [kind] of enabledDefinitions) beginCategory(kind, null, "pending");
      for (const [kind, path, params] of enabledDefinitions) {
        state.categories[kind].status = "running";
        collections[kind] = [];
        let seenItems = 0;
        const accept = (item) => {
          seenItems++;
          if (kind === "AZGroup" || kind === "AZRole") collections[kind].push({ id: item.id });
          if (kind === "AZApp") collections[kind].push({ id: item.id, appId: item.appId });
          if (kind === "AZServicePrincipal") collections[kind].push({ id: item.id, appId: item.appId, hasAppRoles: !!item.appRoles?.length });
          if (kind === "AZRoleEligibilityScheduleInstance") {
            add(kind, { id: upper(item.id), roleDefinitionId: upper(item.roleDefinitionId), principalId: upper(item.principalId), directoryScopeId: upper(item.directoryScopeId), startDateTime: item.startDateTime, tenantId });
          } else if (kind === "AZRoleManagementPolicyAssignment") {
            const formatted = { ...idUpper(item), tenantId };
            for (const rule of item.policy?.rules || []) {
              if (rule["@odata.type"]?.includes("ApprovalRule")) {
                formatted.endUserAssignmentRequiresApproval = !!rule.setting?.isApprovalRequired;
                const approvers = (rule.setting?.approvalStages || []).flatMap((stage) => stage.primaryApprovers || []);
                formatted.endUserAssignmentUserApprovers = approvers.filter((a) => a.userId).map((a) => upper(a.userId));
                formatted.endUserAssignmentGroupApprovers = approvers.filter((a) => a.groupId).map((a) => upper(a.groupId));
              } else if (rule["@odata.type"]?.includes("EnablementRule")) {
                formatted.endUserAssignmentRequiresMFA = rule.enabledRules?.includes("MultiFactorAuthentication") || false;
                formatted.endUserAssignmentRequiresJustification = rule.enabledRules?.includes("Justification") || false;
                formatted.endUserAssignmentRequiresTicketInformation = rule.enabledRules?.includes("Ticketing") || false;
              } else if (rule["@odata.type"]?.includes("AuthenticationContextRule")) {
                formatted.endUserAssignmentRequiresCAPAuthenticationContext = !!rule.isEnabled;
              }
            }
            add(kind, formatted);
          } else add(kind, entity(item));
        };
        let complete = false;
        if (kind === "AZUser") {
          try {
            await scanList("graph", path, params, accept);
            complete = true;
          } catch (e) {
            if (!seenItems) {
              console.info("%cAzureHound retry%c  Users without signInActivity: %s", colors.partial, colors.text, e.message);
              const fallback = { ...params, "$select": params.$select.replace(",signInActivity", "") };
              complete = !!await safe(`${kind} without signInActivity`, async () => {
                await scanList("graph", path, fallback, accept);
                return true;
              });
            } else error(kind, e);
          }
        } else complete = !!await safe(kind, async () => {
          await scanList("graph", path, params, accept);
          return true;
        });
        advanceCategory(kind, !complete);
      }
      const relation = async (parents, kind, path, outer, inner, field, top = 99) => each(parents, kind, async (parent) => {
        const values = await list("graph", path(parent), top ? { "$top": top } : {});
        const parentId = upper(field === "appId" ? parent.appId : parent.id);
        add(kind, { [field]: parentId, [outer]: values.map((value) => ({ [inner]: idUpper(value), [field]: parentId })) });
      });
      if (selected("AZGroup")) {
        await relation(collections.AZGroup, "AZGroupMember", (p) => `/beta/groups/${p.id}/members`, "members", "member", "groupId");
        await relation(collections.AZGroup, "AZGroupOwner", (p) => `/beta/groups/${p.id}/owners`, "owners", "owner", "groupId");
      }
      if (selected("AZApp")) await relation(collections.AZApp, "AZAppOwner", (p) => `/beta/applications/${p.id}/owners`, "owners", "owner", "appId");
      if (selected("AZServicePrincipal")) await relation(collections.AZServicePrincipal, "AZServicePrincipalOwner", (p) => `/beta/servicePrincipals/${p.id}/owners`, "owners", "owner", "servicePrincipalId", 999);
      if (selected("AZApp")) await each(collections.AZApp, "AZFederatedIdentityCredential", async (app) => {
        const values = await list("graph", `/beta/applications/${app.id}/federatedIdentityCredentials`);
        if (values.length) add("AZFederatedIdentityCredential", {
          appId: upper(app.appId),
          tenantId,
          tenantName,
          fics: values.map((value) => ({ appId: upper(app.appId), fic: idUpper(value) }))
        });
      });
      if (selected("AZServicePrincipal")) await each((collections.AZServicePrincipal || []).filter((sp) => sp.hasAppRoles), "AZAppRoleAssignment", async (sp) => {
        const values = await list("graph", `/v1.0/servicePrincipals/${sp.id}/appRoleAssignedTo`);
        for (const value of values) add("AZAppRoleAssignment", { ...idUpper(value), appId: upper(sp.appId), tenantId });
      });
      if (selected("AZRole")) await each(collections.AZRole || [], "AZRoleAssignment", async (role) => {
        const values = await list("graph", "/v1.0/roleManagement/directory/roleAssignments", { "$top": 999, "$filter": `roleDefinitionId eq '${role.id}'`, "$expand": "directoryScope" });
        add("AZRoleAssignment", { roleDefinitionId: upper(role.id), tenantId, roleAssignments: values.map((value) => {
          const copy = idUpper(value);
          if (copy.directoryScopeId && copy.directoryScopeId !== "/" && copy.directoryScope?.appId) copy.directoryScopeId = "/" + upper(copy.directoryScope.appId);
          return copy;
        }) });
      });
      return tenantId;
    }
    async function collectArm(tenantId) {
      if (!tokens.arm) {
        error("ARM", "No Resource Manager token found");
        return;
      }
      const enabledResources = resourceDefinitions.filter(([kind]) => selected(kind));
      const includeManagementGroups = selected("AZManagementGroup");
      const cachedSubscriptions = cachedKinds.has("AZSubscription");
      if (!cachedSubscriptions) beginCategory("AZSubscription");
      const subscriptionItems = cachedSubscriptions ? (state.files.AZSubscription || []).map((entry) => entry.data) : await safe("AZSubscription", () => list("arm", "/subscriptions", { "api-version": "2020-01-01" }));
      const subscriptions = subscriptionItems || [];
      if (!cachedSubscriptions) for (const sub of subscriptions) add("AZSubscription", {
        ...idUpper(sub),
        subscriptionId: upper(sub.subscriptionId),
        displayName: upper(sub.displayName),
        tenantId: upper(sub.tenantId || tenantId)
      });
      if (!cachedSubscriptions) advanceCategory("AZSubscription", !subscriptionItems);
      if (!cachedSubscriptions) beginCategory("AZTenantTrust");
      const trustItems = cachedSubscriptions ? [] : await safe("AZTenant trusts", () => list("arm", "/tenants", { "api-version": "2020-01-01" }));
      const trusts = trustItems || [];
      for (const trust of trusts) if (upper(trust.tenantId) !== upper(tenantId)) add("AZTenant", idUpper(trust));
      if (!cachedSubscriptions) advanceCategory("AZTenantTrust", !trustItems);
      if (includeManagementGroups) beginCategory("AZManagementGroup");
      const managementGroupItems = includeManagementGroups ? await safe("AZManagementGroup", () => list("arm", "/providers/Microsoft.Management/managementGroups", { "api-version": "2020-05-01" })) : [];
      const allManagementGroups = managementGroupItems || [];
      const managementGroups = allManagementGroups.filter((group) => !tenantId || upper(group.properties?.tenantId) === upper(tenantId));
      for (const group of managementGroups) add("AZManagementGroup", {
        ...idUpper(group),
        tenantId: upper(group.properties?.tenantId),
        properties: group.properties && {
          ...group.properties,
          displayName: upper(group.properties.displayName),
          tenantId: upper(group.properties.tenantId)
        }
      });
      if (includeManagementGroups) advanceCategory("AZManagementGroup", !managementGroupItems);
      if (includeManagementGroups) await each(managementGroups, "AZManagementGroupDescendant", async (group) => {
        const descendants = await list("arm", `/providers/Microsoft.Management/managementGroups/${encodeURIComponent(group.name)}/descendants`, { "api-version": "2020-05-01" });
        for (const descendant of descendants) add("AZManagementGroupDescendant", idUpper(descendant));
      });
      const rolesFor = async (kind, resource, field, atScope = false) => {
        if (!resource.id) return;
        const values = await list("arm", `${resource.id}/providers/Microsoft.Authorization/roleAssignments`, {
          "api-version": "2015-07-01",
          ...atScope ? { "$filter": "atScope()" } : {}
        });
        const resourceId = upper(resource.id);
        const normalized = values.map((value) => ({ ...idUpper(value), properties: idUpper(value.properties) }));
        if (derivedRoles[kind]) {
          add(kind, { [field]: resourceId, roleAssignments: normalized.map((roleAssignment) => ({ [field]: resourceId, roleAssignment })) });
        } else {
          add(kind, { objectId: resourceId, assignees: normalized.map((assignee) => ({
            objectId: resourceId,
            assignee,
            roleDefinitionId: assignee.properties?.roleDefinitionId?.split("/").pop()?.toLowerCase() || ""
          })) });
        }
        for (const [derivedKind, singular, plural] of derivedRoles[kind] || []) {
          const entries = normalized.filter((value) => value.properties?.roleDefinitionId?.split("/").pop()?.toLowerCase() === roleIds[singular]);
          add(derivedKind, { [field]: resourceId, [plural]: entries.map((value) => ({ [field]: resourceId, [singular]: value })) });
        }
      };
      if (includeManagementGroups) await each(managementGroups, "AZManagementGroupRoleAssignment", (group) => rolesFor("AZManagementGroupRoleAssignment", {
        ...group,
        id: `/providers/Microsoft.Management/managementGroups/${group.name}`
      }, "managementGroupId", true));
      if (!cachedSubscriptions) await each(subscriptions, "AZSubscriptionRoleAssignment", (sub) => rolesFor("AZSubscriptionRoleAssignment", { ...sub, id: `/subscriptions/${sub.subscriptionId}` }, "subscriptionId", true));
      for (const [kind] of enabledResources) beginCategory(kind, subscriptions.length);
      if (!subscriptions.length) for (const [kind] of enabledResources) {
        state.categories[kind].percent = 100;
        state.categories[kind].status = "skipped";
      }
      await each(subscriptions, "subscription resources", async (sub) => {
        const sid = sub.subscriptionId;
        const endpointCache = /* @__PURE__ */ new Map();
        for (const [kind, path, version, filter] of enabledResources) {
          const errorCount = state.errors.length;
          const endpoint = `${path(sid)}?api-version=${version}`;
          const sharedEndpoint = kind === "AZFunctionApp" || kind === "AZWebApp";
          const items = sharedEndpoint && endpointCache.has(endpoint) ? endpointCache.get(endpoint) : await safe(`${kind} ${sid}`, () => list("arm", path(sid), { "api-version": version }));
          if (sharedEndpoint && !endpointCache.has(endpoint)) endpointCache.set(endpoint, items);
          if (!items) {
            advanceCategory(kind, true);
            continue;
          }
          for (const item of items) {
            if (filter && !filter(item)) continue;
            const rgName = item.id?.match(/\/resourceGroups\/([^/]+)/i)?.[1] || "";
            const rgId = rgName ? upper(`/subscriptions/${sid}/resourceGroups/${rgName}`) : "";
            const normalized = {
              ...idUpper(item),
              subscriptionId: upper(kind === "AZKeyVault" ? sid : `/subscriptions/${sid}`),
              tenantId: upper(kind === "AZKeyVault" ? item.properties?.tenantId || sub.tenantId || tenantId : sub.tenantId || tenantId)
            };
            if (kind !== "AZResourceGroup") normalized.resourceGroupId = rgId;
            if (["AZWebApp", "AZFunctionApp", "AZStorageAccount"].includes(kind)) normalized.resourceGroupName = upper(rgName);
            if (kind === "AZKeyVault") normalized.resourceGroup = rgId;
            if (item.identity) normalized.identity = {
              ...item.identity,
              principalId: upper(item.identity.principalId),
              tenantId: upper(item.identity.tenantId),
              userAssignedIdentities: item.identity.userAssignedIdentities && Object.fromEntries(
                Object.entries(item.identity.userAssignedIdentities).map(([key, value]) => [key, { ...value, principalId: upper(value.principalId) }])
              )
            };
            add(kind, normalized);
            const roleKind = kind === "AZVM" ? "AZVMRoleAssignment" : `${kind}RoleAssignment`;
            const fields = {
              AZVM: "virtualMachineId",
              AZVMScaleSet: "vmScaleSetId",
              AZResourceGroup: "resourceGroupId",
              AZKeyVault: "keyVaultId",
              AZStorageAccount: "storageAccountId",
              AZAutomationAccount: "automationAccountId",
              AZLogicApp: "logicAppId",
              AZFunctionApp: "functionAppId",
              AZWebApp: "webAppId",
              AZContainerRegistry: "containerRegistryId",
              AZManagedCluster: "managedClusterId"
            };
            const field = fields[kind];
            await safe(`${roleKind} ${item.id}`, () => rolesFor(roleKind, item, field));
            if (kind === "AZKeyVault") {
              const policies = item.properties?.accessPolicies || [];
              for (const policy of policies) add("AZKeyVaultAccessPolicy", {
                keyVaultId: upper(item.id),
                ...idUpper(policy),
                objectId: upper(policy.objectId),
                applicationId: upper(policy.applicationId)
              });
            }
            if (kind === "AZStorageAccount") {
              await safe(`AZStorageContainer ${item.id}`, async () => {
                const containers = await list("arm", `${item.id}/blobServices/default/containers`, { "api-version": "2023-01-01" });
                for (const container of containers) add("AZStorageContainer", {
                  ...idUpper(container),
                  storageAccountId: upper(item.id),
                  subscriptionId: upper(`/subscriptions/${sid}`),
                  resourceGroupId: upper(`/subscriptions/${sid}/resourceGroups/${rgName}`),
                  resourceGroupName: upper(rgName),
                  tenantId: upper(sub.tenantId || tenantId)
                });
              });
            }
          }
          advanceCategory(kind, state.errors.length > errorCount);
        }
      });
    }
    state.warnings = () => {
      const warnings = [];
      if (config.graph) {
        for (const kind of ["AZUser", "AZGroup", "AZApp", "AZServicePrincipal", "AZRole", "AZRoleAssignment"]) {
          if (selected(kind === "AZRoleAssignment" ? "AZRole" : kind) && !state.counts[kind]) warnings.push(`No ${kind} records collected`);
        }
      }
      if (state.errors.length) warnings.push(`${state.errors.length} collection errors; inspect errors for missing data`);
      return warnings;
    };
    state.report = () => ({
      collector: "azurehound-browser",
      startedAt: state.startedAt,
      finishedAt: state.finishedAt || (/* @__PURE__ */ new Date()).toISOString(),
      targetTenantId: targetTenant || graphTenant || state.preflight?.tenantId || state.files.AZTenant?.find((entry) => entry.data.collected)?.data.tenantId || null,
      tenantSource: state.preflight?.tenantSource || tenantSource,
      availableTenantIds: state.availableTenantIds || [],
      graphPermissions: audience(tokens.graph || "")?.permissions || [],
      selectedKinds: selectedKinds ? [...selectedKinds] : null,
      initialCounts: { ...state.preflight?.counts || {} },
      countNotes: [...state.preflight?.countNotes || []],
      cancelled: state.abortController.signal.aborted,
      counts: { ...state.counts },
      importable: state.validate().length === 0,
      warnings: state.warnings(),
      progress: state.progress(),
      cache: { ...state.cache },
      exportEstimate: state.exportEstimate || null,
      throttling: { concurrency: config.concurrency, throttleMs: config.throttleMs, requestsPerMinute: config.requestsPerMinute },
      errors: [...state.errors]
    });
    state.validate = () => {
      const issues = [];
      const tenant = state.files.AZTenant?.find((entry) => entry.data.collected && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.data.tenantId));
      if (!tenant) issues.push("No collected tenant with a valid tenant ID");
      const principals = ["AZUser", "AZGroup", "AZApp", "AZServicePrincipal"].some((kind) => state.files[kind]?.some((entry) => typeof entry.data.id === "string" && entry.data.id.length > 0));
      if (!principals) issues.push("No core directory objects with IDs were collected");
      if (state.abortController.signal.aborted) issues.push("Collection was cancelled");
      return issues;
    };
    const hasArmSelection = () => selected("AZManagementGroup") || resourceDefinitions.some(([kind]) => selected(kind));
    const { jsonLimit, boundedEntries, categoryEntries } = createExporter({ state, config, recordKindsFor, graphOptions, armOptions, delay, colors });
    const { cacheMetadata, categoryRecordCount, reuseCache, saveCache } = createCache({ state, config, graphOptions, armOptions, recordKindsFor, jsonLimit, boundedEntries, categoryEntries, nonnegative, chosen, cachedKinds, add, logCategory });
    const runPreflight = createPreflight({ state, config, request, targetTenant, graphTenant, tenantSource, tokens, audience, isTenantId, armTenant, tokenMismatch, cacheMetadata });
    const showPreflight = createPopup({ state, config, graphOptions, armOptions, chosen, elapsed, recordKindsFor, categoryRecordCount, error });
    let progressTimer = null;
    try {
      let reuse = config.useCache !== false;
      if (config.interactive) {
        const preflight = await runPreflight();
        const choice = await showPreflight(preflight);
        if (!choice) return state;
        selectedKinds = new Set(choice.kinds);
        state.selectedKinds = choice.kinds;
        reuse = choice.reuse;
        Object.assign(config, choice.limits);
        requestSpacingMs = Math.max(
          nonnegative(config.throttleMs),
          nonnegative(config.requestsPerMinute) ? 6e4 / nonnegative(config.requestsPerMinute) : 0
        );
        nextRequestAt = 0;
        try {
          localStorage.setItem(`azurehound:last-selection:${preflight.tenantId.toLowerCase()}`, JSON.stringify(choice.kinds));
        } catch {
        }
      }
      if (!config.graphToken && !targetTenant && (state.availableTenantIds?.length || 0) > 1) {
        throw new Error(`Multiple Graph token tenants are cached (${state.availableTenantIds.join(", ")}). Set window.AzureHoundConfig.tenantId to the tenant to collect.`);
      }
      if (targetTenant && graphTenant && targetTenant.toLowerCase() !== graphTenant.toLowerCase()) {
        throw new Error(`Graph token tenant ${graphTenant} does not match selected tenant ${targetTenant}`);
      }
      if (config.arm && hasArmSelection() && targetTenant && armTenant && targetTenant.toLowerCase() !== armTenant.toLowerCase()) {
        throw new Error(`Resource Manager token tenant ${armTenant} does not match selected tenant ${targetTenant}`);
      }
      if (config.arm && hasArmSelection() && tokenMismatch) throw new Error(`Graph and Azure Resource Manager tokens belong to different tenants (${graphTenant} and ${armTenant})`);
      if (!config.graph && !config.arm) throw new Error("Both Graph and ARM collection are disabled");
      if (config.graph && !tokens.graph && config.arm === false) throw new Error("No Graph token available");
      if (config.arm && !tokens.arm && config.graph === false) throw new Error("No ARM token available");
      const cacheTenant = targetTenant || graphTenant || state.preflight?.tenantId;
      if (previousCacheReady) await previousCacheReady;
      if (cacheTenant && reuse) {
        try {
          await reuseCache(cacheTenant, state.preflight?.cacheMetadata || await cacheMetadata(cacheTenant), true);
        } catch (e) {
          state.cache.errors.push(e.message);
        }
      }
      progressTimer = setInterval(logProgress, Math.max(1e3, nonnegative(config.progressIntervalMs) || 1e4));
      logProgress();
      let tenantId = config.tenantId || "";
      if (config.graph) tenantId = await collectGraph() || tenantId;
      if (config.arm && hasArmSelection()) await collectArm(tenantId);
      if (!state.abortController.signal.aborted && config.useCache !== false) state.cacheReady = saveCache(tenantId);
      if (config.interactive && state.cacheReady) await state.cacheReady;
      state.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      const issues = state.validate();
      if (issues.length) {
        for (const issue of issues) error("Collection validation", issue);
        console.error("%cAzureHound blocked%c  No importable ZIP was downloaded. Inspect window.AzureHound.report().", colors.blocked, colors.text);
      } else if (config.download && !config.interactive) await state.download();
      if (!issues.length && state.warnings().length) console.warn("%cAzureHound partial%c  Check window.AzureHound.report() before importing.", colors.partial, colors.text);
      return state;
    } finally {
      state.running = false;
      if (progressTimer) clearInterval(progressTimer);
      logProgress(true);
      state.popup?.finish?.();
    }
  })();
  window.AzureHound.completion = completion;
})();

window.AzureHound.completion;
