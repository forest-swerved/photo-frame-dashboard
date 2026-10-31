import { cityState, visibleParents } from './parent-locations.js';
import { dateFormatter } from './model.js';

let sdk;
function loadMaps(mapURL) {
  if(window.google?.maps?.Map)return Promise.resolve(window.google.maps);
  if(sdk)return sdk;
  let source;try{source=new URL(mapURL);}catch{return Promise.reject(Error('Map unavailable'));}
  if(source.origin!=='https://maps.googleapis.com'||source.pathname!=='/maps/api/staticmap'||!source.searchParams.get('key'))return Promise.reject(Error('Map unavailable'));
  sdk=new Promise((resolve,reject)=>{
    const script=document.createElement('script');let timer;
    const finish=error=>{clearTimeout(timer);delete window.familyMapsReady;if(error){script.remove();sdk=undefined;reject(error);}else resolve(window.google.maps);};
    window.familyMapsReady=()=>finish();
    script.onerror=()=>finish(Error('Map unavailable'));
    timer=setTimeout(()=>finish(Error('Map timed out')),30000);
    const url=new URL('https://maps.googleapis.com/maps/api/js');
    for(const [key,value] of Object.entries({key:source.searchParams.get('key'),v:'quarterly',loading:'async',callback:'familyMapsReady'}))url.searchParams.set(key,value);
    script.src=url.href;script.async=true;document.head.append(script);
  });
  return sdk;
}
function makePin(maps,map,parent) {
  class ParentPin extends maps.OverlayView {
    constructor(){super();this.node=document.createElement('div');this.node.className='parent-map-pin';this.node.innerHTML='<i class="map-pulse"></i><i class="map-pulse map-pulse-delayed"></i><span class="map-pin-shadow"></span><span class="map-pin-drop"><b></b></span><span class="map-pin-name"></span>';this.update(parent);this.setMap(map);}
    onAdd(){this.getPanes().floatPane.append(this.node);}
    draw(){const p=this.getProjection().fromLatLngToDivPixel(this.position);if(p){this.node.style.left=`${p.x}px`;this.node.style.top=`${p.y}px`;}}
    update(person){this.position=new maps.LatLng(person.latitude,person.longitude);this.node.querySelector('b').textContent=person.label.slice(0,1).toUpperCase();this.node.querySelector('.map-pin-name').textContent=person.label;this.node.title=`${person.label} · ${cityState(person.place)}`;if(this.getProjection())this.draw();}
    onRemove(){this.node.remove();}
  }
  return new ParentPin();
}
export function createParentLocationMap({dialog,openDialog,snapshot,timezone,requestRefresh,poll}) {
  let selected,epoch=0,map,pin,loading=false,waiting=null,pollAt=0;
  function clearMap(){pin?.setMap(null);pin=null;if(map)window.google?.maps?.event.clearInstanceListeners(map);map=null;dialog.querySelector('[data-parent-map-canvas]')?.replaceChildren();}
  function clear(){epoch++;selected=undefined;loading=false;waiting=null;clearMap();delete dialog.dataset.parentLocation;}
  dialog.addEventListener('close',()=>{if(!dialog.open)clear();});
  function status(text){const el=dialog.querySelector('[data-parent-map-message]');if(el){el.textContent=text;el.hidden=!text;}}
  function refreshButton(busy){const button=dialog.querySelector('[data-parent-map-refresh]');if(button){button.disabled=busy;button.classList.toggle('is-waiting',busy);button.setAttribute('aria-busy',String(busy));}}
  async function refresh(){
    if(!selected||!dialog.open||!dialog.dataset.parentLocation)return;
    const version=epoch,data=snapshot(),parent=visibleParents(data).find(p=>p.id===selected);
    dialog.querySelector('#dialog-title').textContent=parent?`${parent.label} · Satellite map`:'Location unavailable';
    if(!parent||!Number.isFinite(parent.latitude)||!Number.isFinite(parent.longitude)){clearMap();waiting=null;refreshButton(false);status('Waiting for a recent shared location.');return;}
    const updated=dateFormatter({timeZone:timezone(),hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(parent.recordedAt));
    const detail=`${parent.label} · ${cityState(parent.place)} · Updated ${updated} · Accuracy about ${Math.max(1,Math.round(parent.accuracy||0))} m`;
    dialog.querySelector('[data-parent-map-canvas]').setAttribute('aria-label',detail);
    if(waiting){
      if(Date.parse(parent.recordedAt)>waiting.previous && Date.parse(parent.recordedAt)>=waiting.started-5000){waiting=null;refreshButton(false);map?.panTo({lat:parent.latitude,lng:parent.longitude});status(`Location updated at ${updated}`);}
      else if(Date.now()-waiting.started>30000){waiting=null;refreshButton(false);status('Still waiting for the phone. iOS may delay background updates.');}
      else if(Date.now()-pollAt>=3000){pollAt=Date.now();void poll?.();}
    }
    if(map){pin.update(parent);pin.node.title=detail;return;}
    if(loading)return;loading=true;status('Opening satellite view…');
    try{
      const maps=await loadMaps(data.mapURL);if(version!==epoch||!dialog.open)return;
      // Read again after the SDK loads: sharing may have ended in the meantime.
      const current=visibleParents(snapshot()).find(p=>p.id===selected);if(!current||!Number.isFinite(current.latitude))return;
      map=new maps.Map(dialog.querySelector('[data-parent-map-canvas]'),{center:{lat:current.latitude,lng:current.longitude},zoom:18,minZoom:3,maxZoom:21,mapTypeId:'satellite',renderingType:maps.RenderingType.RASTER,tilt:0,disableDefaultUI:true,gestureHandling:'greedy',clickableIcons:false,keyboardShortcuts:true});
      pin=makePin(maps,map,current);maps.event.addListenerOnce(map,'tilesloaded',()=>{if(version===epoch&&!waiting)status('');});
    }catch{if(version===epoch)status('The satellite map could not load. Close and reopen to try again.');}
    finally{if(version===epoch)loading=false;}
  }
  async function askPhone(){
    if(waiting||!selected)return;const version=epoch,id=selected,parent=visibleParents(snapshot()).find(p=>p.id===id);
    refreshButton(true);status('Requesting a fresh location…');
    try{
      await requestRefresh(id);if(version!==epoch)return;
      waiting={previous:Date.parse(parent?.recordedAt)||0,started:Date.now()};pollAt=0;status('Requested from phone · waiting for a fresh location');await poll?.();
    }catch(error){if(version===epoch){refreshButton(false);status(error.message||'The phone could not be reached. Try again.');}}
  }
  function open(id){
    const parent=visibleParents(snapshot()).find(p=>p.id===id);if(!parent)return;
    openDialog(`${parent.label} · Satellite map`,`<section class="parent-map-detail"><div data-parent-map-canvas role="region" aria-label="Satellite map"></div><p data-parent-map-message role="status" hidden></p><button type="button" class="parent-map-refresh" data-parent-map-refresh aria-label="Refresh parent location" title="Request a fresh phone location"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 6.3A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.7"/></svg></button></section>`,async()=>{});
    selected=id;dialog.dataset.parentLocation=id;dialog.querySelector('[data-parent-map-refresh]').addEventListener('click',askPhone);void refresh();
  }
  return {open,refresh,clear};
}
