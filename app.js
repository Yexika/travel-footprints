/* 我的世界足迹 — 世界 → 中国 → 省 三级可标记地图
 * 数据保存：Claude 云端（在 Claude 里打开时）/ GitHub 仓库里的 footprints.json（主人用令牌，或别人登录后经服务器提交）/ 本机浏览器
 */
(function(){
'use strict';
const $=s=>document.querySelector(s);
if(!window.d3||!window.topojson){$('#loading').textContent='地图组件没有加载出来，请刷新页面再试。';return;}

/* ---------- 常量 ---------- */
const CT={AS:'亚洲',EU:'欧洲',AF:'非洲',NA:'北美洲',SA:'南美洲',OC:'大洋洲',AN:'南极洲'};
const CTS={AS:'亚',EU:'欧',AF:'非',NA:'北美',SA:'南美',OC:'大洋',AN:'南极'};
const ORDER=['AS','EU','AF','NA','SA','OC','AN'];
const SN={been:'去过',want:'想去'};
const W2CN={TW:'710000',HK:'810000',MO:'820000'};
const PIN='M0 0C-1.5-4.5-8-8.2-8-13.5a8 8 0 1 1 16 0C8-8.2 1.5-4.5 0 0Z';
// 小红旗：旗杆底部在 (0,0)
const FLAG_POLE='M-0.9 0V-20h1.8V0Z',FLAG_CLOTH='M1-20C4.5-21.6 8-18.4 13-20V-11.6C8-10 4.5-13.2 1-11.6Z';
const LS='worldmap.v2',LS1='worldmap.v1',LSG='worldmap.gh',LSA='worldmap.api';
const CN_BOX={type:'MultiPoint',coordinates:[[73.5,39.4],[135.1,48.4],[123.3,53.6],[109.6,18.1],[97.3,28.2],[87.5,49.2]]};
const INSET_PROV=['440000','450000','460000','710000','350000','810000','820000'];
const HINTS={
  world:{view:'点国家查看或标记，点中国进入省份地图；拖动平移，滚轮或双指缩放。',been:'涂色模式：点一下国家就标为「去过」，再点一下取消。',want:'涂色模式：点一下国家就标为「想去」，再点一下取消。',pin:'点地图上任意位置放一个地点，城市、海岛、雪山都行。'},
  china:{view:'点省份进入局部图；去过的城市会插上小红旗，点小红旗可以直接打开那个城市。',been:'涂色模式：点一下省份就标为「去过」，再点一下取消。',want:'涂色模式：点一下省份就标为「想去」，再点一下取消。',pin:'点地图上任意位置放一个地点。'},
  prov:{view:'点城市或景点（圆点）查看和标记，去过的景点会插上小红旗；下面有这个省的景点清单。',been:'涂色模式：点城市或景点就标为「去过」，再点一下取消。',want:'涂色模式：点城市或景点就标为「想去」，再点一下取消。',pin:'点地图上任意位置放一个自己的地点，比如一家店、一条徒步线。'}
};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const str=(v,n)=>typeof v==='string'?v.slice(0,n):'';
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const ETH=/(蒙古族|蒙古|藏族|羌族|彝族|苗族|侗族|布依族|土家族|傣族|景颇族|傈僳族|白族|哈尼族|壮族|回族|哈萨克|柯尔克孜|朝鲜族|黎族|满族|畲族|瑶族|仡佬族|水族|纳西族|普米族|独龙族|怒族|拉祜族|佤族|布朗族|撒拉族|保安族|东乡族|裕固族|土族|锡伯族|达斡尔族|鄂温克族|鄂伦春族|仫佬族|毛南族|各族)+/g;
function short(n){
  n=n||'';
  if(/特别行政区$/.test(n))return n.replace('特别行政区','');
  if(/自治区$/.test(n))return n.replace(/(壮族|回族|维吾尔)?自治区$/,'');
  if(/自治州$/.test(n))return n.replace(ETH,'').replace('自治州','州');
  if(/自治县$/.test(n))return n.replace(ETH,'').replace('自治县','');
  return n.replace(/(省|市|地区|盟)$/,'')||n;
}
const okK=k=>/^([A-Z]{2,3}|\d{6}|s-\d{2}-[a-z0-9]{1,20})$/.test(k);
const okP=k=>/^[A-Za-z0-9_-]{1,40}$/.test(k);
const b64enc=s=>{const b=new TextEncoder().encode(s);let bin='';for(let i=0;i<b.length;i+=0x8000)bin+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));return btoa(bin);};
const b64dec=s=>new TextDecoder().decode(Uint8Array.from(atob((s||'').replace(/\s/g,'')),c=>c.charCodeAt(0)));

/* ---------- 状态 ---------- */
const fig=$('#fig'),cardEl=$('#card'),tip=$('#tip'),syncEl=$('#sync');
let NAMES={},CENTERS={},SPOTS=[],SPOT={},WORLD=null,CHINA=null;const PROV={};
let view='world',prov=null,curFeats=[],AREA={};
let marks={},pins={},D={};
let mode='view',backend='init',ro=false,db=null,envClaude=false;
let sel=null,W=0,H=0,K=1,T=d3.zoomIdentity,TE=[[0,0],[1,1]],lastPt=null,undoFn=null,toastTimer=0,routeId=0,pendingFocus=null,LBL=[];

/* ---------- 地图骨架 ---------- */
const svg=d3.select('#map');
const root=svg.append('g');
const gBg=root.append('g'),gC=root.append('g'),gDot=root.append('g'),gLbl=root.append('g'),gSpot=root.append('g'),gFlag=root.append('g'),gPin=root.append('g');
const gIns=svg.append('g').attr('class','ins');
let proj=d3.geoEqualEarth();
const path=d3.geoPath(proj);
const sphere={type:'Sphere'},grat=d3.geoGraticule10();
const zoom=d3.zoom().scaleExtent([1,16]).clickDistance(5)
  .on('zoom',e=>{T=e.transform;K=T.k;root.attr('transform',T);scaleDeps();tip.hidden=true;})
  .on('end',()=>placeLabels());
svg.call(zoom).on('dblclick.zoom',null);
const C=t=>zoom.constrain()(t,[[0,0],[W,H]],TE);
const go=t=>(reduce?svg:svg.transition().duration(700)).call(zoom.transform,t);

/* ---------- 数据 ---------- */
const getJSON=u=>fetch(u).then(r=>{if(!r.ok)throw new Error(u+' '+r.status);return r.json();});
function prep(f,key,name,sub){
  f.key=key;f.name=name;f.sub=sub;
  const g=f.geometry;let main=f;
  if(g&&g.type==='MultiPolygon'){let ba=-1;for(const c of g.coordinates){const p={type:'Polygon',coordinates:c},a=d3.geoArea(p);if(a>ba){ba=a;main=p;}}}
  f.main=main;f.ga=d3.geoArea(f);return f;
}
async function loadBase(){
  const [w,c,n,s,ct]=await Promise.all([getJSON('data/world.json'),getJSON('data/china.json'),getJSON('data/names.json'),getJSON('data/spots.json'),getJSON('data/centers.json').catch(()=>({}))]);
  NAMES=n;CENTERS=ct||{};
  SPOTS=s.filter(x=>x&&x.id&&x.n&&isFinite(x.lon)&&isFinite(x.lat));
  for(const x of SPOTS)SPOT[x.id]=x;
  const pf=topojson.feature(c,c.objects.prov).features.map(f=>{prep(f,f.properties.a,short(f.properties.n),f.properties.n);f.drill='#p-'+f.key;return f;});
  CHINA={feats:pf,jd:topojson.feature(c,c.objects.jd),by:Object.fromEntries(pf.map(f=>[f.key,f]))};
  // 世界图层里的中国轮廓改用与省界同源的数据（台湾、香港、澳门单独成块，点击进入对应省级地图）
  const cnGeom=topojson.merge(c,c.objects.prov.geometries.filter(g=>!['710000','810000','820000'].includes(g.properties.a)));
  const wf=topojson.feature(w,w.objects.countries).features.filter(f=>f.properties&&f.properties.k);
  for(const f of wf){
    const p=f.properties;if(p.k==='CN')f.geometry=cnGeom;
    prep(f,W2CN[p.k]||p.k,p.zh,`${p.en} · ${CT[p.ct]||''}`);f.wk=p.k;f.ct=p.ct;
    if(p.k==='CN')f.drill='#china';else if(W2CN[p.k])f.drill='#p-'+W2CN[p.k];
  }
  wf.sort((a,b)=>(a.wk==='CN')-(b.wk==='CN'));
  WORLD={feats:wf,total:d3.sum(wf,f=>f.ga)};
  buildIndex();
}
async function loadProv(a){
  if(PROV[a])return PROV[a];
  const t=await getJSON(`data/prov/${a}.json`);
  const pn=short(NAMES[a]);
  const feats=topojson.feature(t,t.objects.city).features.map(f=>prep(f,f.properties.a,short(f.properties.n),f.properties.a===a?f.properties.n:`${f.properties.n} · ${pn}`));
  return PROV[a]={feats};
}

