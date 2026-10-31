import test from 'node:test';
import assert from 'node:assert/strict';
import {EFFECT_PRESETS,parseEffectRecipe,effectRecipeOperations,parseTimelineOperations,applyTimelineOperations} from '../dist/index.js';
test('every creative recipe compiles to valid operations anchored to the chosen clip occurrence',()=>{
  const timeline={durationUs:8e6,tracks:[{id:'v',kind:'video',clips:[{id:'first',assetId:'a',sourceStartUs:0,sourceEndUs:4e6,timelineStartUs:0,timelineEndUs:4e6},{id:'repeat',assetId:'a',sourceStartUs:0,sourceEndUs:4e6,timelineStartUs:4e6,timelineEndUs:8e6}]}]};
  for(const preset of EFFECT_PRESETS){
    const recipe=parseEffectRecipe({presetId:preset.id,durationS:2});
    const ops=effectRecipeOperations(recipe,{anchorAssetId:'a',anchorClipId:'repeat',anchorSourceUs:1e6});
    const parsed=parseTimelineOperations(ops);
    const result=applyTimelineOperations(timeline,parsed);
    for(const c of result.tracks.filter(t=>t.kind==='overlay'||t.kind==='audio').flatMap(t=>t.clips))assert.ok(c.timelineStartUs>=4e6,preset.id+' must target repeat occurrence');
    assert.equal(result.durationUs,8e6);
  }
});
test('untrusted recipes cannot inject unknown executable effects or unbounded parameters',()=>{
  for(const value of [{presetId:'remote-js',url:'https://example.com/code.js'},{presetId:'thinking',durationS:Infinity},{presetId:'thinking',color:'url(x)'},{presetId:'chapter',text:'x'.repeat(81)},null])assert.throws(()=>parseEffectRecipe(value));
  assert.equal(parseEffectRecipe({presetId:'chapter',text:'  Hello  ',color:'#aabbcc'}).text,'Hello');
});

test('a new combination of text, motion and sound is a reusable recipe, not another hard-coded preset',()=>{
  const recipe=parseEffectRecipe({presetId:'question',text:'What changed?',color:'#8AA592',durationS:2.5,sound:'riser',zoom:'push'});
  const ops=effectRecipeOperations(recipe,{anchorAssetId:'a',anchorClipId:'clip',anchorSourceUs:1e6});
  assert.deepEqual(ops.map(o=>o.type),['set-clip-effects','add-graphic','add-sfx']);
  assert.equal(ops[0].zoom,'push');assert.equal(ops[1].text,'What changed?');assert.equal(ops[2].kind,'riser');
  assert.deepEqual(parseEffectRecipe(JSON.parse(JSON.stringify(recipe))),recipe);
  for(const field of [{sound:'remote-mp3'},{zoom:'run-script'}])assert.throws(()=>parseEffectRecipe({...recipe,...field}));
});
