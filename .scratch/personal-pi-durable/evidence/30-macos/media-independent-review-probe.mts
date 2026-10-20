import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Harness,createRegistry,ProviderDoc,ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { personalMedia } from '../../../../apps/ruukoto/src/personal-media.ts';
import { personalProvider,recordedModels } from '../../../../apps/ruukoto/src/personal-model.ts';
import { lockPersonalProfile } from '../../../../apps/ruukoto/src/personal-profile.ts';
import { MockModelServer } from '../../../../test/helpers/mock-provider.ts';
const context=BACKGROUND_CONTEXT;
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/rk-media-independent-')),lock=lockPersonalProfile(root);
const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
process.env.RK_MEDIA_REVIEW_KEY='test';
const server=new MockModelServer(()=>({kind:'text',text:'ok'}));
const baseUrl=await server.start(),config={api:'openai-completions' as const,baseUrl,modelId:'mock-model',apiKeyEnv:'RK_MEDIA_REVIEW_KEY',contextWindow:128000,maxTokens:8192,imageInput:true};
let harness:Harness;
const media=personalMedia(root,()=>harness),registry=createRegistry();registry.install(media.extension);
harness=await Harness.open(await openNodeSqliteStorage(path.join(root,'personal.sqlite')),{registry,models:recordedModels(personalProvider(config),async()=>{},media.modelMedia)},context);
try {
  const main=await harness.root(context,{agent:{model:{provider:'personal',modelId:'mock-model'},extensions:[media.extension],tools:[]}});
  const key='qq:independent';
  await media.stage({key,source:{platform:'qq',accountId:'bot',ownerId:'owner',generation:'1'},body:'review image',media:[{identity:'one',declaredMime:'image/png',download:async()=>new Response(png,{headers:{'content-type':'image/png'}})}]});
  await (await main.submit({type:'input',content:await media.input(key),requestId:key},context)).wait(context);
  const view=await main.context(context),sessionId=(await harness.snapshot(ProviderDoc,ROOT_CONVERSATION_ID,context))!.sessionId!;
  for(const api of ['openai-completions','openai-responses','anthropic-messages'] as const){
    const payloads:unknown[]=[],evidence:unknown[]=[];
    const models=recordedModels(personalProvider({...config,api}),async value=>{evidence.push(value)},media.modelMedia),model=models.getModel('personal','mock-model')!;
    await models.streamSimple(model,{messages:[...view.messages]},{sessionId,fetch:async(_url,init)=>{payloads.push(JSON.parse(String(init?.body)));return Response.json({error:{message:'review stops after capturing request'}},{status:400})}}).result();
    assert.equal(payloads.length,1,api+' did not reach transport');
    assert.ok(JSON.stringify(payloads).includes(png.toString('base64')),api+' lost image bytes');
    assert.ok(!JSON.stringify(evidence).includes(png.toString('base64')),api+' duplicated raw bytes in evidence');
    assert.ok(JSON.stringify(evidence).includes('ruukotoImage'),api+' lost ref snapshot');
    process.stdout.write(api+' actual transport image + reference evidence verified\n');
  }
}finally{await harness.close(context);await server.close();lock.release();fs.rmSync(root,{recursive:true,force:true});delete process.env.RK_MEDIA_REVIEW_KEY}
