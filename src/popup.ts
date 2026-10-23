export function createPopup(ctx: any) {
  const { state, config, graphOptions, armOptions, chosen, elapsed, recordKindsFor, categoryRecordCount, error } = ctx;
  function showPreflight(result: any): Promise<any> {
    return new Promise<any>(resolve => {
      const host = document.createElement('div');
      host.id = 'azurehound-preflight';
      const shadow = host.attachShadow({ mode: 'open' });
      const stylesheet = document.createElement('style');
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
      const element = (tag: string, id?: string, className?: string, label?: string): any => {
        const node = document.createElement(tag);
        if (id) node.id = id;
        if (className) node.className = className;
        if (label) node.textContent = label;
        return node;
      };
      const backdrop = element('div', null, 'backdrop');
      const panel = element('section', null, 'panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-labelledby', 'title');
      panel.append(element('h2', 'title', null, 'AzureHound browser collection'));
      panel.append(element('p', null, null, 'Review the detected session and choose what to collect.'));
      panel.append(element('div', 'facts', 'facts'));
      const issuesBox = element('div', 'issues', 'issues');
      issuesBox.hidden = true;
      panel.append(issuesBox);
      panel.append(element('h3', null, null, 'Directory'));
      panel.append(element('div', 'graph', 'choices'));
      panel.append(element('h3', null, null, 'Azure resources'));
      panel.append(element('p', null, null, 'Subscriptions and their role assignments are included when any Azure resource is selected.'));
      panel.append(element('div', 'arm', 'choices'));
      const actions = element('div', null, 'actions');
      actions.append(element('span', 'hint'));
      const cancelButton = element('button', 'cancel', null, 'Cancel');
      const startButton = element('button', 'start', null, 'Start collection');
      cancelButton.type = 'button';
      startButton.type = 'button';
      actions.append(cancelButton, startButton);
      panel.append(actions);
      backdrop.append(panel);
      shadow.append(stylesheet, backdrop);
      const facts = shadow.getElementById('facts');
      const fact = (label, value, className = '') => {
        const a = document.createElement('span'), b = document.createElement('span');
        a.className = 'label'; a.textContent = label; b.className = className; b.textContent = value;
        facts.append(a, b);
      };
      fact('Page', result.page);
      fact('Tenant', result.tenantId ? `${result.tenantId} (${result.tenantSource})` : 'Not detected', result.tenantId ? 'ok' : 'bad');
      fact('Graph', result.graphStatus, result.graphStatus === 'Ready' ? 'ok' : 'bad');
      fact('Resource Manager', result.armStatus, result.armReady ? 'ok' : 'note');
      fact('Graph permissions', result.graphPermissions.join(', ') || 'Not visible in token');
      fact('Cached results', result.cacheStatus || 'Unavailable', Object.keys(result.cacheMetadata || {}).length ? 'ok' : 'note');
      fact('Object counts', `${Object.keys(result.counts).length} categories counted`, Object.keys(result.counts).length ? 'ok' : 'note');
      const cacheChoice = element('label', null, 'cacheChoice');
      const cacheCheckbox = element('input', 'reuse-cache');
      cacheCheckbox.type = 'checkbox';
      cacheCheckbox.checked = config.useCache !== false;
      cacheCheckbox.disabled = !Object.keys(result.cacheMetadata || {}).length;
      cacheChoice.append(cacheCheckbox, element('span', null, null, 'Reuse fresh cached categories from earlier runs'));
      facts.after(cacheChoice);
      const settings = element('div', 'settings', 'settings');
      const numberField = (id, label, value, min, max) => {
        const field = element('label', null, 'setting', label), input = element('input', id);
        input.type = 'number'; input.min = String(min); input.max = String(max); input.step = '1'; input.value = String(value);
        field.append(input); settings.append(field); return input;
      };
      const concurrencyInput = numberField('concurrency', 'Concurrent workers', config.concurrency, 1, 16);
      const gapInput = numberField('throttle-ms', 'Minimum request gap (ms)', config.throttleMs, 0, 60000);
      const rateInput = numberField('requests-per-minute', 'Requests per minute (0 = unlimited)', config.requestsPerMinute, 0, 60000);
      const estimateBox = element('div', 'estimate', 'estimate');
      cacheChoice.after(element('h3', null, null, 'Request limits'), settings, estimateBox);
      if (result.issues.length) { const issues = shadow.getElementById('issues'); issues.hidden = false; issues.textContent = result.issues.join('\n'); }
      const boxes = [];
      const addOptions = (containerId, options, enabled) => {
        const container = shadow.getElementById(containerId);
        for (const [kind, label] of options) {
          const row = document.createElement('label'), checkbox = document.createElement('input'), name = document.createElement('span');
          row.className = 'choice'; checkbox.type = 'checkbox'; checkbox.dataset.kind = kind;
          checkbox.checked = enabled && (result.previousSelection ? result.previousSelection.includes(kind) : chosen(kind));
          checkbox.disabled = !enabled; name.textContent = label;
          const count = result.counts[kind];
          name.textContent += Number.isSafeInteger(count) ? ` · ${count.toLocaleString()} ${count === 1 ? 'object' : 'objects'}` : ' · count unavailable';
          if (result.cacheMetadata?.[kind]) name.textContent += ` · cached ${new Date(result.cacheMetadata[kind].savedAt).toLocaleString()}`;
          row.append(checkbox, name); container.append(row); boxes.push(checkbox);
        }
      };
      addOptions('graph', graphOptions, result.graphStatus === 'Ready');
      addOptions('arm', armOptions, !!result.armReady);
      const start = shadow.getElementById('start') as HTMLButtonElement, hint = shadow.getElementById('hint');
      const settingsValue = () => ({ concurrency: Number(concurrencyInput.value), throttleMs: Number(gapInput.value),
        requestsPerMinute: Number(rateInput.value) });
      const validSettings = value => Number.isInteger(value.concurrency) && value.concurrency >= 1 && value.concurrency <= 16
        && Number.isInteger(value.throttleMs) && value.throttleMs >= 0 && value.throttleMs <= 60000
        && Number.isInteger(value.requestsPerMinute) && value.requestsPerMinute >= 0 && value.requestsPerMinute <= 60000
        && concurrencyInput.value !== '' && gapInput.value !== '' && rateInput.value !== '';
      const duration = ms => ms < 60000 ? `${Math.max(1, Math.ceil(ms / 1000))} sec`
        : ms < 3600000 ? `${Math.ceil(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} hr`;
      const update = () => {
        const checked = new Set(boxes.filter(box => box.checked).map(box => box.dataset.kind));
        const core = ['AZUser', 'AZGroup', 'AZApp', 'AZServicePrincipal'].some(kind => checked.has(kind));
        const limits = settingsValue(), valid = validSettings(limits);
        start.disabled = result.graphStatus !== 'Ready' || !core || !valid;
        hint.textContent = result.graphStatus !== 'Ready' ? 'Graph access is required.' : !core
          ? 'Select at least one core directory category.' : !valid ? 'Enter valid request limits.' : '';
        const uncached = [...checked].filter(kind => !cacheCheckbox.checked || !result.cacheMetadata?.[kind]);
        const unknown = uncached.filter(kind => !Number.isSafeInteger(result.counts[kind]));
        const subscriptions = Math.max(1, result.counts.AZSubscription || 1);
        const requestCount = kind => {
          const count = Number.isSafeInteger(result.counts[kind]) ? result.counts[kind] : 10;
          const pageSize = { AZUser: 500, AZGroup: 99, AZApp: 99, AZServicePrincipal: 999, AZDevice: 999 }[kind] || 100;
          if (graphOptions.some(([item]) => item === kind)) {
            const pages = Math.max(1, Math.ceil(count / pageSize));
            if (kind === 'AZGroup' || kind === 'AZApp') return pages + count * 2;
            if (kind === 'AZServicePrincipal') return pages + count + Math.ceil(count / 4);
            if (kind === 'AZRole') return pages + count + 2;
            return pages;
          }
          if (kind === 'AZManagementGroup') return 1 + count * 2;
          return subscriptions + count * (kind === 'AZStorageAccount' || kind === 'AZKeyVault' ? 3 : 2);
        };
        const armSelected = uncached.some(kind => armOptions.some(([item]) => item === kind));
        const assumedRequests = (uncached.length || armSelected ? 1 : 0)
          + uncached.reduce((sum, kind) => sum + requestCount(kind), 0)
          + (armSelected && (!cacheCheckbox.checked || !result.cacheMetadata?.AZSubscription) ? 2 + subscriptions : 0);
        if (valid && core) {
          const spacing = Math.max(limits.throttleMs, limits.requestsPerMinute ? 60000 / limits.requestsPerMinute : 0);
          const baseline = Math.max((assumedRequests - 1) * spacing, Math.ceil(assumedRequests / limits.concurrency) * 250);
          estimateBox.replaceChildren(element('strong', null, null, `Estimated collection: ${duration(baseline)}–${duration(baseline * 3)}`),
            element('small', null, null, `Based on ${assumedRequests.toLocaleString()} estimated requests from initial object counts and the selected limits. ${unknown.length ? `Count unavailable for ${unknown.join(', ')}; using 10 objects each. ` : ''}Pagination, retries, and API delays can take longer.`));
        } else estimateBox.textContent = 'Select categories and enter valid request limits to see an estimate.';
      };
      shadow.addEventListener('change', update);
      shadow.addEventListener('input', update);
      update();
      let started = false;
      const cancel = () => { if (!started) { state.cancel(); host.remove(); resolve(null); } else state.cancel(); };
      shadow.getElementById('cancel').addEventListener('click', cancel);
      start.addEventListener('click', () => {
        if (start.disabled || started) return;
        started = true;
        const kinds = boxes.filter(box => box.checked).map(box => box.dataset.kind);
        const limits = settingsValue();
        const title = element('h2', 'title', null, 'Collecting Azure data');
        const summary = element('p', 'progress-summary', null, 'Starting collection…');
        const rows = element('div', 'progress-rows', 'progress-list');
        const controls = element('div', null, 'actions');
        const stop = element('button', 'stop', null, 'Stop collection');
        stop.type = 'button'; stop.addEventListener('click', () => state.cancel()); controls.append(stop);
        panel.replaceChildren(title, summary, rows, controls);
        state.popup = {
          update() {
            if (!host.isConnected || !state.running) return;
            const progress = state.progress();
            summary.textContent = `${elapsed(progress.elapsedSeconds)} · ${progress.records.toLocaleString()} records · ${progress.requests.completed} requests · ${progress.errors} errors`;
            rows.replaceChildren();
            for (const kind of [...kinds, ...(kinds.some(item => armOptions.some(([armKind]) => armKind === item)) ? ['AZSubscription'] : [])]) {
              const related = recordKindsFor(kind).map(item => progress.categories[item]).filter(Boolean);
              const category = related.length ? {
                percent: Math.round(related.reduce((sum, item) => sum + item.percent, 0) / related.length),
                status: related.every(item => ['complete', 'cached', 'skipped'].includes(item.status)) ? 'complete'
                  : related.some(item => item.status === 'partial') ? 'partial' : 'running',
                records: categoryRecordCount(kind)
              } : null;
              const row = element('div', null, 'progress-row');
              row.append(element('span', null, null, kind), element('span', null, null,
                category ? `${category.percent}% · ${category.records} records · ${category.status}` : 'Waiting'));
              rows.append(row);
            }
          },
          finish() {
            if (!host.isConnected) return;
            const issues = state.validate(), title = element('h2', 'title', null,
              issues.length ? 'Collection stopped' : 'Collection complete');
            const report = state.progress();
            const message = element('p', null, null, `${report.records.toLocaleString()} records · ${report.requests.completed} requests · ${report.errors} errors`);
            const details = element('p', null, issues.length ? 'bad' : 'ok',
              issues.length ? issues.join('; ') : 'Estimating JSON sizes and preparing ZIP parts…');
            const downloads = element('div', null, 'download-list');
            const controls = element('div', null, 'actions');
            if (!issues.length) {
              state.estimateExport().then(estimate => {
                if (!host.isConnected) return;
                const mib = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;
                details.textContent = `${estimate.jsonFiles} JSON files · ${mib(estimate.jsonBytes)} total uncompressed · ${estimate.zipFiles} ZIP ${estimate.zipFiles === 1 ? 'file' : 'files'}.`;
                for (let index = 0; index < estimate.zipFiles; index++) {
                  const button = element('button', estimate.zipFiles === 1 ? 'download-zip' : `download-zip-${index + 1}`,
                    null, estimate.zipFiles === 1 ? 'Download ZIP' : `Download ZIP ${index + 1}/${estimate.zipFiles}`);
                  button.type = 'button';
                  button.addEventListener('click', () => state.downloadZipPart(index).catch(e => error('ZIP download', e)));
                  controls.prepend(button);
                }
              }).catch(e => { details.className = 'bad'; details.textContent = `Export preparation failed: ${e.message}`; error('Export preparation', e); });
              for (const kind of [...kinds, ...(kinds.some(item => armOptions.some(([armKind]) => armKind === item)) ? ['AZSubscription'] : [])]) {
                const row = element('div', null, 'download-row');
                row.append(element('span', null, null, `${kind} · ${categoryRecordCount(kind)} records`));
                const button = element('button', null, null, 'Download JSON');
                button.type = 'button'; button.addEventListener('click', async () => {
                  try {
                    const parts = await state.listJsonParts(kind);
                    if (parts.length === 1) { await state.downloadJsonPart(kind, 0); return; }
                    button.remove();
                    let insertionPoint = row;
                    for (const part of parts) {
                      const partRow = element('div', null, 'download-row');
                      partRow.append(element('small', null, null, `${part.name} · ${(part.bytes / 1048576).toFixed(1)} MiB`));
                      const partButton = element('button', null, null, 'Download JSON');
                      partButton.type = 'button';
                      partButton.addEventListener('click', () => state.downloadJsonPart(kind, part.index).catch(e => error('JSON download', e)));
                      partRow.append(partButton); insertionPoint.after(partRow); insertionPoint = partRow;
                    }
                  } catch (e) { error('JSON download', e); }
                });
                row.append(button); downloads.append(row);
              }
            }
            if (state.cache.errors.length) downloads.append(element('p', null, 'note', `Cache: ${state.cache.errors.join('; ')}`));
            const close = element('button', 'close', null, 'Close');
            close.type = 'button'; close.addEventListener('click', () => host.remove()); controls.append(close);
            panel.replaceChildren(title, message, details, downloads, controls);
          }
        };
        state.popup.update();
        resolve({ kinds, reuse: cacheCheckbox.checked, limits });
      });
      shadow.addEventListener('keydown', (event: KeyboardEvent) => { if (event.key === 'Escape') { if (!started) cancel(); else state.cancel(); } });
      (document.body || document.documentElement).append(host);
      shadow.getElementById('cancel').focus();
    });
  }
  return showPreflight;
}
