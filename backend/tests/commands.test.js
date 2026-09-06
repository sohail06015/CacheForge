const net=require('net');
const c=net.connect(6399,'127.0.0.1');
let buf='',waiters=[],pushed=[];
const enc=(...a)=>`*${a.length}\r\n`+a.map(x=>`$${Buffer.byteLength(x)}\r\n${x}\r\n`).join('');
function parse(){if(!buf.length)return undefined;const t=buf[0],e=buf.indexOf('\r\n');if(e===-1)return undefined;const l=buf.slice(1,e);
if(t==='+'){buf=buf.slice(e+2);return l}
if(t==='-'){buf=buf.slice(e+2);return {error:l}}
if(t===':'){buf=buf.slice(e+2);return Number(l)}
if(t==='$'){const n=Number(l);if(n===-1){buf=buf.slice(e+2);return null}const s=e+2;if(buf.length<s+n+2)return undefined;const v=buf.slice(s,s+n);buf=buf.slice(s+n+2);return v}
if(t==='*'){const n=Number(l);if(n===-1){buf=buf.slice(e+2);return null}const sv=buf;buf=buf.slice(e+2);const it=[];for(let i=0;i<n;i++){const x=parse();if(x===undefined){buf=sv;return undefined}it.push(x)}return it}
return undefined}
c.on('data',d=>{buf+=d;while(buf.length){const b=buf;const p=parse();if(p===undefined){buf=b;break}const w=waiters.shift();if(w)w(p);else pushed.push(p)}});
const send=(...a)=>new Promise(r=>{waiters.push(r);c.write(enc(...a))});
let F=0,P=0;
const ck=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);if(a===b)P++;else{F++;console.log(`FAIL ${n}: got ${a} want ${b}`)}};
c.on('connect',async()=>{
ck('PING',await send('PING'),'PONG');
ck('quoted value',await send('SET','msg','hello world'),'OK');
ck('read quoted',await send('GET','msg'),'hello world');
ck('INCR',await send('INCR','ctr'),1);
ck('INCRBY',await send('INCRBY','ctr','9'),10);
ck('MGET',await send('MGET','ctr','zz'),['10',null]);
ck('RPUSH',await send('RPUSH','L','a','b','c'),3);
ck('LPOP',await send('LPOP','L'),'a');
ck('LLEN',await send('LLEN','L'),2);
ck('HSET multi',await send('HSET','H','f1','v1','f2','v2'),2);
ck('HGETALL',await send('HGETALL','H'),['f1','v1','f2','v2']);
ck('HDEL',await send('HDEL','H','f1'),1);
ck('SADD',await send('SADD','S','x','y'),2);
ck('SREM',await send('SREM','S','x'),1);
ck('ZADD',await send('ZADD','Z','3','c','1','a','2','b'),3);
ck('ZRANGE sorted',await send('ZRANGE','Z','0','-1'),['a','b','c']);
ck('ZRANK',await send('ZRANK','Z','c'),2);
ck('ZSCORE',await send('ZSCORE','Z','b'),'2');
ck('ZRANGE WITHSCORES',await send('ZRANGE','Z','0','1','WITHSCORES'),['a','1','b','2']);
ck('ZRANGEBYSCORE',await send('ZRANGEBYSCORE','Z','2','3'),['b','c']);
ck('ZADD rescore',await send('ZADD','Z','0','c'),0);
ck('reorder after rescore',await send('ZRANGE','Z','0','-1'),['c','a','b']);
ck('WRONGTYPE',(await send('LPUSH','msg','x')).error?.slice(0,9),'WRONGTYPE');
ck('bad arity',(await send('GET')).error?.slice(0,3),'ERR');
ck('unknown cmd',(await send('NOPE')).error?.slice(0,3),'ERR');
ck('TTL missing',await send('TTL','zz'),-2);
ck('EXPIRE',await send('EXPIRE','msg','100'),1);
ck('TTL set',await send('TTL','msg'),100);
ck('PERSIST',await send('PERSIST','msg'),1);
ck('TTL persisted',await send('TTL','msg'),-1);
await send('SET','tmp','x','PX','150');
await new Promise(r=>setTimeout(r,400));
ck('expired',await send('GET','tmp'),null);
ck('DBSIZE type',typeof(await send('DBSIZE')),'number');
console.log(`\n${P} passed, ${F} failed`);
c.destroy();process.exit(F?1:0);
});