/* ---------- 标记与推导 ---------- */
function cleanMark(o){if(!o||(o.s!=='been'&&o.s!=='want'))return null;return {s:o.s,date:str(o.date,40),note:str(o.note,300),t:+o.t||0};}
function cleanPin(o){if(!o||(o.s!=='been'&&o.s!=='want'))return null;const lon=+o.lon,lat=+o.lat;if(!isFinite(lon)||!isFinite(lat)||Math.abs(lat)>90||Math.abs(lon)>180)return null;return {s:o.s,name:str(o.name,60)||'未命名地点',lon,lat,date:str(o.date,40),note:str(o.note,300),t:+o.t||0};}
function normMarks(o){const n={};if(o&&typeof o==='object')for(let [k,v] of Object.entries(o)){if(W2CN[k])k=W2CN[k];const c=cleanMark(v);if(c&&okK(k))n[k]=c;}return n;}
function normPins(o){const n={};if(o&&typeof o==='object')for(const [k,v] of Object.entries(o)){const c=cleanPin(v);if(c&&okP(k))n[k]=c;}return n;}
// 城市/景点会把所在的省、中国一起点亮；「去过」优先于「想去」
function derive(){
  const d={};const up=(k,s)=>{if(d[k]!=='been')d[k]=s==='been'?'been':(d[k]||s);};
  for(const [k,m] of Object.entries(marks)){
    if(k.startsWith('s-')){const sp=SPOT[k];if(!sp)continue;up(k,m.s);up(sp.c,m.s);up(sp.p,m.s);up('CN',m.s);}
    else if(/^\d{6}$/.test(k)){up(k,m.s);const p=k.slice(0,2)+'0000';if(p!==k)up(p,m.s);up('CN',m.s);}
    else up(k,m.s);
  }
  D=d;
}
function kids(key){
  const r=[];
  for(const [k,m] of Object.entries(marks)){
    if(k===key)continue;
    if(k.startsWith('s-')){const sp=SPOT[k];if(sp&&(key==='CN'||key===sp.p||key===sp.c))r.push([sp.n,m.s]);}
    else if(/^\d{6}$/.test(k)&&(key==='CN'||(key.endsWith('0000')&&k.slice(0,2)===key.slice(0,2))))r.push([short(NAMES[k]||k),m.s]);
  }
  return r;
}
function nameOf(k){
  if(k.startsWith('s-'))return SPOT[k]?SPOT[k].n:k;
  if(/^\d{6}$/.test(k))return short(NAMES[k]||k);
  const f=WORLD&&WORLD.feats.find(x=>x.key===k);return f?f.name:k;
}
const isMuni=a=>['110000','120000','310000','500000','810000','820000'].includes(a);

