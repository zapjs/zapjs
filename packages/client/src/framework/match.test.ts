import { expect, test } from 'bun:test';
import { matchRoute, type Params } from './match.js';
import type { Segment } from '../compiler/graph.js';
type Route = { id: string; segments: Segment[] };
function scan(routes: Route[], pathname: string): {route:Route;params:Params}|undefined {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  for(const route of routes) {
    let index=0, matches=true;
    const entries:[string,string|string[]][]=[];
    for(const segment of route.segments) {
      if(segment.kind==='optional'||segment.kind==='catchall') {
        if(segment.kind==='catchall'&&index>=parts.length){matches=false;break;}
        entries.push([segment.value,parts.slice(index)]); index=parts.length;
      } else {
        const value=parts[index++];
        if(value===undefined||(segment.kind==='static'&&value!==segment.value)){matches=false;break;}
        if(segment.kind==='dynamic') entries.push([segment.value,value]);
      }
    }
    if(matches&&index===parts.length)return {route,params:Object.fromEntries(entries)};
  }
}
test('trie preserves scanner precedence across overlapping branches, fallbacks and arbitrary graph order',()=>{
  const routes:Route[]=[];
  const values=['a','b'];
  const prefixes:Segment[][]=[[]];
  for(let depth=0;depth<3;depth++) {
    for(const prefix of prefixes.filter(value=>value.length===depth)) {
      for(const value of values) prefixes.push([...prefix,{kind:'static',value}]);
      prefixes.push([...prefix,{kind:'dynamic',value:`arg${depth}`}]);
    }
  }
  for(const prefix of prefixes) {
    routes.push({id:String(routes.length),segments:prefix});
    routes.push({id:String(routes.length),segments:[...prefix,{kind:'catchall',value:'rest'}]});
    routes.push({id:String(routes.length),segments:[...prefix,{kind:'optional',value:'rest'}]});
  }
  const paths=[''];
  for(let depth=0;depth<4;depth++) for(const path of paths.filter(value=>value.split('/').filter(Boolean).length===depth)) for(const value of ['a','b','c','%E2%98%83']) paths.push(path+'/'+value);
  // Several deterministic permutations include higher-priority fallback routes
  // before exact routes; trie pruning must still preserve the original order.
  for(let run=1;run<=5;run++) {
    const ordered=[...routes]; let seed=run;
    for(let index=ordered.length-1;index>0;index--) { seed=(Math.imul(seed,1664525)+1013904223)>>>0; const other=seed%(index+1); [ordered[index],ordered[other]]=[ordered[other],ordered[index]]; }
    for(const path of paths) expect(matchRoute(ordered,path)).toEqual(scan(ordered,path));
  }
});
test('large immutable graphs compile once and warm lookups do not inspect unrelated routes',()=>{
  let metadataReads=0;
  const routes:Route[]=Array.from({length:10000},(_,index)=>({id:String(index),get segments():Segment[]{metadataReads++;return [{kind:'static',value:'products'},{kind:'static',value:'item-'+index}];}}));
  routes.push({id:'fallback',segments:[{kind:'dynamic',value:'section'},{kind:'dynamic',value:'item'},{kind:'static',value:'details'}]});
  expect(matchRoute(routes,'/products/item-9999')?.route.id).toBe('9999');
  metadataReads=0;
  for(let index=0;index<500;index++) expect(matchRoute(routes,`/products/item-${index*17%10000}`)?.route.id).toBe(String(index*17%10000));
  expect(metadataReads).toBeLessThanOrEqual(500);
  expect(matchRoute(routes,'/products/unknown')).toBeUndefined();
  expect(matchRoute(routes,'/products/unknown/details')?.params).toEqual({section:'products',item:'unknown'});
  const replacement=[...routes,{id:'new',segments:[{kind:'static' as const,value:'added'}]}];
  expect(matchRoute(replacement,'/added')?.route.id).toBe('new');
});
