import test from 'node:test';
import assert from 'node:assert/strict';
import { createParentLocations, visibleParents, locationMapMarkup, cityState, parentLocationChips, satelliteMapURL } from './parent-locations.js';
const old=globalThis.document;
test('late household location reads never populate a changed household',async()=>{
 globalThis.document={hidden:false};let scope='first',resolve,changes=0;
 const controller=createParentLocations({scope:()=>scope,read:()=>new Promise(r=>{resolve=r}),onChange:()=>changes++});
 try{const read=controller.tick();scope='second';resolve({parents:[{id:'old-parent',recordedAt:new Date().toISOString(),latitude:1,longitude:1}]});await read;assert.deepEqual(controller.snapshot().parents,[]);assert.equal(changes,0);}finally{globalThis.document=old;}
});
test('home chips show city/state and the selected satellite map includes only a current shared parent',()=>{
 const data={parents:[{id:'dad',label:'Dad',marker:'A',latitude:39.7,longitude:-105,place:'Neighborhood, Denver, CO',recordedAt:new Date().toISOString()},{id:'mom',label:'Mom',marker:'B',latitude:40,longitude:-105.2,place:'Boulder, CO',recordedAt:new Date().toISOString()}],mapURL:'https://maps.googleapis.com/maps/api/staticmap?key=fixture&markers=first&markers=second'};
 assert.equal(cityState(data.parents[0].place),'Denver, CO');assert.doesNotMatch(parentLocationChips(data),/Neighborhood/);
 const url=new URL(satelliteMapURL(data,'mom',18));assert.equal(url.searchParams.get('center'),'40,-105.2');assert.equal(url.searchParams.get('zoom'),'18');assert.equal(url.searchParams.get('maptype'),'hybrid');assert.equal(url.searchParams.getAll('markers').length,1);assert.match(url.searchParams.get('markers'),/label:B/);
 assert.equal(satelliteMapURL(data,'not-shared'),null);
 assert.equal(satelliteMapURL({...data,mapURL:'https://example.invalid/map'},'mom'),null);
 data.parents[1].recordedAt='2000-01-01';assert.equal(satelliteMapURL(data,'mom'),null);
});
test('expired locations lose their coordinates and a non-Google URL cannot become a map image',()=>{
 const expired=visibleParents({parents:[{id:'p',latitude:1,longitude:2,place:'Old place',recordedAt:'2000-01-01'}]});
 assert.equal(expired[0].latitude,null);assert.equal(expired[0].place,null);
 const recent={parents:[{id:'p',latitude:1,longitude:2,recordedAt:new Date().toISOString()}],mapURL:'https://example.invalid/map'};
 assert.doesNotMatch(locationMapMarkup(recent),/<img/);
});