/* ---------- 保存 ---------- */
function readLocal(){try{const o=JSON.parse(localStorage.getItem(LS)||localStorage.getItem(LS1)||'null');return o?{marks:normMarks(o.marks),pins:normPins(o.pins)}:null;}catch(e){return null;}}
function saveLocal(){try{localStorage.setItem(LS,JSON.stringify({v:2,marks,pins}));}catch(e){}}
function put(col,id,v){
  if(backend==='claude'){qPut(col,id,v);return;}
  saveLocal();
  if(backend==='github')ghSchedule();
  else if(backend==='api'){AP.q.set(col+'/'+id,{c:col,k:id,v:v||null});apiSchedule();}
}
// Claude 云端：一次写一份，同一份文档合并排队
const pend=new Map();let working=false;
function qPut(col,id,v){const key=col+'/'+id;pend.delete(key);pend.set(key,v);if(!working)qWork();}
async function qWork(){
  working=true;
  while(pend.size){
    const [key,v]=pend.entries().next().value;pend.delete(key);
    if(pend.size>2)syncEl.textContent=`正在保存…还剩 ${pend.size} 项`;
    const ref=db.doc(key);let ok=false;
    for(let i=0;i<2&&!ok;i++){
      try{if(v===null)await ref.delete();else await ref.set(v);ok=true;}
      catch(err){const c=err&&err.code;if(c==='unavailable'&&i===0){await new Promise(r=>setTimeout(r,400+Math.random()*800));continue;}qFail(c);break;}
    }
    if(ok&&!ro)setSync('ok');
  }
  working=false;
}
function qFail(c){
  if(c==='invalid_argument'||c==='not_granted'){pend.clear();setReadOnly();toast('你没有修改这张地图的权限，刚才的改动没有保存。');}
  else if(c==='quota_exceeded')toast('存储空间满了，删掉一些地点再试。');
  else{if(c==='revoked')pend.clear();setSync('err');}
}
// GitHub：把整份足迹写进仓库里的 footprints.json（停手 1.5 秒后合并成一次提交）
const GH={cfg:null,sha:null,timer:0,busy:false,again:false,retry:0};
function ghReadCfg(){try{const c=JSON.parse(localStorage.getItem(LSG)||'null');return c&&c.repo&&c.token?c:null;}catch(e){return null;}}
// 镜像站（比如自己服务器上的国内镜像）：同步脚本会在网站根目录写一个 mirror.json，里面是 {"repo":"用户名/仓库名","branch":"main"}
let MIRROR=null;
async function loadMirror(){
  if(/\.github\.io$/i.test(location.hostname))return;
  try{const m=await getJSON('mirror.json?t='+Date.now());if(m&&/^[\w.-]+\/[\w.-]+$/.test(m.repo||''))MIRROR={repo:m.repo,branch:m.branch||'main'};}catch(e){}
}
function ghGuess(){
  const m=/^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);if(!m)return MIRROR?MIRROR.repo:'';
  const seg=location.pathname.split('/').filter(Boolean)[0];
  return m[1]+'/'+(seg&&!/\.html?$/i.test(seg)?seg:m[1]+'.github.io');
}
const ghURL=c=>`https://api.github.com/repos/${c.repo}/contents/footprints.json`;
const ghH=c=>Object.assign({Accept:'application/vnd.github+json'},c.token?{Authorization:'Bearer '+c.token}:{});
async function ghGet(c){
  const r=await fetch(ghURL(c)+'?ref='+encodeURIComponent(c.branch||'main'),{headers:ghH(c),cache:'no-store'});
  if(r.status===404)return {sha:null,data:null};
  if(!r.ok){const e=new Error('gh');e.status=r.status;throw e;}
  const j=await r.json();
  let data=null;try{data=JSON.parse(b64dec(j.content)||'{}');}catch(e){data=null;}
  return {sha:j.sha,data};
}
async function ghPut(){
  const c=GH.cfg;
  const body={message:'更新旅行足迹',branch:c.branch||'main',content:b64enc(JSON.stringify({v:2,updated:new Date().toISOString(),marks,pins},null,1))};
  if(GH.sha)body.sha=GH.sha;
  const send=()=>fetch(ghURL(c),{method:'PUT',headers:Object.assign({'Content-Type':'application/json'},ghH(c)),body:JSON.stringify(body)});
  let r=await send();
  if(r.status===409||r.status===422){
    const cur=await ghGet(c);GH.sha=cur.sha;if(cur.sha)body.sha=cur.sha;else delete body.sha;r=await send();
  }
  if(!r.ok){const e=new Error('gh');e.status=r.status;throw e;}
  const j=await r.json();GH.sha=j.content&&j.content.sha;
}
function ghSchedule(){setSync('gh-saving');clearTimeout(GH.timer);GH.timer=setTimeout(ghFlush,1500);}
async function ghFlush(){
  GH.timer=0;
  if(GH.busy){GH.again=true;return;}
  GH.busy=true;GH.again=false;
  try{await ghPut();GH.retry=0;setSync(GH.again?'gh-saving':'gh-ok');}
  catch(e){
    if(e.status===401||e.status===403||e.status===404)setSync('gh-auth');
    else{setSync('gh-err');if(GH.retry<3){GH.retry++;GH.timer=setTimeout(ghFlush,20000*GH.retry);}}
  }
  GH.busy=false;if(GH.again)ghFlush();
}
window.addEventListener('beforeunload',e=>{if((backend==='github'&&(GH.timer||GH.busy))||(backend==='api'&&(AP.timer||AP.busy||AP.q.size))){e.preventDefault();e.returnValue='';}});
function mergeObj(a,b){const o=Object.assign({},a);for(const [k,v] of Object.entries(b)){if(!o[k]||(+v.t||0)>(+o[k].t||0))o[k]=v;}return o;}
async function ghConnect(repo,branch,token){
  const c={repo:repo.trim().replace(/^https?:\/\/github\.com\//i,'').replace(/\.git$/,'').replace(/\/+$/,''),branch:(branch||'main').trim()||'main',token:token.trim()};
  if(!/^[\w.-]+\/[\w.-]+$/.test(c.repo))throw '仓库要写成「用户名/仓库名」，例如 xiaoming/travel-map';
  if(!c.token)throw '请粘贴令牌';
  const r=await fetch('https://api.github.com/repos/'+c.repo,{headers:ghH(c)});
  if(r.status===401)throw '令牌无效，请检查是否完整复制';
  if(r.status===404||r.status===403)throw '找不到这个仓库，或者令牌没有访问它的权限';
  if(!r.ok)throw '连接 GitHub 失败（'+r.status+'），请稍后再试';
  const cur=await ghGet(c);
  const remote={marks:normMarks(cur.data&&cur.data.marks),pins:normPins(cur.data&&cur.data.pins)};
  const local=backend==='local'?{marks,pins}:(readLocal()||{marks:{},pins:{}});
  const merged={marks:mergeObj(remote.marks,local.marks),pins:mergeObj(remote.pins,local.pins)};
  GH.cfg=c;GH.sha=cur.sha;
  try{localStorage.setItem(LSG,JSON.stringify(c));}catch(e){}
  backend='github';ro=false;document.body.classList.remove('ro');
  marks=merged.marks;pins=merged.pins;saveLocal();renderAll();setMode(mode);
  if(JSON.stringify(merged)!==JSON.stringify(remote)||!cur.sha)ghFlush();else setSync('gh-ok');
  updGhBtn();
}
function ghDisconnect(){
  try{localStorage.removeItem(LSG);}catch(e){}
  GH.cfg=null;GH.sha=null;clearTimeout(GH.timer);GH.timer=0;backend='local';setSync('local');updGhBtn();
}
// 登录编辑：账号密码交给 site.json 里写的登录服务（自己的服务器）验证；
// 登录后的改动发给服务器，由服务器在 GitHub 最新的 footprints.json 上合并提交，GitHub 令牌不经过浏览器
let SITE={api:'',sites:[]};
async function loadSite(){
  try{
    const s=await getJSON('site.json?t='+Date.now());
    if(s&&typeof s.api==='string'&&/^https?:\/\/\S+$/.test(s.api))SITE.api=s.api.replace(/\/+$/,'');
    if(s&&Array.isArray(s.sites))SITE.sites=s.sites.filter(x=>x&&typeof x.url==='string'&&/^https?:\/\//.test(x.url)&&x.name).slice(0,6);
  }catch(e){}
}
function renderSites(){
  const el=$('#sites');if(!SITE.sites.length){el.hidden=true;return;}
  el.setAttribute('aria-label','访问网址');
  el.innerHTML=SITE.sites.map(x=>{
    let cur=false;try{const u=new URL(x.url);cur=u.host===location.host&&location.pathname.startsWith(u.pathname.replace(/index\.html?$/,''));}catch(e){}
    const sub=[x.desc,cur?'当前':''].filter(Boolean).join(' · ');
    return `<a href="${esc(x.url)}"${cur?' aria-current="page"':''}>${esc(x.name)}${sub?`<small>${esc(sub)}</small>`:''}</a>`;
  }).join('');
  el.hidden=false;
}
const AP={sess:null,q:new Map(),timer:0,busy:false,again:false,retry:0,last:0,lastUser:''};
function apiReadSess(){try{const o=JSON.parse(localStorage.getItem(LSA)||'null');return o&&o.token&&o.api===SITE.api&&o.exp*1000>Date.now()+60000?o:null;}catch(e){return null;}}
function apiDropSess(){AP.sess=null;try{localStorage.removeItem(LSA);}catch(e){}}
async function apiFetch(path,opt){
  const h={'Content-Type':'application/json'};if(AP.sess)h.Authorization='Bearer '+AP.sess.token;
  let r;
  try{r=await fetch(SITE.api+path,Object.assign({cache:'no-store'},opt||{},{headers:h}));}
  catch(e){const x=new Error('net');x.status=0;x.msg='连不上登录服务，请检查网络后再试。';throw x;}
  let j=null;try{j=await r.json();}catch(e){}
  if(!r.ok){const x=new Error('api');x.status=r.status;x.msg=(j&&j.error)||('登录服务返回了错误（'+r.status+'）');throw x;}
  return j||{};
}
// 用服务器返回的最新足迹替换本地，再把还没发出去的改动叠上去
function applyRemote(j){
  const m=normMarks(j.marks),p=normPins(j.pins);
  for(const o of AP.q.values()){const d=o.c==='marks'?m:p;if(o.v)d[o.k]=o.v;else delete d[o.k];}
  marks=m;pins=p;saveLocal();renderAll();
}
async function enterApi(){
  setSync('api-loading');
  const j=await apiFetch('/footprints');
  backend='api';ro=false;document.body.classList.remove('ro');
  applyRemote(j);AP.last=Date.now();setMode(mode);updLoginBtn();
  if(sel&&lastPt)showCard(lastPt);
  if(AP.q.size)apiFlush();else setSync('api-ok');
}
function apiSchedule(){setSync('api-saving');clearTimeout(AP.timer);AP.timer=setTimeout(apiFlush,1200);}
async function apiFlush(){
  clearTimeout(AP.timer);AP.timer=0;
  if(!AP.sess){setSync('api-auth');return;}
  if(AP.busy){AP.again=true;return;}
  if(!AP.q.size){setSync('api-ok');return;}
  AP.busy=true;AP.again=false;
  const batch=new Map(AP.q);AP.q.clear();
  try{
    const j=await apiFetch('/footprints',{method:'POST',body:JSON.stringify({ops:[...batch.values()]})});
    AP.retry=0;AP.last=Date.now();applyRemote(j);setSync(AP.q.size?'api-saving':'api-ok');
  }catch(e){
    if(e.status===400){setSync('api-err');toast(e.msg);}
    else{
      for(const [k,v] of batch)if(!AP.q.has(k))AP.q.set(k,v);
      if(e.status===401)apiExpired();
      else{setSync('api-err');syncEl.textContent=e.msg+' 改动先存在这个浏览器里，稍后会自动重试。';if(AP.retry<6){AP.retry++;AP.timer=setTimeout(apiFlush,5000*AP.retry);}}
    }
  }
  AP.busy=false;
  if(AP.again&&AP.sess)apiFlush();
}
function apiExpired(){
  apiDropSess();setSync('api-auth');updLoginBtn();
  openLogin('登录已过期，请重新登录。没保存的改动还在，登录后会接着保存。');
}
// 切回这个页面时，取一次别人刚做的修改
async function apiRefresh(){
  if(backend!=='api'||!AP.sess||AP.busy||AP.q.size||AP.timer||Date.now()-AP.last<15000)return;
  try{const j=await apiFetch('/footprints');AP.last=Date.now();if(!AP.busy&&!AP.q.size)applyRemote(j);}
  catch(e){if(e.status===401)apiExpired();}
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')apiRefresh();});
function setSync(s){
  const t={init:'正在读取足迹…',ok:'已自动保存，换台设备打开也在。',
    local:envClaude?'目前只保存在这个浏览器里。':'目前只保存在这个浏览器里。连接 GitHub 后可以多设备同步。',
    slow:'暂时连不上保存服务，显示的可能不是最新内容。',err:'有改动没能保存，请检查网络后再试。',
    ro:'只读：这是别人分享的足迹地图，可以浏览，不能修改。',
    'gh-loading':'正在从 GitHub 读取足迹…','gh-ok':'已同步到 GitHub：'+(GH.cfg?GH.cfg.repo:''),'gh-saving':'正在保存到 GitHub…',
    'gh-auth':'GitHub 令牌无效或没有写入权限，改动先存在这个浏览器里。请点「GitHub 设置」重新连接。',
    'gh-err':'保存到 GitHub 没成功（可能是网络问题），改动先存在这个浏览器里，稍后会自动重试。',
    'gh-offline':'暂时连不上 GitHub，先显示这台设备上的缓存。',
    'gh-view':SITE.api&&!envClaude?'只读：这是发布在 GitHub 上的足迹地图。有账号的话，点地图上方的「登录编辑」就能一起修改。':'只读：这是发布在 GitHub 上的足迹地图。主人点「连接 GitHub」后就能编辑。',
    'api-loading':'正在读取最新足迹…','api-ok':'已登录为 '+(AP.sess?AP.sess.user:'')+'，改动会自动保存，两个网址都能看到。','api-saving':'正在保存…',
    'api-err':'保存没成功（可能是网络问题），改动先存在这个浏览器里，稍后会自动重试。',
    'api-auth':'登录已过期，请重新登录；没保存的改动还在这个浏览器里。',
    'api-down':'登录服务暂时连不上，先以只读方式显示。'}[s]||'';
  syncEl.textContent=t;syncEl.dataset.s=s;
}
function setReadOnly(){ro=true;document.body.classList.add('ro');setMode('view');setSync('ro');if(sel)showCard(lastPt);renderAll();}
function ready(){if(backend==='init'){toast('还在读取足迹，稍等一下再点。');return false;}return !ro;}
function setMark(k,v){const n=Object.assign({},marks);if(v)n[k]=v;else delete n[k];marks=n;put('marks',k,v||null);renderAll();}
function setPin(id,v){const n=Object.assign({},pins);if(v)n[id]=v;else delete n[id];pins=n;put('pins',id,v||null);renderAll();}

/* ---------- 布局与绘制 ---------- */
function layout(force){
  const w=fig.clientWidth;
  if(!w||!curFeats.length)return;
  if(!force&&Math.abs(w-W)<2&&H)return;
  W=w;let h,minK=1;const vh=innerHeight;
  if(view==='world'){
    proj=d3.geoEqualEarth().rotate([-150,0]);path.projection(proj);
    if(W<600){
      h=Math.round(Math.min(460,Math.max(320,vh*0.56)));
      proj.fitHeight(h-16,sphere);
      let tr=proj.translate();proj.translate([tr[0],tr[1]+8]);
      const cx=proj([115,30])[0];tr=proj.translate();proj.translate([tr[0]+W/2-cx,tr[1]]);
      const b=path.bounds(sphere);TE=[[b[0][0]-8,0],[b[1][0]+8,h]];minK=W/(TE[1][0]-TE[0][0]);
    }else{
      proj.fitWidth(W-16,sphere);
      const tr=proj.translate();proj.translate([tr[0]+8,tr[1]+8]);
      h=Math.ceil(path.bounds(sphere)[1][1])+8;
      const maxH=Math.max(300,vh*0.78);
      if(h>maxH){h=Math.round(maxH);proj.fitExtent([[8,8],[W-8,h-8]],sphere);}
      TE=[[0,0],[W,h]];
    }
  }else if(view==='china'){
    proj=d3.geoConicEqualArea().parallels([25,47]).rotate([-105,0]);path.projection(proj);
    if(W<700){
      // 窄屏：主图在上，南海诸岛小图放在主图下方，不遮挡东南沿海
      const ih=Math.round(Math.max(84,Math.min(150,W*0.15))*1.4),mh=Math.round((W-16)/1.36)+16;
      h=mh+ih+6;proj.fitExtent([[8,8],[W-8,mh]],CN_BOX);
    }else{
      h=Math.round(Math.max(320,Math.min(W*0.74,vh*0.78)));
      proj.fitExtent([[14,14],[W-14,h-14]],CN_BOX);
    }
    TE=[[0,0],[W,h]];
  }else{
    proj=d3.geoMercator();path.projection(proj);
    h=Math.round(W<600?Math.max(340,Math.min(W*0.95,vh*0.62)):Math.max(320,Math.min(W*0.68,vh*0.76)));
    const fitF=curFeats.filter(f=>f.key!=='460300');
    proj.fitExtent([[24,24],[W-24,h-24]],{type:'FeatureCollection',features:fitF.length?fitF:curFeats});
    const b=path.bounds({type:'FeatureCollection',features:curFeats});
    TE=[[Math.min(0,b[0][0]-40),Math.min(0,b[0][1]-40)],[Math.max(W,b[1][0]+40),Math.max(h,b[1][1]+40)]];
  }
  H=h;fig.style.height=H+'px';svg.attr('width',W).attr('height',H);
  zoom.extent([[0,0],[W,H]]).translateExtent(TE).scaleExtent([minK,view==='world'?16:view==='prov'?64:24]);
  gBg.selectAll('*').remove();
  if(view==='world'){gBg.append('path').attr('class','sea').attr('d',path(sphere));gBg.append('path').attr('class','grat').attr('d',path(grat));}
  gC.selectAll('path').attr('d',path);
  for(const f of curFeats){f.a=path.area(f.main);f.cen=path.centroid(f.main);}
  drawInset();buildLabels();
  if(sel){sel=null;cardEl.hidden=true;}
  T=d3.zoomIdentity;svg.call(zoom.transform,d3.zoomIdentity);
  renderMap();placeLabels();
}
function drawInset(){
  gIns.selectAll('*').remove();
  if(view!=='china'||!CHINA)return;
  const iw=Math.round(Math.max(84,Math.min(150,W*0.15))),ih=Math.round(iw*1.4);
  const x=W-iw-64,y=H-ih-10;
  d3.select('#insrect').attr('x',x).attr('y',y).attr('width',iw).attr('height',ih);
  const ip=d3.geoConicEqualArea().parallels([25,47]).rotate([-105,0]).fitExtent([[x+4,y+4],[x+iw-4,y+ih-18]],{type:'MultiPoint',coordinates:[[108,24],[122,24],[108,3.5],[122,3.5]]});
  const ipath=d3.geoPath(ip);
  gIns.append('rect').attr('class','ins-bg').attr('x',x).attr('y',y).attr('width',iw).attr('height',ih).attr('rx',6);
  const g=gIns.append('g').attr('clip-path','url(#insclip)');
  g.selectAll('path.c').data(curFeats.filter(f=>INSET_PROV.includes(f.key))).join('path').attr('d',ipath).attr('class',cls);
  g.append('path').attr('class','jd').attr('d',ipath(CHINA.jd));
  gIns.append('text').attr('class','ins-t').attr('x',x+iw-6).attr('y',y+ih-5).attr('text-anchor','end').text('南海诸岛');
}
function buildLabels(){
  LBL=[];
  if(view!=='world'){
    for(const f of curFeats){if(!f.cen||!isFinite(f.cen[0]))continue;LBL.push({id:'a'+f.key,key:f.key,x:f.cen[0],y:f.cen[1],t:f.name,cls:'a',pri:f.a,w:f.name.length*13+6,h:16});}
    if(view==='prov')for(const s of SPOTS){if(s.p!==prov)continue;const p=proj([s.lon,s.lat]);if(!p)continue;LBL.push({id:s.id,x:p[0],y:p[1],dx:14,t:s.n,cls:'s',pri:s.g?2e12:1e12,w:s.n.length*13+6,h:16,st:true});}
  }
  gLbl.selectAll('text').data(LBL,d=>d.id).join('text').attr('class',d=>'lbl '+d.cls).attr('x',d=>d.dx||0).attr('y',4).text(d=>d.t);
}
function placeLabels(){
  if(!LBL.length)return;
  const placed=[],vis=new Set();
  if(view==='prov')for(const s of SPOTS){if(s.p!==prov)continue;const p=proj([s.lon,s.lat]);if(!p)continue;const q=T.apply(p);placed.push(marks[s.id]&&marks[s.id].s==='been'?[q[0]-3,q[1]-24,q[0]+11,q[1]+3]:[q[0]-7,q[1]-7,q[0]+7,q[1]+7]);}
  for(const d of FLAGS){const q=T.apply(d._p);placed.push([q[0]-3,q[1]-22,q[0]+15,q[1]+2]);}
  for(const d of LBL.slice().sort((a,b)=>b.pri-a.pri)){
    const q=T.apply([d.x,d.y]);
    const x0=d.st?q[0]+(d.dx||0):q[0]-d.w/2,y0=q[1]+7-d.h,box=[x0,y0,x0+d.w,y0+d.h];
    if(box[2]<0||box[0]>W||box[3]<0||box[1]>H)continue;
    if(!d.st){const f=AREA[d.key];if(f&&f.a*K*K<d.w*d.h*0.7)continue;}
    if(placed.some(b=>b[0]<box[2]&&box[0]<b[2]&&b[1]<box[3]&&box[1]<b[3]))continue;
    placed.push(box);vis.add(d.id);
  }
  gLbl.selectAll('text').classed('hid',d=>!vis.has(d.id));
}
function cls(f){const s=D[f.key];return 'c'+(s?' '+s:'')+(sel&&sel.t==='a'&&sel.k===f.key?' sel':'');}
function pinT(d){const p=proj([d.lon,d.lat])||[0,0];return `translate(${p[0]},${p[1]}) scale(${1/K})`;}
function scaleDeps(){
  d3.select('#hatch').attr('patternTransform',`rotate(45) scale(${1/K})`);
  gDot.selectAll('circle').attr('r',4.5/K);
  gSpot.selectAll('g.spot').attr('transform',d=>`translate(${d._p[0]},${d._p[1]}) scale(${1/K})`);
  gFlag.selectAll('g.flag').attr('transform',d=>`translate(${d._p[0]},${d._p[1]}) scale(${1/K})`);
  gPin.selectAll('g.pin').attr('transform',pinT);
  gPin.classed('plbl',K>=2.5||view==='prov');
  gLbl.selectAll('text').attr('transform',d=>`translate(${d.x},${d.y}) scale(${1/K})`);
}
function renderMap(){
  if(!W)return;
  gC.selectAll('path').attr('class',cls);gC.selectAll('path.sel').raise();
  gIns.selectAll('path.c').attr('class',cls);
  const small=view==='world'?curFeats.filter(f=>D[f.key]&&f.a<60):[];
  gDot.selectAll('circle').data(small,f=>f.key).join('circle').attr('class',f=>'dot '+D[f.key]).attr('cx',f=>f.cen[0]).attr('cy',f=>f.cen[1]);
  const sp=view==='prov'?SPOTS.filter(s=>s.p===prov):[];
  for(const s of sp)s._p=proj([s.lon,s.lat])||[0,0];
  gSpot.selectAll('g.spot').data(sp,d=>d.id).join(en=>{const g=en.append('g');g.append('circle').attr('class','hit').attr('r',14);g.append('circle').attr('class','r').attr('r',6.5);g.append('circle').attr('class','d').attr('r',2.2);flagInto(g);return g;})
    .attr('class',d=>'spot'+(marks[d.id]?' '+marks[d.id].s:'')+(sel&&sel.t==='s'&&sel.id===d.id?' sel':'')).attr('data-id',d=>d.id);
  gSpot.selectAll('g.spot.sel').raise();gSpot.selectAll('g.spot.been').raise();
  FLAGS=view==='china'?cityFlags():[];
  for(const d of FLAGS)d._p=proj([d.lon,d.lat])||[0,0];
  gFlag.selectAll('g.flag').data(FLAGS,d=>d.id).join(en=>{const g=en.append('g').attr('class','flag');g.append('rect').attr('class','hit').attr('x',-6).attr('y',-24).attr('width',22).attr('height',28);flagInto(g);return g;})
    .attr('data-id',d=>d.id);
  const list=Object.entries(pins).map(([id,p])=>Object.assign({id},p));
  if(sel&&sel.t==='new')list.push({id:'__new',s:'new',name:'',lon:sel.lon,lat:sel.lat});
  gPin.selectAll('g.pin').data(list,d=>d.id).join(en=>{const g=en.append('g');g.append('path').attr('d',PIN);g.append('circle').attr('cy',-13.5).attr('r',3);g.append('text').attr('x',10).attr('y',-9);return g;})
    .attr('class',d=>'pin '+d.s+(sel&&sel.t==='p'&&sel.id===d.id?' sel':'')).attr('data-id',d=>d.id)
    .select('text').text(d=>d.name);
  gPin.selectAll('g.pin.sel').raise();
  gLbl.selectAll('text.a').classed('on',d=>D[d.key]==='been');
  scaleDeps();
}
function flagInto(g){
  // 旗杆底部正好落在地点中心的小圆点上
  const f=g.append('g').attr('class','flg').attr('transform','scale(1.15)');
  f.append('path').attr('class','fp').attr('d',FLAG_POLE);
  f.append('path').attr('class','fc').attr('d',FLAG_CLOTH);
  f.append('circle').attr('class','fb').attr('r',2.4);
}
let FLAGS=[];
const MUNI=['110000','120000','310000','500000','810000','820000'];
// 中国地图上的小红旗：去过的城市（直辖市、港澳合并成一面旗，台湾按省算）
function cityFlags(){
  const out=[];
  for(const a of Object.keys(NAMES)){
    if(a.endsWith('0000'))continue;
    const p=a.slice(0,2)+'0000';
    if(MUNI.includes(p)||D[a]!=='been'||!CENTERS[a])continue;
    out.push({id:a,prov:p,lon:CENTERS[a][0],lat:CENTERS[a][1],n:short(NAMES[a])});
  }
  for(const p of MUNI.concat(['710000']))if(D[p]==='been'&&CENTERS[p]&&(p==='710000'||Object.keys(NAMES).some(a=>a!==p&&a.startsWith(p.slice(0,2))&&D[a]==='been')||marks[p]))out.push({id:p,prov:p,lon:CENTERS[p][0],lat:CENTERS[p][1],n:short(NAMES[p])});
  return out;
}
function fitT(g){
  const [[x0,y0],[x1,y1]]=path.bounds(g);
  const k=Math.max(1,Math.min(view==='world'?10:12,0.55/Math.max((x1-x0)/W,(y1-y0)/H)));
  return C(d3.zoomIdentity.translate(W/2,H/2).scale(k).translate(-(x0+x1)/2,-(y0+y1)/2));
}
function focusArea(k){
  const f=AREA[k];if(!f||!W)return;
  const t=fitT(f.main);go(t);sel={t:'a',k};renderMap();showCard(t.apply(f.cen));scrollToMap();
}
function focusPoint(lon,lat,s,minK){
  const p=proj([lon,lat]);if(!p||!W)return;
  const t=C(d3.zoomIdentity.translate(W/2,H/2).scale(Math.max(K,minK)).translate(-p[0],-p[1]));go(t);
  sel=s;renderMap();showCard(t.apply(p));scrollToMap();
}
// 定位景点时放大到约 0.4 经度宽（城区街道尺度），市区里挨得很近的景点也能分开
function cityK(lon,lat){const a=proj([lon,lat]),b=proj([lon+0.1,lat]);if(!a||!b)return 6;const px=Math.hypot(b[0]-a[0],b[1]-a[1])||1;return Math.max(2,Math.min(48,W/(px*4)));}
const focusSpot=id=>{const s=SPOT[id];if(s)focusPoint(s.lon,s.lat,{t:'s',id},view==='prov'?cityK(s.lon,s.lat):6);};
const focusPin=id=>{const d=pins[id];if(d)focusPoint(d.lon,d.lat,{t:'p',id},view==='world'?4:2);};
function scrollToMap(){const r=fig.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)fig.scrollIntoView({block:'nearest',behavior:reduce?'auto':'smooth'});}

/* ---------- 地图交互 ---------- */
svg.on('click',e=>{
  if(!curFeats.length)return;
  lastPt=d3.pointer(e,fig);
  const t=e.target,pg=t.closest&&t.closest('g.pin'),sg=t.closest&&t.closest('g.spot'),fg=t.closest&&t.closest('g.flag');
  if(fg&&fg.__data__){const d=fg.__data__;if(d.id===d.prov)nav('#p-'+d.prov);else goThen('#p-'+d.prov,()=>focusArea(d.id));return;}
  if(pg){const id=pg.getAttribute('data-id');if(id!=='__new')openSel({t:'p',id});return;}
  if(sg){const id=sg.getAttribute('data-id');if((mode==='been'||mode==='want')&&!ro)brushKey(id);else openSel({t:'s',id});return;}
  if(mode==='pin'&&!ro){
    if(t.closest&&t.closest('.ins'))return;
    if(!ready())return;
    const [x,y]=d3.pointer(e,root.node()),ll=proj.invert([x,y]);
    if(!ll||!isFinite(ll[0])||!isFinite(ll[1]))return;
    const back=proj(ll);if(!back||Math.hypot(back[0]-x,back[1]-y)>1)return;
    sel={t:'new',lon:+ll[0].toFixed(4),lat:+ll[1].toFixed(4)};renderMap();showCard(lastPt);
    const inp=cardEl.querySelector('[data-f=newname]');if(inp&&matchMedia('(pointer:fine)').matches)inp.focus();
    return;
  }
  const f=t.classList&&(t.classList.contains('c')||t.classList.contains('dot'))?t.__data__:null;
  if(!f){closeCard();return;}
  if((mode==='been'||mode==='want')&&!ro){brushKey(f.key);return;}
  if(f.drill){nav(f.drill);return;}
  openSel({t:'a',k:f.key});
});
svg.on('pointermove',e=>{
  if(e.pointerType!=='mouse')return;
  const t=e.target;let txt='';
  if(t.classList&&(t.classList.contains('c')||t.classList.contains('dot'))){const f=t.__data__;txt=f.name+(D[f.key]?' · '+SN[D[f.key]]:'')+(f.drill&&mode==='view'?' · 点击进入':'');}
  else{
    const sg=t.closest&&t.closest('g.spot'),pg=t.closest&&t.closest('g.pin');
    const fg=t.closest&&t.closest('g.flag');
    if(fg&&fg.__data__)txt=fg.__data__.n+' · 去过 · 点击查看';
    else if(sg&&sg.__data__){const s=sg.__data__;txt=s.n+(marks[s.id]?' · '+SN[marks[s.id].s]:'');}
    else if(pg&&pg.__data__&&pg.__data__.id!=='__new')txt=pg.__data__.name+' · '+SN[pg.__data__.s];
  }
  if(!txt){tip.hidden=true;return;}
  const [x,y]=d3.pointer(e,fig);tip.textContent=txt;tip.hidden=false;
  tip.style.transform=`translate(${Math.max(4,Math.min(x+14,W-tip.offsetWidth-4))}px,${Math.min(y+16,H-30)}px)`;
});
svg.on('pointerleave',()=>{tip.hidden=true;});
function brushKey(k){
  if(!ready())return;
  const prev=marks[k];
  const next=prev&&prev.s===mode?null:Object.assign({date:'',note:''},prev||{},{s:mode,t:Date.now()});
  setMark(k,next);
  const nm=nameOf(k);
  toast(next?`${nm} 已标为${SN[mode]}`:`已取消 ${nm} 的标记`,()=>setMark(k,prev||null));
}

/* ---------- 卡片 ---------- */
const head=(t,s)=>`<div class="ch"><div><b>${esc(t)}</b>${s?`<small>${esc(s)}</small>`:''}</div><button class="x" data-act="close" aria-label="关闭">×</button></div>`;
const seg=(opts,cur)=>`<div class="seg">${opts.map(([v,l])=>`<button data-act="s" data-s="${v}" aria-pressed="${v===cur}" class="${v||'none'}">${l}</button>`).join('')}</div>`;
const fields=m=>`<label class="fl">${m.s==='want'?'打算什么时候去':'什么时候去的'}<input data-f="date" value="${esc(m.date)}" placeholder="${m.s==='want'?'例如 明年春天':'例如 2023 年 7 月'}" maxlength="40"></label><label class="fl">备注<textarea data-f="note" rows="2" maxlength="300" placeholder="${m.s==='want'?'想去做什么…':'和谁去的、记得最深的事…'}">${esc(m.note)}</textarea></label>`;
const roBody=m=>m?`<p class="rs ${m.s}">${SN[m.s]}${m.date?' · '+esc(m.date):''}</p>${m.note?`<p class="cm">${esc(m.note)}</p>`:''}`:'<p class="cm">还没有标记</p>';
const fmtLL=d=>`${Math.abs(d.lat).toFixed(2)}°${d.lat>=0?'N':'S'}  ${Math.abs(d.lon).toFixed(2)}°${d.lon>=0?'E':'W'}`;
function autoNote(k){
  if(marks[k]||!D[k])return '';
  const ks=kids(k).filter(x=>x[1]===D[k]);if(!ks.length)return '';
  return `<p class="cm">已自动${D[k]==='been'?'点亮':'标为想去'}，因为：${esc(ks.slice(0,3).map(x=>x[0]).join('、'))}${ks.length>3?` 等 ${ks.length} 处`:''}</p>`;
}
function markCard(k,nm,sub){
  const m=marks[k],auto=autoNote(k);
  if(ro)return head(nm,sub)+roBody(m||(D[k]?{s:D[k],date:'',note:''}:null))+auto;
  return head(nm,sub)+seg([['been','去过'],['want','想去'],['','未标记']],m?m.s:'')+auto+(m?fields(m):(auto?'':'<p class="cm">标记之后，可以记下时间和备注。</p>'));
}
function selKey(){return sel?(sel.t==='a'?sel.k:sel.t==='s'?sel.id:null):null;}
function cardHTML(){
  if(!sel)return '';
  if(sel.t==='a'){const f=AREA[sel.k];return f?markCard(sel.k,f.name,f.sub):'';}
  if(sel.t==='s'){const s=SPOT[sel.id];return s?markCard(s.id,s.n,`${gradeText(s)} · ${short(NAMES[s.c]||'')} · ${short(NAMES[s.p]||'')}`):'';}
  if(sel.t==='p'){
    const d=pins[sel.id];if(!d)return '';
    return head(d.name,'自己放的地点 · '+fmtLL(d))+(ro?roBody(d):`<label class="fl">名字<input data-f="name" value="${esc(d.name)}" maxlength="60"></label>`+seg([['been','去过'],['want','想去']],d.s)+fields(d)+'<button class="del" data-act="del">删除这个地点</button>');
  }
  if(sel.t==='new')return head('新地点',fmtLL(sel))+'<label class="fl">名字<input data-f="newname" placeholder="例如 京都、黄石公园" maxlength="60"></label><div class="seg"><button data-act="mk" data-s="been">记为去过</button><button data-act="mk" data-s="want">记为想去</button></div>';
  return '';
}
function openSel(s){sel=s;renderMap();showCard(lastPt);}
function showCard(pt){
  const html=cardHTML();if(!html){closeCard();return;}
  cardEl.innerHTML=html;cardEl.hidden=false;
  pt=pt||lastPt||[W/2,H/2];lastPt=pt;
  const cw=cardEl.offsetWidth,ch=cardEl.offsetHeight;
  let x=pt[0]+18,y=pt[1]-30;
  if(x+cw>W-8)x=pt[0]-cw-18;
  x=Math.max(8,Math.min(x,W-cw-8));y=Math.max(8,Math.min(y,H-ch-8));
  cardEl.style.left=x+'px';cardEl.style.top=y+'px';
}
function closeCard(){sel=null;cardEl.hidden=true;renderMap();}
cardEl.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||!sel)return;const a=b.dataset.act;
  if(a==='close'){closeCard();return;}
  if(!ready())return;
  if(a==='s'){
    const s=b.dataset.s,k=selKey();
    if(k){
      const prev=marks[k];
      if(!s){if(prev){setMark(k,null);toast(`已取消 ${nameOf(k)} 的标记`,()=>setMark(k,prev));}}
      else setMark(k,Object.assign({date:'',note:''},prev||{},{s,t:prev?prev.t:Date.now()}));
    }else if(sel.t==='p'&&pins[sel.id])setPin(sel.id,Object.assign({},pins[sel.id],{s}));
    showCard(lastPt);
  }
  if(a==='mk')createPin(cardEl.querySelector('[data-f=newname]').value,b.dataset.s);
  if(a==='del'){const id=sel.id,prev=pins[id];if(!prev)return;setPin(id,null);closeCard();toast(`已删除 ${prev.name}`,()=>setPin(id,prev));}
});
cardEl.addEventListener('change',e=>{
  const f=e.target.dataset&&e.target.dataset.f;if(!f||f==='newname'||!sel||ro)return;
  let v=e.target.value.trim();const k=selKey();
  if(k){const m=marks[k];if(m&&m[f]!==v)setMark(k,Object.assign({},m,{[f]:v}));}
  else if(sel.t==='p'){const d=pins[sel.id];if(!d)return;if(f==='name'){v=v||'未命名地点';cardEl.querySelector('.ch b').textContent=v;}if(d[f]!==v)setPin(sel.id,Object.assign({},d,{[f]:v}));}
});
cardEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.dataset.f==='newname'){e.preventDefault();createPin(e.target.value,'been');}});
function createPin(name,s){
  if(!sel||sel.t!=='new'||!ready())return;
  const d={s,name:(name||'').trim().slice(0,60)||'未命名地点',lon:sel.lon,lat:sel.lat,date:'',note:'',t:Date.now()};
  const id=backend==='claude'?db.collection('pins').doc().id:'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  setPin(id,d);sel={t:'p',id};renderMap();showCard(lastPt);
  toast(`已添加 ${d.name}`,()=>setPin(id,null));
}

