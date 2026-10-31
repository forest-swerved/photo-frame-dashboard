import { escapeHtml as h, dateFormatter } from './model.js';
export function visibleParents(data, now=Date.now()) {
  return (data?.parents||[]).map(p=>({...p,...(p.recordedAt && now-Date.parse(p.recordedAt)<86400000 ? {} : {latitude:null,longitude:null,place:null,recordedAt:null})}));
}
export function locationCards(data,timezone) {
  return visibleParents(data).map((p,i)=>{
    const age=p.recordedAt?Math.max(0,Date.now()-Date.parse(p.recordedAt)):Infinity;
    const time=p.recordedAt?dateFormatter({timeZone:timezone,hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(p.recordedAt)):null;
    return `<article class="parent-location" data-key="parent-location-${h(p.id)}"><span class="parent-location-pin">${h(p.marker||String.fromCharCode(65+i%26))}</span><div><h3>${h(p.label)}</h3><p>${h(p.place|| (time?'Location available':'Waiting for a recent location'))}</p><small>${time?`Updated ${h(time)}${age>300000?' · May have moved':''}`:'No recent update'}${p.accuracy>100?` · Approx. ${Math.round(p.accuracy)} m`:''}</small></div></article>`;
  }).join('');
}
export function locationMapMarkup(data) {
  const recent=visibleParents(data).some(p=>Number.isFinite(p.latitude));
  let url;try{url=new URL(data?.mapURL)}catch{}
  return recent&&url?.origin==='https://maps.googleapis.com'&&url.pathname==='/maps/api/staticmap'
    ? `<img class="parent-map-image" data-key="parent-map-image" src="${h(url.href)}" alt="Map of shared parent locations" referrerpolicy="no-referrer">`
    : `<div class="parent-map-empty">${data?.mapUnavailable?'The map is temporarily unavailable.':'The map appears after a parent shares a recent location.'}</div>`;
}
export function createParentLocations({read,scope,onChange,onAuthFailure=()=>{}}) {
  let identity,epoch=0,busy=false,lastRead=-Infinity,coordinateKey='',value={parents:[],mapURL:null};
  function sync(){const next=scope();if(next!==identity){identity=next;epoch++;busy=false;lastRead=-Infinity;coordinateKey='';value={parents:[],mapURL:null};}return next;}
  async function tick(){
    if(!sync()||busy||document.hidden||performance.now()-lastRead<30000)return;
    busy=true;lastRead=performance.now();const version=epoch;
    try{
      const result=await read('/api/locations');sync();if(version!==epoch||!identity)return;
      const parents=visibleParents(result),key=JSON.stringify(parents.map(p=>[p.id,p.latitude,p.longitude]));
      let mapURL=value.mapURL,mapUnavailable=false;
      if(key!==coordinateKey||value.mapUnavailable){
        mapURL=null;
        if(parents.some(p=>Number.isFinite(p.latitude)))try{mapURL=(await read('/api/locations/map-url')).url;}catch(error){if([401,403].includes(error.status))throw error;mapUnavailable=true;}
      }
      sync();if(version!==epoch||!identity)return;
      coordinateKey=key;value={parents,mapURL,mapUnavailable,offline:false};onChange();
    }catch(error){if(version!==epoch)return;if([401,403].includes(error.status)){value={parents:[],mapURL:null};onAuthFailure(error);}else{value={...value,offline:true};onChange();}}
    finally{if(version===epoch)busy=false;}
  }
  return {sync,tick,snapshot:()=>{sync();const parents=visibleParents(value),key=JSON.stringify(parents.map(p=>[p.id,p.latitude,p.longitude]));return {...value,parents,mapURL:key===coordinateKey?value.mapURL:null};}};
}
