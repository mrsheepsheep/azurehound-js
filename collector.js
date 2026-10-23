/* AzureHound browser collector. GPL-3.0-or-later; see ../AzureHound/LICENSE.md.
 * Paste/evaluate this entire file in a signed-in Azure or Microsoft 365 portal tab.
 * Configure optional window.AzureHoundConfig before evaluation. No external runtime.
 */
(async function azureHoundBrowserCollector() {
  'use strict';
  if (window.AzureHound && window.AzureHound.running) throw new Error('AzureHound collection is already running');
  const config = Object.assign({ concurrency: 4, retries: 4, pageTimeoutMs: 120000, graph: true, arm: true, download: true }, window.AzureHoundConfig || {});
  const state = { running: true, startedAt: new Date().toISOString(), errors: [], counts: {}, abortController: new AbortController(), files: {} };
  window.AzureHound = state;
  state.cancel = () => state.abortController.abort();
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
    console.warn('[AzureHound]', area, message);
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
  async function request(service, path, params = {}) {
    const token = tokens[service];
    if (!token) throw new Error(`No ${service} access token. Set window.AzureHoundConfig.${service === 'graph' ? 'graphToken' : 'armToken'} to a token for the respective API and evaluate again.`);
    const url = urlFor(service, path, params);
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      if (state.abortController.signal.aborted) throw new Error('Collection cancelled');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.pageTimeoutMs);
      const cancel = () => controller.abort();
      state.abortController.signal.addEventListener('abort', cancel, { once: true });
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: controller.signal,
          credentials: 'omit'
        });
        if ((response.status === 429 || response.status >= 500) && attempt < config.retries) {
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
        if (e.name === 'TypeError') throw new Error(`Browser request failed for ${url.origin}. Check portal CORS policy and token audience: ${e.message}`);
        throw e;
      } finally {
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
  async function safe(area, work) { try { return await work(); } catch (e) { error(area, e); return null; } }
  async function each(items, area, work) {
    const concurrency = Math.max(1, Math.min(16, Number(config.concurrency) || 4));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length && !state.abortController.signal.aborted) {
        const item = items[cursor++];
        await safe(`${area} ${item.id || item.name || item.appId || ''}`, () => work(item));
      }
    }));
  }
  async function collectGraph() {
    if (!tokens.graph) { error('Graph', 'No Graph token found'); return; }
    const org = await safe('organization', () => request('graph', '/v1.0/organization'));
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
    const entity = item => ({
      ...idUpper(item), displayName: upper(item.displayName), deviceId: upper(item.deviceId),
      appOwnerOrganizationId: upper(item.appOwnerOrganizationId), tenantId, tenantName
    });
    const definitions = [
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
    const collections = {};
    for (const [kind, path, params] of definitions) {
      let items;
      if (kind === 'AZUser') {
        try { items = await list('graph', path, params); }
        catch (e) {
          console.info('[AzureHound] Retrying users without signInActivity:', e.message);
          const fallback = { ...params, '$select': params.$select.replace(',signInActivity', '') };
          items = await safe(`${kind} without signInActivity`, () => list('graph', path, fallback));
        }
      } else items = await safe(kind, () => list('graph', path, params));
      collections[kind] = items || [];
      for (const item of collections[kind]) {
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
      }
      console.info('[AzureHound]', kind, collections[kind].length);
    }
    const relation = async (parents, kind, path, outer, inner, field, top = 99) => each(parents, kind, async parent => {
      const values = await list('graph', path(parent), top ? { '$top': top } : {});
      const parentId = upper(field === 'appId' ? parent.appId : parent.id);
      add(kind, { [field]: parentId, [outer]: values.map(value => ({ [inner]: idUpper(value), [field]: parentId })) });
    });
    await relation(collections.AZGroup, 'AZGroupMember', p => `/beta/groups/${p.id}/members`, 'members', 'member', 'groupId');
    await relation(collections.AZGroup, 'AZGroupOwner', p => `/beta/groups/${p.id}/owners`, 'owners', 'owner', 'groupId');
    await relation(collections.AZApp, 'AZAppOwner', p => `/beta/applications/${p.id}/owners`, 'owners', 'owner', 'appId');
    await relation(collections.AZServicePrincipal, 'AZServicePrincipalOwner', p => `/beta/servicePrincipals/${p.id}/owners`, 'owners', 'owner', 'servicePrincipalId', 999);
    await each(collections.AZApp, 'AZFederatedIdentityCredential', async app => {
      const values = await list('graph', `/beta/applications/${app.id}/federatedIdentityCredentials`);
      if (values.length) add('AZFederatedIdentityCredential', {
        appId: upper(app.appId), tenantId, tenantName,
        fics: values.map(value => ({ appId: upper(app.appId), fic: idUpper(value) }))
      });
    });
    await each(collections.AZServicePrincipal.filter(sp => sp.appRoles?.length), 'AZAppRoleAssignment', async sp => {
      const values = await list('graph', `/v1.0/servicePrincipals/${sp.id}/appRoleAssignedTo`);
      for (const value of values) add('AZAppRoleAssignment', { ...idUpper(value), appId: upper(sp.appId), tenantId });
    });
    await each(collections.AZRole, 'AZRoleAssignment', async role => {
      const values = await list('graph', '/v1.0/roleManagement/directory/roleAssignments', { '$top': 999, '$filter': `roleDefinitionId eq '${role.id}'`, '$expand': 'directoryScope' });
      add('AZRoleAssignment', { roleDefinitionId: upper(role.id), tenantId, roleAssignments: values.map(value => {
        const copy = idUpper(value);
        if (copy.directoryScopeId && copy.directoryScopeId !== '/' && copy.directoryScope?.appId) copy.directoryScopeId = '/' + upper(copy.directoryScope.appId);
        return copy;
      }) });
    });
    return tenantId;
  }
  const resourceDefinitions = [
    ['AZResourceGroup', sid => `/subscriptions/${sid}/resourcegroups`, '2021-04-01'],
    ['AZVM', sid => `/subscriptions/${sid}/providers/Microsoft.Compute/virtualMachines`, '2024-07-01'],
    ['AZVMScaleSet', sid => `/subscriptions/${sid}/providers/Microsoft.Compute/virtualMachineScaleSets`, '2024-07-01'],
    ['AZKeyVault', sid => `/subscriptions/${sid}/providers/Microsoft.KeyVault/vaults`, '2023-07-01'],
    ['AZStorageAccount', sid => `/subscriptions/${sid}/providers/Microsoft.Storage/storageAccounts`, '2023-01-01'],
    ['AZAutomationAccount', sid => `/subscriptions/${sid}/providers/Microsoft.Automation/automationAccounts`, '2023-11-01'],
    ['AZLogicApp', sid => `/subscriptions/${sid}/providers/Microsoft.Logic/workflows`, '2019-05-01'],
    ['AZFunctionApp', sid => `/subscriptions/${sid}/providers/Microsoft.Web/sites`, '2023-12-01', item => item.kind?.toLowerCase() === 'functionapp'],
    ['AZWebApp', sid => `/subscriptions/${sid}/providers/Microsoft.Web/sites`, '2023-12-01', item => item.kind?.toLowerCase() === 'app'],
    ['AZContainerRegistry', sid => `/subscriptions/${sid}/providers/Microsoft.ContainerRegistry/registries`, '2023-07-01'],
    ['AZManagedCluster', sid => `/subscriptions/${sid}/providers/Microsoft.ContainerService/managedClusters`, '2024-05-01']
  ];
  const roleIds = {
    owner: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635',
    contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
    userAccessAdmin: '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9',
    kvContributor: 'f25e0fa2-a7c8-4377-a976-54943a77a395',
    avereContributor: '4f8fab4f-1852-4a58-a46a-8eaf358af14a',
    adminLogin: '1c0163c0-47e6-4577-8991-ea5c82e286e4',
    vmContributor: '9980e02c-c2be-4d73-94e8-173b1dc7cf3c'
  };
  const derivedRoles = {
    AZSubscriptionRoleAssignment: [['AZSubscriptionOwner', 'owner', 'owners'], ['AZSubscriptionContributor', 'contributor', 'contributors'], ['AZSubscriptionUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins']],
    AZManagementGroupRoleAssignment: [['AZManagementGroupOwner', 'owner', 'owners'], ['AZManagementGroupContributor', 'contributor', 'contributors'], ['AZManagementGroupUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins']],
    AZResourceGroupRoleAssignment: [['AZResourceGroupOwner', 'owner', 'owners'], ['AZResourceGroupContributor', 'contributor', 'contributors'], ['AZResourceGroupUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins']],
    AZKeyVaultRoleAssignment: [['AZKeyVaultOwner', 'owner', 'owners'], ['AZKeyVaultContributor', 'contributor', 'contributors'], ['AZKeyVaultUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins'], ['AZKeyVaultKVContributor', 'kvContributor', 'kvContributors']],
    AZVMRoleAssignment: [['AZVMOwner', 'owner', 'owners'], ['AZVMContributor', 'contributor', 'contributors'], ['AZVMUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins'], ['AZVMAvereContributor', 'avereContributor', 'avereContributors'], ['AZVMAdminLogin', 'adminLogin', 'adminLogins'], ['AZVMVMContributor', 'vmContributor', 'vmContributors']]
  };
  async function collectArm(tenantId) {
    if (!tokens.arm) { error('ARM', 'No Resource Manager token found'); return; }
    const subscriptions = await safe('AZSubscription', () => list('arm', '/subscriptions', { 'api-version': '2020-01-01' })) || [];
    for (const sub of subscriptions) add('AZSubscription', {
      ...idUpper(sub), subscriptionId: upper(sub.subscriptionId), displayName: upper(sub.displayName),
      tenantId: upper(sub.tenantId || tenantId)
    });
    const trusts = await safe('AZTenant trusts', () => list('arm', '/tenants', { 'api-version': '2020-01-01' })) || [];
    for (const trust of trusts) if (upper(trust.tenantId) !== upper(tenantId)) add('AZTenant', idUpper(trust));
    const allManagementGroups = await safe('AZManagementGroup', () => list('arm', '/providers/Microsoft.Management/managementGroups', { 'api-version': '2020-05-01' })) || [];
    const managementGroups = allManagementGroups.filter(group => !tenantId || upper(group.properties?.tenantId) === upper(tenantId));
    for (const group of managementGroups) add('AZManagementGroup', {
      ...idUpper(group), tenantId: upper(group.properties?.tenantId), properties: group.properties && {
        ...group.properties, displayName: upper(group.properties.displayName), tenantId: upper(group.properties.tenantId)
      }
    });
    await each(managementGroups, 'AZManagementGroupDescendant', async group => {
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
    await each(managementGroups, 'AZManagementGroupRoleAssignment', group => rolesFor('AZManagementGroupRoleAssignment', {
      ...group, id: `/providers/Microsoft.Management/managementGroups/${group.name}`
    }, 'managementGroupId', true));
    await each(subscriptions, 'AZSubscriptionRoleAssignment', sub => rolesFor('AZSubscriptionRoleAssignment', { ...sub, id: `/subscriptions/${sub.subscriptionId}` }, 'subscriptionId', true));
    await each(subscriptions, 'subscription resources', async sub => {
      const sid = sub.subscriptionId;
      const endpointCache = new Map();
      for (const [kind, path, version, filter] of resourceDefinitions) {
        const endpoint = `${path(sid)}?api-version=${version}`;
        if (!endpointCache.has(endpoint)) endpointCache.set(endpoint, await safe(`${kind} ${sid}`, () => list('arm', path(sid), { 'api-version': version })));
        const items = endpointCache.get(endpoint);
        if (!items) continue;
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
              Object.entries(item.identity.userAssignedIdentities).map(([key, value]) => [key, { ...value, principalId: upper(value.principalId) }])
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
        console.info('[AzureHound]', kind, sid, items.length);
      }
    });
  }
  // Build a single-file ZIP without a CDN dependency; use DEFLATE where supported.
  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  }
  async function zip(entries) {
    if (entries.length > 65535) throw new Error('ZIP contains too many files');
    const encoder = new TextEncoder();
    const parts = [], central = [];
    let offset = 0, centralLength = 0;
    const u16 = (view, at, n) => view.setUint16(at, n, true);
    const u32 = (view, at, n) => view.setUint32(at, n >>> 0, true);
    for (const [name, content] of entries) {
      const filename = encoder.encode(name), raw = encoder.encode(content), crc = crc32(raw);
      let bytes = raw, method = 0;
      if (typeof CompressionStream !== 'undefined') {
        try {
          const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
          bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          method = 8;
        } catch (e) { console.warn('[AzureHound] DEFLATE unavailable; using stored ZIP entry:', e.message); }
      }
      if (filename.length > 65535 || raw.length > 0xFFFFFFFF || bytes.length > 0xFFFFFFFF) throw new Error(`ZIP entry too large: ${name}`);
      const local = new Uint8Array(30 + filename.length), lv = new DataView(local.buffer);
      u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, 0x800); u16(lv, 8, method); u32(lv, 14, crc);
      u32(lv, 18, bytes.length); u32(lv, 22, raw.length); u16(lv, 26, filename.length);
      local.set(filename, 30); parts.push(local, bytes);
      const header = new Uint8Array(46 + filename.length), hv = new DataView(header.buffer);
      u32(hv, 0, 0x02014b50); u16(hv, 4, 20); u16(hv, 6, 20); u16(hv, 8, 0x800); u16(hv, 10, method);
      u32(hv, 16, crc); u32(hv, 20, bytes.length); u32(hv, 24, raw.length);
      u16(hv, 28, filename.length); u32(hv, 42, offset); header.set(filename, 46);
      central.push(header); centralLength += header.length; offset += local.length + bytes.length;
    }
    if (offset + centralLength > 0xFFFFFFFF) throw new Error('ZIP exceeds the ZIP32 size limit');
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    u32(ev, 0, 0x06054b50); u16(ev, 8, entries.length); u16(ev, 10, entries.length);
    u32(ev, 12, centralLength); u32(ev, 16, offset);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }
  state.report = () => ({
    collector: 'azurehound-browser', startedAt: state.startedAt,
    finishedAt: state.finishedAt || new Date().toISOString(),
    targetTenantId: targetTenant || graphTenant || null, tenantSource,
    availableTenantIds: state.availableTenantIds || [],
    graphPermissions: audience(tokens.graph || '')?.permissions || [],
    cancelled: state.abortController.signal.aborted, counts: { ...state.counts }, errors: [...state.errors]
  });
  state.validate = () => {
    const issues = [];
    const tenant = state.files.AZTenant?.find(entry => entry.data.collected && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.data.tenantId));
    if (!tenant) issues.push('No collected tenant with a valid tenant ID');
    const principals = ['AZUser', 'AZGroup', 'AZApp', 'AZServicePrincipal', 'AZDevice'].reduce((n, kind) => n + (state.counts[kind] || 0), 0);
    if (!principals) issues.push('No directory principals were collected');
    if (config.graph) {
      for (const kind of ['AZUser', 'AZGroup', 'AZApp', 'AZServicePrincipal', 'AZRole', 'AZRoleAssignment']) {
        if (!state.counts[kind]) issues.push(`Missing critical ${kind} collection; check Graph permissions and window.AzureHound.errors`);
      }
    }
    if (state.abortController.signal.aborted) issues.push('Collection was cancelled');
    return issues;
  };
  state.makeZip = async () => {
    const issues = state.validate();
    if (issues.length) throw new Error(`Cannot build a BloodHound collection: ${issues.join('; ')}. Inspect window.AzureHound.errors.`);
    const records = Object.values(state.files).flat();
    return zip([['azurehound.json', JSON.stringify({
      data: records, meta: { type: 'azure', version: 5, count: records.length }
    })]]);
  };
  state.download = async () => {
    const blob = await state.makeZip(), url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `azurehound-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return blob;
  };
  try {
    if (!config.graphToken && !targetTenant && (state.availableTenantIds?.length || 0) > 1) {
      throw new Error(`Multiple Graph token tenants are cached (${state.availableTenantIds.join(', ')}). Set window.AzureHoundConfig.tenantId to the tenant to collect.`);
    }
    if (targetTenant && graphTenant && targetTenant.toLowerCase() !== graphTenant.toLowerCase()) {
      throw new Error(`Graph token tenant ${graphTenant} does not match selected tenant ${targetTenant}`);
    }
    if (targetTenant && armTenant && targetTenant.toLowerCase() !== armTenant.toLowerCase()) {
      throw new Error(`Resource Manager token tenant ${armTenant} does not match selected tenant ${targetTenant}`);
    }
    if (tokenMismatch) throw new Error(`Graph and Azure Resource Manager tokens belong to different tenants (${graphTenant} and ${armTenant})`);
    if (!config.graph && !config.arm) throw new Error('Both Graph and ARM collection are disabled');
    if (config.graph && !tokens.graph && config.arm === false) throw new Error('No Graph token available');
    if (config.arm && !tokens.arm && config.graph === false) throw new Error('No ARM token available');
    let tenantId = config.tenantId || '';
    if (config.graph) tenantId = await collectGraph() || tenantId;
    if (config.arm) await collectArm(tenantId);
    state.finishedAt = new Date().toISOString();
    const issues = state.validate();
    if (issues.length) {
      for (const issue of issues) error('Collection validation', issue);
      console.error('[AzureHound] No importable ZIP was downloaded. Inspect window.AzureHound.errors.');
    } else if (config.download) await state.download();
    console.info('[AzureHound] Collection finished', state.counts, `${state.errors.length} errors`);
    return state;
  } finally { state.running = false; }
})();