/* ---------- 统计、导航、清单 ---------- */
function stat(v,l,c,extra){return `<div class="st"><b class="${c||''}">${v}</b>${extra||''}<span>${l}</span></div>`;}
function renderStats(){
  const el=$('#stats');if(!WORLD){el.innerHTML='';return;}
  if(view==='world'){
    const cnt=s=>WORLD.feats.filter(f=>!W2CN[f.wk]&&D[f.key]===s);
    const been=cnt('been'),nw=cnt('want').length;
    const pct=100*d3.sum(WORLD.feats.filter(f=>D[f.key]==='been'),f=>f.ga)/WORLD.total;
    const cs=new Set(been.map(f=>f.ct));
    el.innerHTML=stat(been.length,'去过的国家和地区','been')+stat(nw,'想去的国家和地区','want')
      +stat((pct===0?'0':pct<0.1?'&lt;0.1':pct<10?pct.toFixed(1):Math.round(pct))+'%','点亮的世界陆地面积')
      +stat(`${cs.size}<small>/7</small>`,'踏足的大洲','',`<div class="cts">${ORDER.map(c=>`<span class="${cs.has(c)?'on':''}">${CTS[c]}</span>`).join('')}</div>`);
  }else if(view==='china'){
    const pk=CHINA.feats.map(f=>f.key);
    const pb=pk.filter(k=>D[k]==='been').length,pw=pk.filter(k=>D[k]==='want').length;
    const cb=Object.keys(NAMES).filter(a=>!a.endsWith('0000')&&D[a]==='been').length;
    const sb=SPOTS.filter(s=>marks[s.id]&&marks[s.id].s==='been').length;
    el.innerHTML=stat(`${pb}<small>/${pk.length}</small>`,'去过的省级行政区','been')+stat(cb,'去过的市（区县）','been')+stat(`${sb}<small>/${SPOTS.length}</small>`,'打卡的知名景点')+stat(pw,'想去的省份','want');
  }else{
    const ps=SPOTS.filter(s=>s.p===prov),single=curFeats.length===1&&curFeats[0].key===prov;
    const cb=curFeats.filter(f=>D[f.key]==='been').length;
    const sb=ps.filter(s=>marks[s.id]&&marks[s.id].s==='been').length,sw=ps.filter(s=>marks[s.id]&&marks[s.id].s==='want').length;
    const pf=CHINA.by[prov],pn=pf?Object.values(pins).filter(p=>d3.geoContains(pf,[p.lon,p.lat])).length:0;
    el.innerHTML=(single?stat(D[prov]?SN[D[prov]]:'—','这个地区',D[prov]||''):stat(`${cb}<small>/${curFeats.length}</small>`,isMuni(prov)?'去过的区县':'去过的市（州）','been'))
      +stat(`${sb}<small>/${ps.length}</small>`,'打卡的景点')+stat(sw,'想去的景点','want')+stat(pn,'自己放的地点');
  }
}
function renderCrumbs(){
  const c=$('#crumbs');
  if(view==='world')c.innerHTML='<b>世界</b><a href="#china">进入中国地图 ›</a>';
  else if(view==='china')c.innerHTML='<a href="#world">世界</a><i>›</i><b>中国</b>';
  else c.innerHTML=`<a href="#world">世界</a><i>›</i><a href="#china">中国</a><i>›</i><b>${esc(NAMES[prov]||'')}</b>`;
  const ph=$('#ph');
  if(view!=='prov'){ph.hidden=true;ph.innerHTML='';return;}
  ph.hidden=false;
  const m=marks[prov],auto=!m&&D[prov]?`<span class="auto">已因城市或景点自动${D[prov]==='been'?'点亮':'标为想去'}</span>`:'';
  ph.innerHTML=ro?`<span class="lab">这个省：${D[prov]?SN[D[prov]]:'未标记'}</span>`:`<span class="lab">这个省</span>${seg([['been','去过'],['want','想去'],['','未标记']],m?m.s:'')}${auto}`;
}
$('#ph').addEventListener('click',e=>{
  const b=e.target.closest('button[data-act=s]');if(!b||view!=='prov'||!ready())return;
  const s=b.dataset.s,prev=marks[prov];
  if(!s){if(prev){setMark(prov,null);toast(`已取消 ${nameOf(prov)} 的标记`,()=>setMark(prov,prev));}}
  else setMark(prov,Object.assign({date:'',note:''},prev||{},{s,t:prev?prev.t:Date.now()}));
});
const pinIcon=`<svg class="pi" viewBox="-9 -23 18 24" aria-hidden="true"><path d="${PIN}"/></svg>`;
function chip(attr,name,meta,isPin){return `<li><button ${attr}>${isPin?pinIcon:''}<b>${esc(name)}</b>${meta?`<small>${esc(meta)}</small>`:''}</button></li>`;}
const mmeta=m=>m?[m.date,m.note].filter(Boolean).join(' · '):'';
function col(s,inner,count){
  return `<div class="${s==='been'?'b':'w'}"><h2><i class="sw ${s}"></i><span>${SN[s]}</span><span>${esc(count)}</span></h2>${inner}</div>`;
}
function worldLists(){
  return '<div class="cols">'+['been','want'].map(s=>{
    const fs=WORLD.feats.filter(f=>!W2CN[f.wk]&&D[f.key]===s).sort((a,b)=>ORDER.indexOf(a.ct)-ORDER.indexOf(b.ct)||a.name.localeCompare(b.name,'zh-CN'));
    const ps=Object.entries(pins).filter(([,p])=>p.s===s).sort((a,b)=>a[1].name.localeCompare(b[1].name,'zh-CN'));
    let h='',cur='';
    if(!fs.length&&!ps.length)h=`<p class="empty">${s==='been'?'还没有去过的地方。切到「涂·去过」，在地图上点几下试试。':'心愿单还空着。切到「涂·想去」，把想去的国家涂上。'}</p>`;
    for(const f of fs){
      if(f.ct!==cur){if(cur)h+='</ul>';h+=`<h3>${CT[f.ct]||'其他'}</h3><ul class="chips">`;cur=f.ct;}
      if(f.wk==='CN'){const n=CHINA.feats.filter(p=>D[p.key]===s).length;h+=chip('data-go="#china"',f.name,n?`${n} 个省份 · 点开看`:'点开看省份');}
      else h+=chip(`data-k="${esc(f.key)}"`,f.name,mmeta(marks[f.key]));
    }
    if(cur)h+='</ul>';
    if(ps.length)h+='<h3>自己放的地点</h3><ul class="chips">'+ps.map(([id,p])=>chip(`data-pin="${esc(id)}"`,p.name,mmeta(p),true)).join('')+'</ul>';
    return col(s,h,`${fs.length} 个国家和地区 · ${ps.length} 个地点`);
  }).join('')+'</div>';
}
function chinaLists(){
  return '<div class="cols">'+['been','want'].map(s=>{
    const fs=CHINA.feats.filter(f=>D[f.key]===s).sort((a,b)=>a.key.localeCompare(b.key));
    const h=fs.length?'<ul class="chips">'+fs.map(f=>{
      const pre=f.key.slice(0,2);
      const nc=Object.keys(NAMES).filter(a=>!a.endsWith('0000')&&a.startsWith(pre)&&D[a]===s).length;
      const ns=SPOTS.filter(x=>x.p===f.key&&marks[x.id]&&marks[x.id].s===s).length;
      return chip(`data-go="#p-${f.key}"`,f.name,[nc?nc+' 市':'',ns?ns+' 景点':''].filter(Boolean).join(' · '));
    }).join('')+'</ul>':`<p class="empty">${s==='been'?'还没有点亮的省份。点一个省进去，标记城市或景点。':'还没有想去的省份。'}</p>`;
    return col(s,h,`${fs.length} 个省级行政区`);
  }).join('')+'</div>';
}
// 5A 标识：g 为 '5A'（国家5A级旅游景区）或 '拟5A'（2026年11月公示中）
const gradeText=s=>s.g==='5A'?'国家5A级景区':s.g==='拟5A'?'拟评5A景区（2026年11月公示）':'景点';
const badge=s=>s.g?`<em class="g5${s.g==='5A'?'':' p'}" title="${s.g==='5A'?'国家5A级旅游景区':'拟评5A（2026年11月公示）'}">${s.g}</em>`:'';
let spotFilter='all';
function provLists(){
  const pn=NAMES[prov]||'';
  const ps=SPOTS.filter(s=>s.p===prov);
  const n5=ps.filter(s=>s.g).length;
  const shown=ps.filter(s=>spotFilter==='5a'?s.g:spotFilter==='todo'?!(marks[s.id]&&marks[s.id].s==='been'):true);
  const groups=new Map();for(const s of shown){if(!groups.has(s.c))groups.set(s.c,[]);groups.get(s.c).push(s);}
  const gs=[...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const fb=(v,l)=>`<button data-sf="${v}" aria-pressed="${spotFilter===v}">${l}</button>`;
  let h=`<div class="sec"><h2><span>景点打卡</span><span>${esc(short(pn))}收录了 ${ps.length} 个景点${n5?`，其中 ${n5} 个是 5A 景区`:''}</span></h2><p>没收录的地方，可以用「放地点」在地图上自己加。</p><div class="sf" role="group" aria-label="筛选景点">${fb('all','全部')}${fb('5a','只看 5A')}${fb('todo','没去过的')}</div>`;
  if(!shown.length)h+=`<p class="empty">${spotFilter==='todo'?'这个省收录的景点都去过了，厉害！':'没有符合条件的景点。'}</p>`;
  h+='<div class="grid">';
  for(const [c,list] of gs){
    const nb=list.filter(s=>marks[s.id]&&marks[s.id].s==='been').length;
    h+=`<div class="grp"><h3><span>${esc(c===prov?short(pn):short(NAMES[c]||''))}</span><small>${nb}/${list.length}</small></h3><ul class="spl">`;
    for(const s of list){
      const st=marks[s.id]?marks[s.id].s:'';
      h+=`<li data-id="${esc(s.id)}"><button class="nm" data-spot="${esc(s.id)}"><i class="${st}"></i><span>${esc(s.n)}</span>${badge(s)}</button><span class="tg edit"><button data-ss="been" aria-pressed="${st==='been'}">去过</button><button data-ss="want" aria-pressed="${st==='want'}">想去</button></span></li>`;
    }
    h+='</ul></div>';
  }
  h+='</div></div>';
  const pf=CHINA.by[prov];
  h+='<div class="cols">'+['been','want'].map(s=>{
    const fs=curFeats.filter(f=>f.key!==prov&&D[f.key]===s);
    const pp=Object.entries(pins).filter(([,p])=>p.s===s&&pf&&d3.geoContains(pf,[p.lon,p.lat]));
    let x='';
    if(!fs.length&&!pp.length)x=`<p class="empty">${s==='been'?'这个省还没有去过的城市。':'这个省还没有想去的城市。'}</p>`;
    if(fs.length)x+=`<h3>${isMuni(prov)?'区县':'城市'}</h3><ul class="chips">`+fs.map(f=>chip(`data-k="${esc(f.key)}"`,f.name,mmeta(marks[f.key])||(marks[f.key]?'':'因景点自动点亮'))).join('')+'</ul>';
    if(pp.length)x+='<h3>自己放的地点</h3><ul class="chips">'+pp.map(([id,p])=>chip(`data-pin="${esc(id)}"`,p.name,mmeta(p),true)).join('')+'</ul>';
    return col(s,x,`${fs.length} 个${isMuni(prov)?'区县':'城市'} · ${pp.length} 个地点`);
  }).join('')+'</div>';
  return h;
}
function renderLists(){
  const L=$('#lists');if(!WORLD){L.innerHTML='';return;}
  L.innerHTML=view==='world'?worldLists():view==='china'?chinaLists():provLists();
}
$('#lists').addEventListener('click',e=>{
  const sf=e.target.closest('button[data-sf]');
  if(sf){spotFilter=sf.dataset.sf;renderLists();const nb=document.querySelector(`#lists button[data-sf="${spotFilter}"]`);if(nb)nb.focus({preventScroll:true});return;}
  const tg=e.target.closest('button[data-ss]');
  if(tg){
    const id=tg.closest('li').dataset.id,s=tg.dataset.ss;if(!ready()||!SPOT[id])return;
    const prev=marks[id];setMark(id,prev&&prev.s===s?null:Object.assign({date:'',note:''},prev||{},{s,t:Date.now()}));
    const nb=document.querySelector(`#lists li[data-id="${id}"] button[data-ss="${s}"]`);if(nb)nb.focus({preventScroll:true});
    return;
  }
  const b=e.target.closest('button[data-go],button[data-k],button[data-spot],button[data-pin]');if(!b)return;
  if(b.dataset.go)nav(b.dataset.go);else if(b.dataset.k)focusArea(b.dataset.k);else if(b.dataset.spot)focusSpot(b.dataset.spot);else focusPin(b.dataset.pin);
});
function renderAll(){
  derive();
  if(sel&&((sel.t==='a'&&!AREA[sel.k])||(sel.t==='p'&&!pins[sel.id])||(sel.t==='s'&&!SPOT[sel.id]))){sel=null;cardEl.hidden=true;}
  renderMap();renderStats();renderLists();renderCrumbs();
}

/* ---------- 路由 ---------- */
const viewHash=()=>view==='world'?'#world':view==='china'?'#china':'#p-'+prov;
function nav(h){if((location.hash||'#world')===h){if(viewHash()!==h)route();}else location.hash=h;}
function goThen(h,fn){if(viewHash()===h&&(location.hash||'#world')===h){fn();return;}pendingFocus=fn;nav(h);}
async function route(){
  if(!WORLD)return;
  const id=++routeId,h=location.hash.slice(1);
  let v='world',p=null;
  if(h==='china')v='china';
  else{const m=/^p-(\d{6})$/.exec(h);if(m&&m[1].endsWith('0000')&&NAMES[m[1]]){v='prov';p=m[1];}}
  let feats;
  const ld=$('#loading');
  try{
    if(v==='world')feats=WORLD.feats;
    else if(v==='china')feats=CHINA.feats;
    else{if(!PROV[p]){ld.hidden=false;ld.textContent='正在打开'+short(NAMES[p])+'…';}feats=(await loadProv(p)).feats;}
  }catch(e){ld.hidden=false;ld.textContent='这个省的地图没有加载出来，请刷新页面再试。';return;}
  if(id!==routeId)return;
  ld.hidden=true;
  if(p!==prov)spotFilter='all';
  view=v;prov=p;curFeats=feats;AREA={};for(const f of feats)AREA[f.key]=f;
  sel=null;cardEl.hidden=true;tip.hidden=true;
  document.body.classList.remove('v-world','v-china','v-prov');document.body.classList.add('v-'+v);
  gC.selectAll('path').data(curFeats,f=>f.key).join('path').order();
  gSpot.selectAll('*').remove();gFlag.selectAll('*').remove();gLbl.selectAll('*').remove();gDot.selectAll('*').remove();FLAGS=[];
  layout(true);renderAll();setMode(mode==='pin'||mode==='view'||!ro?mode:'view');
  document.title=v==='world'?'我的世界足迹':v==='china'?'中国 · 我的世界足迹':short(NAMES[p])+' · 我的世界足迹';
  if(pendingFocus){const f=pendingFocus;pendingFocus=null;f();}
}

/* ---------- 工具条 ---------- */
function setMode(m){
  mode=ro?'view':m;
  document.querySelectorAll('.modes button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.m===mode)));
  $('#hint').textContent=ro?'这是一张只读的足迹地图：点国家、省份、城市或景点看看。'+(SITE.api&&!envClaude?'有账号的话，点「登录编辑」就能一起修改。':''):HINTS[view][mode];
  svg.attr('data-mode',mode);
  if(sel&&sel.t==='new'&&mode!=='pin')closeCard();
}
document.querySelectorAll('.modes button').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.m)));
$('#zin').addEventListener('click',()=>svg.transition().duration(reduce?0:300).call(zoom.scaleBy,1.6));
$('#zout').addEventListener('click',()=>svg.transition().duration(reduce?0:300).call(zoom.scaleBy,1/1.6));
$('#zre').addEventListener('click',()=>{go(d3.zoomIdentity);closeCard();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('#loginDlg').hidden)$('#loginDlg').hidden=true;else if(!$('#ghDlg').hidden)$('#ghDlg').hidden=true;else if(!cardEl.hidden)closeCard();}});

