/* AzureHound browser collector source. GPL-3.0-or-later; see ../AzureHound/LICENSE.md.
 * Build the browser-ready collector.js with npm run build.
 */
import { resourceDefinitions, roleIds, derivedRoles, graphOptions, armOptions, recordKindsFor } from './constants';
import { createExporter } from './export';
import { createCache } from './cache';
import { createPreflight } from './preflight';
import { createPopup } from './popup';
import { listMsalAccessTokens } from './tokens';

declare global { interface Window { AzureHound: any; AzureHoundConfig: any; } }

const completion = (async function azureHoundBrowserCollector() {
  'use strict';
  if (window.AzureHound && window.AzureHound.running) throw new Error('AzureHound collection is already running');
  const previousCacheReady = window.AzureHound?.cacheReady;
  const config = Object.assign({ concurrency: 4, retries: 4, pageTimeoutMs: 120000, preflightTimeoutMs: 15000,
    throttleMs: 0, requestsPerMinute: 0, progressIntervalMs: 10000,
    graph: true, arm: true, download: true, interactive: true,
    useCache: true, cacheMaxAgeMs: 86400000,
    maxJsonBytes: 16 * 1024 * 1024, maxZipBytes: 128 * 1024 * 1024 }, window.AzureHoundConfig || {});
  const state: any = { running: true, startedAt: new Date().toISOString(), errors: [], counts: {}, abortController: new AbortController(), files: {} };
  window.AzureHound = state;
  state.cancel = () => state.abortController.abort();
  let selectedKinds = Array.isArray(config.categories) ? new Set(config.categories) : null;
  const cachedKinds = new Set();
  const chosen = kind => !selectedKinds || selectedKinds.has(kind);
  const selected = kind => chosen(kind) && !cachedKinds.has(kind);
  state.cache = { reused: [], saved: [], errors: [] };
  state.requests = { started: 0, completed: 0, failed: 0, retried: 0, throttled: 0, active: 0, lastEndpoint: null };
  state.categories = {};
  const beginCategory = (kind, total = null, status = 'running') => {
    state.categories[kind] = { completed: 0, total, failed: 0, percent: 0, status };
  };
  const advanceCategory = (kind, failed = false) => {
    const category = state.categories[kind];
    if (!category) return;
    category.completed++;
    if (failed) category.failed++;
    if (category.total === null) category.total = category.completed;
    category.percent = category.total ? Math.min(100, Math.round(100 * category.completed / category.total)) : 100;
    category.status = category.completed >= category.total ? (category.failed ? 'partial' : 'complete') : 'running';
    if (category.status !== 'running') logCategory(kind);
  };
  const nonnegative = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  let requestSpacingMs = Math.max(nonnegative(config.throttleMs),
    nonnegative(config.requestsPerMinute) ? 60000 / nonnegative(config.requestsPerMinute) : 0);
  let nextRequestAt = 0;
  async function waitForRequestSlot() {
    if (!requestSpacingMs) return;
    const now = performance.now();
    const slot = Math.max(now, nextRequestAt);
    nextRequestAt = slot + requestSpacingMs;
    if (slot > now) {
      state.requests.throttled++;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer); reject(new Error('Collection cancelled'));
        };
        const timer = setTimeout(() => {
          state.abortController.signal.removeEventListener('abort', onAbort);
          resolve();
        }, slot - now);
        state.abortController.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (state.abortController.signal.aborted) throw new Error('Collection cancelled');
  }
  state.progress = () => ({
    elapsedSeconds: Math.round((Date.now() - Date.parse(state.startedAt)) / 1000),
    requests: { ...state.requests }, records: (Object.values(state.counts) as number[]).reduce((sum, count) => sum + count, 0),
    errors: state.errors.length, counts: { ...state.counts },
    percentages: Object.fromEntries((Object.entries(state.categories) as [string, any][]).map(([kind, category]) => [kind, category.percent])),
    categories: Object.fromEntries((Object.entries(state.categories) as [string, any][]).map(([kind, category]) =>
      [kind, { ...category, records: state.counts[kind] || 0 }]))
  });
  const colors = {
    brand: 'color:#a78bfa;font-weight:bold', running: 'color:#60a5fa;font-weight:bold',
    complete: 'color:#4ade80;font-weight:bold', partial: 'color:#fbbf24;font-weight:bold',
    skipped: 'color:#94a3b8;font-weight:bold', cached: 'color:#86efac;font-weight:bold', blocked: 'color:#f87171;font-weight:bold',
    text: 'color:#cbd5e1', muted: 'color:#94a3b8'
  };
  const loggedCategories = new Map();
  const elapsed = seconds => `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  function logCategory(kind, force = false) {
    const category = state.categories[kind];
    if (!category || category.status === 'pending') return;
    const signature = `${category.percent}:${category.status}:${category.completed}:${category.failed}`;
    if (!force && loggedCategories.get(kind) === signature) return;
    loggedCategories.set(kind, signature);
    const color = colors[category.status] || colors.running;
    const bars = Math.round(category.percent / 10);
    const bar = '█'.repeat(bars) + '░'.repeat(10 - bars);
    const units = category.total === null ? 'pages ongoing' : `${category.completed}/${category.total} units`;
    const records = state.counts[kind] || 0;
    console.info(`%c${bar} ${String(category.percent).padStart(3)}% %c${kind}%c  ${units} · ${records.toLocaleString()} records · ${category.status}`,
      color, 'font-weight:bold;color:#e2e8f0', colors.muted);
    state.popup?.update?.();
  }
  function logProgress(forceCategories = false) {
    const progress = state.progress();
    const status = state.running ? 'RUNNING' : state.abortController.signal.aborted ? 'CANCELLED' : state.validate().length ? 'BLOCKED' : state.warnings().length ? 'PARTIAL' : 'DONE';
    const statusColor = status === 'DONE' ? colors.complete : status === 'CANCELLED' ? colors.skipped : colors[status.toLowerCase()] || colors.running;
    console.info(`%cAzureHound%c ${status}%c  ${elapsed(progress.elapsedSeconds)} · ${progress.records.toLocaleString()} records · ${progress.requests.completed} requests · ${progress.requests.active} active · ${progress.errors} errors`,
      colors.brand, statusColor, colors.text);
    for (const kind of Object.keys(state.categories)) logCategory(kind, forceCategories);
    state.popup?.update?.();
  }
  const upper = value => typeof value === 'string' ? value.toUpperCase() : value;
  const idUpper = object => {
    if (!object || typeof object !== 'object') return object;
    const copy = { ...object };
    for (const key of ['id', 'appId', 'tenantId', 'onPremisesSecurityIdentifier', 'principalId', 'roleDefinitionId', 'scope', 'resourceId']) {
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
    console.warn('%cAzureHound warning%c  %s: %s', colors.partial, colors.text, area, message);
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const audience = token => {
    try {
      const body = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return {
        aud: String(body.aud || '').toLowerCase(), exp: Number(body.exp || 0), tid: body.tid,
        permissions: [...String(body.scp || '').split(' '), ...(Array.isArray(body.roles) ? body.roles : [])].filter(Boolean)
      };
    } catch { return null; }
  };
  function cachedToken(resource, tenantId) {
    const audiences = resource === 'graph'
      ? ['graph.microsoft.com', '00000003-0000-0000-c000-000000000000']
      : ['management.azure.com', 'management.core.windows.net'];
    const now = Date.now() / 1000 + 120;
    const candidates = [];
    for (const storage of [sessionStorage, localStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key || !/(accesstoken|access_token|msal|adal|token)/i.test(key)) continue;
        let raw;
        try { raw = storage.getItem(key); } catch { continue; }
        const tokenCandidates = [];
        if (raw && raw.split('.').length === 3) tokenCandidates.push(raw);
        try {
          const entry = JSON.parse(raw);
          for (const value of [entry.accessToken, entry.secret, entry.token, entry.credential]) {
            if (typeof value === 'string') tokenCandidates.push(value);
          }
        } catch { /* non-JSON cache entry */ }
        for (const token of tokenCandidates) {
          const claims = audience(token);
          if (claims && claims.exp > now && audiences.some(aud => claims.aud.includes(aud))) {
            const scopes = claims.permissions.map(permission => permission.toLowerCase());
            const score = scopes.length +
              (scopes.includes('directory.read.all') ? 10 : 0) +
              (scopes.includes('rolemanagement.read.directory') ? 10 : 0) +
              (scopes.includes('rolemanagement.read.all') ? 10 : 0) +
              (scopes.includes('application.read.all') ? 3 : 0);
            candidates.push({ token, tid: claims.tid, exp: claims.exp, score });
          }
        }
      }
    }
    const tenantIds = [...new Set(candidates.map(candidate => candidate.tid?.toLowerCase()).filter(Boolean))];
    if (resource === 'graph') state.availableTenantIds = tenantIds;
    if (!tenantId && tenantIds.length > 1) return null;
    return candidates
      .filter(candidate => !tenantId || candidate.tid?.toLowerCase() === tenantId.toLowerCase())
      .sort((a, b) => b.score - a.score || b.exp - a.exp)[0]?.token || null;
  }
  const isTenantId = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  const portalTenant = (() => {
    const candidates = [new URLSearchParams(location.search), new URLSearchParams(location.hash.split('?')[1] || '')];
    for (const params of candidates) {
      const value = params.get('tenantId') || params.get('tenant');
      if (isTenantId(value)) return value;
    }
    const pathTenant = location.pathname.match(/^\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i)?.[1];
    if (isTenantId(pathTenant)) return pathTenant;
    return null;
  })();
  // MSAL stores the active account separately from cached accounts and tokens.
  // An account's realm is the signed-in directory, including for guest accounts.
  const activeAccountTenant = (() => {
    const entries = [];
    for (const storage of [sessionStorage, localStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key || !/msal\..*active.account(?:.filters)?$/i.test(key)) continue;
        try {
          const filters = JSON.parse(storage.getItem(key));
          if (!filters || typeof filters !== 'object') continue;
          if (isTenantId(filters.tenantId)) { entries.push(filters.tenantId); continue; }
          for (let j = 0; j < storage.length; j++) {
            const accountKey = storage.key(j);
            if (!accountKey || accountKey === key) continue;
            let account;
            try { account = JSON.parse(storage.getItem(accountKey)); } catch { continue; }
            if (!account || !isTenantId(account.realm)) continue;
            if ((filters.localAccountId && account.localAccountId === filters.localAccountId) ||
                (filters.homeAccountId && account.homeAccountId === filters.homeAccountId) ||
                (filters.username && account.username === filters.username)) entries.push(account.realm);
          }
        } catch { /* malformed account cache entry */ }
      }
    }
    const unique = [...new Set(entries.map(value => value.toLowerCase()))];
    return unique.length === 1 ? unique[0] : null;
  })();
  const targetTenant = config.tenantId || portalTenant || activeAccountTenant;
  const tenantSource = config.tenantId ? 'config' : portalTenant ? 'portal URL' : activeAccountTenant ? 'active MSAL account' : 'Graph token';
  const graphToken = config.graphToken || cachedToken('graph', targetTenant);
  const tokenTenant = targetTenant || audience(graphToken || '')?.tid;
  const tokens = {
    graph: graphToken,
    arm: config.armToken || cachedToken('arm', tokenTenant)
  };
  const graphTenant = audience(tokens.graph || '')?.tid;
  const armTenant = audience(tokens.arm || '')?.tid;
  const tokenMismatch = graphTenant && armTenant && graphTenant.toLowerCase() !== armTenant.toLowerCase();
  function urlFor(service, path, params = {}) {
    const root = service === 'graph' ? 'https://graph.microsoft.com' : 'https://management.azure.com';
    const url = new URL(path, root);
    if (url.origin !== root) throw new Error(`Unexpected ${service} pagination origin: ${url.origin}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    return url;
  }
  async function request(service, path, params = {}, options: any = {}) {
    const token = tokens[service];
    if (!token) throw new Error(`No ${service} access token. Set window.AzureHoundConfig.${service === 'graph' ? 'graphToken' : 'armToken'} to a token for the respective API and evaluate again.`);
    const url = urlFor(service, path, params);
    const retries = options.retries ?? config.retries;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (state.abortController.signal.aborted) throw new Error('Collection cancelled');
      await waitForRequestSlot();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? config.pageTimeoutMs);
      const cancel = () => controller.abort();
      state.abortController.signal.addEventListener('abort', cancel, { once: true });
      state.requests.started++;
      state.requests.active++;
      state.requests.lastEndpoint = `${service.toUpperCase()} ${url.pathname}`;
      try {
        const response = await fetch(url, {
          method: options.method || 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
          credentials: 'omit'
        });
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          state.requests.retried++;
          const retryAfter = Number(response.headers.get('Retry-After'));
          await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 1000 * 2 ** attempt));
          continue;
        }
        if (!response.ok) {
          let detail = '';
          try { const body = await response.json(); detail = body.error?.message || body.error?.code || ''; } catch { /* no JSON body */ }
          throw new Error(`${response.status} ${url.pathname}: ${detail}`);
        }
        return await response.json();
      } catch (e) {
        state.requests.failed++;
        if (e.name === 'TypeError') throw new Error(`Browser request failed for ${url.origin}. Check portal CORS policy and token audience: ${e.message}`);
        throw e;
      } finally {
        state.requests.active--;
        state.requests.completed++;
        if (state.requests.completed % 25 === 0) logProgress();
        clearTimeout(timer);
        state.abortController.signal.removeEventListener('abort', cancel);
      }
    }
  }
  async function list(service, path, params = {}) {
    const items = [];
    let next = path;
    let query = params;
    const seen = new Set();
    while (next) {
      const url = urlFor(service, next, query);
      if (seen.has(url.href)) throw new Error(`Pagination loop: ${url.href}`);
      seen.add(url.href);
      const result = await request(service, next, query);
      if (!Array.isArray(result.value)) throw new Error(`Missing value array: ${url.pathname}`);
      items.push(...result.value);
      next = result['@odata.nextLink'] || result.nextLink || null;
      query = {};
    }
    return items;
  }
  async function scanList(service, path, params, onItem) {
    let next = path, query = params;
    const seen = new Set();
    while (next) {
      const url = urlFor(service, next, query);
      if (seen.has(url.href)) throw new Error(`Pagination loop: ${url.href}`);
      seen.add(url.href);
      const result = await request(service, next, query);
      if (!Array.isArray(result.value)) throw new Error(`Missing value array: ${url.pathname}`);
      for (const item of result.value) onItem(item);
      next = result['@odata.nextLink'] || result.nextLink || null;
      query = {};
    }
  }
  async function safe(area, work) { try { return await work(); } catch (e) { error(area, e); return null; } }
  async function each(items, area, work) {
    beginCategory(area, items.length);
    if (!items.length) { state.categories[area].percent = 100; state.categories[area].status = 'skipped'; logCategory(area); return; }
    const concurrency = Math.max(1, Math.min(16, Number(config.concurrency) || 4));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length && !state.abortController.signal.aborted) {
        const item = items[cursor++];
        const errorCount = state.errors.length;
        await safe(`${area} ${item.id || item.name || item.appId || ''}`, () => work(item));
        advanceCategory(area, state.errors.length > errorCount);
      }
    }));
  }
  async function collectGraph() {
    if (!tokens.graph) { error('Graph', 'No Graph token found'); return; }
    beginCategory('AZTenant');
    const org = state.preflight?.organization || await safe('organization', () => request('graph', '/v1.0/organization'));
    const tenant = org?.value?.[0];
    if (tenant?.id && graphTenant && tenant.id.toLowerCase() !== graphTenant.toLowerCase()) {
      throw new Error(`Graph organization tenant ${tenant.id} does not match Graph token tenant ${graphTenant}`);
    }
    if (tenant?.id && targetTenant && tenant.id.toLowerCase() !== targetTenant.toLowerCase()) {
      throw new Error(`Graph organization tenant ${tenant.id} does not match selected tenant ${targetTenant}`);
    }
    const tenantId = upper(tenant?.id || targetTenant || graphTenant || '');
    const tenantName = upper(tenant?.displayName || '');
    if (tenant?.id) {
      const domains = (tenant?.verifiedDomains || []).map(domain => domain.name);
      add('AZTenant', {
        id: upper(`/tenants/${tenantId}`), tenantId, displayName: tenantName,
        country: tenant?.country, countryCode: tenant?.countryLetterCode,
        defaultDomain: tenant?.verifiedDomains?.find(domain => domain.isDefault)?.name || '',
        domains, tenantType: tenant?.tenantType, collected: true
      });
    }
    advanceCategory('AZTenant', !tenant?.id);
    const entity = item => ({
      ...idUpper(item), displayName: upper(item.displayName), deviceId: upper(item.deviceId),
      appOwnerOrganizationId: upper(item.appOwnerOrganizationId), tenantId, tenantName
    });
    const definitions: any[] = [
      ['AZUser', '/v1.0/users', { '$top': 999, '$select': 'id,accountEnabled,createdDateTime,displayName,jobTitle,lastPasswordChangeDateTime,mail,onPremisesSecurityIdentifier,onPremisesSyncEnabled,userPrincipalName,userType,signInActivity' }],
      ['AZGroup', '/v1.0/groups', { '$top': 99, '$filter': 'securityEnabled eq true' }],
      ['AZApp', '/v1.0/applications', { '$top': 99 }],
      ['AZServicePrincipal', '/v1.0/servicePrincipals', { '$top': 999 }],
      ['AZDevice', '/v1.0/devices', { '$top': 999 }],
      ['AZRole', '/v1.0/roleManagement/directory/roleDefinitions', {}],
      ['AZRoleEligibilityScheduleInstance', '/v1.0/roleManagement/directory/roleEligibilityScheduleInstances', {}],
      ['AZRoleManagementPolicyAssignment', '/v1.0/policies/roleManagementPolicyAssignments', {
        '$filter': "scopeId eq '/' and scopeType eq 'Directory'", '$expand': 'policy($expand=rules)'
      }]
    ];
    const collections: Record<string, any[]> = {};
    const enabledDefinitions = definitions.filter(([kind]) => selected(
      kind === 'AZRoleEligibilityScheduleInstance' || kind === 'AZRoleManagementPolicyAssignment' ? 'AZRole' : kind));
    for (const [kind] of enabledDefinitions) beginCategory(kind, null, 'pending');
    for (const [kind, path, params] of enabledDefinitions) {
      state.categories[kind].status = 'running';
      collections[kind] = [];
      let seenItems = 0;
      const accept = item => {
        seenItems++;
        if (kind === 'AZGroup' || kind === 'AZRole') collections[kind].push({ id: item.id });
        if (kind === 'AZApp') collections[kind].push({ id: item.id, appId: item.appId });
        if (kind === 'AZServicePrincipal') collections[kind].push({ id: item.id, appId: item.appId, hasAppRoles: !!item.appRoles?.length });
        if (kind === 'AZRoleEligibilityScheduleInstance') {
          add(kind, { id: upper(item.id), roleDefinitionId: upper(item.roleDefinitionId), principalId: upper(item.principalId), directoryScopeId: upper(item.directoryScopeId), startDateTime: item.startDateTime, tenantId });
        } else if (kind === 'AZRoleManagementPolicyAssignment') {
          const formatted = { ...idUpper(item), tenantId };
          for (const rule of item.policy?.rules || []) {
            if (rule['@odata.type']?.includes('ApprovalRule')) {
              formatted.endUserAssignmentRequiresApproval = !!rule.setting?.isApprovalRequired;
              const approvers = (rule.setting?.approvalStages || []).flatMap(stage => stage.primaryApprovers || []);
              formatted.endUserAssignmentUserApprovers = approvers.filter(a => a.userId).map(a => upper(a.userId));
              formatted.endUserAssignmentGroupApprovers = approvers.filter(a => a.groupId).map(a => upper(a.groupId));
            } else if (rule['@odata.type']?.includes('EnablementRule')) {
              formatted.endUserAssignmentRequiresMFA = rule.enabledRules?.includes('MultiFactorAuthentication') || false;
              formatted.endUserAssignmentRequiresJustification = rule.enabledRules?.includes('Justification') || false;
              formatted.endUserAssignmentRequiresTicketInformation = rule.enabledRules?.includes('Ticketing') || false;
            } else if (rule['@odata.type']?.includes('AuthenticationContextRule')) {
              formatted.endUserAssignmentRequiresCAPAuthenticationContext = !!rule.isEnabled;
            }
          }
          add(kind, formatted);
        } else add(kind, entity(item));
      };
      let complete = false;
      if (kind === 'AZUser') {
        try { await scanList('graph', path, params, accept); complete = true; }
        catch (e) {
          if (!seenItems) {
            console.info('%cAzureHound retry%c  Users without signInActivity: %s', colors.partial, colors.text, e.message);
            const fallback = { ...params, '$select': params.$select.replace(',signInActivity', '') };
            complete = !!await safe(`${kind} without signInActivity`, async () => { await scanList('graph', path, fallback, accept); return true; });
          } else error(kind, e);
        }
      } else complete = !!await safe(kind, async () => { await scanList('graph', path, params, accept); return true; });
      advanceCategory(kind, !complete);
    }
    const relation = async (parents, kind, path, outer, inner, field, top = 99) => each(parents, kind, async parent => {
      const values = await list('graph', path(parent), top ? { '$top': top } : {});
      const parentId = upper(field === 'appId' ? parent.appId : parent.id);
      add(kind, { [field]: parentId, [outer]: values.map(value => ({ [inner]: idUpper(value), [field]: parentId })) });
    });
    if (selected('AZGroup')) {
      await relation(collections.AZGroup, 'AZGroupMember', p => `/beta/groups/${p.id}/members`, 'members', 'member', 'groupId');
      await relation(collections.AZGroup, 'AZGroupOwner', p => `/beta/groups/${p.id}/owners`, 'owners', 'owner', 'groupId');
    }
    if (selected('AZApp')) await relation(collections.AZApp, 'AZAppOwner', p => `/beta/applications/${p.id}/owners`, 'owners', 'owner', 'appId');
    if (selected('AZServicePrincipal')) await relation(collections.AZServicePrincipal, 'AZServicePrincipalOwner', p => `/beta/servicePrincipals/${p.id}/owners`, 'owners', 'owner', 'servicePrincipalId', 999);
    if (selected('AZApp')) await each(collections.AZApp, 'AZFederatedIdentityCredential', async app => {
      const values = await list('graph', `/beta/applications/${app.id}/federatedIdentityCredentials`);
      if (values.length) add('AZFederatedIdentityCredential', {
        appId: upper(app.appId), tenantId, tenantName,
        fics: values.map(value => ({ appId: upper(app.appId), fic: idUpper(value) }))
      });
    });
    if (selected('AZServicePrincipal')) await each((collections.AZServicePrincipal || []).filter(sp => sp.hasAppRoles), 'AZAppRoleAssignment', async sp => {
      const values = await list('graph', `/v1.0/servicePrincipals/${sp.id}/appRoleAssignedTo`);
      for (const value of values) add('AZAppRoleAssignment', { ...idUpper(value), appId: upper(sp.appId), tenantId });
    });
    if (selected('AZRole')) await each(collections.AZRole || [], 'AZRoleAssignment', async role => {
      const values = await list('graph', '/v1.0/roleManagement/directory/roleAssignments', { '$top': 999, '$filter': `roleDefinitionId eq '${role.id}'`, '$expand': 'directoryScope' });
      add('AZRoleAssignment', { roleDefinitionId: upper(role.id), tenantId, roleAssignments: values.map(value => {
        const copy = idUpper(value);
        if (copy.directoryScopeId && copy.directoryScopeId !== '/' && copy.directoryScope?.appId) copy.directoryScopeId = '/' + upper(copy.directoryScope.appId);
        return copy;
      }) });
    });
    return tenantId;
  }
  async function collectArm(tenantId) {
    if (!tokens.arm) { error('ARM', 'No Resource Manager token found'); return; }
    const enabledResources = resourceDefinitions.filter(([kind]) => selected(kind));
    const includeManagementGroups = selected('AZManagementGroup');
    const cachedSubscriptions = cachedKinds.has('AZSubscription');
    if (!cachedSubscriptions) beginCategory('AZSubscription');
    const subscriptionItems = cachedSubscriptions ? (state.files.AZSubscription || []).map(entry => entry.data)
      : await safe('AZSubscription', () => list('arm', '/subscriptions', { 'api-version': '2020-01-01' }));
    const subscriptions = subscriptionItems || [];
    if (!cachedSubscriptions) for (const sub of subscriptions) add('AZSubscription', {
      ...idUpper(sub), subscriptionId: upper(sub.subscriptionId), displayName: upper(sub.displayName),
      tenantId: upper(sub.tenantId || tenantId)
    });
    if (!cachedSubscriptions) advanceCategory('AZSubscription', !subscriptionItems);
    if (!cachedSubscriptions) beginCategory('AZTenantTrust');
    const trustItems = cachedSubscriptions ? [] : await safe('AZTenant trusts', () => list('arm', '/tenants', { 'api-version': '2020-01-01' }));
    const trusts = trustItems || [];
    for (const trust of trusts) if (upper(trust.tenantId) !== upper(tenantId)) add('AZTenant', idUpper(trust));
    if (!cachedSubscriptions) advanceCategory('AZTenantTrust', !trustItems);
    if (includeManagementGroups) beginCategory('AZManagementGroup');
    const managementGroupItems = includeManagementGroups
      ? await safe('AZManagementGroup', () => list('arm', '/providers/Microsoft.Management/managementGroups', { 'api-version': '2020-05-01' })) : [];
    const allManagementGroups = managementGroupItems || [];
    const managementGroups = allManagementGroups.filter(group => !tenantId || upper(group.properties?.tenantId) === upper(tenantId));
    for (const group of managementGroups) add('AZManagementGroup', {
      ...idUpper(group), tenantId: upper(group.properties?.tenantId), properties: group.properties && {
        ...group.properties, displayName: upper(group.properties.displayName), tenantId: upper(group.properties.tenantId)
      }
    });
    if (includeManagementGroups) advanceCategory('AZManagementGroup', !managementGroupItems);
    if (includeManagementGroups) await each(managementGroups, 'AZManagementGroupDescendant', async group => {
      const descendants = await list('arm', `/providers/Microsoft.Management/managementGroups/${encodeURIComponent(group.name)}/descendants`, { 'api-version': '2020-05-01' });
      for (const descendant of descendants) add('AZManagementGroupDescendant', idUpper(descendant));
    });
    const rolesFor = async (kind, resource, field, atScope = false) => {
      if (!resource.id) return;
      const values = await list('arm', `${resource.id}/providers/Microsoft.Authorization/roleAssignments`, {
        'api-version': '2015-07-01', ...(atScope ? { '$filter': 'atScope()' } : {})
      });
      const resourceId = upper(resource.id);
      const normalized = values.map(value => ({ ...idUpper(value), properties: idUpper(value.properties) }));
      if (derivedRoles[kind]) {
        add(kind, { [field]: resourceId, roleAssignments: normalized.map(roleAssignment => ({ [field]: resourceId, roleAssignment })) });
      } else {
        add(kind, { objectId: resourceId, assignees: normalized.map(assignee => ({
          objectId: resourceId, assignee,
          roleDefinitionId: assignee.properties?.roleDefinitionId?.split('/').pop()?.toLowerCase() || ''
        })) });
      }
      for (const [derivedKind, singular, plural] of derivedRoles[kind] || []) {
        const entries = normalized.filter(value => value.properties?.roleDefinitionId?.split('/').pop()?.toLowerCase() === roleIds[singular]);
        add(derivedKind, { [field]: resourceId, [plural]: entries.map(value => ({ [field]: resourceId, [singular]: value })) });
      }
    };
    if (includeManagementGroups) await each(managementGroups, 'AZManagementGroupRoleAssignment', group => rolesFor('AZManagementGroupRoleAssignment', {
      ...group, id: `/providers/Microsoft.Management/managementGroups/${group.name}`
    }, 'managementGroupId', true));
    if (!cachedSubscriptions) await each(subscriptions, 'AZSubscriptionRoleAssignment', sub => rolesFor('AZSubscriptionRoleAssignment', { ...sub, id: `/subscriptions/${sub.subscriptionId}` }, 'subscriptionId', true));
    for (const [kind] of enabledResources) beginCategory(kind, subscriptions.length);
    if (!subscriptions.length) for (const [kind] of enabledResources) {
      state.categories[kind].percent = 100;
      state.categories[kind].status = 'skipped';
    }
    await each(subscriptions, 'subscription resources', async sub => {
      const sid = sub.subscriptionId;
      const endpointCache = new Map();
      for (const [kind, path, version, filter] of enabledResources) {
        const errorCount = state.errors.length;
        const endpoint = `${path(sid)}?api-version=${version}`;
        const sharedEndpoint = kind === 'AZFunctionApp' || kind === 'AZWebApp';
        const items = sharedEndpoint && endpointCache.has(endpoint) ? endpointCache.get(endpoint)
          : await safe(`${kind} ${sid}`, () => list('arm', path(sid), { 'api-version': version }));
        if (sharedEndpoint && !endpointCache.has(endpoint)) endpointCache.set(endpoint, items);
        if (!items) { advanceCategory(kind, true); continue; }
        for (const item of items) {
          if (filter && !filter(item)) continue;
          const rgName = item.id?.match(/\/resourceGroups\/([^/]+)/i)?.[1] || '';
          const rgId = rgName ? upper(`/subscriptions/${sid}/resourceGroups/${rgName}`) : '';
          const normalized = {
            ...idUpper(item), subscriptionId: upper(kind === 'AZKeyVault' ? sid : `/subscriptions/${sid}`),
            tenantId: upper(kind === 'AZKeyVault' ? item.properties?.tenantId || sub.tenantId || tenantId : sub.tenantId || tenantId)
          };
          if (kind !== 'AZResourceGroup') normalized.resourceGroupId = rgId;
          if (['AZWebApp', 'AZFunctionApp', 'AZStorageAccount'].includes(kind)) normalized.resourceGroupName = upper(rgName);
          if (kind === 'AZKeyVault') normalized.resourceGroup = rgId;
          if (item.identity) normalized.identity = {
            ...item.identity, principalId: upper(item.identity.principalId), tenantId: upper(item.identity.tenantId),
            userAssignedIdentities: item.identity.userAssignedIdentities && Object.fromEntries(
              (Object.entries(item.identity.userAssignedIdentities) as [string, any][]).map(([key, value]) => [key, { ...value, principalId: upper(value.principalId) }])
            )
          };
          add(kind, normalized);
          const roleKind = kind === 'AZVM' ? 'AZVMRoleAssignment' : `${kind}RoleAssignment`;
          const fields = {
            AZVM: 'virtualMachineId', AZVMScaleSet: 'vmScaleSetId', AZResourceGroup: 'resourceGroupId',
            AZKeyVault: 'keyVaultId', AZStorageAccount: 'storageAccountId', AZAutomationAccount: 'automationAccountId',
            AZLogicApp: 'logicAppId', AZFunctionApp: 'functionAppId', AZWebApp: 'webAppId',
            AZContainerRegistry: 'containerRegistryId', AZManagedCluster: 'managedClusterId'
          };
          const field = fields[kind];
          await safe(`${roleKind} ${item.id}`, () => rolesFor(roleKind, item, field));
          if (kind === 'AZKeyVault') {
            const policies = item.properties?.accessPolicies || [];
            for (const policy of policies) add('AZKeyVaultAccessPolicy', {
              keyVaultId: upper(item.id), ...idUpper(policy), objectId: upper(policy.objectId), applicationId: upper(policy.applicationId)
            });
          }
          if (kind === 'AZStorageAccount') {
            await safe(`AZStorageContainer ${item.id}`, async () => {
              const containers = await list('arm', `${item.id}/blobServices/default/containers`, { 'api-version': '2023-01-01' });
              for (const container of containers) add('AZStorageContainer', {
                ...idUpper(container), storageAccountId: upper(item.id), subscriptionId: upper(`/subscriptions/${sid}`),
                resourceGroupId: upper(`/subscriptions/${sid}/resourceGroups/${rgName}`),
                resourceGroupName: upper(rgName), tenantId: upper(sub.tenantId || tenantId)
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
      for (const kind of ['AZUser', 'AZGroup', 'AZApp', 'AZServicePrincipal', 'AZRole', 'AZRoleAssignment']) {
        if (selected(kind === 'AZRoleAssignment' ? 'AZRole' : kind) && !state.counts[kind]) warnings.push(`No ${kind} records collected`);
      }
    }
    if (state.errors.length) warnings.push(`${state.errors.length} collection errors; inspect errors for missing data`);
    return warnings;
  };
  state.report = () => ({
    collector: 'azurehound-browser', startedAt: state.startedAt,
    finishedAt: state.finishedAt || new Date().toISOString(),
    targetTenantId: targetTenant || graphTenant || state.preflight?.tenantId || state.files.AZTenant?.find(entry => entry.data.collected)?.data.tenantId || null,
    tenantSource: state.preflight?.tenantSource || tenantSource,
    availableTenantIds: state.availableTenantIds || [],
    graphPermissions: audience(tokens.graph || '')?.permissions || [],
    selectedKinds: selectedKinds ? [...selectedKinds] : null,
    initialCounts: { ...(state.preflight?.counts || {}) }, countNotes: [...(state.preflight?.countNotes || [])],
    cancelled: state.abortController.signal.aborted, counts: { ...state.counts },
    importable: state.validate().length === 0, warnings: state.warnings(),
    progress: state.progress(), cache: { ...state.cache }, exportEstimate: state.exportEstimate || null,
    throttling: { concurrency: config.concurrency, throttleMs: config.throttleMs, requestsPerMinute: config.requestsPerMinute },
    errors: [...state.errors]
  });
  state.validate = () => {
    const issues = [];
    const tenant = state.files.AZTenant?.find(entry => entry.data.collected && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.data.tenantId));
    if (!tenant) issues.push('No collected tenant with a valid tenant ID');
    const principals = ['AZUser', 'AZGroup', 'AZApp', 'AZServicePrincipal']
      .some(kind => state.files[kind]?.some(entry => typeof entry.data.id === 'string' && entry.data.id.length > 0));
    if (!principals) issues.push('No core directory objects with IDs were collected');
    if (state.abortController.signal.aborted) issues.push('Collection was cancelled');
    return issues;
  };
  const hasArmSelection = () => selected('AZManagementGroup') || resourceDefinitions.some(([kind]) => selected(kind));
  const { jsonLimit, boundedEntries, categoryEntries } = createExporter({ state, config, recordKindsFor, graphOptions, armOptions, delay, colors });
  const { cacheMetadata, categoryRecordCount, reuseCache, saveCache } = createCache({ state, config, graphOptions, armOptions, recordKindsFor, jsonLimit, boundedEntries, categoryEntries, nonnegative, chosen, cachedKinds, add, logCategory });
  const runPreflight = createPreflight({ state, config, request, targetTenant, graphTenant, tenantSource, tokens, audience, isTenantId, armTenant, tokenMismatch, cacheMetadata });
  const showPreflight = createPopup({ state, config, graphOptions, armOptions, chosen, elapsed, recordKindsFor,
    categoryRecordCount, error, listTokens: () => listMsalAccessTokens(audience) });
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
      requestSpacingMs = Math.max(nonnegative(config.throttleMs),
        nonnegative(config.requestsPerMinute) ? 60000 / nonnegative(config.requestsPerMinute) : 0);
      nextRequestAt = 0;
      try { localStorage.setItem(`azurehound:last-selection:${preflight.tenantId.toLowerCase()}`, JSON.stringify(choice.kinds)); }
      catch { /* localStorage may be unavailable */ }
    }
    if (!config.graphToken && !targetTenant && (state.availableTenantIds?.length || 0) > 1) {
      throw new Error(`Multiple Graph token tenants are cached (${state.availableTenantIds.join(', ')}). Set window.AzureHoundConfig.tenantId to the tenant to collect.`);
    }
    if (targetTenant && graphTenant && targetTenant.toLowerCase() !== graphTenant.toLowerCase()) {
      throw new Error(`Graph token tenant ${graphTenant} does not match selected tenant ${targetTenant}`);
    }
    if (config.arm && hasArmSelection() && targetTenant && armTenant && targetTenant.toLowerCase() !== armTenant.toLowerCase()) {
      throw new Error(`Resource Manager token tenant ${armTenant} does not match selected tenant ${targetTenant}`);
    }
    if (config.arm && hasArmSelection() && tokenMismatch) throw new Error(`Graph and Azure Resource Manager tokens belong to different tenants (${graphTenant} and ${armTenant})`);
    if (!config.graph && !config.arm) throw new Error('Both Graph and ARM collection are disabled');
    if (config.graph && !tokens.graph && config.arm === false) throw new Error('No Graph token available');
    if (config.arm && !tokens.arm && config.graph === false) throw new Error('No ARM token available');
    const cacheTenant = targetTenant || graphTenant || state.preflight?.tenantId;
    if (previousCacheReady) await previousCacheReady;
    if (cacheTenant && reuse) {
      try { await reuseCache(cacheTenant, state.preflight?.cacheMetadata || await cacheMetadata(cacheTenant), true); }
      catch (e) { state.cache.errors.push(e.message); }
    }
    progressTimer = setInterval(logProgress, Math.max(1000, nonnegative(config.progressIntervalMs) || 10000));
    logProgress();
    let tenantId = config.tenantId || '';
    if (config.graph) tenantId = await collectGraph() || tenantId;
    if (config.arm && hasArmSelection()) await collectArm(tenantId);
    if (!state.abortController.signal.aborted && config.useCache !== false) state.cacheReady = saveCache(tenantId);
    if (config.interactive && state.cacheReady) await state.cacheReady;
    state.finishedAt = new Date().toISOString();
    const issues = state.validate();
    if (issues.length) {
      for (const issue of issues) error('Collection validation', issue);
      console.error('%cAzureHound blocked%c  No importable ZIP was downloaded. Inspect window.AzureHound.report().', colors.blocked, colors.text);
    } else if (config.download && !config.interactive) await state.download();
    if (!issues.length && state.warnings().length) console.warn('%cAzureHound partial%c  Check window.AzureHound.report() before importing.', colors.partial, colors.text);
    return state;
  } finally { state.running = false; if (progressTimer) clearInterval(progressTimer); logProgress(true); state.popup?.finish?.(); }
})();
window.AzureHound.completion = completion;
