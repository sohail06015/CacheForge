const net=require('net');
const enc=(...a)=>`*${a.length}\r\n`+a.map(x=>`$${Buffer.byteLength(x)}\r\n${x}\r\n`).join('');
let F=0,P=0;
const ck=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);if(a===b)P++;else{F++;console.log(`FAIL ${n}: got ${a} want ${b}`)}};
const subA=net.connect(6399),subB=net.connect(6399),pub=net.connect(6399);
let aBuf='',bBuf='',pBuf='';
subA.on('data',d=>aBuf+=d); subB.on('data',d=>bBuf+=d); pub.on('data',d=>pBuf+=d);
setTimeout(()=>{
  subA.write(enc('SUBSCRIBE','news'));
  subB.write(enc('PSUBSCRIBE','ne*'));
},200);
setTimeout(()=>{ pub.write(enc('PUBLISH','news','hello')); },700);
setTimeout(()=>{
  ck('subscriber got message', aBuf.includes('message')&&aBuf.includes('hello'), true);
  ck('pattern sub got pmessage', bBuf.includes('pmessage')&&bBuf.includes('hello'), true);
  ck('publish returned 2', pBuf.includes(':2'), true);
  // subscribed connection is restricted
  subA.write(enc('GET','x'));
  setTimeout(()=>{
    ck('subscribe mode restricts commands', aBuf.includes('only'), true);
    subA.destroy();subB.destroy();
    setTimeout(()=>{
      pBuf='';
      pub.write(enc('PUBLISH','news','x'));
      setTimeout(()=>{
        ck('cleanup on disconnect', pBuf.trim(), ':0');
        console.log(`\n${P} passed, ${F} failed`);
        pub.destroy();process.exit(F?1:0);
      },300);
    },300);
  },300);
},1300);
