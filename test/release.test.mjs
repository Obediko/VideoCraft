import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const sha='a'.repeat(40);
function release(options={}){
  const dir=mkdtempSync(join(tmpdir(),'vc-release-test-')),bin=join(dir,'bin'),app=join(dir,'app');
  mkdirSync(bin);mkdirSync(app);
  const oldEnv='EXISTING_SETTING=test-value\n',oldCompose='services: {}\n';
  writeFileSync(join(app,'.env'),oldEnv,{mode:0o600});writeFileSync(join(app,'docker-compose.yml'),oldCompose);
  writeFileSync(join(dir,'ci.json'),JSON.stringify({workflow_runs:options.ci===false?[]:[{path:'.github/workflows/ci.yml',head_sha:sha,status:'completed',conclusion:'success'}]}));
  writeFileSync(join(dir,'version.json'),JSON.stringify({sha:options.badVersion?'b'.repeat(40):sha}));
  writeFileSync(join(bin,'docker'),`#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_DIR/commands"
if [[ "$1" = inspect ]]; then
  if [[ "$*" = *'.Image'* ]]; then printf 'sha256:${'1'.repeat(64)}\\n'; else echo true; fi
elif [[ "$*" = *'ps -q'* ]]; then echo mock-container;
fi
`,{mode:0o755});
  writeFileSync(join(bin,'curl'),`#!/bin/bash
if [[ "$*" = *'actions/runs?'* ]]; then cat "$MOCK_DIR/ci.json";
elif [[ "$*" = *'/version'* ]]; then cat "$MOCK_DIR/version.json";
else echo ok; fi
`,{mode:0o755});
  writeFileSync(join(bin,'sleep'),'#!/bin/bash\nexit 0\n',{mode:0o755});
  const result=spawnSync('bash',[resolve('ops/oci-staging/release.sh'),sha],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,MOCK_DIR:dir,VIDEOCRAFT_APP_DIR:app}});
  return {dir,app,oldEnv,oldCompose,result,commands:()=>{try{return readFileSync(join(dir,'commands'),'utf8');}catch{return '';}}};
}

test('release refuses a commit without passing CI before changing containers',()=>{
  const f=release({ci:false});try{
    assert.notEqual(f.result.status,0);assert.equal(f.commands(),'');
    assert.equal(readFileSync(join(f.app,'.env'),'utf8'),f.oldEnv);
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('release pins only app services and retains existing configuration',()=>{
  const f=release();try{
    assert.equal(f.result.status,0,f.result.stderr);
    assert.match(f.commands(),/up -d --no-deps api web render-worker/);
    assert.doesNotMatch(f.commands(),/hub|n8n|postgres|redis|clamav/);
    assert.equal(readFileSync(join(f.app,'.env'),'utf8'),f.oldEnv+'VIDEOCRAFT_RELEASE_SHA='+sha+'\n');
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('version mismatch rolls back exact prior app images and restores configuration',()=>{
  const f=release({badVersion:true});try{
    assert.notEqual(f.result.status,0);
    assert.match(f.commands(),/rollback.json up -d --no-deps api web render-worker/);
    assert.equal(readFileSync(join(f.app,'.env'),'utf8'),f.oldEnv);
    assert.equal(readFileSync(join(f.app,'docker-compose.yml'),'utf8'),f.oldCompose);
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
