'use strict';
// Titanic Kid Plays shared multiplayer v2: resumable WebSocket room server. Requires Node 20+.
// Place behind HTTPS/WSS reverse proxy for Quest/Netlify public play.
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 65536;
const MAX_ROOMS = 120;
const MAX_PLAYERS = 4;
const RESUME_GRACE_MS = 120000;
const HOST_FAILOVER_MS = 12000;
const rooms = new Map();
const clients = new Set();
const avatars = ['#c7ec77','#6ce2e8','#e0a7f9','#f7bf77'];
const codeChars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,39}$/;
const allowedGames = (process.env.ALLOWED_GAMES || 'PrimateLab,CarnivalHorror').split(',').map(x=>x.trim()).filter(Boolean);
function validGame(game) {return typeof game==='string'&&GAME_PATTERN.test(game)&&allowedGames.includes(game);}
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
const server = http.createServer((req,res)=>{
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if(pathname==='/health'){
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({ok:true,service:'titanic-kid-plays-shared',version:2,rooms:rooms.size,players:clients.size}));return;
  }
  if(pathname==='/'){
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({service:'Titanic Kid Plays Multiplayer',version:2,ok:true,health:'/health',socket:'/socket',mode:'private-rooms'}));return;
  }
  res.writeHead(404);res.end('Not found');
});
const now=()=>Date.now();
function safeText(str,limit=18){return String(str||'PLAYER').replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,limit)||'PLAYER';}
function newCode(){let code;do{code=Array.from({length:6},()=>codeChars[crypto.randomInt(codeChars.length)]).join('');}while(rooms.has(code));return code;}
function validVec(v,n=3){return Array.isArray(v)&&v.length===n&&v.every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<300);}
function validPose(p){return p&&validVec(p.head)&&typeof p.yaw==='number'&&Number.isFinite(p.yaw)&&Math.abs(p.yaw)<100000&&(!p.left||validVec(p.left))&&(!p.right||validVec(p.right))&&typeof p.vr==='boolean'&&(!p.scene||(typeof p.scene==='string'&&/^[a-zA-Z0-9_-]{1,32}$/.test(p.scene)))&&(!('level' in p)||(Number.isInteger(p.level)&&p.level>=0&&p.level<=99));}
function send(client,obj){if(client.closed||!client.socket.writable||client.socket.writableLength>350000)return;const buf=Buffer.from(JSON.stringify(obj));const header=buf.length<126?Buffer.from([0x81,buf.length]):buf.length<=65535?Buffer.from([0x81,126,buf.length>>8,buf.length&255]):null;if(header)client.socket.write(Buffer.concat([header,buf]));}
function frame(client,opcode,data=Buffer.alloc(0)){if(client.closed||!client.socket.writable)return;const length=data.length;if(length>65535)return;const h=length<126?Buffer.from([0x80|opcode,length]):Buffer.from([0x80|opcode,126,length>>8,length&255]);client.socket.write(Buffer.concat([h,data]));}
function sendError(c,message){send(c,{type:'error',message});}
function sendToRoom(room,obj,exceptId=null){for(const c of room.members.values())if(c.id!==exceptId)send(c,obj);}
function roster(room){return {type:'roster',room:room.code,gameId:room.gameId,hostId:room.hostId,players:Array.from(room.members.values()).filter(c=>!c.closed).map(c=>({id:c.id,name:c.name,color:c.color,pose:c.pose}))};}
function roomRoster(room){sendToRoom(room,roster(room));}
function leaveRoom(c){const room=c.room;if(!room)return;c.room=null;room.members.delete(c.id);if(!room.members.size){rooms.delete(room.code);return;}if(room.hostId===c.id){room.hostId=Array.from(room.members.values()).find(p=>!p.closed)?.id||room.members.keys().next().value;sendToRoom(room,{type:'notice',message:'Room host changed. World control transferred.'});}
  roomRoster(room);
}
function reserveDisconnected(c){
  if(!c.room)return;
  c.disconnectedAt=now();
  roomRoster(c.room);
}
function resumeRoom(c,m){
  const code=String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
  const room=rooms.get(code);
  if(!room||room.gameId!==m.gameId){send(c,{type:'error',code:'ROOM_EXPIRED',message:'The room was reset. Create a new room and share its code.'});return;}
  const old=Array.from(room.members.values()).find(p=>p.closed&&p.resumeToken===m.resumeToken&&typeof m.resumeToken==='string'&&p.disconnectedAt&&now()-p.disconnectedAt<RESUME_GRACE_MS);
  if(!old){send(c,{type:'error',code:'RESUME_EXPIRED',message:'Your place in this room expired. Join again using the room code.'});return;}
  c.id=old.id;c.name=old.name;c.color=old.color;c.pose=old.pose;c.lastPose=0;c.lastWorld=0;c.resumeToken=old.resumeToken;c.room=room;c.disconnectedAt=0;
  old.room=null;room.members.set(c.id,c);
  send(c,{type:'joined',room:room.code,gameId:room.gameId,seed:room.seed,id:c.id,hostId:room.hostId,color:c.color,resumeToken:c.resumeToken,resumed:true});
  if(room.latestWorld)send(c,{type:'world',world:room.latestWorld,seq:room.seq});
  roomRoster(room);
  send(c,{type:'notice',message:'Reconnected to your room.'});
}

