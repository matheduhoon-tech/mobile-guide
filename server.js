'use strict';
const express = require('express');
const { AccessToken, TrackSource } = require('livekit-server-sdk');
const { rateLimit } = require('express-rate-limit');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function createApp(env = process.env) {
  for (const key of ['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','SESSION_SECRET','ROOM_CODE']) {
    if (!env[key]) throw new Error(`${key} 환경변수를 설정하세요.`);
  }
  if (!/^wss:\/\//.test(env.LIVEKIT_URL)) throw new Error('LIVEKIT_URL은 wss:// 주소여야 합니다.');
  if (env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET은 32자 이상이어야 합니다.');
  const roomCode = env.ROOM_CODE.toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(roomCode)) throw new Error('ROOM_CODE: 영문/숫자 1~8자');
  const app = express();
  // Render has one reverse proxy. Do not use trust proxy=true.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    res.set('X-Content-Type-Options','nosniff');
    res.set('Referrer-Policy','same-origin');
    if (req.path.startsWith('/api/')) res.set('Cache-Control','no-store');
    next();
  });
  app.use(express.json({limit:'8kb'}));
  const dataDir = env.DATA_DIR || path.join(__dirname,'data');
  fs.mkdirSync(dataDir,{recursive:true});
  const db = new DatabaseSync(path.join(dataDir,'questions.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, room TEXT NOT NULL, sender TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, answered INTEGER NOT NULL DEFAULT 0)');
  const cutoff = () => Date.now() - 24*60*60*1000;
  const prune = () => db.prepare('DELETE FROM questions WHERE at < ?').run(cutoff());
  prune();
  const pruneTimer = setInterval(prune, 3600000); pruneTimer.unref();
  const sign = value => createHmac('sha256',env.SESSION_SECRET).update(value).digest('base64url');
  const equal = (a,b) => { const aa=Buffer.from(String(a)),bb=Buffer.from(String(b)); return aa.length===bb.length && timingSafeEqual(aa,bb); };
  const session = data => { const body=Buffer.from(JSON.stringify(data)).toString('base64url'); return `${body}.${sign(body)}`; };
  function authenticate(req,res,next) {
    try {
      const [body,sig,...rest] = (req.headers.authorization || '').replace(/^Bearer /,'').split('.');
      if (rest.length || !body || !sig || !equal(sign(body),sig)) throw new Error();
      const user=JSON.parse(Buffer.from(body,'base64url').toString());
      if (user.exp < Date.now() || user.room!==roomCode || !['host','listener'].includes(user.role)) throw new Error();
      req.user=user; next();
    } catch { res.status(401).json({message:'입장 인증이 만료되었습니다. 다시 입장해주세요.'}); }
  }
  const hostOnly = (req,res,next) => req.user.role==='host' ? next() : res.status(403).json({message:'진행자만 사용할 수 있습니다.'});
  // Enough capacity for 32+ phones on the same school Wi-Fi/NAT.
  app.use('/api/join',rateLimit({windowMs:60000,limit:240,standardHeaders:'draft-8',legacyHeaders:false,message:{message:'잠시 후 다시 입장해주세요.'}}));
  app.post('/api/join',(req,res) => {
    const {code,role}=req.body || {};
    if (!['host','listener'].includes(role) || !equal(String(code||'').trim().toUpperCase(),roomCode)) {
      return res.status(403).json({message:'입장 코드를 확인해주세요.'});
    }
    const user={room:roomCode,role,identity:`${role}-${randomUUID()}`,exp:Date.now()+12*3600000};
    res.json({session:session(user),identity:user.identity,expiresAt:user.exp});
  });
  app.post('/api/token',authenticate,async(req,res,next) => {
    try {
      const user=req.user;
      const token=new AccessToken(env.LIVEKIT_API_KEY,env.LIVEKIT_API_SECRET,{
        identity:user.identity,ttl:'15m',metadata:JSON.stringify({role:user.role}),name:user.role==='host'?'진행자':'청취자'
      });
      token.addGrant({roomJoin:true,room:`mobile-guide-${user.room}`,canPublish:user.role==='host',
        canPublishSources:user.role==='host'?[TrackSource.MICROPHONE]:[],canSubscribe:user.role==='listener',canPublishData:false,canUpdateOwnMetadata:false});
      res.json({url:env.LIVEKIT_URL,token:await token.toJwt()});
    } catch(e) { next(e); }
  });
  const questionLimit=rateLimit({windowMs:60000,limit:12,keyGenerator:req=>req.user.identity,standardHeaders:'draft-8',legacyHeaders:false,message:{message:'질문은 잠시 기다린 뒤 보내주세요.'}});
  app.post('/api/questions',authenticate,questionLimit,(req,res) => {
    if(req.user.role!=='listener') return res.status(403).json({message:'청취자만 질문을 보낼 수 있습니다.'});
    const {id,text,name}=req.body||{};
    if (!/^[a-f0-9-]{36}$/i.test(id||'') || typeof text!=='string' || !text.trim() || text.length>300 || (name!==undefined && (typeof name!=='string'||name.length>20))) {
      return res.status(400).json({message:'질문은 1~300자, 이름은 20자 이내로 입력해주세요.'});
    }
    const old=db.prepare('SELECT sender FROM questions WHERE id=?').get(id);
    if(old) return old.sender===req.user.identity ? res.json({ok:true,id}) : res.status(409).json({message:'질문 ID가 중복되었습니다.'});
    if(db.prepare('SELECT count(*) AS n FROM questions WHERE room=? AND at>=?').get(req.user.room,cutoff()).n>=2000) return res.status(429).json({message:'오늘 질문 목록이 가득 찼습니다.'});
    db.prepare('INSERT INTO questions (id,room,sender,name,text,at) VALUES (?,?,?,?,?,?)').run(id,req.user.room,req.user.identity,(name||'').trim()||'익명',text.trim(),Date.now());
    res.json({ok:true,id});
  });
  app.get('/api/questions',authenticate,hostOnly,(req,res) => {
    res.json({questions:db.prepare('SELECT id,name,text,at,answered FROM questions WHERE room=? AND at>=? ORDER BY at DESC LIMIT 2000').all(req.user.room,cutoff())});
  });
  app.patch('/api/questions/:id',authenticate,hostOnly,(req,res) => {
    if(typeof req.body?.answered!=='boolean') return res.status(400).json({message:'처리 상태를 확인해주세요.'});
    const result=db.prepare('UPDATE questions SET answered=? WHERE id=? AND room=?').run(Number(req.body.answered),req.params.id,req.user.room);
    res.status(result.changes?200:404).json({ok:!!result.changes});
  });
  app.get('/health',(_req,res)=>res.json({ok:true,version:'6.0.0',media:'LiveKit SFU'}));
  app.get(['/host','/listen','/host.html','/listen.html'],(_req,res)=>res.sendFile('index.html',{root:path.join(__dirname,'public')}));
  app.get('/',(_req,res)=>res.redirect('/listen'));
  app.use(express.static(path.join(__dirname,'public'),{maxAge:0}));
  app.use((err,_req,res,_next)=>{
    if(err instanceof SyntaxError || err.type==='entity.too.large') return res.status(400).json({message:'요청 내용을 확인해주세요.'});
    console.error('Request failed:',err.name);
    res.status(500).json({message:'서버 처리에 실패했습니다. 잠시 후 다시 시도해주세요.'});
  });
  return {app,close:()=>{clearInterval(pruneTimer);db.close();}};
}
if(require.main===module) {
  const service=createApp();
  const server=service.app.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('Mobile Guide V6 SFU ready'));
  const shutdown=()=>server.close(()=>{service.close();process.exit(0);});
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
module.exports={createApp};


