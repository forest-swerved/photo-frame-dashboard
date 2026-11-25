import { request } from './api.js';
import { escapeHtml as h } from './model.js';

// Buttons, rather than an editable input, keep Android's keyboard closed.
// `child` ({ id, name }) asks for that child's own four-digit PIN instead of a parent's.
export function parentKeypad({ temporary = false, verify, child = null }) {
  const modal = document.createElement('dialog');
  modal.className = 'parent-keypad';
  modal.setAttribute('aria-labelledby', 'parent-keypad-title');
  document.body.append(modal);
  return new Promise(resolve => {
    let digits = '', busy = false, finished = false;
    const length = () => temporary ? 6 : 4;
    // An abandoned keypad would otherwise pin the frame on this screen forever.
    let idle = null;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => { if (!busy) finish(null); else touch(); }, 120000); };
    const finish = result => { if (finished) return; finished = true; clearTimeout(idle); digits = ''; modal.close(); modal.remove(); resolve(result); };
    function draw() {
      const copy = temporary ? { eyebrow: child ? h(child.name) : 'PARENT ACCESS', title: 'Code from your phone', help: 'Enter the six-digit code from the Family Frame app.', other: child ? `Use ${h(child.name)}’s PIN` : 'Use parent PIN' }
        : child ? { eyebrow: h(child.name), title: 'Enter your PIN', help: 'Your four digits unlock your time for ten minutes.', other: 'Use a code from my phone' }
        : { eyebrow: 'PARENT ACCESS', title: 'Enter your PIN', help: 'Your four digits identify you. Controls stay unlocked for ten minutes.', other: 'Use a temporary code' };
      modal.innerHTML = `<div class="pin-heading"><div><p class="eyebrow">${copy.eyebrow}</p><h2 id="parent-keypad-title">${copy.title}</h2></div><button type="button" data-pin-close aria-label="Cancel PIN entry">×</button></div><p class="supporting">${copy.help}</p><div class="pin-dots" aria-label="0 of ${length()} digits entered" role="status">${Array.from({length:length()},()=>'<span></span>').join('')}</div><p class="pin-error" role="alert" hidden></p><div class="pin-keys">${[1,2,3,4,5,6,7,8,9,'clear',0,'back'].map(key=>`<button type="button" data-pin-key="${key}" aria-label="${key==='back'?'Delete last digit':key==='clear'?'Clear PIN':key}">${key==='back'?'⌫':key==='clear'?'Clear':key}</button>`).join('')}</div><button type="button" class="button pin-continue" disabled>Continue</button><button type="button" class="text-button pin-switch">${copy.other}</button>`;
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
      touch();
      if(busy)return;
      if(value==='back')digits=digits.slice(0,-1);
      else if(value==='clear')digits='';
      else if(/^\d$/.test(value)&&digits.length<length())digits+=value;
      update();
      // A child's last digit submits by itself; Continue stays for retries and the parent flow.
      if(child&&!temporary&&/^\d$/.test(value)&&digits.length===length())submit();
    }
    async function submit() {
      if(busy||digits.length!==length())return;
      busy=true;update();modal.querySelector('.pin-error').hidden=true;
      const secret=digits;digits='';
      try {
        // A keypad entry replaces any unlock already on this frame, so it is sent without that grant.
        const data=await request(temporary?'/api/frame-access/redeem':child?'/api/frame-access/child-pin':'/api/frame-access/pin', {method:'POST',grant:false,body:temporary?{code:secret}:child?{personId:child.id,pin:secret}:{pin:secret}});
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
    draw();touch();modal.showModal();modal.querySelector('[data-pin-key="1"]').focus();
  });
}
