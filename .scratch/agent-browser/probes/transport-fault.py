#!/usr/bin/env python3
import os, sys, json, socket, threading, subprocess, pathlib, time, hashlib, platform, http.server, uuid, urllib.request, traceback

BIN = pathlib.Path(sys.argv[1])
CHROME = pathlib.Path(sys.argv[2])
ROOT = pathlib.Path(os.environ.get('BROWSER_PROBE_TMP','/tmp')) / ('ab-fault-' + uuid.uuid4().hex[:8])
ROOT.mkdir(mode=0o700)
CFG = ROOT / 'config.json'
CFG.write_text('{}\n')
BASE_ENV = {k:v for k,v in os.environ.items() if not k.startswith('AGENT_BROWSER_') and k not in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']}
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
        self.readiness=0;self.forwarded=[];self.responses=[];self.errors=[];self.finished=threading.Event();self.stopping=False;self.clients=[];self.threads=[]
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
                # Linux AF_UNIX 留住未读请求后关闭产生 reset；Darwin 的同一手法返回 EOF。
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
            elif self.mode=='timeout':
                # 连接保留超过原生 CLI 的 30 秒读超时，daemon 已执行的响应不再传回。
                client.settimeout(34)
                try:
                    data=client.recv(1)
                    if data:raise AssertionError(f'unexpected extra byte after request {data!r}')
                except socket.timeout:
                    # 预期：故意保留连接，触发 CLI 读超时。
                    pass
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
            except OSError:
                # 连接已在故障注入时关闭，不再向它发送请求。
                pass
        for t in self.threads:t.join(timeout=2)
        if self.original.exists():self.original.unlink()
        self.backend.rename(self.original)
    def info(self):
        return {'readiness_empty_connections':self.readiness,'forwarded_count':len(self.forwarded),'click_send_count':sum(r['request']['action']=='click' for r in self.forwarded),'forwarded':self.forwarded,'daemon_responses':self.responses,'proxy_errors':self.errors}

try:
    for mode in (['eof','timeout'] if sys.platform=='darwin' else ['reset','eof','timeout']):
        case={'case':mode,'counter_endpoint':f'http://127.0.0.1:{PORT}/counter/{mode}'};report['cases'].append(case)
        proxy=None
        try:
            run_cli(mode,['open',f'http://127.0.0.1:{PORT}/page/{mode}'])
            run_cli(mode,['snapshot','-i'])
            sockdir=ROOT/mode/'run';original=sockdir/f'{mode}.sock';backend=sockdir/'backend.sock'
            case['files_before_fault']={p.name:p.read_text() if p.suffix in ['.pid','.version','.config'] else 'unix socket' for p in sockdir.iterdir() if p.suffix in ['.pid','.version','.config','.sock']}
            case['processes_before_fault']=ps_rows()
            case['daemon_pid']=int((sockdir/f'{mode}.pid').read_text().strip())
            case['daemon_process_before_fault']=metadata(['ps','-p',str(case['daemon_pid']),'-o','pid=,ppid=,lstart=,command='])
            original.rename(backend);proxy=Proxy(mode,original,backend)
            lost=run_cli(mode,['click','#submit'],timeout=45,check=False)
            proxy.finished.wait(3);time.sleep(.7)
            case['cli_response']=lost
            case.update(proxy.info())
            case['counter_result']=counter(mode)
            response=json.loads(lost['stdout'])
            assert lost['returncode']!=0, 'CLI must report non-success'
            assert response.get('success') is False and response.get('code')=='outcome_unknown',response
            assert case['click_send_count']==1,case['forwarded']
            assert not case['proxy_errors'],case['proxy_errors']
            assert case['counter_result']['count']==1,case['counter_result']
            if mode=='timeout': assert lost['duration_seconds']>=29,lost
            if mode=='reset': assert 'Connection reset' in response.get('error','') or 'os error 54' in response.get('error','') or 'os error 104' in response.get('error',''),response
            case['passed']=True
        except Exception:
            case['passed']=False;case['failure']=traceback.format_exc();raise
        finally:
            if proxy:
                case.update(proxy.info());proxy.close()
            try:
                run_cli(mode,['screenshot',str(ROOT/mode/'after-click.png')])
            except Exception:case['screenshot_failure']=traceback.format_exc()
            try:case['close_response']=run_cli(mode,['close'],timeout=25)
            except Exception:case['close_failure']=traceback.format_exc();case['passed']=False
            time.sleep(.5)
            case['processes_after_close']=ps_rows()
            if case['processes_after_close']:case['passed']=False;case['cleanup_failure']='Chrome processes still exist after close'
            if case.get('daemon_pid'):
                case['daemon_process_after_close']=metadata(['ps','-p',str(case['daemon_pid']),'-o','pid=,ppid=,lstart=,command='])
                if case['daemon_process_after_close']['stdout'].strip():case['passed']=False;case['cleanup_failure']='daemon PID still exists after close'
            (ROOT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    report['passed']=all(c['passed'] for c in report['cases'])
except Exception:
    report['passed']=False;report['failure']=traceback.format_exc()
finally:
    http.shutdown();http.server_close()
    report['processes_after_all']=ps_rows()
    report['tracked_daemons_after_all']=[metadata(['ps','-p',str(c['daemon_pid']),'-o','pid=,ppid=,lstart=,command=']) for c in report['cases'] if c.get('daemon_pid')]
    report['finished_at']=time.strftime('%Y-%m-%dT%H:%M:%S%z')
    (ROOT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'report':str(ROOT/'report.json'),'passed':report['passed'],'remaining_processes':report['processes_after_all']}),flush=True)
if not report['passed']:sys.exit(1)