/* ---------- 搜索（国家、省、市、景点） ---------- */
let IDX=[];
function buildIndex(){
  IDX=[];
  for(const f of WORLD.feats){if(W2CN[f.wk])continue;IDX.push({ty:'国家',n:f.name,en:(f.properties.en||'').toLowerCase(),k:f.key,sub:f.properties.en,cn:f.wk==='CN'});}
  for(const [a,n] of Object.entries(NAMES)){
    if(a.endsWith('0000'))IDX.push({ty:'省',n,k:a,sub:'中国'});
    else IDX.push({ty:/[区县]$/.test(n)?'区县':'市',n,k:a,sub:short(NAMES[a.slice(0,2)+'0000'])});
  }
  for(const s of SPOTS)IDX.push({ty:s.g==='5A'?'5A景点':'景点',n:s.n,k:s.id,sub:short(NAMES[s.c]||'')+' · '+short(NAMES[s.p]||'')});
}
const q=$('#q'),sug=$('#sug');let hits=[],hi=0;
function drawSug(){
  if(!hits.length){sug.innerHTML='<li class="no">没有找到，换个说法试试</li>';sug.hidden=false;return;}
  sug.innerHTML=hits.map((x,i)=>{const s=D[x.k];return `<li role="option" data-i="${i}" aria-selected="${i===hi}"><em>${x.ty}</em><b>${esc(x.n)}</b><small>${esc(x.sub||'')}</small>${s?`<i class="tag ${s}">${SN[s]}</i>`:''}</li>`;}).join('');
  sug.hidden=false;
}
q.addEventListener('input',()=>{
  const v=q.value.trim().toLowerCase();
  if(!v||!IDX.length){sug.hidden=true;return;}
  const sc=x=>x.n===v?0:x.n.startsWith(v)||(x.en&&x.en.startsWith(v))?1:2;
  hits=IDX.filter(x=>x.n.toLowerCase().includes(v)||(x.en&&x.en.includes(v))).sort((a,b)=>sc(a)-sc(b)||a.n.length-b.n.length).slice(0,10);
  hi=0;drawSug();
});
q.addEventListener('keydown',e=>{
  if(sug.hidden)return;
  if(e.key==='ArrowDown'){hi=Math.min(hi+1,hits.length-1);drawSug();e.preventDefault();}
  else if(e.key==='ArrowUp'){hi=Math.max(hi-1,0);drawSug();e.preventDefault();}
  else if(e.key==='Enter'&&hits[hi]){e.preventDefault();pick(hits[hi]);}
  else if(e.key==='Escape')sug.hidden=true;
});
sug.addEventListener('mousedown',e=>e.preventDefault());
sug.addEventListener('click',e=>{const li=e.target.closest('li[data-i]');if(li)pick(hits[+li.dataset.i]);});
q.addEventListener('blur',()=>setTimeout(()=>{sug.hidden=true;},150));
function pick(x){
  sug.hidden=true;q.value='';q.blur();if(!x)return;
  if(x.ty==='国家'){if(x.cn)nav('#china');else goThen('#world',()=>focusArea(x.k));}
  else if(x.ty==='省')nav('#p-'+x.k);
  else if(x.ty==='景点'||x.ty==='5A景点'){const s=SPOT[x.k];if(s)goThen('#p-'+s.p,()=>focusSpot(x.k));}
  else goThen('#p-'+x.k.slice(0,2)+'0000',()=>focusArea(x.k));
}

