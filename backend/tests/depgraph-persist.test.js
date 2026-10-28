// Exercises replay in-process: no sockets, no child processes.
const os=require('os'),pathm=require('path');
const DATA=pathm.join(os.tmpdir(),'cacheforge-deppersist');
const {Store}=require('../dist/core/store');
const {AofLog}=require('../dist/persistence/aof');
const {dispatch}=require('../dist/commands');
const fs=require('fs');
let F=0,P=0;const ck=(n,g,e)=>{const a=JSON.stringify(g),b=JSON.stringify(e);a===b?P++:(F++,console.log(`FAIL ${n}: got ${a} want ${b}`))};

fs.rmSync(DATA,{recursive:true,force:true});
// --- session 1 ---
let store=new Store(), aof=new AofLog(DATA);
for(const [c,...a] of [['SET','user:1','alice'],['SET','cache:p','x'],['DEPEND','cache:p','user:1']]){
  const r=dispatch(store,c,a); if(r.kind!=='error') aof.append(c,a);
}
ck('session1 DEPS',store.deps.dependentsOf('user:1'),['cache:p']);
aof.rewrite(store.rebuildCommands());
store.close();

// --- session 2: fresh Store, replay from disk ---
let s2=new Store(), aof2=new AofLog(DATA);
s2.replaying=true;
const log=aof2.replay();
for(const {command,args} of log) dispatch(s2,command,args);
s2.replaying=false;
ck('replayed commands >0',log.length>0,true);
ck('GRAPH SURVIVED RESTART',s2.deps.dependentsOf('user:1'),['cache:p']);
ck('cache present after replay',s2.exists('cache:p'),true);
// now the real test: does invalidation fire post-restart?
s2.setString('user:1','bob');
ck('INVALIDATION WORKS AFTER RESTART',s2.exists('cache:p'),false);
ck('source intact',s2.getString('user:1'),'bob');
ck('edge retained for rebuild',s2.deps.dependentsOf('user:1'),['cache:p']);
s2.close();
console.log(`\n${P} passed, ${F} failed`);
process.exit(F?1:0);
