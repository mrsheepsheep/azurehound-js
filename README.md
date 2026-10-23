# AzureHound browser collector

`collector.js` is a single self-contained JavaScript eval for a signed-in Azure Portal or Microsoft 365 admin page, compiled from the TypeScript modules in `src/`. It calls Microsoft Graph and Azure Resource Manager from that tab, then creates BloodHound CE JSON files with the same `data` and `meta` envelope as the Go AzureHound collector. Large collections are split into bounded JSON files and ZIP archives; each ZIP is assembled locally and compressed with DEFLATE when supported. No collected data or tokens are sent to this project.

## Build

Install Node.js 18 or newer, then run:

```sh
npm ci
npm run build
```

Edit the modules in `src/`; `npm run build` regenerates the browser-ready `collector.js`. The generated file has no runtime dependencies and can still be pasted directly into a portal console. Run `npm run check` for TypeScript diagnostics and `npm test` for the browser tests.

## Run

1. Open a signed-in portal page and its Developer Tools console.
2. The collector detects the tenant from the portal URL, the active MSAL account, or a single cached Graph token tenant. It verifies the result against the Graph token and organization response. If the page has multiple cached tenants but does not expose an unambiguous active tenant, set `tenantId` explicitly. If it does not expose suitable unexpired Graph and Resource Manager access tokens in session/local storage, set the tokens in the console:

   ```js
   window.AzureHoundConfig = {
     tenantId: '<target tenant GUID>',
     graphToken: '<Graph access token>',
     armToken: '<Azure Resource Manager access token>'
   };
   ```

3. Paste and evaluate the entire contents of `collector.js` in that page. Before showing the popup, the collector requests object counts for directory categories and Azure resource types. The popup shows those counts, the detected tenant, API checks, available cached categories, and a rough collection time estimate. Choose categories and edit the concurrent worker, request gap, and requests-per-minute limits; the estimate updates as you change them. Select **Start collection** and keep the tab open. The popup shows live progress and, when collection finishes, offers **Download ZIP** and a separate **Download JSON** button for each selected category.

The eval returns a promise. Progress and endpoint errors appear in the console. `window.AzureHound` holds `counts`, `errors`, `files`, `cancel()`, `report()`, `validate()`, `estimateExport()`, `makeZip()`, `makeZipPart(index)`, `makeJson(category)`, `makeJsonPart(category, index)`, and download methods for the current run. `makeZip()` and `makeJson(category)` return a single Blob when only one part is needed; use the part methods for larger exports. The ZIP excludes diagnostics because BloodHound CE expects every entry to be an ingestible collection file. Inspect `window.AzureHound.report()` for the selected tenant, its source, token permissions, counts, warnings, cache use, export size estimate, and endpoint errors. Endpoint failures do not prevent a download when the Graph organization tenant and at least one core directory object with an ID were collected. Missing users, groups, apps, service principals, or roles appear as warnings. A missing tenant, no core directory objects, or cancellation blocks the ZIP. If cached tenants remain ambiguous, set `tenantId` explicitly; the script will not guess.

Optional `window.AzureHoundConfig` fields: `graph`, `arm`, `download`, `interactive`, `useCache` (booleans), `tenantId` (string), `categories` (array of collector kind names), `concurrency` (1–16), `throttleMs`, `requestsPerMinute`, `retries`, `pageTimeoutMs`, `preflightTimeoutMs` (default 15000), `cacheMaxAgeMs` (default 24 hours), `maxJsonBytes` (default 16 MiB), and `maxZipBytes` (default 128 MiB). The popup is enabled by default; set `interactive: false` for unattended runs. In interactive mode, downloads start only when you press a download button. For unattended runs, set `download: false` to inspect results before calling `await window.AzureHound.download()`.