/* ---------- 提示、备份、GitHub 设置 ---------- */
function toast(msg,undo){
  const el=$('#toast');el.querySelector('span').textContent=msg;
  undoFn=undo||null;el.querySelector('button').hidden=!undo;el.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true;undoFn=null;},5000);
}
$('#toast button').addEventListener('click',()=>{const f=undoFn;undoFn=null;$('#toast').hidden=true;if(f&&!ro)f();});
$('#bCopy').addEventListener('click',async()=>{
  const s=JSON.stringify({v:2,marks,pins});
  try{await navigator.clipboard.writeText(s);toast('备份已复制，可以粘贴到备忘录里保存。');}
  catch(e){const t=$('#bTxt');t.classList.remove('edit');t.value=s;t.focus();t.select();toast('没法直接复制，备份已放进下面的框里，请手动复制。');}
});
$('#bImp').addEventListener('click',()=>{
  if(!ready())return;
  let o;try{o=JSON.parse($('#bTxt').value);}catch(e){toast('这段文字不是有效的备份。');return;}
  const ms=normMarks(o&&o.marks),ps=normPins(o&&o.pins);
  const n=Object.keys(ms).length+Object.keys(ps).length;
  if(!n){toast('备份里没有找到标记。');return;}
  marks=Object.assign({},marks,ms);pins=Object.assign({},pins,ps);
  for(const [k,v] of Object.entries(ms))put('marks',k,v);
  for(const [k,v] of Object.entries(ps))put('pins',k,v);
  renderAll();$('#bTxt').value='';toast(`已导入 ${n} 条标记。`);
});
let clr=0;
$('#bClear').addEventListener('click',e=>{
  if(!ready())return;const b=e.currentTarget;
  if(!clr){b.textContent='确定清空？再点一次';clr=setTimeout(()=>{clr=0;b.textContent='清空所有标记';},4000);return;}
  clearTimeout(clr);clr=0;b.textContent='清空所有标记';
  const pm=marks,pp=pins;marks={};pins={};
  for(const k of Object.keys(pm))put('marks',k,null);
  for(const id of Object.keys(pp))put('pins',id,null);
  if(backend==='local')saveLocal();
  closeCard();renderAll();
  toast('已清空全部标记',()=>{marks=pm;pins=pp;for(const [k,v] of Object.entries(pm))put('marks',k,v);for(const [k,v] of Object.entries(pp))put('pins',k,v);renderAll();});
});
const dlg=$('#ghDlg');
function updGhBtn(){const b=$('#ghBtn');b.hidden=envClaude;b.textContent=backend==='github'?'GitHub 设置':'连接 GitHub';updLoginBtn();}
function updLoginBtn(){
  const b=$('#loginBtn'),on=backend==='api'&&!!AP.sess;
  b.hidden=envClaude||!SITE.api||backend==='github';
  b.textContent=on?AP.sess.user+' · 退出登录':'登录编辑';b.classList.toggle('on',on);
}
const lgDlg=$('#loginDlg');
function openLogin(msg){
  const err=$('#lgErr');err.textContent=msg||'';err.hidden=!msg;
  $('#lgPass').value='';if(!$('#lgUser').value&&AP.lastUser)$('#lgUser').value=AP.lastUser;
  lgDlg.hidden=false;($('#lgUser').value?$('#lgPass'):$('#lgUser')).focus();
}
$('#loginBtn').addEventListener('click',()=>{
  if(backend==='api'&&AP.sess){
    if(AP.q.size||AP.busy||AP.timer){toast('还有改动正在保存，稍等几秒再退出。');apiFlush();return;}
    apiDropSess();location.reload();return;
  }
  openLogin();
});
$('#lgCancel').addEventListener('click',()=>{lgDlg.hidden=true;});
lgDlg.addEventListener('click',e=>{if(e.target===lgDlg)lgDlg.hidden=true;});
$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const b=$('#lgOk'),err=$('#lgErr');err.hidden=true;
  const user=$('#lgUser').value.trim(),password=$('#lgPass').value;
  if(!user||!password){err.textContent='请填写账号和密码。';err.hidden=false;return;}
  b.disabled=true;b.textContent='登录中…';
  try{
    AP.sess=null;
    const j=await apiFetch('/login',{method:'POST',body:JSON.stringify({user,password})});
    AP.sess={token:j.token,user:j.user,exp:j.exp,api:SITE.api};AP.lastUser=j.user;
    try{localStorage.setItem(LSA,JSON.stringify(AP.sess));}catch(x){}
    await enterApi();
    lgDlg.hidden=true;$('#lgPass').value='';toast('已登录为 '+j.user+'，现在可以修改地图了。');
  }catch(x){err.textContent=x.msg||'登录失败，请稍后再试。';err.hidden=false;}
  b.disabled=false;b.textContent='登录';
});
$('#ghBtn').addEventListener('click',()=>{
  const c=GH.cfg||ghReadCfg();
  $('#ghRepo').value=(c&&c.repo)||ghGuess();$('#ghBranch').value=(c&&c.branch)||(MIRROR&&MIRROR.branch)||'main';
  $('#ghToken').value='';$('#ghToken').placeholder=c?'已连接；粘贴新令牌可以更换':'github_pat_…';
  $('#ghOff').hidden=!c;$('#ghErr').hidden=true;dlg.hidden=false;
  ($('#ghRepo').value?$('#ghToken'):$('#ghRepo')).focus();
});
$('#ghCancel').addEventListener('click',()=>{dlg.hidden=true;});
dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.hidden=true;});
$('#ghOff').addEventListener('click',()=>{ghDisconnect();dlg.hidden=true;toast('这台设备已断开 GitHub，足迹仍保存在这个浏览器里。');});
$('#ghOk').addEventListener('click',async()=>{
  const b=$('#ghOk'),err=$('#ghErr');err.hidden=true;
  const c=GH.cfg||ghReadCfg();
  const token=$('#ghToken').value||(c?c.token:'');
  b.disabled=true;b.textContent='连接中…';
  try{await ghConnect($('#ghRepo').value,$('#ghBranch').value,token);dlg.hidden=true;toast('已连接 GitHub，之后的标记会自动保存到仓库。');}
  catch(e){err.textContent=typeof e==='string'?e:'连接失败，请检查网络后再试。';err.hidden=false;}
  b.disabled=false;b.textContent='连接';
});

