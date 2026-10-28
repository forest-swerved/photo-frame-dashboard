// Domain reads run independently: slow calendar/household requests must not hold
// up network confirmation. Tokens and results are isolated to the current login.
export function createLiveUpdates({ read, loaders, scope, visible, onStatus = () => {}, clock = () => performance.now() }) {
  let identity, busy=false, last=-Infinity, retryMs=2000, domains={};
  function reset() { identity=scope(); domains={};last=-Infinity;retryMs=2000; }
  function enqueue(name, token, expected) {
    const item=domains[name] ||= { applied:null,wanted:null,busy:false };
    item.wanted=token;
    if(item.busy||item.applied===token) return;
    item.busy=true;
    Promise.resolve().then(()=>loaders[name]()).then(result=>{
      if(expected===scope()&&identity===expected&&result!==false) item.applied=token;
    }).catch(()=>{}).finally(()=>{
      item.busy=false;
      if(expected===scope()&&identity===expected&&item.wanted!==token) enqueue(name,item.wanted,expected);
    });
  }
  async function tick(force=false) {
    if(!visible()||busy) return;
    if(identity!==scope()) reset();
    if(!force&&clock()-last<retryMs) return;
    const expected=identity;busy=true;last=clock();
    try {
      const tokens=await read();
      if(expected!==scope()||identity!==expected) return;
      retryMs=2000;onStatus(null);
      for(const name of Object.keys(loaders)) if(typeof tokens[name]==='string') enqueue(name,tokens[name],expected);
    } catch(error) {
      if(expected===scope()&&identity===expected) { retryMs=Math.min(30000,retryMs*2);onStatus(error); }
    } finally { busy=false; }
  }
  return {tick,reset};
}
