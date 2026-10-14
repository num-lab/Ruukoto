import sys, hashlib
import os,pathlib,tempfile,subprocess,json,time,signal,threading,urllib.request
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
BIN=sys.argv[1]
CHROME=sys.argv[2]
NODE=sys.argv[3] if len(sys.argv)>3 else 'node'
ROOT=pathlib.Path(tempfile.mkdtemp(prefix='ab-own-',dir=os.environ.get('BROWSER_PROBE_TMP','/tmp')));(ROOT/'config.json').write_text('{}\n')
env={k:v for k,v in os.environ.items() if not k.startswith('AGENT_BROWSER_') and not k.startswith('AI_GATEWAY_') and k.upper() not in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']};env.update(AGENT_BROWSER_SOCKET_DIR=str(ROOT/'run'),AGENT_BROWSER_IDLE_TIMEOUT_MS='0')
records=[{'environment': {'sha256':hashlib.sha256(pathlib.Path(BIN).read_bytes()).hexdigest(),'binary':subprocess.check_output([BIN,'--version'],text=True).strip(),'chrome':subprocess.check_output([CHROME,'--version'],text=True).strip(),'node':subprocess.check_output([NODE,'--version'],text=True).strip(),'platform':os.uname().sysname,'noSandbox':os.environ.get('BROWSER_PROBE_NO_SANDBOX')=='1'}}]
def birth(pid):
 if os.uname().sysname=='Darwin':return subprocess.check_output(['ps','-p',str(pid),'-o','lstart='],env={**env,'LC_ALL':'C','TZ':'UTC'},text=True).strip()
 stat=pathlib.Path(f'/proc/{pid}/stat').read_text();return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+stat[stat.rindex(')')+1:].strip().split()[19]
def kill_known(pid,expected):
 try:actual=birth(pid)
 except (subprocess.CalledProcessError,FileNotFoundError):return 'already_stopped'
 if actual!=expected:return 'identity_mismatch'
 os.kill(pid,signal.SIGTERM);return 'signal_sent'
class Page(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(b'<h1>Owned probe</h1><button id="login" onclick="document.cookie=\'own=logged-in; Max-Age=86400; path=/\'">Login</button>')
http=ThreadingHTTPServer(('127.0.0.1',0),Page);threading.Thread(target=http.serve_forever,daemon=True).start();url='http://127.0.0.1:'+str(http.server_port)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
chrome=None;target=None;daemon=None

def launch():
 f=ROOT/'profile'/'DevToolsActivePort'
 if f.exists():f.unlink()
 p=subprocess.Popen([CHROME,*(['--no-sandbox'] if os.environ.get('BROWSER_PROBE_NO_SANDBOX')=='1' else []),'--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+str(ROOT/'profile'),url],start_new_session=True,stdout=subprocess.DEVNULL,stderr=open(ROOT/'chrome.log','a'))
 try:
  identity=birth(p.pid);f=ROOT/'profile'/'DevToolsActivePort';deadline=time.monotonic()+15
  while not f.exists():assert time.monotonic()<deadline and p.poll() is None;time.sleep(.05)
  cdp='http://127.0.0.1:'+f.read_text().splitlines()[0]
  data=json.load(opener.open(cdp+'/json/version'));records.append({'owned_chrome':p.pid,'identity':identity,'target':data['webSocketDebuggerUrl']})
  return p,identity,data['webSocketDebuggerUrl']
 except BaseException:
  if p.poll() is None:p.terminate();p.wait(timeout=10)
  records.append({'check':'launch_failed','process_pid':p.pid,'exit_code':p.returncode})
  raise

def call(*args):
 global daemon
 p=subprocess.run([BIN,'--config',str(ROOT/'config.json'),'--session','owned','--cdp',target,'--json',*args],env=env,cwd=ROOT,capture_output=True,text=True,timeout=45);d=json.loads(p.stdout);records.append({'args':args,'exit':p.returncode,'response':d,'stderr':p.stderr});assert p.returncode==0 and d['success'],d
 f=ROOT/'run'/'owned.pid'
 if f.exists():daemon=(int(f.read_text()),birth(int(f.read_text())))
 return d
def graceful_close(target,p):
 script="let sent=false;const ws=new WebSocket(process.argv[1]);ws.onopen=()=>{ws.send(JSON.stringify({id:1,method:'Browser.close'}));sent=true;};ws.onmessage=e=>process.stdout.write(e.data+'\\n');ws.onclose=()=>process.exit(sent?0:1);ws.onerror=e=>{process.stderr.write(String(e.error||e.message||'socket ended'));process.exit(sent?0:1)};setTimeout(()=>process.exit(2),5000);"
 r=subprocess.run([NODE,'-e',script,target],env=env,capture_output=True,text=True,timeout=7);assert r.returncode==0,(r.returncode,r.stderr)
 p.wait(timeout=10)
 end=time.monotonic()+5
 while time.monotonic()<end:
  out=subprocess.check_output(['ps','-axo','pid=,pgid=,command='],text=True)
  rows=[x for x in out.splitlines() if len(x.split())>2 and x.split()[1]==str(p.pid)]
  if not rows:records.append({'check':'owned_group_stopped','pgid':p.pid,'passed':True});return
  time.sleep(.1)
 raise AssertionError(rows)
try:
 chrome,identity,target=launch();call('snapshot');call('click','#login');call('screenshot',str(ROOT/'login.png'));call('snapshot')
 original=chrome.pid;os.kill(daemon[0],signal.SIGKILL);time.sleep(.4);assert chrome.poll() is None
 # 冷恢复核实原进程启动标识后经 CDP 优雅关闭自有 Chrome，并检查原进程组全部退出。
 assert birth(chrome.pid)==identity
 graceful_close(target,chrome)
 if (ROOT/'profile'/'DevToolsActivePort').exists():(ROOT/'profile'/'DevToolsActivePort').unlink()
 chrome,identity,target=launch();assert 'logged-in' in json.dumps(call('cookies'))
 # PID 身份不符不得发信号。
 unrelated=subprocess.Popen(['sleep','60'],start_new_session=True);assert kill_known(unrelated.pid,'wrong-start-token')=='identity_mismatch';assert unrelated.poll() is None;unrelated.terminate();unrelated.wait(timeout=5)
 records.append({'check':'cold_recovery_and_pid_mismatch','original_owned_pid':original,'reopened_owned_pid':chrome.pid,'unrelated_pid':unrelated.pid,'passed':True})
 call('close');assert chrome.poll() is None;assert birth(chrome.pid)==identity;graceful_close(target,chrome)
 records.append({'check':'host_owned_close','passed':True})
finally:
 cleanup_errors=[]
 if daemon:
  try:kill_known(*daemon)
  except ProcessLookupError:
   # 进程已退出，无须再向原 PID 发信号。
   pass
  except Exception as error:cleanup_errors.append(str(error))
 if chrome and chrome.poll() is None:
  try:kill_known(chrome.pid,identity);chrome.wait(timeout=10)
  except Exception as error:cleanup_errors.append(str(error))
 try:http.shutdown()
 except Exception as error:cleanup_errors.append(str(error))
 finally:
  if cleanup_errors:records.append({'check':'cleanup','passed':False,'errors':cleanup_errors})
  (ROOT/'results.json').write_text(json.dumps(records,indent=2)+'\n');print('EVIDENCE',ROOT)
 if cleanup_errors:raise RuntimeError('cleanup_failed: '+str(cleanup_errors))
