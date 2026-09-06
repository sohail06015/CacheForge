const net=require('net');
const c=net.connect(6399,'127.0.0.1');
let buf='',w=[];
const enc=(...a)=>`*${a.length}\r\n`+a.map(x=>`$${Buffer.byteLength(x)}\r\n${x}\r\n`).join('');
function parse(){if(!buf.length)return undefined;const t=buf[0],e=buf.indexOf('\r\n');if(e===-1)return undefined;const l=buf.slice(1,e);
if(t==='+'){buf=buf.slice(e+2);return l}if(t==='-'){buf=buf.slice(e+2);return{error:l}}if(t===':'){buf=buf.slice(e+2);return Number(l)}
if(t==='$'){const n=Number(l);if(n===-1){buf=buf.slice(e+2);return null}const s=e+2;if(buf.length<s+n+2)return undefined;const v=buf.slice(s,s+n);buf=buf.slice(s+n+2);return v}
if(t==='*'){const n=Number(l);if(n===-1){buf=buf.slice(e+2);return null}const sv=buf;buf=buf.slice(e+2);const it=[];for(let i=0;i<n;i++){const x=parse();if(x===undefined){buf=sv;return undefined}it.push(x)}return it}return undefined}
c.on('data',d=>{buf+=d;while(buf.length){const b=buf;const p=parse();if(p===undefined){buf=b;break}const f=w.shift();if(f)f(p)}});
const s=(...a)=>new Promise(r=>{w.push(r);c.write(enc(...a))});
let F=0,P=0;const ck=(n,g,e)=>{const a=JSON.stringify(g),b=JSON.stringify(e);a===b?P++:(F++,console.log(`FAIL ${n}: got ${a} want ${b}`))};
c.on('connect',async()=>{
// setup: user -> profile cache -> feed cache
await s('SET','user:1','alice');
await s('SET','cache:profile:1','<profile html>');
await s('SET','cache:feed:1','<feed html>');
ck('DEPEND profile',await s('DEPEND','cache:profile:1','user:1'),'OK 1');
ck('DEPEND feed',await s('DEPEND','cache:feed:1','cache:profile:1'),'OK 1');
ck('DEPS user:1',await s('DEPS','user:1'),['cache:profile:1']);
ck('DEPENDSON feed',await s('DEPENDSON','cache:feed:1'),['cache:profile:1']);
ck('CASCADE preview',(await s('CASCADE','user:1')).sort(),['cache:feed:1','cache:profile:1']);
ck('caches exist before',await s('EXISTS','cache:profile:1','cache:feed:1'),2);
// THE FEATURE: writing to user:1 auto-invalidates both caches transitively
await s('SET','user:1','alice.smith');
ck('AUTO-INVALIDATED transitively',await s('EXISTS','cache:profile:1','cache:feed:1'),0);
ck('source survived',await s('GET','user:1'),'alice.smith');
// rebuild cache, edges persist
await s('SET','cache:profile:1','<rebuilt>');
ck('edges survive invalidation',await s('DEPS','user:1'),['cache:profile:1']);
await s('DEL','user:1');
ck('DEL also invalidates',await s('EXISTS','cache:profile:1'),0);
// cycle safety
await s('SET','a','1');await s('SET','b','1');
await s('DEPEND','b','a');
const cyc=await s('DEPEND','a','b');
ck('cycle detected',String(cyc).startsWith('OK CYCLE'),true);
await s('SET','a','2'); // must terminate, not hang
ck('cycle does not hang',await s('PING'),'PONG');
// manual invalidate
await s('SET','x','1');await s('SET','y','1');await s('DEPEND','y','x');
ck('INVALIDATE count',await s('INVALIDATE','x'),2);
ck('GRAPH lists edges',(await s('GRAPH')).length>0,true);
ck('UNDEPEND',await s('UNDEPEND','y'),'OK');
console.log(`\n${P} passed, ${F} failed`);c.destroy();process.exit(F?1:0);
});