/* ---------- 启动 ---------- */
async function initStorage(){
  if(envClaude){
    let d=null,u=null;
    try{[d,u]=await Promise.all([window.claude.use('db'),window.claude.use('user')]);}catch(e){}
    if(!d){backend='local';const l=readLocal();if(l){marks=l.marks;pins=l.pins;}setSync('local');renderAll();return;}
    db=d;backend='claude';
    if(u){try{if(await u.isOwner()===false)setReadOnly();}catch(e){}}
    let gm=false,gp=false;
    const tm=setTimeout(()=>{if(!(gm&&gp))setSync('slow');},10000);
    const done=()=>{if(gm&&gp){clearTimeout(tm);if(!ro&&syncEl.dataset.s!=='err')setSync('ok');}};
    db.collection('marks').onSnapshot(s=>{
      const raw={};for(const doc of s.docs)if(doc.exists)raw[doc.id]=doc.data();
      if(!ro)for(const k of Object.keys(W2CN))if(raw[k]&&!raw[W2CN[k]]){const m=cleanMark(raw[k]);if(m)qPut('marks',W2CN[k],m);qPut('marks',k,null);}
      marks=normMarks(raw);if(!s.metadata.fromCache){gm=true;done();}renderAll();
    },()=>{gm=true;done();setSync('err');});
    db.collection('pins').onSnapshot(s=>{
      const raw={};for(const doc of s.docs)if(doc.exists)raw[doc.id]=doc.data();
      pins=normPins(raw);if(!s.metadata.fromCache){gp=true;done();}renderAll();
    },()=>{gp=true;done();setSync('err');});
    return;
  }
  await Promise.all([loadMirror(),loadSite()]);
  renderSites();
  updGhBtn();
  const repo=ghGuess();
  if(repo){const ab=$('#about');ab.innerHTML=`这是一张旅行足迹地图，金色和小红旗是去过的地方，蓝色斜纹是想去的地方。网页代码在 <a href="https://github.com/${esc(repo)}">github.com/${esc(repo)}</a>，你也可以复制一份，做自己的足迹地图。`;ab.hidden=false;}
  const cfg=ghReadCfg();
  if(cfg){
    GH.cfg=cfg;backend='github';updGhBtn();
    const cached=readLocal();if(cached){marks=cached.marks;pins=cached.pins;renderAll();}
    setSync('gh-loading');
    try{const cur=await ghGet(cfg);GH.sha=cur.sha;marks=normMarks(cur.data&&cur.data.marks);pins=normPins(cur.data&&cur.data.pins);saveLocal();renderAll();setSync('gh-ok');}
    catch(e){setSync(e.status===401||e.status===403||e.status===404?'gh-auth':'gh-offline');}
    return;
  }
  // 之前在这个网址登录过：直接进入可编辑状态
  const sess=SITE.api?apiReadSess():null;let apiDown=false;
  if(sess){
    AP.sess=sess;AP.lastUser=sess.user;
    const cached=readLocal();if(cached){marks=cached.marks;pins=cached.pins;renderAll();}
    try{await enterApi();return;}
    catch(e){if(e.status===401)apiDropSess();else apiDown=true;}
  }
  // 没连 GitHub：如果仓库里已经发布了足迹，就以只读方式展示；否则在本机编辑
  let pub=null;
  const guess=ghGuess();
  // GitHub Pages 上直接读仓库（最新）；镜像站读自己同步下来的 footprints.json（国内更快，最多晚一分钟）
  if(guess&&!MIRROR){try{pub=(await ghGet({repo:guess,branch:'main'})).data;}catch(e){}}
  if(!pub){try{pub=await getJSON('footprints.json?t='+Date.now());}catch(e){}}
  const pm=normMarks(pub&&pub.marks),pp=normPins(pub&&pub.pins);
  if(Object.keys(pm).length||Object.keys(pp).length){
    backend='view';ro=true;document.body.classList.add('ro');marks=pm;pins=pp;setSync('gh-view');setMode('view');renderAll();
  }else{
    backend='local';const l=readLocal();if(l){marks=l.marks;pins=l.pins;}setSync('local');renderAll();
  }
  if(apiDown){AP.sess=null;setSync('api-down');}
  updLoginBtn();
}
(async function start(){
  envClaude=!!(window.claude&&typeof window.claude.use==='function');
  setSync('init');
  try{await loadBase();}catch(e){$('#loading').textContent='地图数据没有加载出来。如果是直接双击打开的本地文件，请改用 GitHub Pages 或本地服务器打开。';return;}
  $('#loading').hidden=true;
  window.addEventListener('hashchange',route);
  await route();
  const sizeObs=new ResizeObserver(()=>layout(false));sizeObs.observe(fig);
  initStorage();
})();
})();
