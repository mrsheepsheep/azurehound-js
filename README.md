# AzureHound browser collector

`collector.js` is a single self-contained JavaScript eval for a signed-in Azure Portal or Microsoft 365 admin page. It calls Microsoft Graph and Azure Resource Manager from that tab, then downloads a ZIP containing one `azurehound.json`, compressed with DEFLATE when the browser supports it. The file has the same `data` and `meta` envelope as the Go AzureHound collector. The ZIP is assembled locally in the browser. No collected data or tokens are sent to this project.

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

3. Paste and evaluate the entire contents of `collector.js` in that page. Keep the tab open until collection finishes. The ZIP downloads automatically.

The eval returns a promise. Progress and endpoint errors appear in the console. `window.AzureHound` holds `counts`, `errors`, `files`, `cancel()`, `report()`, `validate()`, `makeZip()`, and `download()` for the current run. The ZIP excludes diagnostics because BloodHound CE expects every entry to be an ingestible collection file. Inspect `window.AzureHound.report()` for the selected tenant, its source, token permissions, counts, warnings, and endpoint errors. Endpoint failures do not prevent a download when the Graph organization tenant and at least one core directory object with an ID were collected. Missing users, groups, apps, service principals, or roles appear as warnings. A missing tenant, no core directory objects, or cancellation blocks the ZIP. If cached tenants remain ambiguous, set `tenantId` explicitly; the script will not guess.

Optional `window.AzureHoundConfig` fields: `graph`, `arm`, `download` (booleans), `tenantId` (string), `concurrency` (1–16), `retries` (number), and `pageTimeoutMs` (number). Set `download: false` to inspect the results before calling `await window.AzureHound.download()`.

To pace requests and see live progress, configure these fields before evaluating the script:

```js
window.AzureHoundConfig = {
  concurrency: 2,             // simultaneous relation/resource workers (default 4)
  throttleMs: 250,            // minimum gap between all API request starts (default 0)
  requestsPerMinute: 120,     // global maximum start rate (default 0, unlimited)
  progressIntervalMs: 5000   // console progress interval (default 10000)
};
```

When both pace limits are set, the slower limit applies; retries also use the global pace. The console logs progress at the interval, after every 25 completed request attempts, and at the start and end. `window.AzureHound.progress()` returns the current elapsed time, request counts, active requests, last endpoint, collected record counts, and error count. Progress output does not include access tokens.

The portal page must permit browser `fetch` to `graph.microsoft.com` and `management.azure.com`; browser CORS rules still apply. The signed-in identity and its token scopes determine which objects can be read. Graph and Resource Manager tokens have different audiences. The collector cannot refresh expired tokens during a run. Exported JSON contains collected directory and resource data, so handle the ZIP as sensitive data. If a ZIP is not downloaded, inspect `window.AzureHound.errors` to identify the failed Graph endpoint or missing permission.

This browser port does not implement BloodHound Enterprise job polling or upload. Collection can continue where permissions permit; check `window.AzureHound.report()` for partial results before importing.
