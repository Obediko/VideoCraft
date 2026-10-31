import {applyTimelineOperations,parseEffectRecipe} from "@videocraft/domain";
import {test,expect, type Page} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Serve the same seekable H.264/faststart MP4 format as real exports.
const fixtureDir=mkdtempSync(join(tmpdir(),'videocraft-browser-'));
let media:Buffer;
try {
  const path=join(fixtureDir,'export.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x120:r=30:d=3','-c:v','libx264','-pix_fmt','yuv420p','-g','1','-movflags','+faststart',path]);
  media=readFileSync(path);
} finally {rmSync(fixtureDir,{recursive:true,force:true});}

async function editor(page:Page, screen='export', resume=false) {
  let editedTimeline:any;
  const state={mixed:false,creativeFails:false,holdStock:false,releaseImport:null as null|(()=>void),importCalls:0,withImportedPhoto:false,savedEffects:[] as any[],libraryFails:false,editOps:[] as any[],revision:2,status:'queued',offline:false,calls:0,links:0,submissions:0,submissionKeys:[] as string[],loseNextSubmission:false,expired:false,uploadCalls:0,uploadExpired:false,uploadTypes:[] as string[],withTranscript:false,planApplied:false,assetLists:0,mediaFails:false,linkFails:false,mediaRequests:0,playbackRequests:0};
  const timeline=(seconds:number):any=>state.mixed?{durationUs:2e6,tracks:[{id:'v',kind:'video',clips:[{id:'c-photo',assetId:'stock-photo',sourceStartUs:0,sourceEndUs:1e6,timelineStartUs:0,timelineEndUs:1e6},{id:'c-video',assetId:'a',sourceStartUs:0,sourceEndUs:1e6,timelineStartUs:1e6,timelineEndUs:2e6}]}]}:({durationUs:seconds*1e6,tracks:[{id:'v',kind:'video',clips:[{id:'c',assetId:'a',sourceStartUs:0,sourceEndUs:seconds*1e6,timelineStartUs:0,timelineEndUs:seconds*1e6}]}]});
  await page.addInitScript(({screen,resume})=>{
    localStorage.setItem('videocraft.lastProject','p');localStorage.setItem('videocraft.lastScreen',screen);
    if(resume)localStorage.setItem('videocraft.render.v1.p',JSON.stringify({id:'job',revision:2,platform:'tiktok'}));
  },{screen,resume});
  await page.route('http://localhost:8080/**',async route=>{
    const req=route.request(), path=new URL(req.url()).pathname;
    const headers={'access-control-allow-origin':req.headers()['origin']??'http://127.0.0.1:5173','access-control-allow-credentials':'true','access-control-allow-methods':'GET, POST, DELETE, OPTIONS','access-control-allow-headers':'authorization, content-type, range'};
    if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
    if(path==='/stock.png'){await route.fulfill({status:200,headers,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')});return;}
    if(path==='/export.mp4'||path==='/fixture.mp4'){
      if(path==='/fixture.mp4'){state.mediaRequests++;if(state.mediaFails){await route.fulfill({status:503,headers:{...headers,'cache-control':'no-store'},body:'Temporary media failure'});return;}}
      const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers()['range']??'');
      const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),media.length-1):media.length-1;
      await route.fulfill({status:range?206:200,headers:{...headers,'accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${media.length}`}:{})},contentType:'video/mp4',body:media.subarray(start,end+1)});return;
    }
    let body:any={}; let status=200;
    if(state.expired){await route.fulfill({status:401,headers,contentType:'application/json',body:JSON.stringify({error:{message:'Session expired'}})});return;}
    if(path==='/auth/refresh')body={accessToken:'test',user:{email:'test@example.com'}};
    else if(path==='/v1/me/effects'){
      if(state.libraryFails){status=503;body={error:{message:'Temporary library failure'}};}
      else if(req.method()==='POST'){const recipe=parseEffectRecipe(req.postDataJSON());const id=Buffer.from(JSON.stringify(recipe)).toString('hex').slice(0,64);const effect={id,recipe,updatedAt:new Date().toISOString()};state.savedEffects=[effect,...state.savedEffects.filter(e=>e.id!==id)];body={effect};status=201;}
      else body={saved:state.savedEffects};
    }
    else if(path.startsWith('/v1/me/effects/')&&req.method()==='DELETE'){state.savedEffects=state.savedEffects.filter(e=>e.id!==path.split('/').at(-1));body={};}
    else if(path.endsWith('/edit')&&req.method()==='POST'){state.editOps=req.postDataJSON().operations;editedTimeline=applyTimelineOperations(editedTimeline??timeline(2),state.editOps);state.revision++;body={revision:{revision:state.revision,timeline:editedTimeline}};}
    else if(path==='/v1/projects')body={projects:[{id:'p',name:'Recovery test',revision:state.revision,createdAt:'2026-01-01',updatedAt:'2026-01-01'}]};
    else if(path.endsWith('/stock/import')){state.importCalls++;if(state.holdStock)await new Promise<void>(resolve=>{state.releaseImport=resolve;});state.withImportedPhoto=true;body={asset:{id:'stock-photo',kind:'image',metadata:{filename:'Library photo',stockProvider:'pexels',stockId:'11',stockKind:'photo'}}};}
    else if(path.endsWith('/assets/upload')){state.uploadCalls++;state.uploadTypes.push(req.headers()['content-type']??'');if(state.uploadExpired&&state.uploadCalls===1){status=401;body={error:{message:'Access expired'}};}else body={asset:{id:'photo',kind:'image',metadata:{filename:'photo.png'}}};}
    else if(path.endsWith('/assets')){state.assetLists++;body={assets:[{id:'a',kind:'video',durationUs:2e6,metadata:{filename:'Test.mp4',width:640,height:360}},...((state.planApplied||state.withImportedPhoto)?[{id:'stock-photo',kind:'image',metadata:{filename:'Approved.png',width:1,height:1}}]:[])]};}
    else if(path.endsWith('/playback-url')){state.playbackRequests++;if(state.linkFails){status=503;body={error:{message:'Temporary link failure'}};}else body={url:path.includes('/stock-photo/')?'/stock.png':'/fixture.mp4',expires:Math.floor(Date.now()/1000)+3600};}
    else if(path.endsWith('/faces'))body={step:1,boxes:[]};
    else if(path.endsWith('/transcript'))body={segments:state.withTranscript?[{id:'s',startUs:0,endUs:1e6,text:'Hello',words:[{text:'Hello',startUs:0,endUs:1e6,confidence:1}]}]:[]};
    else if(path.endsWith('/creative/plan')){if(state.creativeFails){status=502;body={error:{message:'Creative planning is unavailable. Try again.'}};}else body={revision:state.revision,source:'ai',sampledFrames:2,note:'Planned from the script, timeline and sampled source frames.',proposals:[{id:'creative',title:'Mark the insight',reason:'The second scene introduces the key idea.',atUs:1e6,recipe:parseEffectRecipe({presetId:'key-point',text:'City insight',durationS:1})}]};}
    else if(path.endsWith('/director/plan'))body={plan:{source:'ai',summary:'Add the approved picture without music',suggestions:[{id:'stock',kind:'stock',title:'Approved picture',query:'freedom',atS:0,durationS:1,mode:'full'}]}};
    else if(path.endsWith('/director/apply')){state.planApplied=true;state.revision++;const edited=timeline(2);edited.tracks.push({id:'o',kind:'overlay',clips:[{id:'photo-cutaway',assetId:'stock-photo',sourceStartUs:0,sourceEndUs:1e6,timelineStartUs:0,timelineEndUs:1e6,transform:{role:'broll',mode:'full'}}]});body={revision:{revision:state.revision,timeline:edited}};}
    else if(/\/revisions\/\d+\/restore$/.test(path)) {
      const expected=req.postDataJSON().expectedRevision;
      if(expected!==state.revision){status=409;body={error:{message:'Newer edit'}};}
      else{const target=Number(path.split('/').at(-2));state.revision++;body={revision:{revision:state.revision,timeline:timeline(target===1?1:2)}};}
    }
    else if(/\/revisions\/\d+$/.test(path))body={revision:{revision:state.revision,timeline:editedTimeline??timeline(2)}};
    else if(path.endsWith('/renders/job')){state.calls++;if(state.offline){status=503;body={error:{message:'Temporary outage'}};}else body={job:{id:'job',status:state.status,progress:state.status==='succeeded'?100:5}};}
    else if(path.endsWith('/download-url')){state.links++;body={url:'/export.mp4?version='+state.links,expires:Math.floor(Date.now()/1000)+300};}
    else if(path.endsWith('/renders')&&req.method()==='POST'){
      state.submissions++;state.submissionKeys.push(req.postDataJSON().idempotencyKey);
      if(state.loseNextSubmission){state.loseNextSubmission=false;await route.abort();return;}
      state.status='queued';body={job:{id:'job',status:'queued',progress:0}};
    }
    else if(path.endsWith('/cancel')){state.status='cancelled';body={job:{id:'job',status:'cancelled',progress:5}};}
    else if(path.endsWith('/stock/sources'))body={video:[],photo:[],gif:[]};
    else if(path.endsWith('/preferences'))body={samples:0,summary:'',counts:{}};
    await route.fulfill({status,headers,contentType:'application/json',body:JSON.stringify(body)});
  });
  return state;
}

test('an interrupted export reconnects, survives reload, and never creates a duplicate job',async({page})=>{
  await page.clock.install();
  const state=await editor(page,'export',true); state.offline=true;
  await page.goto('/');
  await expect.poll(()=>state.calls).toBe(1);
  await page.clock.fastForward(2100);await expect.poll(()=>state.calls).toBe(2);
  await page.clock.fastForward(2100);await expect.poll(()=>state.calls).toBe(3);
  await expect(page.getByText('Cannot check this export right now. It may still be running. Use Refresh export status to reconnect.',{exact:true})).toBeVisible();
  state.offline=false;state.status='succeeded';
  await page.getByRole('button',{name:'Refresh export status'}).click();
  await expect(page.getByRole('link',{name:'Download video'})).toHaveAttribute('href',/version=1/);
  await page.reload();
  await expect(page.getByRole('link',{name:'Download video'})).toHaveAttribute('href',/version=2/);
  expect(state.submissions).toBe(0);
});

test('undo and redo restore immutable revisions and the editor fits a phone',async({page})=>{
  const state=await editor(page,'edit');
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByText('Last edit undone',{exact:true})).toBeVisible();
  expect(state.revision).toBe(3);
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect(page.getByText('Edit redone',{exact:true})).toBeVisible();
  expect(state.revision).toBe(4);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(1);
});


test('retrying a failed export creates a new attempt, but a lost POST response reuses that attempt',async({page})=>{
  const state=await editor(page,'export',true); state.status='failed';
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Export video',exact:true})).toBeEnabled();
  await expect.poll(()=>state.calls).toBe(1);
  state.loseNextSubmission=true;
  await page.getByRole('button',{name:'Export video',exact:true}).click();
  await expect.poll(()=>state.submissionKeys.length).toBe(1);
  await expect(page.getByRole('button',{name:'Export video',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Export video',exact:true}).click();
  await expect.poll(()=>state.submissionKeys.length).toBe(2);
  expect(state.submissionKeys[0]).not.toBe('p:2:tiktok');
  expect(state.submissionKeys[1]).toBe(state.submissionKeys[0]);
  await page.getByRole('button',{name:'Cancel export',exact:true}).click();
  await expect(page.getByText('Export cancelled. Your edit is saved.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Export video',exact:true}).click();
  await expect.poll(()=>state.submissionKeys.length).toBe(3);
  expect(state.submissionKeys[2]).not.toBe(state.submissionKeys[1]);
});

test('renewing an expiring export link preserves the playback position',async({page})=>{
  await page.clock.install();
  const state=await editor(page,'export',true);state.status='succeeded';
  await page.goto('/');
  const player=page.locator('video').first();
  await expect.poll(()=>player.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(3);
  await expect.poll(()=>player.evaluate((v:HTMLVideoElement)=>v.seekable.length?v.seekable.end(v.seekable.length-1):0)).toBeGreaterThan(1);
  await player.evaluate((v:HTMLVideoElement)=>new Promise<void>(resolve=>{v.pause();v.addEventListener('seeked',()=>resolve(),{once:true});v.currentTime=1;}));
  await expect.poll(()=>player.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeCloseTo(1,1);
  await page.clock.fastForward(241_000);
  await expect.poll(()=>state.links).toBe(2);
  await expect.poll(()=>player.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeCloseTo(1,1);
});


test('an expired refresh session returns to sign-in and clears the editing workspace',async({page})=>{
  const state=await editor(page,'edit');
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeEnabled();
  state.expired=true;
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
  await expect(page.locator('.project-title')).toHaveCount(0);
});


test('an upload refreshes an expired access token and preserves multipart boundaries',async({page})=>{
  const state=await editor(page,'edit');state.uploadExpired=true;
  await page.goto('/');
  await page.getByRole('button',{name:'Visuals',exact:true}).click();
  await page.getByLabel('Upload a photo or clip',{exact:true}).setInputFiles({name:'photo.png',mimeType:'image/png',buffer:Buffer.from('test upload')});
  await expect.poll(()=>state.uploadCalls).toBe(2);
  expect(state.uploadTypes).toHaveLength(2);
  for(const type of state.uploadTypes)expect(type).toMatch(/^multipart\/form-data; boundary=/);
  await expect(page.getByText('Uploaded photo.png',{exact:true})).toBeVisible();
});


test('applying a Director plan without music loads the approved photo into the preview',async({page})=>{
  const state=await editor(page,'describe');state.withTranscript=true;
  await page.goto('/');
  await page.getByLabel('Description',{exact:true}).fill('Add the approved picture, with no music');
  await page.getByRole('button',{name:'Make the first cut',exact:true}).click();
  await page.getByRole('button',{name:'Apply the selected',exact:true}).click();
  await expect.poll(()=>state.assetLists).toBe(2);
  await expect(page.locator('img.live-broll')).toHaveCount(1);
  await expect(page.locator('img.live-broll')).toHaveJSProperty('naturalWidth',1);
  await expect(page.locator('video.live-broll')).toHaveCount(0);
});


test('reload footage recovers a failed media element even when its renewed URL is identical',async({page})=>{
  const state=await editor(page,'edit');state.mediaFails=true;
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('The footage could not be loaded');
  const player=page.locator('video.live-video');
  const slider=page.getByRole('slider',{name:'Position in the edit'});
  await slider.press('ArrowRight');
  await expect.poll(()=>player.evaluate((v:HTMLVideoElement)=>v.error?.code??0)).toBeGreaterThan(0);
  const wanted=Number(await slider.inputValue())/1e6;
  const requests=state.mediaRequests;
  state.mediaFails=false;
  await page.getByRole('button',{name:'Reload footage',exact:true}).click();
  await expect.poll(()=>state.playbackRequests).toBeGreaterThanOrEqual(2);
  await expect.poll(()=>state.mediaRequests).toBeGreaterThan(requests);
  await expect.poll(()=>player.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(()=>player.evaluate((v:HTMLVideoElement,target:number)=>Math.abs(v.currentTime-target),wanted)).toBeLessThan(0.15);
  await page.getByRole('button',{name:'Play the edit',exact:true}).click();
  await expect.poll(()=>player.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(wanted+0.05);
});

test('a failed preview-link request is visible and can be retried',async({page})=>{
  const state=await editor(page,'edit');state.linkFails=true;
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('The preview link could not be loaded');
  state.linkFails=false;
  await page.getByRole('button',{name:'Reload footage',exact:true}).click();
  await expect.poll(()=>page.locator('video.live-video').evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});


test('Play clip opens the original player and starts it from the editor without changing the edit',async({page})=>{
  const state=await editor(page,'edit');
  await page.goto('/');
  await test.step('select the timeline clip',()=>page.getByRole('button',{name:'Test.mp4, 2.0s',exact:true}).click({timeout:10000}));
  await test.step('tap Play clip',()=>page.getByRole('button',{name:'Play clip',exact:true}).click({timeout:10000}));
  await expect(page.getByRole('tab',{name:'Original',exact:true})).toHaveAttribute('aria-selected','true');
  await expect.poll(()=>page.locator('.preview-screen video').evaluate((v:HTMLVideoElement)=>v.paused)).toBe(false);
  await expect.poll(()=>page.locator('.preview-screen video').evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(0);
  expect(state.revision).toBe(2);
});


test('creative library supports composing, applying, saving, reload reuse and private deletion',async({page})=>{
  const state=await editor(page,'edit');
  await page.goto('/');
  await page.getByRole('button',{name:'Visuals',exact:true}).click();
  const library=page.getByRole('region',{name:'Creative effects library'});
  await library.getByRole('button',{name:'Realization pop',exact:false}).click();
  await library.getByLabel('Treatment text',{exact:true}).fill('It clicks');
  await library.getByRole('button',{name:'Add treatment at this moment',exact:true}).click();
  await expect.poll(()=>state.revision).toBe(3);
  await expect.poll(()=>state.savedEffects.length).toBe(1);
  expect(state.editOps.some(o=>o.type==='add-graphic'&&o.text==='It clicks')).toBe(true);
  expect(state.editOps.some(o=>o.type==='add-sfx'&&o.kind==='pop')).toBe(true);
  await expect(page.locator('.live-title.callout')).toContainText('It clicks');
  await expect(page.locator('.live-title.callout')).toHaveCSS('color','rgb(255, 255, 255)');
  await expect(page.locator('.live-title.callout')).toHaveCSS('background-color','rgb(99, 122, 82)');
  await page.reload();await page.getByRole('button',{name:'Visuals',exact:true}).click();
  await expect(library.getByRole('button',{name:'Realization pop · It clicks',exact:true})).toBeVisible();
  await library.getByRole('button',{name:'Realization pop · It clicks',exact:true}).click();
  await expect(library.getByLabel('Treatment text',{exact:true})).toHaveValue('It clicks');
  await library.getByRole('button',{name:'Delete saved treatment It clicks',exact:true}).click();
  await expect.poll(()=>state.savedEffects.length).toBe(0);
  expect(state.revision).toBe(3);
});

test('a library outage leaves the edit usable and a failed save can be retried without duplicating timeline effects',async({page})=>{
  const state=await editor(page,'edit');state.libraryFails=true;
  await page.goto('/');await page.getByRole('button',{name:'Visuals',exact:true}).click();
  const library=page.getByRole('region',{name:'Creative effects library'});
  await expect(library.getByRole('alert')).toContainText('could not be loaded');
  await library.getByRole('button',{name:'Realization pop',exact:false}).click();
  await library.getByRole('button',{name:'Add treatment at this moment',exact:true}).click();
  await expect(library.getByRole('status')).toContainText('Library save failed');
  expect(state.revision).toBe(3);state.libraryFails=false;
  await library.getByRole('button',{name:'Retry library',exact:true}).click();
  await expect(library.getByRole('alert')).toHaveCount(0);
  await library.getByRole('button',{name:'Save treatment',exact:true}).click();
  await expect.poll(()=>state.savedEffects.length).toBe(1);expect(state.revision).toBe(3);
});


test('a saved stock treatment is imported into the current project before it is placed',async({page})=>{
  const state=await editor(page,'edit');
  state.holdStock=true;
  state.savedEffects=[{id:'saved-stock',recipe:parseEffectRecipe({presetId:'stock-cutaway',text:'Library photo',durationS:2,stock:{provider:'pexels',id:'11',kind:'photo',mode:'pip'}}),updatedAt:'2026-10-31'}];
  await page.goto('/');await page.getByRole('button',{name:'Visuals',exact:true}).click();
  const library=page.getByRole('region',{name:'Creative effects library'});
  await library.getByRole('button',{name:'Stock cutaway · Library photo',exact:true}).click();
  await library.getByRole('button',{name:'Add treatment at this moment',exact:true}).click();
  await expect.poll(()=>state.importCalls).toBe(1);
  await expect(page.getByRole('button',{name:'Back to your videos',exact:true})).toBeDisabled();
  await expect.poll(()=>Boolean(state.releaseImport)).toBe(true);state.releaseImport!();
  await expect.poll(()=>state.revision).toBe(3);
  expect(state.editOps.some(o=>o.type==='add-broll'&&o.assetId==='stock-photo'&&o.mode==='pip')).toBe(true);
  await expect(page.locator('img.live-broll.pip')).toHaveJSProperty('naturalWidth',1);
});


test('the creative Director proposes treatments for a mixed story, recovers from failure, and applies only after approval',async({page})=>{
  const state=await editor(page,'edit');state.mixed=true;state.withImportedPhoto=true;state.creativeFails=true;
  await page.goto('/');await page.getByRole('button',{name:'Visuals',exact:true}).click();
  const library=page.getByRole('region',{name:'Creative effects library'});
  await library.getByLabel('Creative direction',{exact:true}).fill('Subtle and thoughtful');
  await library.getByRole('button',{name:'Ask Director for creative treatments',exact:true}).click();
  await expect(library.getByRole('status')).toContainText('Creative planning is unavailable');
  state.creativeFails=false;
  await library.getByRole('button',{name:'Ask Director for creative treatments',exact:true}).click();
  const ideas=library.getByRole('region',{name:'Director creative suggestions'});
  await expect(ideas).toContainText('The second scene introduces the key idea.');
  expect(state.revision).toBe(2);expect(state.editOps).toHaveLength(0);expect(state.savedEffects).toHaveLength(0);
  await ideas.getByRole('button',{name:'Apply treatment: Mark the insight',exact:true}).click();
  await expect.poll(()=>state.revision).toBe(3);await expect.poll(()=>state.savedEffects.length).toBe(1);
  expect(state.editOps).toHaveLength(1);expect(state.editOps[0]).toMatchObject({type:'add-graphic',anchorAssetId:'a',anchorClipId:'c-video',anchorSourceUs:0,text:'City insight'});
  await expect(ideas.getByRole('button',{name:'Apply treatment: Mark the insight',exact:true})).toBeDisabled();
  await expect(ideas).toContainText('Your edit changed');
  const position=page.getByRole('slider',{name:'Position in the edit',exact:true});await position.press('End');await position.press('ArrowLeft');
  await expect(page.locator('.live-title.callout')).toContainText('City insight');
});
