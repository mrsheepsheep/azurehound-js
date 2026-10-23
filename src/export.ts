import { zip } from './zip';

export function createExporter(ctx: any) {
  const { state, config, recordKindsFor, graphOptions, armOptions, delay, colors } = ctx;
  const encoder = new TextEncoder();
  const jsonPrefix = '{"data":[';
  const jsonSuffix = count => `],"meta":{"type":"azure","version":5,"count":${count}}}`;
  const jsonLimit = () => Math.min(0xFFFFFFFF - 4096, Math.floor(Number(config.maxJsonBytes)));
  const zipLimit = () => Math.min(0xFFFFFFFF - 4096, Math.floor(Number(config.maxZipBytes)));
  const tenantRecord = () => state.files.AZTenant?.find(entry => entry.data.collected);
  function* allEntries() {
    for (const records of Object.values(state.files) as any[][]) for (const entry of records) {
      if (entry.kind !== 'AZTenant' || !entry.data.collected) yield entry;
    }
  }
  function* categoryEntries(category) {
    for (const kind of recordKindsFor(category)) for (const entry of state.files[kind] || []) {
      if (kind !== 'AZTenant' || !entry.data.collected) yield entry;
    }
  }
  const relationArrays = new Set(['members', 'owners', 'fics', 'roleAssignments', 'assignees',
    'contributors', 'admins', 'userAccessAdmins', 'kvContributors', 'avereContributors', 'adminLogins', 'vmContributors']);
  function* boundedEntries(entry, maxBytes) {
    const arrayKey = Object.keys(entry.data || {}).find(key => relationArrays.has(key) && Array.isArray(entry.data[key]) && entry.data[key].length > 1);
    if (arrayKey && entry.data[arrayKey].length > 128) {
      const values = entry.data[arrayKey];
      for (let index = 0; index < values.length; index += 128) {
        yield* boundedEntries({ kind: entry.kind, data: { ...entry.data, [arrayKey]: values.slice(index, index + 128) } }, maxBytes);
      }
      return;
    }
    const bytes = encoder.encode(JSON.stringify(entry)).length;
    if (bytes <= maxBytes) { yield { entry, bytes }; return; }
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
    if (!tenant) throw new Error('No collected tenant is available for JSON export');
    const limit = jsonLimit(), tenantBytes = encoder.encode(JSON.stringify(tenant)).length;
    if (!Number.isSafeInteger(limit) || limit < tenantBytes + 128) throw new Error('maxJsonBytes is too small for the tenant envelope');
    const prefixBytes = encoder.encode(jsonPrefix).length;
    const sizeOf = (recordBytes, count) => prefixBytes + recordBytes + count - 1 + encoder.encode(jsonSuffix(count)).length;
    const maxRecordBytes = limit - sizeOf(tenantBytes, 1) - 2;
    const parts = [];
    let records = [], recordBytes = tenantBytes, count = 1;
    const flush = () => {
      parts.push({ records, count, bytes: sizeOf(recordBytes, count) });
      records = []; recordBytes = tenantBytes; count = 1;
    };
    let processed = 0;
    for (const entry of entries) {
      for (const piece of boundedEntries(entry, maxRecordBytes)) {
        if (sizeOf(recordBytes + piece.bytes, count + 1) > limit) flush();
        records.push(piece.entry); recordBytes += piece.bytes; count++;
      }
      if (++processed % 1000 === 0) await delay(0);
    }
    if (records.length || !parts.length) flush();
    for (let i = 0; i < parts.length; i++) parts[i].name = parts.length === 1 ? `${baseName}.json`
      : `${baseName}-part-${String(i + 1).padStart(3, '0')}.json`;
    return parts;
  }
  function jsonPartContent(part) {
    const pieces = [jsonPrefix, JSON.stringify(tenantRecord())];
    for (const entry of part.records) pieces.push(',', JSON.stringify(entry));
    pieces.push(jsonSuffix(part.count));
    return pieces.join('');
  }
  function jsonBlob(part) {
    const blob = new Blob([jsonPartContent(part)], { type: 'application/json' });
    if (blob.size !== part.bytes) throw new Error(`JSON size changed while exporting ${part.name}`);
    return blob;
  }
  let exportPlanPromise;
  async function exportPlan() {
    if (!exportPlanPromise) exportPlanPromise = (async () => {
      const issues = state.validate();
      if (issues.length) throw new Error(`Cannot build a BloodHound collection: ${issues.join('; ')}. Inspect window.AzureHound.errors.`);
      const jsonParts = await planJson(allEntries(), 'azurehound');
      const maxZip = zipLimit();
      if (!Number.isSafeInteger(maxZip) || maxZip <= 0) throw new Error('maxZipBytes must be a positive integer');
      const zipParts = [];
      let group = [], estimated = 22;
      for (const part of jsonParts) {
        const entryBytes = part.bytes + 264 + Math.ceil(part.bytes / 16384) * 5 + encoder.encode(part.name).length * 2;
        if (entryBytes + 22 > maxZip) throw new Error('maxZipBytes is too small for one JSON part; raise maxZipBytes or lower maxJsonBytes');
        if (group.length && (estimated + entryBytes > maxZip || group.length >= 65535)) {
          zipParts.push({ files: group, estimatedBytes: estimated }); group = []; estimated = 22;
        }
        group.push(part); estimated += entryBytes;
      }
      if (group.length) zipParts.push({ files: group, estimatedBytes: estimated });
      const summary = { jsonFiles: jsonParts.length, jsonBytes: jsonParts.reduce((sum, part) => sum + part.bytes, 0),
        zipFiles: zipParts.length, estimatedZipBytes: zipParts.reduce((sum, part) => sum + part.estimatedBytes, 0) };
      state.exportEstimate = summary;
      return { jsonParts, zipParts, summary };
    })();
    return exportPlanPromise;
  }
  state.estimateExport = async () => (await exportPlan()).summary;
  state.makeZipPart = async index => {
    const plan = await exportPlan(), group = plan.zipParts[index];
    if (!group) throw new Error(`Unknown ZIP part ${index + 1}`);
    const blob = await zip(group.files.map(part => [part.name, part]), jsonPartContent, colors);
    if (blob.size > zipLimit()) throw new Error(`ZIP part ${index + 1} exceeds maxZipBytes after compression`);
    return blob;
  };
  state.makeZip = async () => {
    const plan = await exportPlan();
    if (plan.zipParts.length !== 1) throw new Error(`Collection requires ${plan.zipParts.length} ZIP files; use makeZipPart(index) or download()`);
    return state.makeZipPart(0);
  };
  const categoryPlans = new Map();
  const categoryPlan = category => {
    if (![...graphOptions.map(([kind]) => kind), ...armOptions.map(([kind]) => kind), 'AZSubscription'].includes(category)) {
      throw new Error(`Unknown collection category: ${category}`);
    }
    if (!categoryPlans.has(category)) categoryPlans.set(category, planJson(categoryEntries(category), `azurehound-${category.toLowerCase()}`));
    return categoryPlans.get(category);
  };
  state.listJsonParts = async category => (await categoryPlan(category)).map((part, index) => ({ index, name: part.name, bytes: part.bytes, count: part.count }));
  state.makeJsonPart = async (category, index) => {
    const part = (await categoryPlan(category))[index];
    if (!part) throw new Error(`Unknown ${category} JSON part ${index + 1}`);
    return jsonBlob(part);
  };
  state.makeJson = async category => {
    const parts = await categoryPlan(category);
    if (parts.length !== 1) throw new Error(`${category} requires ${parts.length} JSON files; use makeJsonPart(category, index)`);
    return jsonBlob(parts[0]);
  };
  const triggerDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename;
    (document.body || document.documentElement).append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return blob;
  };
  state.downloadJsonPart = async (category, index) => {
    const parts = await categoryPlan(category), part = parts[index];
    if (!part) throw new Error(`Unknown ${category} JSON part ${index + 1}`);
    return triggerDownload(jsonBlob(part), part.name);
  };
  state.downloadJson = async category => {
    const parts = await categoryPlan(category);
    for (let i = 0; i < parts.length; i++) {
      await state.downloadJsonPart(category, i);
      if (i < parts.length - 1) await delay(5500);
    }
    return parts.length;
  };
  state.downloadZipPart = async index => {
    const plan = await exportPlan(), suffix = plan.zipParts.length === 1 ? '' : `-part-${String(index + 1).padStart(3, '0')}`;
    return triggerDownload(await state.makeZipPart(index), `azurehound-${state.startedAt.replace(/[:.]/g, '-')}${suffix}.zip`);
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
