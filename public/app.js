const $=(s,e=document)=>e.querySelector(s), $$=(s,e=document)=>[...e.querySelectorAll(s)];
function money(c,currency="EUR"){try{return new Intl.NumberFormat(undefined,{style:"currency",currency}).format((Number(c)||0)/100)}catch{return `${((Number(c)||0)/100).toFixed(2)} ${currency}`}}
function esc(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function token(){return localStorage.getItem("creator_token")||""}
async function api(url,opt={}){const headers={"Content-Type":"application/json",...(opt.headers||{})};if(token())headers.Authorization=`Bearer ${token()}`;const r=await fetch(url,{...opt,headers});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d}
async function applyConfig(){const c=await api("/api/config");try{const p=await api("/auth/profile");if(p.creator){c.creatorName=p.creator.name||c.creatorName;c.creatorHandle=p.creator.handle||c.creatorHandle}}catch{}$$(".js-store").forEach(x=>x.textContent=c.storeName);$$(".js-creator").forEach(x=>x.textContent=c.creatorName);if($("#heroTitle"))$("#heroTitle").textContent=c.heroTitle;if($("#heroSubtitle"))$("#heroSubtitle").textContent=c.heroSubtitle;if($("#tagline"))$("#tagline").textContent=c.tagline;document.title=c.storeName;return c}
function getRef(){const p=new URLSearchParams(location.search);return p.get("ref")||localStorage.getItem("creator_ref")||""}
function captureRef(){const r=new URLSearchParams(location.search).get("ref");if(r)localStorage.setItem("creator_ref",r)}

if(location.pathname.endsWith('/dashboard.html')||location.pathname.endsWith('/dashboard')){
  window.addEventListener('load',()=>{
    if(document.querySelector('script[data-dashboard-save-fix]'))return;
    const s=document.createElement('script');
    s.src='/dashboard-save-fix.js?v=3';
    s.dataset.dashboardSaveFix='1';
    document.body.appendChild(s);
  });
}
