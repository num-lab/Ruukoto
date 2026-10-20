from pathlib import Path
import json,hashlib,base64
base=Path('/tmp/ruukoto39-report-stage-independent/model-private');r=json.loads((base/'result.json').read_text());old=json.load(open('/tmp/ruukoto39-report593-actual-private/independent-audit/actual-full-private.json'))
def walk(v):
 if isinstance(v,dict):
  yield v
  for x in v.values():yield from walk(x)
 elif isinstance(v,list):
  for x in v:yield from walk(x)
images=[]
for turn in r['turns']:
 i=turn['step'];folder=base/f'turn-{i}';inp=json.loads((folder/'input-wire-full-private.json').read_text());payload=json.loads((folder/'payload-wire-full-private.json').read_text())
 original=[{'mime':p['mimeType'],'bytes':len(base64.b64decode(p['data'])),'sha256':hashlib.sha256(base64.b64decode(p['data'])).hexdigest()}for p in walk(inp)if p.get('type')=='image']
 wire=[]
 for p in walk(payload):
  if p.get('type')=='input_image':
   prefix,body=p['image_url'].split(',',1);data=base64.b64decode(body);wire.append({'mime':prefix.split(':',1)[1].split(';',1)[0],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
 assert original==wire
 assert len(original)==2
 assert [x['sha256']for x in original]==[x['sha256']for x in turn['imageMappings']]
 images.append({'step':i,'count':len(original),'images':original,'inputPayloadImagesByteEqual':True})
 assert turn['httpCalls']==1 and turn['payloadSaved']
 assert turn['metrics']==r['before']['metrics']
replays=[]
for replay in r['replays']:
 original=next(e for e in old['newEntries']if e['id']==replay['resultEntry'])['model'][0]
 inp=json.loads((base/f"turn-{replay['beforeHttp']}"/'input-wire-full-private.json').read_text())
 found=[m for m in inp['messages']if m.get('role')=='toolResult'and m.get('toolCallId')==replay['toolCallId']]
 assert len(found)==1
 msg=found[0].copy();msg['toolCallId']=original['toolCallId'];assert msg==original
 replays.append({'resultEntry':replay['resultEntry'],'modifiedFields':['toolCallId'],'allOtherFieldsByteEquivalent':True})
assert r['networkCalls']==3 and r['networkLimit']==4 and r['retryAttemptsBlocked']==0
assert r['termination']=='assistant_without_tools'
assert r['turns'][0]['firstPayloadOnlyReportContentChanged']
summary={'sourceSHA256':r['candidate']['sourceSHA256'],'candidateContentSHA256':r['candidate']['contentSHA256'],'networkCalls':r['networkCalls'],'networkLimit':r['networkLimit'],'retryAttemptsBlocked':r['retryAttemptsBlocked'],'toolsExecuted':0,'harnessOpened':False,'imSends':0,'liveInputsSubmitted':0,'firstPayloadOnlyReportContentChanged':True,'images':images,'replays':replays,'metrics':{'before':r['before']['metrics'],'after':r['turns'][0]['metrics'],'reportReferenceEstimatedTokensBefore':r['before']['reportReferenceEstimatedTokens'],'reportReferenceEstimatedTokensAfter':r['candidate']['reportReferenceEstimatedTokens'],'method':'shared pi-coding-agent estimateTokens(role=user,text,timestamp=0), no provider-token claim'},'afterTextChars':len(r['finalText']),'afterTextSHA256':hashlib.sha256(r['finalText'].encode()).hexdigest(),'asksReportAgain':'再次调用 report'in r['finalText'],'claimsIHaveNotSent':'我也未发送'in r['finalText'],'remainingDeliveryCommentary':'投递状态'in r['finalText'],'scope':'one bounded direct-model sample; no new product report/IM; original593 immutable; A10 full acceptance remains unproven'}
Path('/tmp/ruukoto39-report-stage-independent/model-audit.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items()if k not in ['images','metrics']},ensure_ascii=False))
