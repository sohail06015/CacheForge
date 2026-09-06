const net=require('net'),{spawn}=require('child_process'),os=require('os'),pathm=require('path');
// os.tmpdir() rather than a hardcoded /tmp - Windows has no /tmp.
const DATA=pathm.join(os.tmpdir(),'strata-persist');
const enc=(...a)=>`*${a.length}\r\n`+a.map(x=>`$${Buffer.byteLength(x)}\r\n${x}\r\n`).join('');
let F=0,P=0;
const ck=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);if(a===b)P++;else{F++;console.log(`FAIL ${n}: got ${a} want ${b}`)}};
function mkClient(port){return new Promise(res=>{const c=net.connect(port,'127.0.0.1');let buf='',waiters=[];
function parse(){if(!buf.length)return undefined;const t=buf[0],e=buf.indexOf('\r\n');if(e===-1)return undefined;const l=buf.slice(1,e);
if(t==='+'){buf=buf.slice(e+2);return l}if(t==='-'){buf=buf.slice(e+2);return{error:l}}if(t===':'){buf=buf.slice(e+2);return Number(l)}
if(t==='$'){const n=Number(l);if(n===-1){buf=buf.slice(e+2);return null}const s=e+2;if(buf.length<s+n+2)return undefined;const v=buf.slice(s,s+n);buf=buf.slice(s+n+2);return v}
if(t==='*'){const n=Number(l);if(n===-1){buf=buf.slice(e+2);return null}const sv=buf;buf=buf.slice(e+2);const it=[];for(let i=0;i<n;i++){const x=parse();if(x===undefined){buf=sv;return undefined}it.push(x)}return it}return undefined}
c.on('data',d=>{buf+=d;while(buf.length){const b=buf;const p=parse();if(p===undefined){buf=b;break}const w=waiters.shift();if(w)w(p)}});
c.on('connect',()=>res({send:(...a)=>new Promise(r=>{waiters.push(r);c.write(enc(...a))}),close:()=>c.destroy()}));});}
function start(){return new Promise((res,rej)=>{const p=spawn(process.execPath,['dist/index.js'],{cwd:require('path').join(__dirname,'..'),env:{...process.env,strata_DATA_DIR:DATA,strata_PORT:'6398',strata_API_PORT:'8098'}});let o='';
const t=setTimeout(()=>rej(new Error('timeout '+o)),15000);
p.stdout.on('data',d=>{o+=d;if(o.includes('Dashboard API listening')){clearTimeout(t);res(p)}});p.stderr.on('data',d=>o+=d);});}
(async()=>{
let srv=await start(); let c=await mkClient(6398);
await c.send('SET','msg','hello world');
await c.send('RPUSH','L','a','b','c');
await c.send('HSET','H','f','v');
await c.send('SADD','S','x','y');
await c.send('ZADD','Z','2','b','1','a');
await c.send('SET','tt','v3');
await c.send('SET','user:1','alice');await c.send('SET','cache:x','cached');
await c.send('DEPEND','cache:x','user:1');
const keysBefore=(await c.send('KEYS','*')).sort();
c.close();
const ex=new Promise(r=>srv.once('exit',r)); srv.kill('SIGTERM'); await ex;
await new Promise(r=>setTimeout(r,400));
srv=await start(); c=await mkClient(6398);
ck('keys survived',(await c.send('KEYS','*')).sort(),keysBefore);
ck('string+spaces survived',await c.send('GET','msg'),'hello world');
ck('list survived',await c.send('LRANGE','L','0','-1'),['a','b','c']);
ck('hash survived',await c.send('HGETALL','H'),['f','v']);
ck('set survived',(await c.send('SMEMBERS','S')).sort(),['x','y']);
ck('zset survived',await c.send('ZRANGE','Z','0','-1'),['a','b']);
const api=await (await fetch('http://localhost:8098/api/keys')).json();
ck('DEP GRAPH SURVIVED RESTART',await c.send('DEPS','user:1'),['cache:x']);
ck('api keys',Array.isArray(api)&&api.length>0,true);
const cons=await (await fetch('http://localhost:8098/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:'SET q "a b c"'})})).json();
ck('api console quoting',cons.ok,true);
ck('api console value',await c.send('GET','q'),'a b c');
console.log(`\n${P} passed, ${F} failed`);
c.close();srv.kill('SIGTERM');process.exit(F?1:0);
})().catch(e=>{console.error(e.message);process.exit(1)});
