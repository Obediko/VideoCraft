import {test,expect, type Page} from '@playwright/test';
import {execFileSync} from 'node:child_process';
const media=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x120:r=10:d=3','-c:v','libvpx','-f','webm','pipe:1']);

async function editor(page:Page, screen='export', resume=false) {
  const state={revision:2,status:'queued',offline:false,calls:0,links:0,submissions:0,submissionKeys:[] as string[],loseNextSubmission:false,expired:false};
  const timeline=(seconds:number)=>({durationUs:seconds*1e6,tracks:[{id:'v',kind:'video',clips:[{id:'c',assetId:'a',sourceStartUs:0,sourceEndUs:seconds*1e6,timelineStartUs:0,timelineEndUs:seconds*1e6}]}]});
  await page.addInitScript(({screen,resume})=>{
    localStorage.setItem('videocraft.lastProject','p');localStorage.setItem('videocraft.lastScreen',screen);
    if(resume)localStorage.setItem('videocraft.render.v1.p',JSON.stringify({id:'job',revision:2,platform:'tiktok'}));
  },{screen,resume});
  await page.route('**/*.webm*',()=>{});
  await page.route('http://localhost:8080/**',async route=>{
    const req=route.request(), path=new URL(req.url()).pathname;
    const headers={'access-control-allow-origin':req.headers()['origin']??'http://127.0.0.1:5173','access-control-allow-credentials':'true','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'authorization, content-type'};
    if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
    if(path==='/export.mp4'){await route.fulfill({status:200,headers,contentType:'video/webm',body:media});return;}
    let body:any={}; let status=200;
    if(state.expired){await route.fulfill({status:401,headers,contentType:'application/json',body:JSON.stringify({error:{message:'Session expired'}})});return;}
    if(path==='/auth/refresh')body={accessToken:'test',user:{email:'test@example.com'}};
    else if(path==='/v1/projects')body={projects:[{id:'p',name:'Recovery test',revision:state.revision,createdAt:'2026-01-01',updatedAt:'2026-01-01'}]};
    else if(path.endsWith('/assets'))body={assets:[{id:'a',kind:'video',durationUs:2e6,metadata:{filename:'Test.mp4',width:640,height:360}}]};
    else if(path.endsWith('/playback-url'))body={url:'/fixture.webm',expires:Math.floor(Date.now()/1000)+3600};
    else if(path.endsWith('/faces'))body={step:1,boxes:[]};
    else if(path.endsWith('/transcript'))body={segments:[]};
    else if(/\/revisions\/\d+\/restore$/.test(path)) {
      const expected=req.postDataJSON().expectedRevision;
      if(expected!==state.revision){status=409;body={error:{message:'Newer edit'}};}
      else{const target=Number(path.split('/').at(-2));state.revision++;body={revision:{revision:state.revision,timeline:timeline(target===1?1:2)}};}
    }
    else if(/\/revisions\/\d+$/.test(path))body={revision:{revision:state.revision,timeline:timeline(2)}};
    else if(path.endsWith('/renders/job')){state.calls++;if(state.offline){status=503;body={error:{message:'Temporary outage'}};}else body={job:{id:'job',status:state.status,progress:state.status==='succeeded'?100:5}};}
    else if(path.endsWith('/download-url')){state.links++;body={url:'/export.mp4?version='+state.links,expires:Math.floor(Date.now()/1000)+300};}
    else if(path.endsWith('/renders')&&req.method()==='POST'){
      state.submissions++;state.submissionKeys.push(req.postDataJSON().idempotencyKey);
      if(state.loseNextSubmission){state.loseNextSubmission=false;await route.abort();return;}
      state.status='queued';body={job:{id:'job',status:'queued',progress:0}};
    }
    else if(path.endsWith('/cancel')){state.status='cancelled';body={job:{id:'job',status:'cancelled',progress:5}};}
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
  await expect.poll(()=>player.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThan(0);
  await player.evaluate((v:HTMLVideoElement)=>{v.pause();v.currentTime=1;});
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
