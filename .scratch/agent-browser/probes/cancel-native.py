#!/usr/bin/env python3
import os, sys, json, socket, threading, subprocess, pathlib, time, hashlib, platform, http.server, uuid, urllib.request, traceback

BIN = pathlib.Path(sys.argv[1])
CHROME = pathlib.Path(sys.argv[2])
ROOT = pathlib.Path(os.environ.get('RUUKOTO_PROBE_TMP_ROOT','/tmp')) / ('ab-fault-' + uuid.uuid4().hex[:8])
ROOT.mkdir(mode=0o700)
CFG = ROOT / 'config.json'
CFG.write_text('{}\n')
BASE_ENV = {k:v for k,v in os.environ.items() if not k.startswith('AGENT_BROWSER_') and not k.startswith('AI_GATEWAY_') and k not in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']}
counts = {}
count_lock = threading.Lock()
records = []
report = {'root':str(ROOT), 'started_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'platform':platform.platform(), 'native_sha256':hashlib.sha256(BIN.read_bytes()).hexdigest(), 'commands':records, 'cases':[]}

def metadata(cmd):
    p=subprocess.run(cmd,text=True,capture_output=True,timeout=20)
    return {'command':cmd,'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
report['native_version']=metadata([str(BIN),'--version'])
report['chrome_version']=metadata([str(CHROME),'--version'])
report['os_version']=metadata(['sw_vers'] if sys.platform=='darwin' else ['uname','-a'])
report['python_version']=sys.version

class HTTP(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        mode=self.path.rsplit('/',1)[-1]
        if self.path.startswith('/counter/'):
            with count_lock: body=json.dumps({'case':mode,'count':counts.get(mode,0)}).encode()
            mime='application/json'
        else:
            body=(f'<!doctype html><meta charset="utf-8"><title>Transport fault {mode}</title><button id="submit" onclick="fetch(\'/submit/{mode}\', {{method:\'POST\'}}).then(r=>r.json()).then(r=>document.querySelector(\'#result\').textContent=\'Submitted \'+r.count)">Submit once</button><p id="result">Not submitted</p>').encode()
            mime='text/html; charset=utf-8'
        self.send_response(200); self.send_header('Content-Type',mime); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if not self.path.startswith('/submit/'):
            self.send_error(404); return
        mode=self.path.rsplit('/',1)[-1]
        length=int(self.headers.get('Content-Length','0')); self.rfile.read(length)
        with count_lock:
            counts[mode]=counts.get(mode,0)+1
            body=json.dumps({'case':mode,'count':counts[mode]}).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)

http=http.server.ThreadingHTTPServer(('127.0.0.1',0),HTTP)
http_thread=threading.Thread(target=http.serve_forever,daemon=True);http_thread.start()
PORT=http.server_address[1]
report['http_address']=f'http://127.0.0.1:{PORT}'

def counter(mode):
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(f'http://127.0.0.1:{PORT}/counter/{mode}',timeout=2) as r: return json.load(r)

def run_cli(mode, args, timeout=50, check=True):
    run_dir=ROOT/mode; run_dir.mkdir(exist_ok=True)
    profile=run_dir/'profile'
    sock_dir=run_dir/'run';sock_dir.mkdir(exist_ok=True)
    env={**BASE_ENV,'AGENT_BROWSER_SOCKET_DIR':str(sock_dir),'AGENT_BROWSER_IDLE_TIMEOUT_MS':'0'}
    argv=[str(BIN),'--session',mode,'--profile',str(profile),'--executable-path',str(CHROME),'--config',str(CFG),'--json',*(['--args','--no-sandbox'] if os.environ.get('BROWSER_PROBE_NO_SANDBOX') == '1' else []),*args]
    started=time.monotonic()
    p=subprocess.run(argv,env=env,text=True,capture_output=True,timeout=timeout)
    r={'case':mode,'command':argv,'env':{'AGENT_BROWSER_SOCKET_DIR':str(sock_dir),'AGENT_BROWSER_IDLE_TIMEOUT_MS':'0'},'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr,'duration_seconds':round(time.monotonic()-started,3)}
    records.append(r)
    print(json.dumps({'case':mode,'args':args,'returncode':p.returncode,'duration':r['duration_seconds'],'stdout':p.stdout,'stderr':p.stderr}),flush=True)
    if check and p.returncode != 0: raise AssertionError(r)
    return r

def ps_rows():
    out=subprocess.check_output(['ps','-ww','-axo','pid=,ppid=,lstart=,command='],text=True)
    return [line.strip() for line in out.splitlines() if str(ROOT) in line]

class Proxy:
    def __init__(self, mode, original, backend):
        self.mode=mode;self.original=original;self.backend=backend
        self.readiness=0;self.forwarded=[];self.responses=[];self.errors=[];self.finished=threading.Event();self.command_completed=threading.Event();self.stopping=False;self.clients=[];self.threads=[]
        self.listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.listener.bind(str(original));self.listener.listen();self.listener.settimeout(.25)
        self.thread=threading.Thread(target=self.accept,daemon=True);self.thread.start()
    def accept(self):
        while not self.stopping:
            try: client,_=self.listener.accept()
            except socket.timeout: continue
            except OSError:
                if self.stopping: break
                raise
            self.clients.append(client)
            t=threading.Thread(target=self.handle,args=(client,),daemon=True);self.threads.append(t);t.start()
    def handle(self, client):
        try:
            client.settimeout(4)
            if self.mode=='reset':
                # Keep the accepted request unread in the receive queue; close then reports ECONNRESET to the peer on Darwin.
                while True:
                    request=client.recv(65536,socket.MSG_PEEK)
                    if not request: self.readiness+=1;return
                    if b'\n' in request: request=request.split(b'\n',1)[0]+b'\n';break
                    time.sleep(.005)
            else:
                parts=[]
                while True:
                    chunk=client.recv(65536)
                    if not chunk:
                        if not parts: self.readiness+=1;return
                        raise AssertionError('partial request without newline')
                    parts.append(chunk)
                    if b'\n' in chunk: request=b''.join(parts).split(b'\n',1)[0]+b'\n';break
            value=json.loads(request)
            self.forwarded.append({'received_at':time.time(),'request_line':request.decode(),'request':value})
            if value.get('action') not in ['click','launch']: raise AssertionError(f'unexpected proxy command {value}')
            upstream=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);upstream.settimeout(10);upstream.connect(str(self.backend));upstream.sendall(request)
            parts=[]
            while True:
                chunk=upstream.recv(65536)
                if not chunk: raise AssertionError('daemon EOF before response')
                parts.append(chunk)
                if b'\n' in chunk: break
            response=b''.join(parts).split(b'\n',1)[0]+b'\n';upstream.close()
            parsed=json.loads(response);self.responses.append({'action':value.get('action'),'response_line':response.decode(),'response':parsed})
            if value.get('action')=='launch':
                if self.mode=='reset': client.recv(len(request))
                client.sendall(response)
                return
            if parsed.get('success') is not True: raise AssertionError(f'daemon did not complete click {parsed}')
            deadline=time.monotonic()+5
            while counter(self.mode)['count']<1 and time.monotonic()<deadline:time.sleep(.01)
            if counter(self.mode)['count']!=1:raise AssertionError('click not executed once before fault')
            if self.mode=='eof': client.shutdown(socket.SHUT_WR)
            elif self.mode in ['timeout','cancel']:
                # Preserve the connection beyond the native CLI's 30-second read timeout.
                self.command_completed.set()
                client.settimeout(34)
                try:
                    data=client.recv(1)
                    if data:raise AssertionError(f'unexpected extra byte after request {data!r}')
                except socket.timeout: pass
            elif self.mode=='reset': pass
            self.finished.set()
        except Exception:
            self.errors.append(traceback.format_exc());self.finished.set()
        finally:
            client.close()
    def close(self):
        self.stopping=True;self.listener.close();self.thread.join(timeout=2)
        for c in self.clients:
            try:c.close()
            except OSError:pass
        for t in self.threads:t.join(timeout=2)
        if self.original.exists():self.original.unlink()
        self.backend.rename(self.original)
    def info(self):
        return {'readiness_empty_connections':self.readiness,'forwarded_count':len(self.forwarded),'click_send_count':sum(r['request']['action']=='click' for r in self.forwarded),'forwarded':self.forwarded,'daemon_responses':self.responses,'proxy_errors':self.errors}


mode='cancel'
case={'case':mode,'counter_endpoint':f'http://127.0.0.1:{PORT}/counter/{mode}'};report['cases'].append(case)
proxy=None;pending=None;daemon_pid=None;daemon_identity=None

def birth(pid):
    p=subprocess.run(['ps','-p',str(pid),'-o','lstart='],env={**BASE_ENV,'LC_ALL':'C','TZ':'UTC'},capture_output=True,text=True)
    return p.stdout.strip() if p.returncode==0 else None

try:
    run_cli(mode,['open',f'http://127.0.0.1:{PORT}/page/{mode}'])
    run_cli(mode,['snapshot','-i'])
    sockdir=ROOT/mode/'run';original=sockdir/f'{mode}.sock';backend=sockdir/'backend.sock'
    daemon_pid=int((sockdir/f'{mode}.pid').read_text().strip());daemon_identity=birth(daemon_pid)
    assert daemon_identity
    case['daemon_pid']=daemon_pid;case['daemon_identity']=daemon_identity;case['owned_chrome_processes_before_cancel']=ps_rows()
    original.rename(backend);proxy=Proxy(mode,original,backend)
    argv=records[-1]['command'][:-2]+['click','#submit']
    env={**BASE_ENV,'AGENT_BROWSER_SOCKET_DIR':str(sockdir),'AGENT_BROWSER_IDLE_TIMEOUT_MS':'0'}
    pending=subprocess.Popen(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    assert proxy.command_completed.wait(10),'daemon did not confirm click and POST before cancel'
    assert not proxy.errors,proxy.errors
    assert counter(mode)['count']==1
    assert pending.poll() is None, 'CLI already got response before cancellation'
    pending.terminate();stdout,stderr=pending.communicate(timeout=5)
    case['canceled_cli']={'command':argv,'pid':pending.pid,'returncode':pending.returncode,'stdout':stdout,'stderr':stderr}
    assert pending.returncode==-15 and stdout=='',case['canceled_cli']
    proxy.finished.wait(3);time.sleep(.5)
    case.update(proxy.info());case['counter_result_after_cancel']=counter(mode)
    assert case['click_send_count']==1 and case['counter_result_after_cancel']['count']==1
    assert not proxy.errors,proxy.errors
    proxy.close();proxy=None
    run_cli(mode,['screenshot',str(ROOT/mode/'after-cancel.png')])
    assert birth(daemon_pid)==daemon_identity, 'daemon identity changed before stop'
    import signal
    os.kill(daemon_pid,signal.SIGTERM)
    deadline=time.monotonic()+10
    while birth(daemon_pid)==daemon_identity or ps_rows():
        assert time.monotonic()<deadline, {'daemon':birth(daemon_pid),'chrome':ps_rows()}
        time.sleep(.05)
    case['daemon_identity_after_stop']=birth(daemon_pid);case['owned_chrome_processes_after_stop']=ps_rows()
    case['counter_result_after_stop']=counter(mode)
    assert case['counter_result_after_stop']['count']==1
    case['passed']=True;report['passed']=True
except Exception:
    case['passed']=False;report['passed']=False;report['failure']=traceback.format_exc()
finally:
    if pending and pending.poll() is None:pending.terminate();pending.communicate(timeout=5)
    if proxy:
        case.update(proxy.info());proxy.close()
    if daemon_pid and birth(daemon_pid)==daemon_identity:
        os.kill(daemon_pid,signal.SIGTERM)
        deadline=time.monotonic()+10
        while birth(daemon_pid)==daemon_identity and time.monotonic()<deadline:time.sleep(.05)
    report['remaining_daemon_identity']=birth(daemon_pid) if daemon_pid else None
    report['remaining_owned_chrome_processes']=ps_rows()
    if report['remaining_daemon_identity']==daemon_identity and daemon_identity or report['remaining_owned_chrome_processes']:report['passed']=False
    http.shutdown();http.server_close()
    (ROOT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'report':str(ROOT/'report.json'),'passed':report['passed']}),flush=True)
if not report['passed']:sys.exit(1)
