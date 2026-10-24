// Rphysics: локальный сервер комнат (без установки пакетов).
// Запуск:  node rphysics-server.js     (игра: rphystestwebgl.html или index.html рядом)
// Для интернета: залей на Render.com как Web Service (Start Command: node rphysics-server.js), адрес вписать в игре.
// Потом открой на всех телефонах/ПК в одной Wi‑Fi сети адрес, который выведет сервер.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const PORT=+process.env.PORT||8080,GAME=['rphystestwebgl.html','index.html','Rphysics.html'].map(n=>path.join(__dirname,n)).find(p=>fs.existsSync(p))||path.join(__dirname,'rphystestwebgl.html');
const rooms=new Map();let nid=0;
const srv=http.createServer((q,r)=>{if(q.url==='/health'){r.writeHead(200);r.end('ok');return}if(q.url.split('?')[0]==='/'||q.url.endsWith('.html')){fs.readFile(GAME,(e,b)=>{if(e){r.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});r.end('Положи rphystestwebgl.html рядом с этим файлом')}else{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(b)}})}else{r.writeHead(404);r.end('404')}});
function frame(obj){const p=Buffer.from(typeof obj==='string'?obj:JSON.stringify(obj));let h;if(p.length<126)h=Buffer.from([0x81,p.length]);else if(p.length<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(p.length,2)}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(p.length),2)}return Buffer.concat([h,p])}
const send=(c,o)=>{try{c.sock.write(frame(o))}catch(e){}};
function leave(c){const r=c.room;if(!r)return;r.players.delete(c.id);c.room=null;for(const p of r.players.values())send(p,{t:'gone',id:c.id});if(!r.players.size){rooms.delete(r.name);return}if(r.host===c.id){r.host=r.players.keys().next().value;for(const p of r.players.values())send(p,{t:'host',id:r.host})}}
function onMsg(c,txt){let d;try{d=JSON.parse(txt)}catch(e){return}
 if(d.t==='list')return send(c,{t:'rooms',rooms:[...rooms.values()].map(r=>({name:r.name,map:r.map,n:r.players.size,max:r.max,lock:!!r.pass}))});
 if(d.t==='create'){const name=String(d.name||'room').slice(0,24);if(rooms.has(name))return send(c,{t:'err',m:'Комната с таким названием уже есть'});leave(c);const r={name,pass:String(d.pass||''),map:d.map||'construct',vx:d.vx||.4,max:8,players:new Map(),host:c.id};r.players.set(c.id,c);c.room=r;rooms.set(name,r);console.log('+ комната',name,r.map);return send(c,{t:'joined',id:c.id,host:true,room:name,map:r.map,vx:r.vx})}
 if(d.t==='join'){const r=rooms.get(String(d.name));if(!r)return send(c,{t:'err',m:'Комната не найдена'});if(r.pass&&r.pass!==String(d.pass||''))return send(c,{t:'err',m:'Неверный пароль'});if(r.players.size>=r.max)return send(c,{t:'err',m:'Комната заполнена'});leave(c);r.players.set(c.id,c);c.room=r;return send(c,{t:'joined',id:c.id,host:r.host===c.id,room:r.name,map:r.map,vx:r.vx})}
 if(d.t==='msg'&&c.room){if(d.d&&d.d.k==='map'&&c.room.host===c.id){c.room.map=d.d.id;c.room.vx=d.d.vx||c.room.vx}for(const p of c.room.players.values())if(p!==c)send(p,{t:'m',from:c.id,d:d.d})}}
srv.on('upgrade',(req,sock)=>{const key=req.headers['sec-websocket-key'];if(!key){sock.destroy();return}
 sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')+'\r\n\r\n');
 const c={sock,id:++nid,room:null};let buf=Buffer.alloc(0);sock.setNoDelay(true);
 sock.on('data',d=>{buf=Buffer.concat([buf,d]);for(;;){if(buf.length<2)return;const op=buf[0]&15,m=buf[1]&128;let len=buf[1]&127,off=2;
  if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4}else if(len===127){if(buf.length<10)return;len=Number(buf.readBigUInt64BE(2));off=10}
  const mk=m?buf.slice(off,off+4):null;if(m)off+=4;if(buf.length<off+len)return;const pl=Buffer.from(buf.slice(off,off+len));if(mk)for(let i=0;i<len;i++)pl[i]^=mk[i&3];buf=buf.slice(off+len);
  if(op===8){sock.end();return}if(op===9){sock.write(Buffer.concat([Buffer.from([0x8A,pl.length]),pl]));continue}if(op===1)onMsg(c,pl.toString('utf8'))}});
 const bye=()=>leave(c);sock.on('close',bye);sock.on('error',bye)});
srv.listen(PORT,'0.0.0.0',()=>{console.log('Rphysics: сервер запущен. Открой на устройствах в этой Wi‑Fi сети:');for(const l of Object.values(os.networkInterfaces()))for(const a of l)if(a.family==='IPv4'&&!a.internal)console.log('   http://'+a.address+':'+PORT)});
