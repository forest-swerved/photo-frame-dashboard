import { cityState, satelliteMapURL, visibleParents } from './parent-locations.js';
import { dateFormatter } from './model.js';

export function createParentLocationMap({dialog,openDialog,snapshot,timezone}) {
  let selected,zoom=17,currentURL=null;
  function clear(){selected=undefined;currentURL=null;delete dialog.dataset.parentLocation;}
  dialog.addEventListener('close',()=>{if(!dialog.open)clear();});
  function refresh(){
    if(!selected||!dialog.open||!dialog.dataset.parentLocation)return;
    const data=snapshot(),parent=visibleParents(data).find(p=>p.id===selected);
    const image=dialog.querySelector('[data-parent-map-image]'),message=dialog.querySelector('[data-parent-map-message]');
    const url=satelliteMapURL(data,selected,zoom);
    dialog.querySelector('#dialog-title').textContent=parent?`${parent.label} · Satellite map`:'Location unavailable';
    dialog.querySelector('[data-parent-map-place]').textContent=cityState(parent?.place)||'Waiting for a recent location';
    const updated=parent?.recordedAt?dateFormatter({timeZone:timezone(),hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(parent.recordedAt)):null;
    dialog.querySelector('[data-parent-map-update]').textContent=updated?`Updated ${updated}${Date.now()-Date.parse(parent.recordedAt)>300000?' · May have moved':''}${Number.isFinite(parent.accuracy)?` · Accuracy about ${Math.max(1,Math.round(parent.accuracy))} m`:''}`:'No recent update';
    dialog.querySelector('[data-map-zoom="-1"]').disabled=!url||zoom<=12;
    dialog.querySelector('[data-map-zoom="1"]').disabled=!url||zoom>=20;
    if(!url){currentURL=null;image.removeAttribute('src');image.hidden=true;message.hidden=false;message.textContent=parent?.recordedAt?'The satellite map is temporarily unavailable.':'A map appears when this parent shares a recent location.';return;}
    if(url!==currentURL){currentURL=url;image.hidden=true;message.hidden=false;message.textContent='Loading satellite map…';image.src=url;}
  }
  function open(id){
    const parent=visibleParents(snapshot()).find(p=>p.id===id);if(!parent)return;
    openDialog(`${parent.label} · Satellite map`,`<section class="parent-map-detail"><div class="parent-map-summary"><strong data-parent-map-place></strong><span data-parent-map-update></span></div><div class="parent-map-surface"><img data-parent-map-image alt="Satellite map of the shared phone location" referrerpolicy="no-referrer" hidden><p data-parent-map-message role="status"></p></div><div class="parent-map-controls"><span>Satellite imagery with street names</span><button type="button" class="icon-button" data-map-zoom="-1" aria-label="Zoom out">−</button><button type="button" class="icon-button" data-map-zoom="1" aria-label="Zoom in">+</button></div></section>`,async()=>{});
    selected=id;zoom=17;currentURL=null;dialog.dataset.parentLocation=id;
    const image=dialog.querySelector('[data-parent-map-image]'),message=dialog.querySelector('[data-parent-map-message]');
    image.addEventListener('load',()=>{if(currentURL&&image.getAttribute('src')===currentURL){image.hidden=false;message.hidden=true;}});
    image.addEventListener('error',()=>{image.hidden=true;message.hidden=false;message.textContent='The satellite map could not load. Try zooming out or reopen the map.';});
    dialog.querySelectorAll('[data-map-zoom]').forEach(button=>button.addEventListener('click',()=>{zoom=Math.max(12,Math.min(20,zoom+Number(button.dataset.mapZoom)));refresh();}));
    refresh();
  }
  return {open,refresh,clear};
}
