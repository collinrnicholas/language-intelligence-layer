import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/interactions.js',import.meta.url),'utf8');
function setup(reduced=false){
 const listeners={},preference={matches:reduced,addEventListener:(name,fn)=>listeners[name]=fn};
 const context=vm.createContext({matchMedia:()=>preference,document:{documentElement:{},addEventListener:(name,fn)=>listeners[name]=fn},
  getComputedStyle:()=>({getPropertyValue:name=>({'--motion-standard':'200ms','--motion-layout':'240ms','--motion-ease':'ease-out'}[name]||'')})});
 vm.runInContext(source,context);return {motion:context.PERSADO_MOTION,preference,listeners};
}
function element(){
 const animations=[];
 const el={open:true,style:{},getBoundingClientRect:()=>({height:el.open?120:30}),querySelector:()=>({getBoundingClientRect:()=>({height:30})}),
  animate:(frames,options)=>{let resolve,reject;const a={frames,options,finished:new Promise((yes,no)=>{resolve=yes;reject=no;}),cancel(){a.cancelled=true;reject(Error('Cancelled'));},finish(){resolve();}};animations.push(a);return a;}};
 return {el,animations};
}
test('missing or failing native animation support cannot break the interface',()=>{
 const {motion}=setup();assert.doesNotThrow(()=>motion.reveal({}));
 assert.doesNotThrow(()=>motion.reveal({animate:()=>{throw Error('Unsupported');}}));
});
test('reduced-motion users get final disclosure state immediately without an animation',()=>{
 const {motion}=setup(true),{el,animations}=element();motion.disclose(el,false);
 assert.equal(el.open,false);assert.equal(el.style.height,'');assert.equal(animations.length,0);
});
test('rapid reversal cannot leave a disclosure stuck closed or with a fixed height',async()=>{
 const {motion}=setup(),{el,animations}=element();motion.disclose(el,false);motion.disclose(el,true);
 assert.equal(animations[0].cancelled,true);animations[1].finish();await new Promise(r=>setImmediate(r));
 assert.equal(el.open,true);assert.equal(el.style.height,'');assert.equal(el.style.overflow,'');
});
test('changing reduced-motion preference cancels active motion and settles the intended state',()=>{
 const {motion,preference,listeners}=setup(),{el,animations}=element();motion.disclose(el,false);
 preference.matches=true;listeners.change();assert.equal(animations[0].cancelled,true);assert.equal(el.open,false);assert.equal(el.style.height,'');
});
