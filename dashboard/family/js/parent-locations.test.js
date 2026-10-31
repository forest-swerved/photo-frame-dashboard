import test from 'node:test';
import assert from 'node:assert/strict';
import { createParentLocations, visibleParents, locationMapMarkup } from './parent-locations.js';
const old=globalThis.document;
test('late household location reads never populate a changed household',async()=>{
 globalThis.document={hidden:false};let scope='first',resolve,changes=0;
 const controller=createParentLocations({scope:()=>scope,read:()=>new Promise(r=>{resolve=r}),onChange:()=>changes++});
 try{const read=controller.tick();scope='second';resolve({parents:[{id:'old-parent',recordedAt:new Date().toISOString(),latitude:1,longitude:1}]});await read;assert.deepEqual(controller.snapshot().parents,[]);assert.equal(changes,0);}finally{globalThis.document=old;}
});
test('expired locations lose their coordinates and a non-Google URL cannot become a map image',()=>{
 const expired=visibleParents({parents:[{id:'p',latitude:1,longitude:2,place:'Old place',recordedAt:'2000-01-01'}]});
 assert.equal(expired[0].latitude,null);assert.equal(expired[0].place,null);
 const recent={parents:[{id:'p',latitude:1,longitude:2,recordedAt:new Date().toISOString()}],mapURL:'https://example.invalid/map'};
 assert.doesNotMatch(locationMapMarkup(recent),/<img/);
});
