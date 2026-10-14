import sys, hashlib
import os, pathlib, tempfile, subprocess, json, threading, time, signal, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

binary = sys.argv[1]
chrome = sys.argv[2]
root = pathlib.Path(tempfile.mkdtemp(prefix='abl-', dir=os.environ.get('BROWSER_PROBE_TMP', '/tmp')))
(root/'config.json').write_text('{}\n')
env = {k:v for k,v in os.environ.items() if not k.startswith('AGENT_BROWSER_') and not k.startswith('AI_GATEWAY_') and k.upper() not in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']}
env['AGENT_BROWSER_SOCKET_DIR'] = str(root/'sockets')
env['AGENT_BROWSER_IDLE_TIMEOUT_MS'] = '0'
results = []
class Page(BaseHTTPRequestHandler):
 def log_message(self, *args): pass
 def do_GET(self):
  self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
  self.wfile.write(b'''<h1>Lifecycle</h1><input id="name" aria-label="Name"><input id="pw" aria-label="Password" type="password"><button id="login" onclick="document.cookie='probe=logged-in; Max-Age=86400; path=/'; document.getElementById('result').textContent='logged in'">Login</button><button id="next" onclick="document.getElementById('result').textContent='next round'">Next</button><p id="result">start</p>''')
server = ThreadingHTTPServer(('127.0.0.1',0),Page)
threading.Thread(target=server.serve_forever,daemon=True).start()
url = 'http://127.0.0.1:'+str(server.server_port)
sessions = set()

def call(session,*args, attached=None, extra_env=None, check=True, record=True):
 e = dict(env); e.update(extra_env or {})
 base = [binary,'--config',str(root/'config.json'),'--session',session,'--json']
 base += ['--cdp',attached] if attached else ['--profile',str(root/('profile-'+session)),'--executable-path',chrome]
 if not attached and os.environ.get('BROWSER_PROBE_NO_SANDBOX')=='1':base += ['--args','--no-sandbox']
 sessions.add(session)
 p = subprocess.run(base+list(args),env=e,cwd=root,capture_output=True,text=True,timeout=50)
 try: out = json.loads(p.stdout)
 except json.JSONDecodeError: out = {'stdout':p.stdout}
 if record: results.append({'session':session,'args':args,'returncode':p.returncode,'response':out,'stderr':p.stderr})
 if check: assert p.returncode == 0 and out.get('success'), (args,out,p.stderr)
 return out

def pid(session): return int((root/'sockets'/(session+'.pid')).read_text())
def ps():
 out = subprocess.check_output(['ps','-axo','pid=,ppid=,pgid=,lstart=,command='],text=True)
 return [line.strip() for line in out.splitlines() if str(root) in line or ('agent-browser-darwin-arm64' in line and '-c' not in line)]
def record(label,**data):
 results.append({'check':label,**data}); print(label,json.dumps({k:v for k,v in data.items() if k!='processes'}),flush=True)
def wait_gone(session,seconds=8):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if not (root/'sockets'/(session+'.pid')).exists(): return True
  time.sleep(.1)
 return False

owned=None
try:
 record('environment',sha256=hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest(),root=str(root),os=subprocess.check_output(['uname','-a'],text=True).strip(),node=subprocess.check_output(['node','--version'],text=True).strip(),chrome=subprocess.check_output([chrome,'--version'],text=True).strip(),binary=subprocess.check_output([binary,'--version'],text=True).strip())
 call('owned','open',url); original=pid('owned')
 call('owned','fill','#name','round-one'); call('owned','fill','#pw','test-secret-probe')
 snap=call('owned','snapshot','-i'); assert 'test-secret-probe' not in json.dumps(snap), 'password leaked to snapshot'
 call('owned','click','#login'); call('owned','screenshot',str(root/'round-one.png'))
 call('owned','click','#next'); snap=call('owned','snapshot'); assert 'next round' in json.dumps(snap)
 assert pid('owned')==original
 record('two-round-reuse',daemon_pid=original,processes=ps())
 call('owned','close'); assert wait_gone('owned')
 record('owned-close',processes=ps())
 call('owned','open',url); cookies=call('owned','cookies'); assert 'logged-in' in json.dumps(cookies)
 call('isolated','open',url); assert 'logged-in' not in json.dumps(call('isolated','cookies'))
 record('profile-persistence-and-isolation')
 before=pid('owned'); call('owned','snapshot',extra_env={'AGENT_BROWSER_DEFAULT_TIMEOUT':'4000'}); after=pid('owned'); assert before!=after
 record('fingerprint-restart',before=before,after=after,processes=ps())
 os.kill(after,signal.SIGTERM); assert wait_gone('owned'); record('owned-sigterm',processes=ps())
 call('owned','open',url); crashed=pid('owned'); os.kill(crashed,signal.SIGKILL); time.sleep(.5)
 record('daemon-sigkill',daemon_pid=crashed,processes=ps())
 recovered=call('owned','open',url,check=False); record('cold-reopen-after-sigkill',response=recovered,processes=ps())
 # 如果上游强杀后残留浏览器锁住 profile，保持现场且只终止本探针专属 profile 的 Chrome。
 if not recovered.get('success'):
  lines=subprocess.check_output(['ps','-axo','pid=,command='],text=True).splitlines()
  for line in lines:
   if ('--user-data-dir='+str(root/'profile-owned')) in line and chrome in line:
    os.kill(int(line.strip().split(None,1)[0]),signal.SIGTERM)
  time.sleep(1)
 call('owned','close',check=False)
 call('idle','open',url,extra_env={'AGENT_BROWSER_IDLE_TIMEOUT_MS':'1500'}); idle=pid('idle'); assert wait_gone('idle',10)
 record('idle-reap',daemon_pid=idle,processes=ps())
 # 附接只使用本探针直接启动的独立 Chrome，退出不得关闭它。
 owned=subprocess.Popen([chrome,*(['--no-sandbox'] if os.environ.get('BROWSER_PROBE_NO_SANDBOX')=='1' else []),'--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+str(root/'external'),url],stdout=subprocess.DEVNULL,stderr=open(root/'chrome-external.log','w'))
 end=time.monotonic()+15
 while not (root/'external'/'DevToolsActivePort').exists():
  assert time.monotonic()<end and owned.poll() is None; time.sleep(.1)
 port=(root/'external'/'DevToolsActivePort').read_text().splitlines()[0]; cdp='http://127.0.0.1:'+port
 call('attached','snapshot',attached=cdp); tabs_before=json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(cdp+'/json/list')); call('attached','close',attached=cdp); assert wait_gone('attached'); assert owned.poll() is None
 tabs_after=json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(cdp+'/json/list')); assert {x['id'] for x in tabs_before}=={x['id'] for x in tabs_after}
 call('attached','snapshot',attached=cdp); os.kill(pid('attached'),signal.SIGTERM); assert wait_gone('attached'); assert owned.poll() is None
 record('attach-close-and-sigterm-preserve',chrome_pid=owned.pid,tab_ids=[x['id'] for x in tabs_after])
 record('result',status='completed',pending=['PID mismatch guard / exclusive attach are host-owned mechanisms','cancel inflight and dashboard not run in this script'])
finally:
 errors=[]
 for session in sessions:
  if (root/'sockets'/(session+'.pid')).exists():
   try:call(session,'close',attached=cdp if session=='attached' and 'cdp' in locals() else None,check=False)
   except Exception as error:errors.append({'session':session,'failure':repr(error)})
 try:
  if owned and owned.poll() is None:owned.terminate();owned.wait(timeout=10)
 except Exception as error:errors.append({'external_cleanup_failure':repr(error)})
 try:server.shutdown()
 finally:
  results.append({'cleanup_failures':errors,'remaining_processes':ps()})
  (root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
  print('EVIDENCE',root,flush=True)
 if errors:raise RuntimeError('探针清理失败，请查看 results.json')
