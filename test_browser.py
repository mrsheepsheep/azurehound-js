"""End-to-end browser smoke test with mocked Microsoft APIs and ZIP validation."""
import base64
import html
import io
import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

chrome = shutil.which('google-chrome') or shutil.which('chromium')
if not chrome:
    raise SystemExit('Chrome or Chromium required for browser smoke test')
source = Path(__file__).with_name('collector.js').read_text()
setup = r'''
window.AzureHoundConfig={graphToken:'graph-test',armToken:'arm-test',download:false,interactive:false,useCache:false};
const urls=[];
window.fetch=async function(input,init){
  const url=new URL(input); urls.push(url.href);
  let value=[];
  if(url.pathname==='/v1.0/organization') value=[{id:'11111111-2222-3333-4444-555555555555',displayName:'Test Tenant'}];
  if(url.pathname==='/v1.0/users') value=[{id:'u1',displayName:'User One'}];
  if(url.pathname==='/v1.0/groups') value=[{id:'g1',displayName:'Group One'}];
  if(url.pathname==='/v1.0/applications') value=[{id:'a1',appId:'app1',displayName:'App One'}];
  if(url.pathname==='/v1.0/servicePrincipals') value=[{id:'sp1',appId:'app1',displayName:'Service Principal One'}];
  if(url.pathname==='/beta/groups/g1/members') value=[{id:'u1'}];
  if(url.pathname==='/v1.0/roleManagement/directory/roleDefinitions') value=[{id:'r1'}];
  if(url.pathname==='/subscriptions') value=[{id:'/subscriptions/s1',subscriptionId:'s1',tenantId:'11111111-2222-3333-4444-555555555555'}];
  if(url.pathname==='/subscriptions/s1/providers/Microsoft.Storage/storageAccounts')
    value=[{id:'/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/sa1',name:'sa1'}];
  if(url.pathname.endsWith('/roleAssignments') && url.hostname==='management.azure.com')
    value=[{id:'role1',properties:{principalId:'u1',roleDefinitionId:'8e3af657-a8ff-443c-a75c-2fe8c4bcb635'}}];
  let body={value};
  if(url.searchParams.get('$count')==='true') body['@odata.count']={
    '/v1.0/users':2,'/v1.0/groups':1,'/v1.0/applications':1,
    '/v1.0/servicePrincipals':1,'/v1.0/devices':0,
    '/v1.0/roleManagement/directory/roleDefinitions':1
  }[url.pathname];
  if(url.pathname==='/providers/Microsoft.ResourceGraph/resources'){
    const query=JSON.parse(init.body).query;
    body={data:query.startsWith('Resources')
      ?[{type:'microsoft.storage/storageaccounts',kind:'',total:1}]
      :[{type:'microsoft.resources/subscriptions/resourcegroups',total:0}]};
  }
  if(url.pathname==='/v1.0/users'&&!url.searchParams.has('$skiptoken'))
    body['@odata.nextLink']='https://graph.microsoft.com/v1.0/users?$skiptoken=2';
  if(url.pathname==='/v1.0/users'&&url.searchParams.has('$skiptoken')) body={value:[{id:'u2'}]};
  return {ok:true,status:200,json:async()=>body,headers:new Headers()};
};
'''
finish = r'''
setTimeout(async()=>{
  try {
    const state=window.AzureHound;
    const bytes=new Uint8Array(await (await state.makeZip()).arrayBuffer());
    document.body.textContent=JSON.stringify({running:state.running,errors:state.errors,
      counts:state.counts,urls,zip:btoa(String.fromCharCode(...bytes))});
  } catch(e) { document.body.textContent='ERROR '+e.stack; }
},2500);
'''
with tempfile.TemporaryDirectory() as tmp:
    page = Path(tmp, 'test.html')
    page.write_text(f'<!doctype html><body><script>{setup}</script><script>{source}</script><script>{finish}</script></body>')
    result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu',
        '--disable-dev-shm-usage', '--disable-background-networking',
        f'--user-data-dir={Path(tmp, "profile")}', '--virtual-time-budget=8000',
        '--dump-dom', page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    match = re.search(r'<body>(.*?)</body>', result.stdout, re.S)
    assert match, result.stdout
    body = html.unescape(match.group(1))
    assert body.startswith('{') or body.startswith('ERROR'), body[-1200:]
    assert not body.startswith('ERROR'), body
    report = json.loads(body)
    assert report['running'] is False
    assert not report['errors'], report['errors']
    assert any('$skiptoken=2' in url for url in report['urls'])
    archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(report['zip'])))
    assert archive.testzip() is None
    assert archive.namelist() == ['azurehound.json']
    assert archive.infolist()[0].compress_type == zipfile.ZIP_DEFLATED
    all_data = []
    for name in archive.namelist():
        collection = json.loads(archive.read(name))
        assert collection['meta'] == {'type': 'azure', 'version': 5, 'count': len(collection['data'])}
        assert collection['data']
        all_data.extend(collection['data'])
    by_kind = {}
    for entry in all_data:
        by_kind.setdefault(entry['kind'], []).append(entry['data'])
    assert [entry['id'] for entry in by_kind['AZUser']] == ['U1', 'U2']
    assert by_kind['AZTenant'][0]['collected'] is True
    assert by_kind['AZSubscriptionOwner'][0]['owners'][0]['owner']['properties']['principalId'] == 'U1'
    assert by_kind['AZStorageAccount'][0]['resourceGroupId'] == '/SUBSCRIPTIONS/S1/RESOURCEGROUPS/RG1'
    assert by_kind['AZStorageAccountRoleAssignment'][0]['assignees'][0]['roleDefinitionId'] == '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'
    print(f"Passed: {len(archive.namelist())} valid ZIP files; {len(report['urls'])} mocked API calls")

    empty_page = Path(tmp, 'empty.html')
    empty_page.write_text('''<!doctype html><body><script>
window.AzureHoundConfig={graphToken:'graph-test',arm:false,download:false,interactive:false,
 tenantId:'11111111-2222-3333-4444-555555555555',useCache:false};
window.fetch=async()=>({ok:true,status:200,json:async()=>({value:[]}),headers:new Headers()});
</script><script>''' + source + '''</script><script>
setTimeout(()=>{const s=window.AzureHound;document.body.textContent=JSON.stringify({issues:s.validate(),errors:s.errors});},1000);
</script></body>''')
    empty_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "empty-profile")}', '--virtual-time-budget=5000',
        '--dump-dom', empty_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert empty_result.returncode == 0, empty_result.stderr
    empty_body = html.unescape(re.search(r'<body>(.*?)</body>', empty_result.stdout, re.S).group(1))
    empty_report = json.loads(empty_body)
    assert 'No core directory objects with IDs were collected' in empty_report['issues']
    assert empty_report['errors']
    print('Passed: empty directory collection is rejected')

    ambiguous_page = Path(tmp, 'ambiguous.html')
    ambiguous_page.write_text('''<!doctype html><body><script>
window.AzureHoundConfig={arm:false,download:false,interactive:false};
function token(tid){return 'e30.'+btoa(JSON.stringify({aud:'https://graph.microsoft.com',tid,
 exp:Math.floor(Date.now()/1000)+3600,scp:'Directory.Read.All'})).replace(/=/g,'')+'.sig';}
localStorage.setItem('msal.accessToken.one',JSON.stringify({secret:token('11111111-2222-3333-4444-555555555555')}));
localStorage.setItem('msal.accessToken.two',JSON.stringify({secret:token('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')}));
</script><script>''' + source + '''</script><script>
setTimeout(()=>{const s=window.AzureHound;document.body.textContent=JSON.stringify({running:s.running,
 tenants:s.availableTenantIds,selected:s.report().targetTenantId});},1000);
</script></body>''')
    ambiguous_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "ambiguous-profile")}', '--virtual-time-budget=5000',
        '--dump-dom', ambiguous_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert ambiguous_result.returncode == 0, ambiguous_result.stderr
    ambiguous_body = html.unescape(re.search(r'<body>(.*?)</body>', ambiguous_result.stdout, re.S).group(1))
    ambiguous_report = json.loads(ambiguous_body)
    assert ambiguous_report['running'] is False
    assert len(ambiguous_report['tenants']) == 2
    assert ambiguous_report['selected'] is None
    print('Passed: ambiguous cached tenants require explicit selection')

    active_setup = setup.replace(
        "window.AzureHoundConfig={graphToken:'graph-test',armToken:'arm-test',download:false,interactive:false,useCache:false};",
        """window.AzureHoundConfig={arm:false,download:false,interactive:false,useCache:false};
function token(tid){return 'e30.'+btoa(JSON.stringify({aud:'https://graph.microsoft.com',tid,
 exp:Math.floor(Date.now()/1000)+3600,scp:'Directory.Read.All RoleManagement.Read.Directory'})).replace(/=/g,'')+'.sig';}
localStorage.setItem('msal.accessToken.one',JSON.stringify({secret:token('11111111-2222-3333-4444-555555555555')}));
localStorage.setItem('msal.accessToken.two',JSON.stringify({secret:token('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')}));
localStorage.setItem('msal.client.active-account-filters',JSON.stringify({localAccountId:'active-user'}));
localStorage.setItem('account.active',JSON.stringify({localAccountId:'active-user',realm:'11111111-2222-3333-4444-555555555555'}));
localStorage.setItem('account.old',JSON.stringify({localAccountId:'old-user',realm:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}));""")
    active_page = Path(tmp, 'active.html')
    active_page.write_text('<!doctype html><body><script>' + active_setup + '</script><script>' + source + '''</script><script>
setTimeout(()=>{const s=window.AzureHound;document.body.textContent=JSON.stringify({report:s.report(),issues:s.validate()});},1000);
</script></body>''')
    active_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "active-profile")}', '--virtual-time-budget=5000',
        '--dump-dom', active_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert active_result.returncode == 0, active_result.stderr
    active_body = html.unescape(re.search(r'<body>(.*?)</body>', active_result.stdout, re.S).group(1))
    active_report = json.loads(active_body)
    assert active_report['report']['targetTenantId'] == '11111111-2222-3333-4444-555555555555'
    assert active_report['report']['tenantSource'] == 'active MSAL account'
    assert not active_report['issues'], active_report
    print('Passed: active account selects tenant despite multiple cached tenants')

    partial_setup = setup.replace(
        '  return {ok:true,status:200,json:async()=>body,headers:new Headers()};',
        """  if(url.pathname==='/v1.0/roleManagement/directory/roleDefinitions')
    return {ok:false,status:403,json:async()=>({error:{message:'Insufficient privileges'}}),headers:new Headers()};
  return {ok:true,status:200,json:async()=>body,headers:new Headers()};""")
    partial_page = Path(tmp, 'partial.html')
    partial_page.write_text('<!doctype html><body><script>' + partial_setup + '</script><script>' + source + '''</script><script>
setTimeout(async()=>{const s=window.AzureHound;try{
 const archive=await s.makeZip();document.body.textContent=JSON.stringify({size:archive.size,report:s.report()});
}catch(e){document.body.textContent='ERROR '+e.message;}},1000);
</script></body>''')
    partial_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "partial-profile")}', '--virtual-time-budget=5000',
        '--dump-dom', partial_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert partial_result.returncode == 0, partial_result.stderr
    partial_body = html.unescape(re.search(r'<body>(.*?)</body>', partial_result.stdout, re.S).group(1))
    assert not partial_body.startswith('ERROR'), partial_body
    partial_report = json.loads(partial_body)
    assert partial_report['size'] > 0
    assert partial_report['report']['importable'] is True
    assert partial_report['report']['errors']
    assert any('AZRole' in warning for warning in partial_report['report']['warnings'])
    print('Passed: ZIP builds when optional role collection fails')

    throttle_setup = setup.replace(
        "window.AzureHoundConfig={graphToken:'graph-test',armToken:'arm-test',download:false,interactive:false,useCache:false};",
        """window.AzureHoundConfig={graphToken:'graph-test',armToken:'arm-test',download:false,interactive:false,useCache:false,
 throttleMs:10,requestsPerMinute:3000};
window.progressMessages=[];
const originalInfo=console.info;
console.info=(...args)=>{if(typeof args[0]==='string'&&args[0].includes('%c'))
 progressMessages.push({format:args[0],types:args.map(value=>typeof value)});originalInfo(...args);};""")
    throttle_setup = throttle_setup.replace('urls.push(url.href);', 'urls.push({url:url.href,at:performance.now()});')
    throttle_page = Path(tmp, 'throttle.html')
    throttle_page.write_text('<!doctype html><body><script>' + throttle_setup + '</script><script>' + source + '''</script><script>
setTimeout(()=>{const s=window.AzureHound;document.body.textContent=JSON.stringify({
 times:urls.map(value=>value.at),progress:progressMessages,report:s.report(),running:s.running
});},1500);
</script></body>''')
    throttle_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "throttle-profile")}', '--virtual-time-budget=6000',
        '--dump-dom', throttle_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert throttle_result.returncode == 0, throttle_result.stderr
    throttle_body = html.unescape(re.search(r'<body>(.*?)</body>', throttle_result.stdout, re.S).group(1))
    assert throttle_body.startswith('{'), throttle_body[-1200:]
    throttle_report = json.loads(throttle_body)
    assert throttle_report['running'] is False, throttle_report
    assert len(throttle_report['times']) == 32, throttle_report
    assert min(b-a for a,b in zip(throttle_report['times'],throttle_report['times'][1:])) >= 17
    assert len(throttle_report['progress']) >= 2
    assert all('%c' in message['format'] and set(message['types']) == {'string'}
               for message in throttle_report['progress'])
    assert any('%' in message['format'] and 'AZUser' in message['format']
               for message in throttle_report['progress'])
    assert throttle_report['report']['progress']['requests']['completed'] == 32
    print('Passed: global request pacing and live progress')

    category_setup = setup.replace(
        "if(url.pathname==='/v1.0/groups') value=[{id:'g1',displayName:'Group One'}];",
        "if(url.pathname==='/v1.0/groups') value=[{id:'g1',displayName:'Group One'},{id:'g2',displayName:'Group Two'}];")
    category_setup = category_setup.replace(
        '  return {ok:true,status:200,json:async()=>body,headers:new Headers()};',
        """  if(url.pathname==='/beta/groups/g1/members') await new Promise(resolve=>setTimeout(resolve,50));
  if(url.pathname==='/beta/groups/g2/members') await new Promise(resolve=>setTimeout(resolve,300));
  return {ok:true,status:200,json:async()=>body,headers:new Headers()};""")
    category_page = Path(tmp, 'categories.html')
    category_page.write_text('<!doctype html><body><script>' + category_setup + '</script><script>' + source + '''</script><script>
let intermediate=null;
setTimeout(()=>{intermediate=window.AzureHound.progress().categories.AZGroupMember;},150);
setTimeout(()=>{const s=window.AzureHound;document.body.textContent=JSON.stringify({
 intermediate,final:s.progress().categories.AZGroupMember,percentages:s.progress().percentages,
 user:s.progress().categories.AZUser
});},1000);
</script></body>''')
    category_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "category-profile")}', '--virtual-time-budget=5000',
        '--dump-dom', category_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert category_result.returncode == 0, category_result.stderr
    category_body = html.unescape(re.search(r'<body>(.*?)</body>', category_result.stdout, re.S).group(1))
    category_report = json.loads(category_body)
    assert category_report['intermediate']['percent'] == 50, category_report
    assert category_report['final']['percent'] == 100, category_report
    assert category_report['final']['status'] == 'complete', category_report
    assert category_report['percentages']['AZGroupMember'] == 100
    assert category_report['user']['percent'] == 100
    print('Passed: category percentages advance from 50% to 100%')

    interactive_setup = setup.replace('interactive:false', 'interactive:true')
    interactive_page = Path(tmp, 'interactive.html')
    interactive_page.write_text('<!doctype html><body><script>' + interactive_setup + '</script><script>' + source + '''</script><script>
let popupSeen=false,estimateBefore='',estimateAfter='',appLabel='';
setTimeout(()=>{const host=document.getElementById('azurehound-preflight');popupSeen=!!host;
 const root=host.shadowRoot;
 for(const box of root.querySelectorAll('input[data-kind]')) box.checked=box.dataset.kind==='AZApp';
 root.querySelector('input[data-kind="AZApp"]').dispatchEvent(new Event('change',{bubbles:true}));
 appLabel=root.querySelector('input[data-kind="AZApp"]').parentElement.textContent;
 estimateBefore=root.getElementById('estimate').textContent;
 root.getElementById('concurrency').value='1';
 root.getElementById('concurrency').dispatchEvent(new Event('input',{bubbles:true}));
 estimateAfter=root.getElementById('estimate').textContent;
 root.getElementById('start').click();
},100);
setTimeout(async()=>{try{const s=window.AzureHound;document.body.textContent=JSON.stringify({
 popupSeen,estimateBefore,estimateAfter,appLabel,selected:s.report().selectedKinds,preflight:s.preflight.graphStatus,
 initialCounts:s.report().initialCounts,
 throttling:s.report().throttling,popupComplete:!!s.popup&&!!document.getElementById('azurehound-preflight').shadowRoot.getElementById('download-zip'),
 jsonButtons:document.getElementById('azurehound-preflight').shadowRoot.querySelectorAll('.download-row button').length,
 counts:s.counts,issues:s.validate(),urls,jsonSize:(await s.makeJson('AZApp')).size
});}catch(e){document.body.textContent='ERROR '+e.stack;}},1300);
</script></body>''')
    interactive_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "interactive-profile")}', '--virtual-time-budget=8000',
        '--dump-dom', interactive_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert interactive_result.returncode == 0, interactive_result.stderr
    interactive_body = html.unescape(re.search(r'<body>(.*?)</body>', interactive_result.stdout, re.S).group(1))
    assert interactive_body.startswith('{'), interactive_body[-2000:]
    interactive_report = json.loads(interactive_body)
    assert interactive_report['popupSeen'] is True
    assert interactive_report['estimateBefore'] != interactive_report['estimateAfter']
    assert 'Estimated collection:' in interactive_report['estimateAfter']
    assert interactive_report['throttling'] == {'concurrency': 1, 'throttleMs': 0, 'requestsPerMinute': 0}
    assert interactive_report['popupComplete'] is True
    assert interactive_report['jsonButtons'] == 1
    assert interactive_report['jsonSize'] > 0
    assert interactive_report['preflight'] == 'Ready'
    assert interactive_report['initialCounts']['AZApp'] == 1
    assert '1 object' in interactive_report['appLabel']
    assert interactive_report['selected'] == ['AZApp']
    assert interactive_report['counts']['AZApp'] == 1
    assert 'AZUser' not in interactive_report['counts']
    assert 'AZSubscription' not in interactive_report['counts']
    assert not interactive_report['issues']
    assert interactive_report['jsonSize'] > 0
    assert not any('/v1.0/users' in url and '%24count=true' not in url for url in interactive_report['urls'])
    print('Passed: preflight popup selects application-only collection')

    large_count_setup = interactive_setup.replace("'/v1.0/applications':1,", "'/v1.0/applications':100,")
    large_count_page = Path(tmp, 'large-count.html')
    large_count_page.write_text('<!doctype html><body><script>' + large_count_setup + '</script><script>' + source + '''</script><script>
setTimeout(()=>{const root=document.getElementById('azurehound-preflight').shadowRoot;
 for(const box of root.querySelectorAll('input[data-kind]')) box.checked=box.dataset.kind==='AZApp';
 root.querySelector('input[data-kind="AZApp"]').dispatchEvent(new Event('change',{bubbles:true}));
 document.body.textContent=JSON.stringify({estimate:root.getElementById('estimate').textContent,
  count:window.AzureHound.preflight.counts.AZApp});
},300);
</script></body>''')
    large_count_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "large-count-profile")}', '--virtual-time-budget=4000',
        '--dump-dom', large_count_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert large_count_result.returncode == 0, large_count_result.stderr
    large_count_body = html.unescape(re.search(r'<body>(.*?)</body>', large_count_result.stdout, re.S).group(1))
    large_count_report = json.loads(large_count_body)
    assert large_count_report['count'] == 100
    assert large_count_report['estimate'] != interactive_report['estimateBefore']
    print('Passed: preflight object counts change the time estimate')

    trusted_page = Path(tmp, 'trusted-types.html')
    trusted_page.write_text(interactive_page.read_text().replace(
        '<!doctype html><body>',
        '<!doctype html><head><meta http-equiv="Content-Security-Policy" content="require-trusted-types-for \'script\'"></head><body>'))
    trusted_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "trusted-profile")}', '--virtual-time-budget=8000',
        '--dump-dom', trusted_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert trusted_result.returncode == 0, trusted_result.stderr
    trusted_body = html.unescape(re.search(r'<body>(.*?)</body>', trusted_result.stdout, re.S).group(1))
    trusted_report = json.loads(trusted_body)
    assert trusted_report['popupSeen'] is True
    assert trusted_report['selected'] == ['AZApp']
    assert not trusted_report['issues']
    print('Passed: preflight popup works with Trusted Types enforcement')

    cancel_page = Path(tmp, 'cancel.html')
    cancel_page.write_text('<!doctype html><body><script>' + interactive_setup + '</script><script>' + source + '''</script><script>
setTimeout(()=>document.getElementById('azurehound-preflight').shadowRoot.getElementById('cancel').click(),100);
setTimeout(()=>{const s=window.AzureHound;document.body.textContent=JSON.stringify({
 running:s.running,cancelled:s.report().cancelled,counts:s.counts,urls
});},500);
</script></body>''')
    cancel_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "cancel-profile")}', '--virtual-time-budget=3000',
        '--dump-dom', cancel_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert cancel_result.returncode == 0, cancel_result.stderr
    cancel_body = html.unescape(re.search(r'<body>(.*?)</body>', cancel_result.stdout, re.S).group(1))
    cancel_report = json.loads(cancel_body)
    assert cancel_report['running'] is False
    assert cancel_report['cancelled'] is True
    assert not cancel_report['counts']
    assert len(cancel_report['urls']) == 10
    print('Passed: preflight cancellation stops before full collection')

    split_setup = setup.replace('useCache:false};', 'useCache:false,maxJsonBytes:1000,maxZipBytes:3000};')
    split_page = Path(tmp, 'split.html')
    split_page.write_text('<!doctype html><body><script>' + split_setup + '''
Object.defineProperty(window,'CompressionStream',{value:undefined});
</script><script>''' + source + '''</script><script>
setTimeout(async()=>{try{const s=window.AzureHound;
 s.files.AZGroupMember[0].data.members=Array.from({length:80},(_,i)=>({member:{id:'member-'+i},groupId:'G1'}));
 const estimate=await s.estimateExport(), archiveSizes=[];
 let firstZip='';
 for(let i=0;i<estimate.zipFiles;i++){
  const blob=await s.makeZipPart(i);archiveSizes.push(blob.size);
  if(i===0){const bytes=new Uint8Array(await blob.arrayBuffer());firstZip=btoa(String.fromCharCode(...bytes));}
 }
 const groupParts=await s.listJsonParts('AZGroup');
 document.body.textContent=JSON.stringify({estimate,archiveSizes,groupParts,firstZip});
}catch(e){document.body.textContent='ERROR '+e.stack;}},2500);
</script></body>''')
    split_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "split-profile")}', '--virtual-time-budget=10000',
        '--dump-dom', split_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert split_result.returncode == 0, split_result.stderr
    split_body = html.unescape(re.search(r'<body>(.*?)</body>', split_result.stdout, re.S).group(1))
    assert split_body.startswith('{'), split_body[-1200:]
    split_report = json.loads(split_body)
    assert split_report['estimate']['zipFiles'] > 1
    assert split_report['estimate']['jsonFiles'] > 1
    assert len(split_report['archiveSizes']) == split_report['estimate']['zipFiles']
    assert all(size <= 3000 for size in split_report['archiveSizes'])
    first_archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(split_report['firstZip'])))
    assert first_archive.testzip() is None
    assert len(first_archive.namelist()) > 1
    for name in first_archive.namelist():
        raw = first_archive.read(name)
        assert len(raw) <= 1000
        collection = json.loads(raw)
        assert collection['meta'] == {'type': 'azure', 'version': 5, 'count': len(collection['data'])}
        assert any(entry['kind'] == 'AZTenant' and entry['data'].get('collected') for entry in collection['data'])
    assert len(split_report['groupParts']) > 1
    assert all(part['bytes'] <= 1000 for part in split_report['groupParts'])
    print('Passed: bounded JSON parts and multiple ZIPs are planned and built')

    cache_page = Path(tmp, 'chunk-cache.html')
    cache_script = r'''
window.AzureHoundConfig={graphToken:'graph-test',arm:false,download:false,interactive:false,useCache:true,
 tenantId:'11111111-2222-3333-4444-555555555555',categories:['AZGroup'],maxJsonBytes:1000};
const stores={data:new Map(),meta:new Map()};
const database={objectStoreNames:{contains:()=>true},createObjectStore:()=>{},
 transaction:()=>{const tx={oncomplete:null,onerror:null,onabort:null,objectStore:name=>({
  get:key=>{const req={};queueMicrotask(()=>{req.result=stores[name].get(key);req.onsuccess();});return req;},
  put:value=>{stores[name].set(value.key,value);queueMicrotask(()=>tx.oncomplete?.());},
  delete:key=>{stores[name].delete(key);queueMicrotask(()=>tx.oncomplete?.());}
 })};return tx;}};
Object.defineProperty(window,'indexedDB',{value:{open:()=>{const req={result:database};
 queueMicrotask(()=>req.onsuccess());return req;}}});
let paths=[];
window.fetch=async input=>{const url=new URL(input);paths.push(url.pathname);
 const value=url.pathname==='/v1.0/organization'?[{id:'11111111-2222-3333-4444-555555555555'}]
  :url.pathname==='/v1.0/groups'?[{id:'g1'}]
  :url.pathname==='/beta/groups/g1/members'?Array.from({length:80},(_,i)=>({id:'u'+i})):[];
 return {ok:true,status:200,json:async()=>({value}),headers:new Headers()};};
const collectorSource=SOURCE;
(async()=>{try{await eval(collectorSource);const first=window.AzureHound;await first.cacheReady;
 const firstPaths=paths.slice(),storedParts=stores.meta.values().next().value.parts;
 paths=[];await eval(collectorSource);const second=window.AzureHound;
 document.body.textContent=JSON.stringify({firstPaths,secondPaths:paths,storedParts,
  cache:second.cache,counts:second.counts,issues:second.validate()});
}catch(e){document.body.textContent='ERROR '+e.stack;}})();
'''.replace('SOURCE', json.dumps(source))
    cache_page.write_text('<!doctype html><body><script>' + cache_script + '</script></body>')
    cache_result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        f'--user-data-dir={Path(tmp, "chunk-cache-profile")}', '--virtual-time-budget=5000',
        '--dump-dom', cache_page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert cache_result.returncode == 0, cache_result.stderr
    cache_body = html.unescape(re.search(r'<body>(.*?)</body>', cache_result.stdout, re.S).group(1))
    assert cache_body.startswith('{'), cache_body[-1200:]
    cache_report = json.loads(cache_body)
    assert '/v1.0/groups' in cache_report['firstPaths']
    assert cache_report['secondPaths'] == ['/v1.0/organization']
    assert cache_report['storedParts'] > 1
    assert cache_report['cache']['reused'] == ['AZGroup']
    assert cache_report['counts']['AZGroupMember'] > 1
    assert not cache_report['issues']
    print('Passed: bounded cache chunks are reused without repeat API collection')
