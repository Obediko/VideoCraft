import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerEffectRoutes} from '../dist/effects.js';
test('effects are authenticated, private, deduplicated, persistent across requests, and deletable by owner only',async()=>{
  const rows=new Map();let user='alice';
  const effects={list:async uid=>[...rows.entries()].filter(([k])=>k.startsWith(uid+':')).map(([,v])=>v),save:async(uid,e)=>rows.set(uid+':'+e.id,e),remove:async(uid,id)=>rows.delete(uid+':'+id)};
  const server=Fastify();registerEffectRoutes(server,{effects,authenticate:async()=>user?{userId:user}:null});
  try{
    const add=await server.inject({method:'POST',url:'/v1/me/effects',payload:{presetId:'chapter',text:'The next step'}});assert.equal(add.statusCode,201);
    const id=add.json().effect.id;
    await server.inject({method:'POST',url:'/v1/me/effects',payload:{presetId:'chapter',text:'The next step'}});
    assert.equal((await server.inject('/v1/me/effects')).json().saved.length,1);
    user='bob';assert.equal((await server.inject('/v1/me/effects')).json().saved.length,0);
    await server.inject({method:'DELETE',url:'/v1/me/effects/'+id});
    user='alice';assert.equal((await server.inject('/v1/me/effects')).json().saved.length,1);
    assert.equal((await server.inject({method:'POST',url:'/v1/me/effects',payload:{presetId:'arbitrary-download'}})).statusCode,400);
    await server.inject({method:'DELETE',url:'/v1/me/effects/'+id});assert.equal((await server.inject('/v1/me/effects')).json().saved.length,0);
    user='';for(const method of ['GET','POST','DELETE'])assert.equal((await server.inject({method,url:'/v1/me/effects'+(method==='DELETE'?'/'+id:'')})).statusCode,401);
  }finally{await server.close();}
});
