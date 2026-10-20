import json,pathlib,collections
p=pathlib.Path('/tmp/ruukoto38-112-cpu-profile.json')
if not p.exists(): raise SystemExit('profile not ready')
v=json.loads(p.read_text()); nodes={node['id']:node for node in v['nodes']}; parent={child:node['id'] for node in v['nodes'] for child in node.get('children',[])}
self_counts=collections.Counter(v.get('samples',[])); inclusive=collections.Counter()
for leaf,count in self_counts.items():
 node=leaf
 while node:
  inclusive[node]+=count;node=parent.get(node)
rows=[]
for node,count in inclusive.most_common(35):
 frame=nodes[node]['callFrame'];rows.append({'inclusiveSamples':count,'selfSamples':self_counts[node],'function':frame['functionName'],'url':frame['url'],'line':frame['lineNumber']+1})
result={'sampleCount':len(v.get('samples',[])),'durationMicroseconds':v['endTime']-v['startTime'],'hotInclusive':rows}
pathlib.Path('/tmp/ruukoto38-112-cpu-summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
