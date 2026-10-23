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
window.AzureHoundConfig={graphToken:'graph-test',armToken:'arm-test',download:false};
const urls=[];
window.fetch=async function(input){
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
},1000);
'''
with tempfile.TemporaryDirectory() as tmp:
    page = Path(tmp, 'test.html')
    page.write_text(f'<!doctype html><body><script>{setup}</script><script>{source}</script><script>{finish}</script></body>')
    result = subprocess.run([
        chrome, '--headless', '--no-sandbox', '--disable-gpu',
        '--disable-dev-shm-usage', '--disable-background-networking',
        f'--user-data-dir={Path(tmp, "profile")}', '--virtual-time-budget=5000',
        '--dump-dom', page.as_uri()
    ], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    match = re.search(r'<body>(.*?)</body>', result.stdout, re.S)
    assert match, result.stdout
    body = html.unescape(match.group(1))
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
window.AzureHoundConfig={graphToken:'graph-test',arm:false,download:false,
 tenantId:'11111111-2222-3333-4444-555555555555'};
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
window.AzureHoundConfig={arm:false,download:false};
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
        "window.AzureHoundConfig={graphToken:'graph-test',armToken:'arm-test',download:false};",
        """window.AzureHoundConfig={arm:false,download:false};
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
        "window.AzureHoundConfig={graphToken:'graph-test',armToken:'arm-test',download:false};",
        """window.AzureHoundConfig={graphToken:'graph-test',armToken:'arm-test',download:false,
 throttleMs:10,requestsPerMinute:3000};
window.progressMessages=[];
const originalInfo=console.info;
console.info=(...args)=>{if(args[0]==='[AzureHound] Progress') progressMessages.push(args[1]);originalInfo(...args);};""")
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
    throttle_report = json.loads(throttle_body)
    assert throttle_report['running'] is False, throttle_report
    assert len(throttle_report['times']) == 32, throttle_report
    assert min(b-a for a,b in zip(throttle_report['times'],throttle_report['times'][1:])) >= 17
    assert len(throttle_report['progress']) >= 2
    assert throttle_report['report']['progress']['requests']['completed'] == 32
    print('Passed: global request pacing and live progress')
