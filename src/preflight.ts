import { graphCountQueries, armResourceTypes } from './constants';

export function createPreflight(ctx: any) {
  const { state, config, request, targetTenant, graphTenant, tenantSource, tokens, audience, isTenantId,
    armTenant, tokenMismatch, cacheMetadata } = ctx;
  async function countDirectoryObjects(result: any) {
    await Promise.all(graphCountQueries.map(async ([kind, path, filter]) => {
      try {
        const response = await request('graph', path, { ...filter, '$count': 'true', '$top': 1 },
          { retries: 0, timeoutMs: config.preflightTimeoutMs, headers: { ConsistencyLevel: 'eventual' } });
        const count = Number(response?.['@odata.count']);
        if (Number.isSafeInteger(count) && count >= 0) result.counts[kind] = count;
        else if (Array.isArray(response?.value) && response.value.length === 0 && !response['@odata.nextLink']) result.counts[kind] = 0;
        else result.countNotes.push(`${kind}: count not returned`);
      } catch (e) { result.countNotes.push(`${kind}: ${e.message}`); }
    }));
  }
  async function countAzureResources(result: any, subscriptions: any) {
    const ids = subscriptions.value.map(item => item.subscriptionId).filter(Boolean);
    result.counts.AZSubscription = ids.length;
    if (subscriptions.nextLink) result.countNotes.push('Azure resource counts cover the first subscription page only');
    if (!ids.length) return;
    const countQuery = async query => {
      const response = await request('arm', '/providers/Microsoft.ResourceGraph/resources', { 'api-version': '2024-04-01' },
        { method: 'POST', body: { subscriptions: ids, query, options: { resultFormat: 'objectArray' } },
          retries: 0, timeoutMs: config.preflightTimeoutMs });
      if (!Array.isArray(response?.data)) throw new Error('Resource Graph returned no count rows');
      return response.data;
    };
    const outcomes = await Promise.allSettled([
      countQuery('Resources | summarize total=count() by type, kind'),
      countQuery('ResourceContainers | summarize total=count() by type')
    ]);
    if (outcomes[0].status === 'fulfilled') {
      for (const kind of Object.keys(armResourceTypes)) result.counts[kind] = 0;
      for (const row of outcomes[0].value) {
        const type = String(row.type || '').toLowerCase(), resourceKind = String(row.kind || '').toLowerCase();
        const count = Number(row.total);
        if (!Number.isSafeInteger(count) || count < 0) continue;
        for (const [kind, expectedType] of Object.entries(armResourceTypes)) {
          if (type !== expectedType) continue;
          if (kind === 'AZFunctionApp' && resourceKind !== 'functionapp') continue;
          if (kind === 'AZWebApp' && resourceKind !== 'app') continue;
          result.counts[kind] += count;
        }
      }
    } else result.countNotes.push(`Azure resources: ${outcomes[0].reason.message}`);
    if (outcomes[1].status === 'fulfilled') {
      result.counts.AZResourceGroup = outcomes[1].value
        .filter(row => String(row.type || '').toLowerCase() === 'microsoft.resources/subscriptions/resourcegroups')
        .reduce((sum, row) => sum + (Number(row.total) || 0), 0);
      const groupRows = outcomes[1].value.filter(row => String(row.type || '').toLowerCase() === 'microsoft.management/managementgroups');
      if (groupRows.length) result.counts.AZManagementGroup = groupRows.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
    } else result.countNotes.push(`Azure containers: ${outcomes[1].reason.message}`);
  }
  async function runPreflight() {
    const result: any = { page: location.origin, tenantId: targetTenant || graphTenant || null,
      tenantSource, graphToken: !!tokens.graph, armToken: !!tokens.arm,
      graphPermissions: audience(tokens.graph || '')?.permissions || [],
      graphStatus: 'Unavailable', armStatus: 'Unavailable', issues: [], counts: {}, countNotes: [] };
    if (!config.graph || !tokens.graph) result.issues.push('A Microsoft Graph token is required for the tenant and core directory objects.');
    const graphAmbiguous = !config.graphToken && !targetTenant && (state.availableTenantIds?.length || 0) > 1;
    const graphMismatch = targetTenant && graphTenant && targetTenant.toLowerCase() !== graphTenant.toLowerCase();
    const armMismatch = (targetTenant && armTenant && targetTenant.toLowerCase() !== armTenant.toLowerCase()) || tokenMismatch;
    if (graphAmbiguous) result.issues.push('Several tenant tokens are cached and no active tenant was identified.');
    if (graphMismatch) result.issues.push('The Graph token belongs to another tenant.');
    if (armMismatch) { result.armStatus = 'Tenant mismatch'; result.issues.push('The Resource Manager token belongs to another tenant. Azure resource collection is unavailable.'); }
    if (config.graph && tokens.graph && !graphAmbiguous && !graphMismatch) {
      try {
        const organization = await request('graph', '/v1.0/organization', {}, { retries: 0, timeoutMs: config.preflightTimeoutMs });
        const id = organization?.value?.[0]?.id;
        if (!isTenantId(id)) throw new Error('Organization response did not contain a tenant ID');
        if (result.tenantId && id.toLowerCase() !== result.tenantId.toLowerCase()) throw new Error('Organization tenant differs from the selected tenant');
        result.organization = organization;
        result.tenantId = id;
        if (!targetTenant && !graphTenant) result.tenantSource = 'Graph organization';
        result.graphStatus = 'Ready';
        await countDirectoryObjects(result);
      } catch (e) { result.graphStatus = `Failed: ${e.message}`; result.issues.push(`Graph check failed: ${e.message}`); }
    }
    if (config.arm && tokens.arm && !armMismatch) {
      try {
        const subscriptions = await request('arm', '/subscriptions', { 'api-version': '2020-01-01' }, { retries: 0, timeoutMs: config.preflightTimeoutMs });
        if (!Array.isArray(subscriptions.value)) throw new Error('Subscriptions response was invalid');
        result.armStatus = `Ready (${subscriptions.value.length} subscriptions on first page)`;
        result.armReady = true;
        await countAzureResources(result, subscriptions);
      } catch (e) { result.armStatus = `Failed: ${e.message}`; }
    }
    result.cacheMetadata = {};
    if (result.tenantId) {
      if (config.useCache !== false) {
        try {
          result.cacheMetadata = await cacheMetadata(result.tenantId);
          result.cacheStatus = `${Object.keys(result.cacheMetadata).length} fresh categories available`;
        } catch (e) { result.cacheStatus = `Unavailable: ${e.message}`; state.cache.errors.push(e.message); }
      }
      if (!Array.isArray(config.categories)) {
        try {
          const saved = JSON.parse(localStorage.getItem(`azurehound:last-selection:${result.tenantId.toLowerCase()}`));
          if (Array.isArray(saved)) result.previousSelection = saved;
        } catch { /* localStorage may be unavailable */ }
      }
    }
    state.preflight = result;
    return result;
  }
  return runPreflight;
}
