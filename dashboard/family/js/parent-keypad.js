import { request } from './api.js';
import './parent-keypad.css';

// Buttons, rather than an editable input, keep Android's keyboard closed.
export function parentKeypad({ temporary = false, verify }) {
  const modal = document.createElement('dialog');
  modal.className = 'parent-keypad';
  modal.setAttribute('aria-labelledby', 'parent-keypad-title');
  document.body.append(modal);
  return new Promise(resolve => {
    let digits = '', busy = false, finished = false;
    const length = () => temporary ? 6 : 4;
    const finish = result => { if (finished) return; finished = true; digits = ''; modal.close(); modal.remove(); resolve(result); };
    function draw() {
      modal.innerHTML = `<div class="pin-heading"><div><p class="eyebrow">PARENT ACCESS</p><h2 id="parent-keypad-title">${temporary ? 'Temporary code' : 'Enter your PIN'}</h2></div><button type="button" data-pin-close aria-label="Cancel PIN entry">×</button></div><p class="supporting">${temporary ? 'Enter the six-digit code from your phone.' : 'Your four digits identify you. Controls stay unlocked for ten minutes.'}</p><div class="pin-dots" aria-label="0 of ${length()} digits entered" role="status">${Array.from({length:length()},()=>'<span></span>').join('')}</div><p class="pin-error" role="alert" hidden></p><div class="pin-keys">${[1,2,3,4,5,6,7,8,9,'clear',0,'back'].map(key=>`<button type="button" data-pin-key="${key}" aria-label="${key==='back'?'Delete last digit':key==='clear'?'Clear PIN':key}">${key==='back'?'⌫':key==='clear'?'Clear':key}</button>`).join('')}</div><button type="button" class="button pin-continue" disabled>Continue</button><button type="button" class="text-button pin-switch">${temporary ? 'Use parent PIN' : 'Use a temporary code'}</button>`;
      modal.querySelector('[data-pin-close]').onclick = () => finish(null);
      modal.querySelector('.pin-switch').onclick = () => { if(busy)return; temporary=!temporary;digits='';draw(); };
      modal.querySelectorAll('[data-pin-key]').forEach(button=>button.onclick=()=>key(button.dataset.pinKey));
      modal.querySelector('.pin-continue').onclick = submit;
      if(modal.open)modal.querySelector('[data-pin-key="1"]').focus();
    }
    function update() {
      modal.querySelectorAll('.pin-dots span').forEach((dot,index)=>dot.classList.toggle('filled',index<digits.length));
      modal.querySelector('.pin-dots').setAttribute('aria-label', `${digits.length} of ${length()} digits entered`);
      modal.querySelector('.pin-continue').disabled = busy || digits.length!==length();
      modal.querySelector('.pin-continue').textContent = busy ? 'Checking…' : 'Continue';
      modal.querySelectorAll('[data-pin-key],.pin-switch').forEach(button=>button.disabled=busy);
    }
    function key(value) {
      if(busy)return;
      if(value==='back')digits=digits.slice(0,-1);
      else if(value==='clear')digits='';
      else if(/^\d$/.test(value)&&digits.length<length())digits+=value;
      update();
    }
    async function submit() {
      if(busy||digits.length!==length())return;
      busy=true;update();modal.querySelector('.pin-error').hidden=true;
      const secret=digits;digits='';
      try {
        const data=await request(temporary?'/api/frame-access/redeem':'/api/frame-access/pin', {method:'POST',body:temporary?{code:secret}:{pin:secret}});
        if(!finished) { await verify(data); finish(data); }
      } catch(error) {
        if(!finished) { const box=modal.querySelector('.pin-error');box.textContent=error.message;box.hidden=false; }
      } finally { busy=false;if(!finished)update(); }
    }
    modal.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
    modal.addEventListener('keydown',event=>{
      if(/^\d$/.test(event.key)||['Backspace','Delete','Enter'].includes(event.key)) {
        event.preventDefault();if(event.repeat)return;
        if(event.key==='Enter')submit();else key(event.key==='Backspace'?'back':event.key==='Delete'?'clear':event.key);
      }
    });
    draw();modal.showModal();modal.querySelector('[data-pin-key="1"]').focus();
  });
}
