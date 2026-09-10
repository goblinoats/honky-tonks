import contextlib, importlib.util, io, json, os, pathlib, shutil, sys, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('setup',pathlib.Path(__file__).with_name('setup.py'));setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)
class SetupTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);shutil.copy(pathlib.Path(__file__).with_name('wrangler.jsonc'),self.root/'wrangler.jsonc');self.saved=setup.ROOT;setup.ROOT=self.root
  self.argv=['setup.py','--name','nightsky-unit','--space-did','did:key:z'+'A'*40,'--account-id','a'*32]
 def tearDown(self):setup.ROOT=self.saved;self.tmp.cleanup()
 def run_setup(self,extra=()):
  out=io.StringIO()
  with patch.object(sys,'argv',self.argv+list(extra)),contextlib.redirect_stdout(out):setup.main()
  return out.getvalue()
 def test_private_stable_no_network(self):
  with patch.object(setup.subprocess,'run',side_effect=AssertionError('network attempted')):
   out=self.run_setup();p=self.root/'.relay-private/state.json';state=json.loads(p.read_text());self.assertNotIn(state['token'],out);self.assertEqual(p.stat().st_mode&0o777,0o600);self.run_setup();self.assertEqual(json.loads(p.read_text()),state)
  for flag,value in [('--name','other-worker'),('--account-id','b'*32),('--space-did','did:key:z'+'B'*40)]:
   old=self.argv[:];self.argv[self.argv.index(flag)+1]=value
   with self.assertRaises(ValueError):self.run_setup()
   self.argv=old
 def test_symlink_and_permissions(self):
  private=self.root/'.relay-private';private.mkdir();target=self.root/'untouched';target.write_text('safe');(private/'state.json').symlink_to(target)
  with self.assertRaises((ValueError,OSError)):self.run_setup()
  self.assertEqual(target.read_text(),'safe');(private/'state.json').unlink();self.run_setup();(private/'state.json').chmod(0o644)
  with self.assertRaises(ValueError):self.run_setup()
  for name in ['wrangler.json','capability.txt','deployment.json']:
   p=private/name
   if p.exists():p.unlink()
   p.symlink_to(target)
   with self.assertRaises(OSError):setup.write_private(p,'overwrite')
   self.assertEqual(target.read_text(),'safe')
 def test_existing_worker_guard_and_partial_retry(self):
  self.run_setup();bin=self.root/'node_modules/.bin';bin.mkdir(parents=True);(bin/'wrangler').touch();calls=[]
  def run(argv,**kw):
   calls.append((argv,kw));text=json.dumps({'type':'oauth','token':'private-test-oauth'}) if 'auth' in argv else 'https://nightsky-unit.example.workers.dev'
   return type('R',(),{'returncode':0,'stdout':text,'stderr':''})()
  class Response:
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def read(self,*a):return b''
  with patch.object(setup.subprocess,'run',side_effect=run),patch.object(setup.urllib.request,'urlopen',return_value=Response()):
   with self.assertRaisesRegex(ValueError,'already exists'):self.run_setup(['--deploy'])
   self.assertFalse(any('deploy' in x[0] for x in calls));p=self.root/'.relay-private/state.json';state=json.loads(p.read_text());state['deployed']=True;setup.write_private(p,json.dumps(state));out=self.run_setup(['--deploy','--update']);self.assertNotIn(state['token'],out);self.assertIn(state['token'],(self.root/'.relay-private/capability.txt').read_text());self.assertFalse(any(state['token'] in arg for call,_ in calls for arg in call))
 def test_first_deploy_failure_keeps_receipt_for_explicit_retry(self):
  self.run_setup();bin=self.root/'node_modules/.bin';bin.mkdir(parents=True);(bin/'wrangler').touch();calls=[]
  def run(argv,**kw):
   calls.append(argv)
   if 'auth' in argv:out=json.dumps({'type':'oauth','token':'private-test-oauth'});code=0
   elif 'secret' in argv:out='private error';code=1
   else:out='https://nightsky-unit.example.workers.dev';code=0
   return type('R',(),{'returncode':code,'stdout':out,'stderr':''})()
  error=setup.urllib.error.HTTPError('https://api.cloudflare.com/',404,'missing',{},io.BytesIO(b'{"errors":[{"code":10007}]}'))
  with patch.object(setup.subprocess,'run',side_effect=run),patch.object(setup.urllib.request,'urlopen',side_effect=error):
   with self.assertRaisesRegex(ValueError,'Output withheld'):self.run_setup(['--deploy'])
  self.assertTrue(json.loads((self.root/'.relay-private/state.json').read_text())['deployed'])
  self.assertFalse((self.root/'.relay-private/capability.txt').exists())
  self.assertTrue(any('secret' in argv for argv in calls))
if __name__=='__main__':unittest.main()
