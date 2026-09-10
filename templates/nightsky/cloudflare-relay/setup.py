#!/usr/bin/env python3
"""Configure privately; deploy only with the explicit --deploy flag."""
import argparse, hashlib, json, os, pathlib, re, secrets, subprocess, sys, stat, urllib.request, urllib.error
ROOT=pathlib.Path(__file__).resolve().parent

def write_private(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid():raise ValueError('Unsafe private output file.')
        os.fchmod(fd,0o600);os.ftruncate(fd,0)
        with os.fdopen(fd,'w') as f:fd=None;f.write(value)
    finally:
        if fd is not None:os.close(fd)

def read_private(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError('Private state must be an owner-only regular file.')
        with os.fdopen(fd) as f:fd=None;return json.load(f)
    finally:
        if fd is not None:os.close(fd)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--name',required=True);p.add_argument('--space-did',required=True)
    p.add_argument('--account-id',required=True);p.add_argument('--deploy',action='store_true');p.add_argument('--update',action='store_true');args=p.parse_args()
    if not re.fullmatch(r'[0-9a-f]{32}',args.account_id):raise ValueError('An explicit Cloudflare account ID is required.')
    if not re.fullmatch(r'[a-z][a-z0-9-]{2,49}',args.name):raise ValueError('Use a 3–50 character lowercase Worker name.')
    if not re.fullmatch(r'did:key:z[1-9A-HJ-NP-Za-km-z]{30,100}',args.space_did):raise ValueError('A complete Tonk space did:key is required.')
    private=ROOT/'.relay-private';private.mkdir(mode=0o700,exist_ok=True)
    if private.is_symlink() or private.stat().st_uid!=os.getuid():raise ValueError('Private directory owner/type mismatch.')
    os.chmod(private,0o700)
    state_path=private/'state.json'
    if state_path.exists() or state_path.is_symlink():
        if state_path.is_symlink() or state_path.stat().st_mode&0o077 or state_path.stat().st_uid!=os.getuid():raise ValueError('Private state permissions must be 0600.')
        state=read_private(state_path)
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}',state.get('token','')) or not re.fullmatch(r'[0-9a-f]{32}',state.get('epoch','')):raise ValueError('Invalid private credential state.')
        if state['name']!=args.name or state['spaceDid']!=args.space_did or state.get('accountId')!=args.account_id:raise ValueError('Existing private configuration belongs to a different Worker or space. Use a separate copy of this folder.')
    else:
        state={'accountId':args.account_id,'name':args.name,'spaceDid':args.space_did,'token':secrets.token_urlsafe(32),'epoch':secrets.token_hex(16)}
        write_private(state_path,json.dumps(state))
    config=json.loads((ROOT/'wrangler.jsonc').read_text());config['name']=args.name;config['account_id']=args.account_id;config['main']='../worker.js'
    config['vars']['RELAY_NAMESPACE']='space-'+hashlib.sha256(args.space_did.encode()).hexdigest()[:48]
    config['vars']['RELAY_AUTH_EPOCH']=state['epoch']
    config_path=private/'wrangler.json';write_private(config_path,json.dumps(config,indent=2)+'\n')
    print('Private configuration ready. No Cloudflare or Tonk changes have been made.')
    if not args.deploy:return
    wrangler=ROOT/'node_modules/.bin/wrangler'
    if not wrangler.exists():raise ValueError('Run npm ci first, then npx wrangler login.')
    def run(argv,stdin=None):
        r=subprocess.run([str(wrangler),*argv],cwd=ROOT,input=stdin,text=True,capture_output=True,timeout=180,env={**os.environ,'WRANGLER_SEND_METRICS':'false','CI':'true'})
        if r.returncode:raise ValueError('Cloudflare command failed. Output withheld to protect credentials; check account access and configuration, then retry.')
        return r.stdout+r.stderr
    auth=json.loads(run(['auth','token','--json']))
    if auth.get('type') not in ['oauth','api_token'] or not auth.get('token'):raise ValueError('Log in with Wrangler OAuth or an API token first.')
    req=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/'+args.account_id+'/workers/scripts/'+args.name,headers={'Authorization':'Bearer '+auth['token']})
    exists=True
    try:
        with urllib.request.urlopen(req,timeout=30) as response: response.read(1024)
    except urllib.error.HTTPError as error:
        body=json.loads(error.read(65536))
        if error.code==404 and any(e.get('code')==10007 for e in body.get('errors',[])):exists=False
        else:raise ValueError('Could not verify Worker ownership/absence; no deployment attempted.')
    if exists and not (args.update and state.get('deployed')):raise ValueError('Worker name already exists. Refusing overwrite without this private deployment receipt and --update.')
    if not exists and args.update:raise ValueError('Update requested but Worker does not exist.')
    run(['deploy','--dry-run','--config',str(config_path)])
    output=run(['deploy','--config',str(config_path)])
    state['deployed']=True;write_private(state_path,json.dumps(state))
    hosts=set(re.findall(r'https://('+re.escape(args.name)+r'\.[a-z0-9-]+\.workers\.dev)\b',output))
    if len(hosts)!=1:raise ValueError('Deployment returned no unique workers.dev address. Worker remains fail-closed until its secret is configured.')
    run(['secret','put','RELAY_TOKEN','--config',str(config_path)],state['token']+'\n')
    host=hosts.pop();write_private(private/'capability.txt','wss://'+host+'/?token='+state['token']+'\n')
    write_private(private/'deployment.json',json.dumps({'hostname':host,'spaceDid':args.space_did,'namespace':config['vars']['RELAY_NAMESPACE']},indent=2)+'\n')
    print('Worker deployed. Capability saved privately in .relay-private/capability.txt. Test it before updating only this space’s nightsky-relay fact.')
if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError,subprocess.TimeoutExpired,json.JSONDecodeError,urllib.error.URLError) as e:
        print(str(e) if isinstance(e,ValueError) else 'Setup failed safely; private details withheld.',file=sys.stderr);sys.exit(1)
