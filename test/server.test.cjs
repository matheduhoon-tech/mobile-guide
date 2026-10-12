'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../server');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guide-v6-test-'));
const env={LIVEKIT_URL:'wss://test.livekit.cloud',LIVEKIT_API_KEY:'testkey',LIVEKIT_API_SECRET:'testsecret-which-is-long-enough',SESSION_SECRET:'session-secret-with-at-least-32-characters',ROOM_CODE:'TOK2026',HOST_PIN:'246810',DATA_DIR:temp};
let service=createApp(env);
let server=service.app.listen(0,'127.0.0.1');
const base=()=>`http://127.0.0.1:${server.address().port}`;
async function request(route,method='GET',body,session) {
  const response=await fetch(base()+route,{method,headers:{'Content-Type':'application/json',...(session?{Authorization:`Bearer ${session}`}:{})},body:body?JSON.stringify(body):undefined});
  const data=await response.json();return {status:response.status,data};
}
async function join(role='listener',code='TOK2026',pin='246810') {return request('/api/join','POST',{code,role,pin});}
async function restart() {await new Promise(r=>server.close(r));service.close();service=createApp(env);server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));}
after(async()=>{await new Promise(r=>server.close(r));service.close();fs.rmSync(temp,{recursive:true,force:true});});
test('V6 authentication, SFU grants, 32-person admission, question isolation and persistence',async t=>{
  await t.test('routes, assets and health',async()=>{
    for(const route of ['/host','/listen','/host.html','/listen.html','/school-logo.png','/app.js'])assert.equal((await fetch(base()+route)).status,200,route);
    assert.equal((await request('/health')).data.media,'LiveKit SFU');
    assert.equal((await fetch(base()+'/signal')).status,404);
  });
  await t.test('entry code and host PIN reject invalid roles and credentials',async()=>{
    assert.equal((await join('listener','WRONG')).status,403);
    assert.equal((await join('host','TOK2026','wrong')).status,403);
    assert.equal((await join('admin')).status,403);
  });
  const host1=(await join('host')).data.session,host2=(await join('host')).data.session;
  const listener=(await join()).data.session;
  await t.test('server signed grants: hosts microphone only, listeners cannot publish',async()=>{
    for(const [session,isHost] of [[host1,true],[host2,true],[listener,false]]){
      const response=await request('/api/token','POST',undefined,session);assert.equal(response.status,200);
      const claims=JSON.parse(Buffer.from(response.data.token.split('.')[1],'base64url'));
      assert.equal(claims.video.room,'mobile-guide-TOK2026');
      assert.equal(claims.video.canPublish,isHost);assert.equal(claims.video.canSubscribe,!isHost);
      assert.equal(claims.video.canPublishData,false);assert.equal(claims.video.canUpdateOwnMetadata,false);
      assert.deepEqual(claims.video.canPublishSources,isHost?['microphone']:[]);
      const again=await request('/api/token','POST',undefined,session);
      const renewed=JSON.parse(Buffer.from(again.data.token.split('.')[1],'base64url'));assert.equal(renewed.sub,claims.sub);
    }
    assert.equal((await request('/api/token','POST',undefined,listener+'x')).status,401);
  });
  await t.test('30 listeners and two hosts can enter on one shared IP',async()=>{
    const participants=await Promise.all(Array.from({length:30},()=>join()));
    assert.ok(participants.every(p=>p.status===200));assert.equal(new Set(participants.map(p=>p.data.identity)).size,30);
    const tokens=await Promise.all(participants.map(p=>request('/api/token','POST',undefined,p.data.session)));
    assert.ok(tokens.every(p=>p.status===200));
  });
  const question={id:require('node:crypto').randomUUID(),name:'학생',text:'IB 수업은 어떻게 진행하나요?'};
  await t.test('questions acknowledged once and visible to both hosts',async()=>{
    assert.equal((await request('/api/questions','POST',question,listener)).status,200);
    assert.equal((await request('/api/questions','POST',question,listener)).status,200);
    assert.equal((await request('/api/questions','GET',undefined,listener)).status,403);
    assert.equal((await request('/api/questions','POST',question,host1)).status,403);
    for(const host of [host1,host2]){
      const result=await request('/api/questions','GET',undefined,host);assert.equal(result.data.questions.length,1);assert.equal(result.data.questions[0].text,question.text);
    }
    assert.equal((await request('/api/questions','POST',{...question,id:require('node:crypto').randomUUID(),text:'x'.repeat(301)},listener)).status,400);
    assert.equal((await request('/api/questions/'+question.id,'PATCH',{answered:true},listener)).status,403);
    assert.equal((await request('/api/questions/'+question.id,'PATCH',{answered:true},host1)).status,200);
  });
  await t.test('question history, answer state and signed session survive restart',async()=>{
    await restart();
    const result=await request('/api/questions','GET',undefined,host2);assert.equal(result.status,200);
    assert.equal(result.data.questions.length,1);assert.equal(result.data.questions[0].answered,1);
    assert.equal((await request('/api/token','POST',undefined,listener)).status,200);
  });
  await t.test('question rate limits are per session rather than shared school IP',async()=>{
    const sessions=(await Promise.all(Array.from({length:3},()=>join()))).map(p=>p.data.session);
    for(const session of sessions)for(let i=0;i<12;i++)assert.equal((await request('/api/questions','POST',{id:require('node:crypto').randomUUID(),text:'질문 '+i},session)).status,200);
    assert.equal((await request('/api/questions','POST',{id:require('node:crypto').randomUUID(),text:'제한 확인'},sessions[0])).status,429);
  });
});