After collection, the popup shows the sum of the uncompressed JSON sizes and a button for each ZIP part. Import every ZIP part into BloodHound CE. Each JSON part includes a collected tenant record and its own valid `meta.count`. Relationship records with large member or assignment arrays are split at array boundaries. Individual category exports expose each JSON part separately. The collector builds and downloads one ZIP at a time; `download()` downloads every ZIP in sequence, though the browser may ask you to allow multiple downloads. A single source record with no splittable relationship array that exceeds `maxJsonBytes` produces a clear export error, so raise the limit for that case.

Completed categories are cached in bounded chunks in the page origin's IndexedDB, keyed by tenant ID and category. The last category selection is kept in localStorage. A later run reuses fresh cached categories by default and skips their API calls; clear the reuse checkbox to refresh them. `window.AzureHound.cacheReady` resolves when writes from the current run finish. Cached data contains directory and Azure resource details, so clear this origin's site data when you no longer need it. Storage quota failures appear in `window.AzureHound.report().cache.errors` and do not block the current ZIP.

The popup checks Graph's organization endpoint and the first page of Azure subscriptions. It uses [Microsoft Graph count queries](https://learn.microsoft.com/en-us/graph/query-parameters#count) with a one-object page and [Azure Resource Graph aggregate queries](https://learn.microsoft.com/en-us/azure/governance/resource-graph/first-query-rest-api) to estimate totals without dumping collections. Count checks are optional: if an API does not return a count or the Resource Graph query is denied, the popup marks that category's count unavailable and uses a stated fallback for the estimate. The estimate uses count-based page and relationship request estimates, selected request limits, and the subscription count; pagination, retries, and API delays can take longer. `window.AzureHound.report()` includes `initialCounts` and `countNotes`. The full collection starts only after **Start collection**. Directory tenant data is always included. Selecting groups also collects their members and owners; applications include owners and federated credentials; service principals include owners and app role assignments; directory roles include assignments, eligibility, and policies. Selecting any Azure resource also collects subscriptions and their role assignments. The popup requires at least one core directory category (users, groups, applications, or service principals). An unavailable Resource Manager check disables Azure resource choices while still allowing directory collection. The popup never displays access tokens.

The same request limits are editable in the popup. For unattended runs, configure them before evaluating the script:

```js
window.AzureHoundConfig = {
  concurrency: 2,             // simultaneous relation/resource workers (default 4)
  throttleMs: 250,            // minimum gap between all API request starts (default 0)
  requestsPerMinute: 120,     // global maximum start rate (default 0, unlimited)
  progressIntervalMs: 5000   // console progress interval (default 10000)
};
```

When both pace limits are set, the slower limit applies; retries also use the global pace. The console prints colored, readable status lines at the interval, after every 25 completed request attempts, when a category finishes, and at the start and end. Category lines show a progress bar, percentage, record count, and status; errors and partial collections are highlighted. Console messages contain text only, with no JSON objects or access tokens. `window.AzureHound.progress()` still returns structured elapsed time, request counts, active requests, last endpoint, collected record counts, error count, and `percentages` by collection category. `categories` adds completed/total work units, record counts, failures, and status (`pending`, `running`, `complete`, `partial`, `skipped`, or `cached`). For relationship categories, work units are parent objects; for Azure resource categories, they are subscriptions. A paginated directory list has no reliable total until pagination ends, so it shows 0% while running and 100% once attempted. A category can reach 100% with `partial` status when a request failed.

The portal page must permit browser `fetch` to `graph.microsoft.com` and `management.azure.com`; browser CORS rules still apply. The signed-in identity and its token scopes determine which objects can be read. Graph and Resource Manager tokens have different audiences. The collector cannot refresh expired tokens during a run. Exported JSON contains collected directory and resource data, so handle the ZIP as sensitive data. If a ZIP is not downloaded, inspect `window.AzureHound.errors` to identify the failed Graph endpoint or missing permission.

This browser port does not implement BloodHound Enterprise job polling or upload. Collection can continue where permissions permit; check `window.AzureHound.report()` for partial results before importing.
