import os, pty, signal, subprocess, tempfile, pathlib, shutil, hashlib, json, select, time, fcntl, termios, struct, socket
root=pathlib.Path(os.getcwd())
base=pathlib.Path(tempfile.mkdtemp(prefix='r38-pty-',dir='/tmp'))
repo=base/'repo'; home=base/'home'; repo.mkdir(); home.mkdir()
(repo/'apps/ruukoto').mkdir(parents=True)
shutil.copytree(root/'apps/ruukoto/src',repo/'apps/ruukoto/src')
(repo/'package.json').write_text('{"type":"module"}\n')
(repo/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
(repo/'apps/ruukoto/node_modules').symlink_to(root/'apps/ruukoto/node_modules',target_is_directory=True)
profile=home/'.ruukoto-durable-dev'/hashlib.sha256(str(repo.resolve()).encode()).hexdigest()[:12]
profile.mkdir(parents=True,mode=0o700)
(profile/'profile.json').write_text(json.dumps({'product':'ruukoto','format':1,'pi':'1.3.0','extensions':{'personal':1}})+'\n')
(profile/'model.json').write_text(json.dumps({'api':'openai-completions','baseUrl':'http://127.0.0.1:1','modelId':'no-call','apiKeyEnv':'R38_MODEL_KEY','contextWindow':128000,'maxTokens':1024})+'\n')
env=dict(os.environ,HOME=str(home),R38_MODEL_KEY='test-only')
import sqlite3

def request(route,method='GET'):
 token=(profile/'control.token').read_text().strip()
 c=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); c.settimeout(2)
 try:
  c.connect(str(profile/'control.sock')); c.sendall((method+' '+route+' HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+token+'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n').encode())
  data=b''
  while True:
   chunk=c.recv(65536)
   if not chunk: break
   data+=chunk
  assert b'200 OK' in data, data
  return data.decode()
 finally: c.close()

def until(check):
 end=time.time()+20
 while time.time()<end:
  try:
   if check(): return
  except (OSError,AssertionError): pass
  time.sleep(.05)
 raise AssertionError('condition timeout')

def unlocked():
 c=sqlite3.connect(profile/'owner.sqlite',timeout=0)
 try: c.execute('BEGIN EXCLUSIVE'); c.rollback(); return True
 finally: c.close()

class Menu:
 def __init__(self):
  self.master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,100,0,0))
  self.proc=subprocess.Popen(['node','--import','tsx',str(repo/'apps/ruukoto/src/dev.ts'),'--config'],cwd=repo,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
  os.close(slave); self.out=b''; self.cursor=0
 def read(self):
  if select.select([self.master],[],[],0.1)[0]:
   try: self.out+=os.read(self.master,65536)
   except OSError: pass
 def wait(self,marker):
  end=time.time()+20
  while time.time()<end:
   text=self.out.decode(errors='replace'); at=text.find(marker,self.cursor)
   if at>=0: self.cursor=at+len(marker); return
   self.read()
  raise AssertionError('missing '+marker+'\n'+self.out.decode(errors='replace'))
 def send(self,value): os.write(self.master,(value+'\n').encode())
 def launch(self):
  self.wait('请选择：'); self.send('6'); self.wait('请选择：'); self.send('2')
 def close(self):
  if self.proc.poll() is None: os.killpg(self.proc.pid,signal.SIGTERM)
  try: self.proc.wait(timeout=10)
  except subprocess.TimeoutExpired: os.killpg(self.proc.pid,signal.SIGKILL); self.proc.wait()
  self.read(); os.close(self.master)

results=[]
for sig in [signal.SIGINT,signal.SIGTERM]:
 m=Menu()
 try:
  m.launch(); m.wait('个人后台已启动。'); request('/status')
  m.proc.send_signal(sig)
  deadline=time.time()+5
  while time.time()<deadline and m.proc.poll() is None: m.read()
  try: lockfree=unlocked()
  except sqlite3.OperationalError: lockfree=False
  print(json.dumps({'signal':sig.name,'pid':m.proc.pid,'exit':m.proc.poll(),'lockfreeAfter5s':lockfree,'base':str(base),'out':m.out.decode(errors='replace')},ensure_ascii=False),flush=True)
  m.proc.wait(timeout=5); until(unlocked)
  results.append({'signal':sig.name,'supervisorExit':m.proc.returncode,'profileUnlocked':True})
 finally:
  m.close(); (base/(sig.name+'.log')).write_bytes(m.out)
foreign=subprocess.Popen(['node','--import','tsx',str(repo/'apps/ruukoto/src/main.ts'),'serve'],cwd=repo,env=dict(env,RUUKOTO_PERSONAL_DIR=str(profile)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
m=None
try:
 until(lambda: request('/status'))
 token=(profile/'control.token').read_text()
 m=Menu(); m.launch(); m.wait('profile_busy'); m.wait('请选择：'); m.send('7')
 deadline=time.time()+2
 while time.time()<deadline and m.proc.poll() is None: m.read()
 assert foreign.poll() is None
 assert (profile/'control.token').read_text()==token
 request('/status')
 results.append({'foreignBackendPreserved':True,'tokenUnchanged':True,'afterRejectedMenuExitStatus':'200 OK'})
finally:
 if m: m.close(); (base/'foreign-lock.log').write_bytes(m.out)
 if foreign.poll() is None:
  request('/stop',method='POST')
  try: foreign.wait(timeout=15)
  except subprocess.TimeoutExpired: os.killpg(foreign.pid,signal.SIGKILL); foreign.wait()
 until(unlocked)
print(json.dumps({'base':str(base),'profile':str(profile),'results':results},ensure_ascii=False))
