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
master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,100,0,0))
proc=subprocess.Popen([os.environ.get('R38_NODE','node'),'--watch','--import','tsx',str(repo/'apps/ruukoto/src/dev.ts'),'--config'],cwd=repo,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
os.close(slave); out=b''; cursor=0

def waitfor(marker,timeout=20):
 global out,cursor
 end=time.time()+timeout
 while time.time()<end:
  text=out.decode(errors='replace')
  at=text.find(marker,cursor)
  if at>=0: cursor=at+len(marker); return
  read()
 raise AssertionError('missing '+marker+'\n'+out.decode(errors='replace'))

def read():
 global out
 if select.select([master],[],[],0.1)[0]:
  try: out+=os.read(master,65536)
  except OSError: pass

def send(value): os.write(master,(value+'\n').encode())
try:
 waitfor('请选择：'); send('6'); waitfor('请选择：'); send('2'); waitfor('个人后台已启动。'); waitfor('请选择：'); send('7')
 deadline=time.time()+4
 while time.time()<deadline and proc.poll() is None: read()
 print(json.dumps({'base':str(base),'profile':str(profile),'menuExitSupervisorCode':proc.poll(),'output':out.decode(errors='replace')},ensure_ascii=False))
finally:
 if proc.poll() is None: os.killpg(proc.pid,signal.SIGTERM)
 try: proc.wait(timeout=10)
 except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL); proc.wait()
 (base/'menu-exit.log').write_bytes(out)
 os.close(master)