function joinRoom(c,room){if(c.room)leaveRoom(c);if(room.members.size>=MAX_PLAYERS){sendError(c,'Room is full (4 players).');return;}
  c.room=room;c.name=safeText(c.requestedName);c.resumeToken=crypto.randomBytes(24).toString('hex');const colorsInUse=new Set(Array.from(room.members.values(),p=>p.color));c.color=avatars.find(col=>!colorsInUse.has(col))||avatars[0];room.members.set(c.id,c);
  if(!room.hostId)room.hostId=c.id;
  send(c,{type:'joined',room:room.code,gameId:room.gameId,seed:room.seed,id:c.id,hostId:room.hostId,color:c.color,resumeToken:c.resumeToken});
  if(room.latestWorld)send(c,{type:'world',world:room.latestWorld,seq:room.seq});
  roomRoster(room);
}
const carnivalActions=new Set(['key','trap','advance']);
const actionNames=new Set(['door','skull','core','switch','ghost','mod','exorcise','banishGhost','transform','wall','gun','npcTool']);
const worldModIds=new Set(['spawn','horde','wave','scare','clear','revert','openDoor','closeDoor','spawnNPC','duplicateNPC','resetLab','spawnBlueGhost','spawnGreenGhost','spawnPurpleGhost','spawnGoldGhost','spawnRedGhost','spawnGhostRandom','dismissGhosts','dismissRedGhost','powerPulse','unlockGhosts']);
const ownerMods=new Set(['unlockGhosts','resetLab','spawnOwnerNPC','spawnOwnerMonster','banHammer','kickHammer','freezeHammer','shrinkHammer','cloneHammer','zapHammer','bringHammer','cureHammer']);
function allowedAction(c,a){if(!a||typeof a.kind!=='string')return false;
  if(c.room?.gameId==='CarnivalHorror'){return carnivalActions.has(a.kind)&&(a.kind!=='key'||(Number.isInteger(a.index)&&a.index>=0&&a.index<3));}
  if(c.room?.gameId!=='PrimateLab')return a.kind==='interact'&&typeof a.target==='string'&&/^[a-zA-Z0-9_-]{1,40}$/.test(a.target);
  if(!actionNames.has(a.kind))return false;
  if(a.kind==='door')return typeof a.open==='boolean';
  if(a.kind==='skull')return Number.isInteger(a.index)&&a.index>=0&&a.index<3;
  if(a.kind==='core')return Number.isInteger(a.index)&&a.index>=0&&a.index<4;
  if(a.kind==='switch')return Number.isInteger(a.index)&&a.index>=0&&a.index<3;
  if(a.kind==='ghost')return ['red','blue','green','purple','gold','random'].includes(a.color);
  if(a.kind==='mod')return typeof a.id==='string'&&worldModIds.has(a.id)&&(!ownerMods.has(a.id)||c.id===c.room.hostId);
  if(a.kind==='wall')return Number.isInteger(a.index)&&a.index>=0&&a.index<11;
  if(a.kind==='gun')return ['monsterGun','stunGun','cureGun','cloneGun','blastGun'].includes(a.tool)&&['npc','monster','redGhost'].includes(a.targetType)&&Number.isInteger(a.uid)&&a.uid>=-1;
  if(a.kind==='exorcise'||a.kind==='transform')return Number.isInteger(a.uid)&&a.uid>=0;
  if(a.kind==='banishGhost')return ['red','blue','green','purple','gold'].includes(a.color);
  if(a.kind==='npcTool')return c.id===c.room.hostId&&['banHammer','kickHammer','freezeHammer','shrinkHammer','cloneHammer','zapHammer','bringHammer','cureHammer'].includes(a.tool)&&['npc','monster','redGhost'].includes(a.targetType)&&Number.isInteger(a.uid);
  return false;
}
function handle(c,m){if(!m||typeof m!=='object'||Array.isArray(m))return;
  if(m.type==='resume'){resumeRoom(c,m);return;}
  if(m.type==='create'){
    if(c.room){sendError(c,'Leave your current room before creating another.');return;}
    if(rooms.size>=MAX_ROOMS){sendError(c,'Room capacity reached.');return;}
    const gameId=String(m.gameId||'PrimateLab');if(!validGame(gameId)){sendError(c,'Unknown game. Ask the owner to register it on the shared server.');return;}
    c.requestedName=safeText(m.name);const code=newCode(),room={code,gameId,seed:crypto.randomInt(1,0xFFFFFFFF),members:new Map(),hostId:null,latestWorld:null,seq:0};rooms.set(code,room);joinRoom(c,room);return;
  }
  if(m.type==='join'){
    if(c.room){sendError(c,'Leave your current room before joining another.');return;}
    const room=rooms.get(String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6));if(!room){send(c,{type:'error',code:'ROOM_EXPIRED',message:'Room not found. The server may have restarted. Create a new room.'});return;}
    const gameId=String(m.gameId||'PrimateLab');if(room.gameId!==gameId){sendError(c,'That room belongs to another game. Open the correct game to join.');return;}
    c.requestedName=safeText(m.name);joinRoom(c,room);return;
  }
  if(m.type==='leave'){leaveRoom(c);send(c,{type:'left'});return;}
  if(!c.room)return;
  const r=c.room;
  if(m.type==='pose'){
    if(now()-c.lastPose<36||!validPose(m.pose))return;
    c.lastPose=now();c.pose={head:m.pose.head.map(v=>Math.round(v*100)/100),yaw:m.pose.yaw,vr:m.pose.vr,left:m.pose.left||null,right:m.pose.right||null,scene:m.pose.scene||'lab',level:m.pose.level||0};
  }else if(m.type==='world'){
    if(c.id!==r.hostId||now()-c.lastWorld<65)return;
    const w=m.world;
    if(!w||typeof w!=='object'||Array.isArray(w))return;
    if(r.gameId==='PrimateLab') {if(!Array.isArray(w.scientists)||!Array.isArray(w.monsters)||!Array.isArray(w.ghosts)||w.scientists.length>40||w.monsters.length>45||w.ghosts.length>6)return;}
    else if(r.gameId==='CarnivalHorror'){if(!['carnival','falling','backrooms','dead','win'].includes(w.scene)||!Number.isInteger(w.level)||w.level<0||w.level>2||!Array.isArray(w.enemies)||w.enemies.length>32||!Array.isArray(w.keys)||w.keys.length>3||JSON.stringify(w).length>18000)return;}
    else if(typeof w.scene!=='string'||!/^[a-zA-Z0-9_-]{1,32}$/.test(w.scene)||JSON.stringify(w).length>14000)return;
    c.lastWorld=now();r.latestWorld=w;r.seq++;sendToRoom(r,{type:'world',world:w,seq:r.seq},c.id);
  }else if(m.type==='action'){
    if(now()-c.actionWindow>1000){c.actionWindow=now();c.actionCount=0;}
    if(++c.actionCount>16 || !allowedAction(c,m.action))return;
    if(c.id!==r.hostId){const host=r.members.get(r.hostId);if(host)send(host,{type:'action',from:c.id,action:m.action});}
  }else if(m.type==='catch'){
    if(c.id!==r.hostId)return;
    const target=r.members.get(String(m.target||''));if(target)send(target,{type:'catch',color:['red','blue','green','purple','gold'].includes(m.color)?m.color:'red'});
  }
}
server.on('upgrade',(req,socket,head)=>{
  const uri=new URL(req.url,'http://localhost');
  if(uri.pathname!=='/socket'||(allowedOrigins.length&&!allowedOrigins.includes(req.headers.origin))){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  if(clients.size>=MAX_ROOMS*MAX_PLAYERS){socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');socket.destroy();return;}
  const key=req.headers['sec-websocket-key'];
  if(req.headers.upgrade?.toLowerCase()!=='websocket'||req.headers['sec-websocket-version']!=='13'||typeof key!=='string'||Buffer.from(key,'base64').length!==16){socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  socket.setNoDelay(true);socket.setTimeout(0);
  const c={id:crypto.randomBytes(6).toString('hex'),socket,closed:false,disconnectedAt:0,resumeToken:null,buffer:Buffer.alloc(0),room:null,pose:null,name:'PLAYER',requestedName:'PLAYER',color:avatars[0],lastPose:0,lastWorld:0,actionCount:0,actionWindow:0,lastSeen:now()};
  clients.add(c);send(c,{type:'hello',id:c.id,protocol:13,maxPlayers:MAX_PLAYERS,games:allowedGames});
  const close=()=>{if(c.closed)return;c.closed=true;clients.delete(c);reserveDisconnected(c);try{socket.destroy();}catch(_){}};
  socket.on('error',close);socket.on('close',close);socket.on('end',close);
  function parse(){while(c.buffer.length>=2){const b=c.buffer,op=b[0]&15,fin=!!(b[0]&128),masked=!!(b[1]&128);let size=b[1]&127,offset=2;
      if(size===126){if(b.length<4)return;size=b.readUInt16BE(2);offset=4;}
      else if(size===127){if(b.length<10)return;const long=b.readBigUInt64BE(2);if(long>BigInt(MAX_MESSAGE)){close();return;}size=Number(long);offset=10;}
      if(!masked||size>MAX_MESSAGE||!fin){close();return;}
      if(b.length<offset+4+size)return;
      const mask=b.subarray(offset,offset+4),payload=Buffer.from(b.subarray(offset+4,offset+4+size));for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];c.buffer=b.subarray(offset+4+size);
      c.lastSeen=now();if(op===8){frame(c,8);close();return;}if(op===9){frame(c,10,payload);continue;}if(op===10)continue;if(op!==1){close();return;}
      try{handle(c,JSON.parse(payload.toString('utf8')));}catch(_){/* Ignore malformed JSON */}
    }}
  socket.on('data',chunk=>{if(c.closed)return;c.buffer=Buffer.concat([c.buffer,chunk]);if(c.buffer.length>MAX_MESSAGE+1024){close();return;}parse();});
  if(head?.length)socket.emit('data',head);
});
setInterval(()=>{
  for(const c of clients){if(now()-c.lastSeen>120000){c.socket.destroy();continue;}frame(c,9);}
},10000);
setInterval(()=>{
  const time=now();
  for(const room of rooms.values()){
    for(const c of [...room.members.values()])if(c.closed&&c.disconnectedAt&&time-c.disconnectedAt>RESUME_GRACE_MS){
      room.members.delete(c.id);c.room=null;
    }
    if(!room.members.size){rooms.delete(room.code);continue;}
    const host=room.members.get(room.hostId);
    if(!host||host.closed&&host.disconnectedAt&&time-host.disconnectedAt>HOST_FAILOVER_MS){
      const next=[...room.members.values()].find(c=>!c.closed);
      if(next&&next.id!==room.hostId){room.hostId=next.id;sendToRoom(room,{type:'notice',message:'Host disconnected. World control moved to another player.'});}
    }
  }
},1000);
setInterval(()=>{for(const room of rooms.values())roomRoster(room);},100);
server.listen(PORT,HOST,()=>console.log(`Titanic Kid Plays shared multiplayer: http://${HOST}:${PORT} | WebSocket /socket | /health | games: ${allowedGames.join(', ')}`));
function shutDown(){for(const c of clients){send(c,{type:'notice',message:'Server restarting'});c.socket.destroy();}server.close(()=>process.exit(0));}
process.on('SIGINT',shutDown);process.on('SIGTERM',shutDown);
