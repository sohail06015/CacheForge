import { SkipList } from "../src/core/skiplist";

let fails = 0;
const check = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fails++; }
};

// Randomized differential test vs a naive sorted-array reference.
for (let trial = 0; trial < 200; trial++) {
  const sl = new SkipList();
  const ref = new Map<string, number>();
  for (let i = 0; i < 60; i++) {
    const m = "m" + Math.floor(Math.random() * 20);
    if (Math.random() < 0.25 && ref.size > 0) {
      const keys = [...ref.keys()];
      const victim = keys[Math.floor(Math.random() * keys.length)];
      const a = sl.remove(victim), b = ref.delete(victim);
      if (a !== b) { console.log("FAIL remove retval"); fails++; }
    } else {
      const s = Math.floor(Math.random() * 10);
      const wasNew = !ref.has(m);
      const got = sl.add(s, m);
      ref.set(m, s);
      if (got !== wasNew) { console.log(`FAIL add retval ${m}`); fails++; }
    }
  }
  const expected = [...ref.entries()]
    .map(([member, score]) => ({ member, score }))
    .sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
  check(`trial${trial} order`, sl.toArray(), expected);
  check(`trial${trial} size`, sl.size, expected.length);
  // rank must match array index for every member
  expected.forEach((e, i) => check(`trial${trial} rank ${e.member}`, sl.rank(e.member), i));
}

// Range semantics incl. negative indices
const s2 = new SkipList();
[["a",1],["b",2],["c",3],["d",4]].forEach(([m,sc]:any)=>s2.add(sc,m));
check("range 0..-1", s2.toArray().map(x=>x.member), ["a","b","c","d"]);
check("range 1..2", s2.range(1,2).map(x=>x.member), ["b","c"]);
check("range -2..-1", s2.range(-2,-1).map(x=>x.member), ["c","d"]);
check("range out of bounds", s2.range(10,20), []);
check("rangeByScore 2..3", s2.rangeByScore(2,3).map(x=>x.member), ["b","c"]);
check("score update moves", (()=>{s2.add(0,"d");return s2.toArray().map(x=>x.member)})(), ["d","a","b","c"]);
check("getScore", s2.getScore("d"), 0);
check("rank missing", s2.rank("zz"), -1);
check("tie broken lexically", (()=>{const t=new SkipList();t.add(5,"z");t.add(5,"a");return t.toArray().map(x=>x.member)})(), ["a","z"]);

console.log(fails === 0 ? "ALL SKIPLIST TESTS PASSED" : `${fails} FAILURES`);
