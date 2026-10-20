import os,pty,subprocess,tempfile,pathlib,socketserver,http.server,json,threading,select,time,shutil
root=pathlib.Path(tempfile.mkdtemp(prefix='rk19-pty-',dir='/tmp'))
transcript=bytearray();routes=[];done=False
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  routes.append('GET '+self.path)
  self.reply({'items':[] if done else [{'ref':{'taskId':12,'admission':34},'unit':'example.service','scope':'后台分析的固定检查','canRecheck':True}]})
 def do_POST(self):
  global done
  routes.append('POST '+self.path);done=True;self.reply({'requested':True})
 def reply(self,result):
  assert self.headers['Authorization']=='Bearer '+'a'*64
  data=json.dumps({'v':1,'ok':True,'result':result}).encode();self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
(root/'control.token').write_text('a'*64+'\n')
server=socketserver.UnixStreamServer(str(root/'control.sock'),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
master,slave=pty.openpty();env={**os.environ,'RUUKOTO_PERSONAL_DIR':str(root)}
proc=subprocess.Popen(['node','--import','tsx','apps/ruukoto/src/personal-entry.ts'],stdin=slave,stdout=slave,stderr=slave,env=env);os.close(slave)
try:
 for index,answer in enumerate(['14','1','2','2','10'],1):
  deadline=time.monotonic()+20
  while transcript.decode(errors='replace').count('请选择：')<index:
   assert time.monotonic()<deadline, 'PTY prompt timeout'
   if select.select([master],[],[],.2)[0]: transcript.extend(os.read(master,65536))
  os.write(master,(answer+'\n').encode())
 deadline=time.monotonic()+10
 while proc.poll() is None:
  assert time.monotonic()<deadline, "PTY exit timeout"
  if select.select([master],[],[],.2)[0]:
   try: transcript.extend(os.read(master,65536))
   except OSError: pass
 pathlib.Path("/tmp/rk19-pty-debug.log").write_bytes(transcript)
 assert proc.returncode==0
 assert routes==['GET /inspections?offset=0','POST /inspection/stop?inspection=12&admission=34','GET /inspections?offset=0'],routes
 text=transcript.decode(errors='replace');assert '登记不表示已停止' in text and '强制释放' in text
 out=pathlib.Path('.scratch/personal-pi-durable/evidence/19-macos');(out/'pty.log').write_bytes(transcript);(out/'pty.json').write_text(json.dumps({'exit':0,'routes':routes,'real_pty':True,'backend':'authenticated Unix HTTP fixture, no helper/model/platform'},ensure_ascii=False,indent=2)+'\n')
 print('PTY choices and fixed inspection reference passed')
finally:
 if proc.poll() is None: proc.kill();proc.wait()
 os.close(master);server.shutdown();server.server_close();shutil.rmtree(root)
