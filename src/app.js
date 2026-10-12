import { Room, RoomEvent, Track, ConnectionState, DisconnectReason } from 'livekit-client';
const $ = id => document.getElementById(id);
const role = document.documentElement.dataset.role;
const isHost = role === 'host';
let session = '', roomCode = '', room, connecting = false, stopped = true;
let reconnectTimer, attempt = 0, wantsMic = false, micBusy = false, audioEnabled = false;
let questionTimer, polling = false, wakeLock, wantsWake = false, pendingQuestion, meterTimer;
const remoteAudio = new Map();
const questions = new Map();
const status = (text, kind='') => {
  const el=$(isHost?'hostStatus':'listenerStatus');
  el.querySelector('span:last-child').textContent=text;
  el.querySelector('.dot').className='dot '+kind;
};
async function api(url, method='GET', body) {
  const response=await fetch(url,{method,cache:'no-store',headers:{'Content-Type':'application/json',...(session?{Authorization:`Bearer ${session}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(!response.ok) {
    if(response.status===401) { stopped=true;clearTimeout(reconnectTimer);status('입장 인증 만료 · 나갔다가 다시 입장해주세요.'); }
    const error=new Error(result.message||'요청에 실패했습니다.');error.status=response.status;throw error;
  }
  return result;
}
function micButtons() {
  const connected=room?.state===ConnectionState.Connected;
  $('startMic').disabled=micBusy||!connected||wantsMic;
  $('stopMic').disabled=micBusy||!wantsMic;
}
function roster() {
  if(!room) return;
  const people=[room.localParticipant,...room.remoteParticipants.values()];
  const hosts=people.filter(p=>p.identity.startsWith('host-'));
  const listeners=people.filter(p=>p.identity.startsWith('listener-'));
  for(const id of ['hostCount','listenerHostCount']) $(id).textContent=hosts.length;
  for(const id of ['listenerCount','listenerListenerCount']) $(id).textContent=listeners.length;
  if(!isHost) {
    const broadcasting=hosts.filter(p=>[...p.audioTrackPublications.values()].some(t=>!t.isMuted));
    $('speakerList').textContent=broadcasting.length?`방송 중인 진행자 ${broadcasting.length}명 · 모든 음성을 함께 듣습니다.`:'진행자의 방송을 기다리고 있습니다.';
    if(room.state===ConnectionState.Connected) status(broadcasting.length?'LIVE · 음성 수신 중':'연결됨 · 진행자 방송 대기',broadcasting.length?'live':'ok');
  }
  micButtons();
}
function removeAudio(sid) {
  const entry=remoteAudio.get(sid);
  if(entry) { entry.track.detach(entry.element);entry.element.remove();remoteAudio.delete(sid); }
}
function clearAudio() { for(const sid of remoteAudio.keys()) removeAudio(sid); }
function attachAudio(track,publication,participant) {
  if(isHost||track.kind!==Track.Kind.Audio) return;
  removeAudio(publication.trackSid);
  const element=track.attach();element.autoplay=audioEnabled;element.controls=true;
  element.setAttribute('playsinline','');element.setAttribute('aria-label','진행자 음성');
  element.muted=!audioEnabled;
  $('audioContainer').append(element);
  remoteAudio.set(publication.trackSid,{track,element,identity:participant.identity});
  if(audioEnabled) element.play().catch(()=>audioBlocked());
  roster();
}
function audioBlocked() { $('enableAudio').disabled=false;$('enableAudio').textContent='▶ 눌러서 소리 다시 듣기'; }
async function enableAudio() {
  audioEnabled=true;
  // Invoke startAudio synchronously inside the user gesture for mobile Safari.
  const start=room?.startAudio();
  const plays=[...remoteAudio.values()].map(({element})=>{element.muted=false;return element.play();});
  try {
    await Promise.all([start,...plays]);
    $('enableAudio').textContent='🔊 소리 재생 허용됨';$('enableAudio').disabled=true;
  } catch { audioBlocked(); }
}
function installEvents(r) {
  const current=()=>room===r&&!stopped;
  r.on(RoomEvent.TrackSubscribed,(...args)=>{if(current())attachAudio(...args);});
  r.on(RoomEvent.TrackUnsubscribed,(_t,p)=>{if(current()){removeAudio(p.trackSid);roster();}});
  r.on(RoomEvent.ParticipantDisconnected,p=>{
    if(!current())return;for(const [sid,a] of remoteAudio)if(a.identity===p.identity)removeAudio(sid);roster();
  });
  for(const event of [RoomEvent.ParticipantConnected,RoomEvent.TrackPublished,RoomEvent.TrackUnpublished,RoomEvent.TrackMuted,RoomEvent.TrackUnmuted,RoomEvent.LocalTrackPublished,RoomEvent.LocalTrackUnpublished])r.on(event,()=>{if(current())roster();});
  r.on(RoomEvent.Reconnecting,()=>{if(current()){status('연결 끊김 · 자동 복구 중');micButtons();}});
  r.on(RoomEvent.SignalReconnecting,()=>{if(current())status('네트워크 연결 복구 중');});
  r.on(RoomEvent.Reconnected,()=>{
    if(!current())return;attempt=0;status(isHost?(wantsMic?'LIVE · 방송 복구됨':'연결 복구됨'):'연결 복구됨','ok');roster();
    if(audioEnabled)enableAudio();if(isHost)pollQuestions();
  });
  r.on(RoomEvent.AudioPlaybackStatusChanged,()=>{if(current()&&audioEnabled&&!r.canPlaybackAudio)audioBlocked();});
  r.on(RoomEvent.Disconnected,reason=>{
    if(!current())return;clearAudio();micButtons();
    if([DisconnectReason.DUPLICATE_IDENTITY,DisconnectReason.PARTICIPANT_REMOVED,DisconnectReason.ROOM_DELETED].includes(reason)) {
      stopped=true;status('연결이 종료되었습니다. 나갔다가 다시 입장해주세요.');return;
    }
    status('연결 끊김 · 자동 재접속 중');scheduleReconnect();
  });
  r.on(RoomEvent.MediaDevicesError,()=>{if(current())status('마이크 권한과 연결 상태를 확인해주세요.');});
  r.on(RoomEvent.TrackSubscriptionFailed,()=>{if(current()){status('음성 수신 실패 · 재연결을 시도합니다.');setTimeout(()=>{if(current()&&r.state===ConnectionState.Connected)r.disconnect();},2000);}});
  r.on(RoomEvent.ConnectionQualityChanged,(quality,p)=>{if(current()&&p===r.localParticipant&&quality==='poor')status('네트워크가 약합니다. 잠시 이동을 멈춰주세요.');});
}
function scheduleReconnect() {
  if(stopped||connecting||reconnectTimer)return;
  const delay=Math.min(30000,1000*2**Math.min(attempt++,5))+Math.random()*500;
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;connectRoom();},delay);
}
async function connectRoom() {
  if(stopped||connecting||!session)return;
  if(room && room.state!==ConnectionState.Disconnected)return;
  connecting=true;let r;
  try {
    const old=room;room=undefined;
    if(old)await old.disconnect();clearAudio();
    const credentials=await api('/api/token','POST');
    if(stopped)return;
    r=new Room({adaptiveStream:false,dynacast:false,audioCaptureDefaults:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},publishDefaults:{stopMicTrackOnMute:true,audioPreset:{maxBitrate:32000},dtx:true,red:true}});
    room=r;installEvents(r);
    status('음성 서버에 연결하는 중');
    await r.connect(credentials.url,credentials.token,{autoSubscribe:!isHost});
    if(stopped||room!==r){await r.disconnect();return;}
    attempt=0;status(isHost?'연결됨 · 방송 시작을 눌러주세요.':'연결됨 · 진행자 방송 대기','ok');roster();
    if(audioEnabled)enableAudio();
    if(isHost&&wantsMic) {
      try {await r.localParticipant.setMicrophoneEnabled(true);status('LIVE · 방송 복구됨','live');}
      catch {wantsMic=false;status('마이크 복구를 위해 방송 시작을 다시 눌러주세요.');}
    }
  } catch(error) {
    if(r&&room===r){room=undefined;await r.disconnect();}
    if(!stopped)status(`재연결 대기 · ${error.message}`);
  } finally {connecting=false;micButtons();if(!stopped&&(!room||room.state===ConnectionState.Disconnected))scheduleReconnect();}
}
async function setMic(enabled) {
  if(micBusy)return;
  if(enabled&&room?.state!==ConnectionState.Connected)return;
  micBusy=true;wantsMic=enabled;micButtons();
  try {
    if(room)await room.localParticipant.setMicrophoneEnabled(enabled);
    status(enabled?'LIVE · 방송 중':'방송 종료 · 다시 시작 가능',enabled?'live':'ok');
    if(enabled){wantsWake=true;await acquireWake();}
  } catch(error) {wantsMic=false;status(`마이크를 켤 수 없습니다. 권한을 확인해주세요. (${error.name})`);}
  finally {micBusy=false;micButtons();roster();}
}
function renderQuestions() {
  const container=$('questionList');container.replaceChildren();$('questionCount').textContent=questions.size;
  if(!questions.size){const empty=document.createElement('div');empty.className='questionEmpty';empty.textContent='아직 질문이 없습니다.';container.append(empty);return;}
  for(const q of questions.values()) {
    const box=document.createElement('div');box.className='questionItem'+(q.answered?'':' new');
    const meta=document.createElement('div');meta.className='questionMeta';
    const name=document.createElement('span');name.textContent=`👤 ${q.name}`;
    const time=document.createElement('span');time.textContent=new Date(q.at).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
    meta.append(name,time);
    const text=document.createElement('div');text.className='questionText';text.textContent=q.text;
    const button=document.createElement('button');button.className='secondary';button.textContent=q.answered?'✓ 답변 완료 · 되돌리기':'답변 완료';
    button.onclick=async()=>{button.disabled=true;try{await api(`/api/questions/${q.id}`,'PATCH',{answered:!q.answered});await pollQuestions();}catch(e){alert(e.message);}finally{button.disabled=false;}};
    box.append(meta,text,button);container.append(box);
  }
}
async function pollQuestions() {
  if(!isHost||!session||stopped||polling)return;
  polling=true;
  try {
    const result=await api('/api/questions');
    const next=JSON.stringify(result.questions);
    if(next!==pollQuestions.last){pollQuestions.last=next;questions.clear();for(const q of result.questions)questions.set(q.id,q);renderQuestions();}
    $('questionSync').textContent='질문 목록 연결됨 · 3초마다 확인';
  } catch { $('questionSync').textContent='질문 목록 연결 복구 중 · 받은 질문은 계속 표시됩니다.'; }
  finally {polling=false;}
}
function wakeUI() {
  for(const id of ['wakeBtn','listenerWake']) {$(id).textContent=wakeLock?'✅ 화면 꺼짐 방지 사용 중':wantsWake?'☀️ 화면 꺼짐 방지 재시도':'☀️ 화면 꺼짐 방지 켜기';$(id).classList.toggle('wakeActive',!!wakeLock);}
}
async function acquireWake() {
  if(!wantsWake||wakeLock||document.visibilityState!=='visible')return;
  if(!navigator.wakeLock){wantsWake=false;wakeUI();return;}
  try {const lock=await navigator.wakeLock.request('screen');wakeLock=lock;lock.addEventListener('release',()=>{if(wakeLock===lock)wakeLock=undefined;wakeUI();});}
  catch {}wakeUI();
}
async function toggleWake() {
  if(!navigator.wakeLock)return alert('이 브라우저는 화면 꺼짐 방지를 지원하지 않습니다. 휴대폰의 자동 잠금 시간을 늘려주세요.');
  wantsWake=!wantsWake;if(!wantsWake){await wakeLock?.release();wakeLock=undefined;}else await acquireWake();wakeUI();
}
$('wakeBtn').onclick=toggleWake;$('listenerWake').onclick=toggleWake;
$('enableAudio').onclick=enableAudio;
$('startMic').onclick=()=>setMic(true);$('stopMic').onclick=()=>setMic(false);
$('sendQuestion').onclick=async()=>{
  const text=$('questionText').value.trim(),name=$('questionName').value.trim();
  if(!text)return alert('질문 내용을 입력해주세요.');
  if(!pendingQuestion||pendingQuestion.text!==text||pendingQuestion.name!==name)pendingQuestion={id:crypto.randomUUID(),text,name};
  $('sendQuestion').disabled=true;
  try {await api('/api/questions','POST',pendingQuestion);pendingQuestion=undefined;$('questionText').value='';$('questionSent').textContent='✅ 질문을 접수했습니다.';}
  catch(e){$('questionSent').textContent=`${e.message} 전송되지 않았다면 다시 눌러주세요.`;}
  finally{$('sendQuestion').disabled=false;}
};
$('entryTitle').textContent=isHost?'진행자 입장':'청취자 입장';

$('room').value=(new URLSearchParams(location.search).get('room')||'').toUpperCase().slice(0,8);
const sync=document.createElement('p');sync.id='questionSync';sync.className='muted';$('questionList').before(sync);
$('enter').onclick=async()=>{
  $('enter').disabled=true;$('entryError').textContent='';
  try {
    roomCode=$('room').value.trim().toUpperCase();
    const result=await api('/api/join','POST',{code:roomCode,role});
    session=result.session;stopped=false;attempt=0;
    $('entry').classList.add('hidden');$(isHost?'hostPanel':'listenerPanel').classList.remove('hidden');
    $(isHost?'hostRoom':'listenerRoom').textContent=roomCode;$('leave').classList.remove('hidden');
    history.replaceState(null,'',`${isHost?'/host':'/listen'}?room=${encodeURIComponent(roomCode)}`);
    await connectRoom();
    if(isHost){await pollQuestions();questionTimer=setInterval(pollQuestions,3000);}
    meterTimer=setInterval(()=>{if(isHost&&room)$('meterBar').style.width=Math.min(100,room.localParticipant.audioLevel*200)+'%';},100);
  } catch(e){$('entryError').textContent=e.message;}finally{$('enter').disabled=false;}
};
$('leave').onclick=async()=>{
  stopped=true;wantsMic=false;wantsWake=false;clearTimeout(reconnectTimer);clearInterval(questionTimer);clearInterval(meterTimer);
  await wakeLock?.release();const old=room;room=undefined;await old?.disconnect();clearAudio();session='';location.href=isHost?'/host':'/listen';
};
window.addEventListener('online',()=>{if(!stopped){clearTimeout(reconnectTimer);reconnectTimer=null;connectRoom();if(isHost)pollQuestions();}});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&!stopped){acquireWake();if(audioEnabled)enableAudio();connectRoom();if(isHost)pollQuestions();}
});
window.addEventListener('pagehide',()=>{stopped=true;room?.disconnect();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});




