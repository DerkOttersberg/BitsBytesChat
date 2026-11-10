/* Production UI skin helper. Explicit mount only; no host actions or dialog lifecycle hooks. */
(() => {
  const defaultBorders={control:'solid',primary:'solid',gold:'solid',danger:'solid',paper:'corners',panel:'corners',well:'corners',tile:'corners',tab:'dash',nav:'solid',header:'none'};
  const motionBound=new WeakMap();
  const tabBound=new WeakMap();
  function surfaces(root){
    return [...(root.matches?.('[data-ci-surface]')?[root]:[]),...root.querySelectorAll('[data-ci-surface]')];
  }
  function bindMotion(element){
    if(motionBound.has(element)||!element.classList.contains('ci-button'))return;
    const handlers=[];
    const listen=(name,handler)=>{element.addEventListener(name,handler);handlers.push([name,handler]);};
    const scale=(value,duration,easing)=>{
      if(element.disabled||element.dataset.ciSurface==='nav'||matchMedia('(prefers-reduced-motion: reduce)').matches)value=1;
      element.style.setProperty('--ci-press-duration',duration+'ms');
      element.style.setProperty('--ci-press-ease',easing);
      element.style.setProperty('--ci-press-scale',value);
    };
    const press=()=>scale(.92,80,'cubic-bezier(.215,.61,.355,1)');
    const release=()=>scale(1,180,'cubic-bezier(.34,1.56,.64,1)');
    const cancel=()=>scale(1,120,'cubic-bezier(.215,.61,.355,1)');
    listen('pointerdown',press);listen('pointerup',release);listen('pointerleave',cancel);
    listen('pointercancel',cancel);listen('blur',cancel);
    listen('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat)press();});
    listen('keyup',e=>{if(e.key===' '||e.key==='Enter')release();});
    motionBound.set(element,()=>{for(const [name,handler]of handlers)element.removeEventListener(name,handler);element.style.removeProperty('--ci-press-scale');});
  }
  function unmount(root=document){
    for(const element of surfaces(root)){motionBound.get(element)?.();motionBound.delete(element);}
  }
  function setStateColors(element) {
    const style=getComputedStyle(element);
    const base=style.getPropertyValue('--ci-fill-rgb').split(',').map(Number);
    const alpha=Number(style.getPropertyValue('--ci-fill-alpha'));
    if(base.length!==3||base.some(n=>!Number.isFinite(n)))return;
    const lum=base.reduce((sum,n,i)=>sum+n/255*[.2126,.7152,.0722][i],0);
    const target=lum>.55?[255,255,255]:[255,249,235];
    const blend=(amount)=>base.map((n,i)=>+(n+(target[i]-n)*amount).toFixed(3)).join(',');
    element.style.setProperty('--ci-hover-rgb',blend(.1));
    element.style.setProperty('--ci-pressed-rgb',blend(.2));
    element.style.setProperty('--ci-hover-alpha',Math.min(1,alpha+.12));
  }
  function mount(root=document) {
    surfaces(root).forEach(element=>{
      element.dataset.ciBorder ||= defaultBorders[element.dataset.ciSurface]||'solid';
      if(!element.querySelector(':scope > .ci-decoration')){
        const layer=document.createElement('span');layer.className='ci-decoration';layer.setAttribute('aria-hidden','true');
        layer.innerHTML='<span class="ci-dots"><span></span></span>';
        const border=element.dataset.ciBorder;
        if(border==='dash')for(const edge of ['top','bottom','left','right']){
          const el=document.createElement('span');el.className='ci-dash ci-dash--'+edge;layer.append(el);
        }
        if(border==='dash'||border==='corners')for(const corner of ['tl','tr','bl','br']){
          const el=document.createElement('span');el.className='ci-corner ci-corner--'+corner;layer.append(el);
        }
        element.prepend(layer);
      }
      setStateColors(element);
      bindMotion(element);
    });
  }
  function tabs(group){
    if(tabBound.has(group))return tabBound.get(group);
    const buttons=[...group.querySelectorAll('[role="tab"]')],handlers=[];
    function activate(button){
      buttons.forEach(item=>{
        const selected=item===button;item.setAttribute('aria-selected',selected);item.tabIndex=selected?0:-1;setStateColors(item);
        const panel=group.ownerDocument.getElementById(item.getAttribute('aria-controls'));
        if(panel)panel.hidden=!selected;
      });
    }
    buttons.forEach((button,index)=>{
      const click=()=>activate(button);
      const key=event=>{
        let next;
        if(event.key==='ArrowRight')next=(index+1)%buttons.length;
        if(event.key==='ArrowLeft')next=(index-1+buttons.length)%buttons.length;
        if(event.key==='Home')next=0;if(event.key==='End')next=buttons.length-1;
        if(next!==undefined){event.preventDefault();activate(buttons[next]);buttons[next].focus();}
      };
      button.addEventListener('click',click);button.addEventListener('keydown',key);
      handlers.push(()=>{button.removeEventListener('click',click);button.removeEventListener('keydown',key);});
    });
    const cleanup=()=>{handlers.forEach(fn=>fn());tabBound.delete(group);};
    tabBound.set(group,cleanup);return cleanup;
  }
  window.CreamInk={mount,unmount,setStateColors,tabs};
})();
