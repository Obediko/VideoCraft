import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {LocalObjectStorage} from '@videocraft/storage';
import {registerCreativeRoutes} from '../dist/creative.js';

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'vc-creative-'));
  const photo=join(dir,'photo.png'),video=join(dir,'video.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=96x128','-frames:v','1',photo]);
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=96x64:r=10:d=60','-c:v','libx264','-pix_fmt','yuv420p',video]);
  const assets=[{id:'photo',projectId:'p',kind:'image',storageKey:'photo.png',metadata:{sizeBytes:statSync(photo).size,filename:'Red photo'}},{id:'video',projectId:'p',kind:'video',storageKey:'video.mp4',durationUs:60e6,metadata:{sizeBytes:statSync(video).size,filename:'Blue footage'}}];
  const state={user:'u',allowed:true,revision:1,calls:0,writes:0,input:null,source:'ai',fail:false};
  const revision={revision:1,tailoring:{intent:'Explain a discovery',constraints:['creation:story']},timeline:{durationUs:8e6,tracks:[{id:'v',kind:'video',clips:[{id:'still',assetId:'photo',sourceStartUs:0,sourceEndUs:4e6,timelineStartUs:0,timelineEndUs:4e6},{id:'motion',assetId:'video',sourceStartUs:50e6,sourceEndUs:54e6,timelineStartUs:4e6,timelineEndUs:8e6,transform:{muteSource:true}}]},{id:'a',kind:'audio',clips:[{id:'vo',assetId:'voice',sourceStartUs:0,sourceEndUs:8e6,timelineStartUs:0,timelineEndUs:8e6,transform:{role:'voiceover'}}]}]}};
  const server=Fastify();registerCreativeRoutes(server,{
    projects:{get:async()=>({id:'p',revision:state.revision})},revisions:{get:async()=>revision},assets:{listForProject:async()=>assets},storage:new LocalObjectStorage(dir),
    transcripts:{listForAsset:async id=>[{startUs:0,endUs:8e6,text:id==='voice'?'A clear discovery':'MUTED SOURCE',words:[{text:id==='voice'?'Discovery':'MUTED',startUs:200000,endUs:1e6}]}]},
    authenticate:async()=>state.user?{userId:state.user}:null,authorize:{canAccess:async()=>state.allowed},clock:()=>new Date().toISOString(),saveRevision:async()=>{state.writes++;},
    effects:{list:async()=>[],save:async()=>{state.writes++;},remove:async()=>{}},previewStock:async()=>({provider:'pexels',id:'11',thumbUrl:'https://images.pexels.com/11.jpg',credit:'A on Pexels'}),
    director:{plan:async input=>{state.calls++;state.input=input;if(state.fail)throw Error('provider failed');return {source:state.source,suggestions:[{id:'cut',kind:'cut',segments:[{startS:0,endS:8}],reason:'Do not apply this cut'},{id:'e',kind:'effect',presetId:'key-point',text:'A discovery',atS:1,durationS:3,reason:'The narration introduces the discovery here.'},{id:'s',kind:'stock',query:'city lights',assetKind:'photo',atS:5,durationS:3,mode:'pip',reason:'Add a brief supporting visual for the city example.'}]};}},
  });
  return {state,server,revision,close:async()=>{await server.close();rmSync(dir,{recursive:true,force:true});}};
}

test('creative planning understands edited photo/video time and narration without changing the story',async()=>{
  const s=await fixture();try{
    const r=await s.server.inject({method:'POST',url:'/v1/projects/p/creative/plan',payload:{revision:1,brief:'A thoughtful discovery'}});
    assert.equal(r.statusCode,200,r.body);const body=r.json();assert.equal(body.proposals.length,2);
    assert.equal(body.proposals[0].atUs,1e6);assert.equal(body.proposals[1].atUs,5e6);assert.equal(body.proposals[1].recipe.stock.id,'11');assert.equal(body.proposals[1].stockPreview.credit,'A on Pexels');
    assert.equal(body.sampledFrames,2);assert.deepEqual(s.state.input.frames.map(f=>Number(f.atS.toFixed(1))),[0,4.8]);
    assert.ok(s.state.input.transcript.some(t=>t.text==='Discovery'&&t.startS===0.2&&t.endS===1));assert.ok(!s.state.input.transcript.some(t=>t.text.includes('MUTED')));assert.match(s.state.input.brief,/EDITED TIMELINE/);
    assert.equal(s.state.writes,0);assert.equal(s.revision.timeline.tracks[0].clips[1].sourceStartUs,50e6);
    const rgb=execFileSync('ffmpeg',['-v','error','-i','pipe:0','-vf','scale=1:1','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{input:Buffer.from(s.state.input.frames[1].jpegBase64,'base64')});assert.ok(rgb[2]>180&&rgb[0]<30,'the second frame must come from blue source at 50.8s');
  }finally{await s.close();}
});

test('creative plans require ownership and the current revision, and report provider fallback truthfully',async()=>{
  const s=await fixture();try{
    const request=()=>s.server.inject({method:'POST',url:'/v1/projects/p/creative/plan',payload:{revision:1}});
    s.state.user='';assert.equal((await request()).statusCode,401);
    s.state.user='u';s.state.allowed=false;assert.equal((await request()).statusCode,403);
    s.state.allowed=true;s.state.revision=2;assert.equal((await request()).statusCode,409);assert.equal(s.state.calls,0);
    s.state.revision=1;s.state.source='rules';const fallback=await request();assert.equal(fallback.statusCode,200);assert.deepEqual(fallback.json().proposals,[]);assert.match(fallback.json().note,/need the AI provider/);
    s.state.fail=true;assert.equal((await request()).statusCode,502);assert.equal(s.state.writes,0);
  }finally{await s.close();}
});


test('photo-only creative planning uses retained caption evidence without requiring a video transcript',async()=>{
  const s=await fixture();try{
    s.revision.timeline.tracks=s.revision.timeline.tracks.filter(t=>t.kind==='video');
    s.revision.timeline.tracks[0].clips[1]={id:'repeat-photo',assetId:'photo',sourceStartUs:0,sourceEndUs:4e6,timelineStartUs:4e6,timelineEndUs:8e6};
    s.revision.timeline.tracks.push({id:'captions',kind:'caption',clips:[{id:'caption',assetId:'voice',sourceStartUs:0,sourceEndUs:2e6,timelineStartUs:4e6,timelineEndUs:6e6,transform:{text:'A new beginning'}}]});
    const r=await s.server.inject({method:'POST',url:'/v1/projects/p/creative/plan',payload:{revision:1}});
    assert.equal(r.statusCode,200,r.body);assert.ok(s.state.input.transcript.some(t=>t.text==='A new beginning'&&t.startS===4));
    assert.equal(r.json().sampledFrames,1,'one repeated photo needs only one distinct source sample');assert.equal(s.state.writes,0);
  }finally{await s.close();}
});
