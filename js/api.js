/* DEMO DATA LAYER: the one file to replace with real backend / AI / auth calls. */

/* =========================================================
   2. DEMO DATA LAYER  ->  REPLACE WITH BACKEND LATER
   ---------------------------------------------------------
   Everything the UI needs from a server goes through the
   `API` object below. Each method is async on purpose, so a
   groupmate can swap its body for a fetch() call without
   touching any page/UI code.

   DEMO behavior right now:
   - Data lives in the SEED array + this browser's localStorage.
   - analyzeReport() is a MOCK. It does NOT look at the photo.
   - signIn() accepts any non-empty email/password.

   SERVER MODE (Phase 2): when API.mode is 'server' (decided by API.init(), see js/config.js), listReports,
   listMyReports, submitReport and syncReport use the real server through js/api-server.js. Everything else
   stays as described above. DEMO mode (the default when no server answers) behaves exactly as before.

   TODO(backend)  listReports / submitReport / updateReport
   TODO(ai)       analyzeReport  (real model / API call)
   TODO(auth)     signIn / signOut  (real session or JWT)
   ========================================================= */
const DEMO_KEY='readylink-demo-v1';
const MINE=['RL-027','RL-031','RL-033'];                       // DEMO: which seed reports "belong" to the signed-in resident
const SEED=()=>rd.map(([id,type,x,y,lv,si,date,desc])=>{        // DEMO: sample reports (see `rd` above)
  const log=[{t:'Report submitted',d:date},{t:'AI-assisted assessment generated',d:date}];
  if(si>=1)log.push({t:'Verified by barangay admin',d:'Sep 28'});
  if(si>=2)log.push({t:'Placed under monitoring',d:'Sep 29'});
  if(si>=3)log.push({t:'Marked as resolved',d:'Oct 1'});
  return{id,type,x,y,ai:lv,lv,st:STS[si],date,desc,brgy:brgyAt(x,y),mine:MINE.includes(id),log}});
const R=[];                                                     // UI reads reports from here. Filled by loadReports().
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const todayStr=()=>new Date().toLocaleString('en-US',{month:'short',day:'numeric'});
const stampStr=()=>new Date().toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
let _db=null;                                                   // DEMO: in-memory copy of the "database"
const dbLoad=()=>{if(_db)return _db;try{const j=localStorage.getItem(DEMO_KEY);if(j)_db=JSON.parse(j)}catch(e){}return _db||(_db=SEED())};
/* Saves to localStorage. If the browser quota is hit, older photos are dropped from STORAGE only
   (the in-memory copy, and so the current session, keeps every photo). Returns true when everything was stored. */
const persist=(key,list)=>{const withImg=list.filter(r=>r.img);
  for(let n=withImg.length;n>=0;n--){const keep=new Set(withImg.slice(0,n));
    try{localStorage.setItem(key,JSON.stringify(list.map(r=>r.img&&!keep.has(r)?{...r,img:null}:r)));return n===withImg.length}catch(e){}}
  return false};
const dbSave=()=>persist(DEMO_KEY,_db);

/* DEMO DEVICE QUEUE (offline-first UI).
   Stands in for reports that were made while offline and have not reached the "server" yet.
   Stored in localStorage under its own key so it stays separate from the demo server store.
   TODO(offline): replace with IndexedDB + a real sync worker. */
const QUEUE_KEY='readylink-demo-queue-v1';
const MY=[];                                                    // server mode: reports sent from this browser (GET /api/reports?mine=1). Filled by loadMine().
const Q=[];                                                     // UI reads queued reports from here. Filled by loadQueue().
const PRIORITY=[];                                              // UI reads the priority list from here. Filled by loadInsights().
let _q=null;
const qLoad=()=>{if(_q)return _q;try{const j=localStorage.getItem(QUEUE_KEY);if(j)_q=JSON.parse(j)}catch(e){}_q=_q||[];_q.forEach(r=>{if(r.sync==='syncing')r.sync='pending'});return _q};  // an interrupted sync goes back to pending
const qSave=()=>persist(QUEUE_KEY,_q);

const API={
  /** 'demo' = the code in this file (localStorage). 'server' = js/api-server.js. Set once by init(). */
  mode:'demo',
  /** From /api/health (auto mode only): true / false = admin changes are allowed / turned off on the server, null = unknown. */
  adminWrites:null,
  /** Server mode: { configured, authenticated, name, writes } from GET /api/admin/session. */
  adminInfo:null,
  /** Place search on the server (from /api/health). Unknown until asked, so the Search button works and the server answers if it is off. */
  geocoder:{enabled:true,typeahead:false},

  /** Decides the mode from window.READYLINK_CONFIG.API_MODE ('auto' asks GET /api/health). Call once before loading data. */
  async init(){
    const want=(window.READYLINK_CONFIG&&window.READYLINK_CONFIG.API_MODE)||'auto';
    if(want==='server')API.mode='server';
    else if(want==='auto'){API.mode=(await ServerAPI.probe())?'server':'demo';const h=ServerAPI.health();if(h&&h.admin)API.adminWrites=Boolean(h.admin.writes);if(h&&h.geocoder)API.geocoder={enabled:Boolean(h.geocoder.enabled),typeahead:Boolean(h.geocoder.typeahead)}}
    else API.mode='demo';
    return API.mode},

  /** GET /reports  -> Report[]   (server mode: GET /api/reports) */
  async listReports(){
    if(API.mode==='server')return ServerAPI.listReports();
    return dbLoad().map(r=>({...r,log:[...r.log]}))},

  /** Place search for the report form: GET /api/geocode/search through the READYLINK server (needs the server and internet).
   *  Returns [{ label, lat, lng, inArea }]. An empty list means no match. */
  async searchPlaces(q){
    if(API.mode!=='server'){const err=new Error('place search needs the server');err.userMessage='Place search needs the READYLINK server.';throw err}
    return ServerAPI.searchPlaces(q)},
  /** A readable name for a position (used for the photo's location). Returns { label|null, lat, lng, inArea }. */
  async reversePlace(lat,lng){
    if(API.mode!=='server')return{label:null,lat,lng,inArea:false};
    return ServerAPI.reversePlace(lat,lng)},

  /** Only the reports sent from this browser. Server mode: GET /api/reports?mine=1 with the same X-Client-Id.
   *  Demo mode: the sample reports marked as mine plus the ones made here. */
  async listMyReports(){
    if(API.mode==='server')return ServerAPI.listMyReports();
    return (await API.listReports()).filter(r=>r.mine)},

  /** POST /reports/analyze  -> {t,c,lv,reason}   (TODO(ai))
   *  MOCK ONLY: picks a result from the sample photo type or from keywords in the note.
   *  It never inspects the uploaded image. */

async analyzeReport(draft){
  if(API.mode==='server'){
    return ServerAPI.analyzeReport(draft);
  }

  await wait(1600);

  const t=draft.type||guessType(draft.desc);
  let lv=BASE_LV[t],note='';

  if(/house|school|bahay|bata|children|residential|homes/i.test(draft.desc)){
    if(lv==='lo')lv='mod';
    else if(lv==='mod')lv='hi';
    note=' The note mentions people nearby, so the demo raises the priority.';
  }

  return {
    outcome:'hazard_detected',
    type:t,
    level:lv,
    hazardName:t==='other'?'Other reported hazard':null,
    reason:AI_REASON[t]+note,
    demo:true,
    source:'demo'
  };
},

  /** POST /reports  -> Report   (TODO(backend): upload draft.img to storage, save row)
   *  opts.offline = true puts the report in the DEMO device queue instead of the demo "server" store. */
  async submitReport(draft,analysis,opts={}){
  const valid=!!(
    analysis &&
    analysis.outcome==='hazard_detected' &&
    ['tree','drain','road','pole','flood','slope','river','wall','other'].includes(analysis.type) &&
    ['lo','mod','hi'].includes(analysis.level) &&
    (
      analysis.type==='other'
        ? typeof analysis.hazardName==='string' &&
          analysis.hazardName.trim().length>=3 &&
          analysis.hazardName.trim().length<=60
        : analysis.hazardName===null
    ) &&
    typeof analysis.reason==='string' &&
    ['gemini','fallback','demo'].includes(analysis.source)
  );

  if(!valid){
    const err=new Error('invalid assessment');
    err.userMessage='Only a valid preliminary hazard assessment can be submitted.';
    throw err;
  }

  if(API.mode==='server'&&!opts.offline){
    return ServerAPI.submitReport(draft,analysis);
  }

  await wait(500);

  const assessment={
    outcome:analysis.outcome,
    type:analysis.type,
    level:analysis.level,
    hazardName:analysis.hazardName,
    reason:analysis.reason,
    source:analysis.source,
    demo:Boolean(analysis.demo)
  };

  const base={
    type:analysis.type,
    x:draft.x,
    y:draft.y,
    lat:typeof draft.lat==='number'?draft.lat:null,
    lng:typeof draft.lng==='number'?draft.lng:null,
    assessment,
    ai:analysis.level,
    lv:analysis.level,
    st:'Pending',
    date:todayStr(),
    desc:(draft.desc||'').trim()||'No description provided.',
    brgy:brgyAt(draft.x,draft.y),
    mine:true,
    img:draft.img||null
  };

  if(opts.offline){
    const q=qLoad(),n=Math.max(0,...q.map(r=>parseInt(r.id.slice(6),10)))+1;
    const r={
      ...base,
      id:'LOCAL-'+String(n).padStart(3,'0'),
      sync:'local',
      log:[{t:'Saved on this device',d:stampStr()}]
    };
    q.unshift(r);
    if(!qSave())API.lastWarning='Your photo is shown now, but this browser is too full to keep it after a refresh.';
    return{...r};
  }

  const db=dbLoad();
  const n=Math.max(0,...db.map(r=>parseInt(r.id.slice(3),10)))+1;
  const id='RL-'+String(n).padStart(3,'0');

  const r={
    ...base,
    id,
    log:[
      {t:'Report submitted',d:stampStr()},
      {t:'Preliminary AI-assisted assessment generated',d:stampStr()}
    ]
  };

  db.unshift(r);
  if(!dbSave())API.lastWarning='Your photo is shown now, but this browser is too full to keep it after a refresh.';
  return{...r};
},

  /** PATCH /reports/:id  {status?, level?, remark?}  -> Report   (TODO(backend), admin only) */
  async updateReport(id,patch){
    if(API.mode==='server')return ServerAPI.updateReport(id,patch); // PATCH /api/reports/:id (no admin login yet)
    await wait(200);const r=dbLoad().find(x=>x.id===id);if(!r)throw new Error('not found');const d=stampStr(),n=patch.remark||undefined;
    if(patch.status&&patch.status!==r.st){const a=STS.indexOf(r.st),b=STS.indexOf(patch.status);
      r.st=patch.status;r.log.push({t:b===a+1?['','Verified by barangay admin','Placed under monitoring','Marked as resolved'][b]:'Status changed to '+patch.status,d,n})}
    else if(patch.remark)r.log.push({t:'Admin remark added',d,n});
    if(patch.level&&patch.level!==r.lv){r.lv=patch.level;r.log.push({t:'Risk level set to '+LV[patch.level]+' by admin',d})}
    dbSave();return{...r}},

  /** DEMO device queue: reports saved on this device that are not submitted yet. TODO(offline) */
  async listPending(){return qLoad().map(r=>({...r,log:[...r.log]}))},
  /** DEMO: keeps queued reports in step with the connection (local <-> pending). */
  async setConnectivity(online){const q=qLoad();let ch=false;
    q.forEach(r=>{if(online&&r.sync==='local'){r.sync='pending';r.log.push({t:'Back online. Waiting to sync (demo)',d:stampStr()});ch=true}
                  else if(!online&&r.sync==='pending'){r.sync='local';ch=true}});
    if(ch)qSave()},
  async setQueueState(id,state){const r=qLoad().find(x=>x.id===id);if(r){r.sync=state;qSave()}},
  /** DEMO ONLY: moves a queued report into the demo store. No server is contacted.
   *  TODO(offline/backend): POST the queued report (and its photo), return the saved Report. */
  async syncReport(id){
  const q=qLoad(),i=q.findIndex(x=>x.id===id);
  if(i<0)throw new Error('not in queue');

  const r=q[i],a=r.assessment;

  const valid=!!(
    a &&
    a.outcome==='hazard_detected' &&
    ['tree','drain','road','pole','flood','slope','river','wall','other'].includes(a.type) &&
    ['lo','mod','hi'].includes(a.level) &&
    typeof a.reason==='string' &&
    a.reason.trim().length>0 &&
    (
      a.type==='other'
        ? typeof a.hazardName==='string' &&
          a.hazardName.trim().length>=3 &&
          a.hazardName.trim().length<=60
        : a.hazardName===null
    ) &&
    ['gemini','fallback','demo'].includes(a.source)
  );

  if(!valid){
    const err=new Error('queued assessment needs review');
    err.userMessage='This saved report has no valid preliminary assessment. Please create a new report and assessment before sending.';
    throw err;
  }

  if(API.mode==='server'){
    if(!['gemini','fallback'].includes(a.source)){
      const err=new Error('demo assessment cannot be sent to server');
      err.userMessage='This report has a demo assessment and cannot be synced to the server. Please create a new report using the server assessment.';
      throw err;
    }

    const saved=await ServerAPI.submitReport(
      {x:r.x,y:r.y,lat:r.lat,lng:r.lng,desc:r.desc,img:r.img},
      a
    );

    q.splice(i,1);
    qSave();
    return saved;
  }

  await wait(1800);

  const db=dbLoad();
  const n=Math.max(0,...db.map(x=>parseInt(x.id.slice(3),10)))+1;
  const nid='RL-'+String(n).padStart(3,'0');

  const nr={
    ...r,
    id:nid,
    sync:'submitted',
    log:[
      ...(r.log||[]),
      {t:'Synced to the demo store (no server yet)',d:stampStr()},
      {t:'Preliminary assessment retained (demo)',d:stampStr()}
    ]
  };

  db.unshift(nr);
  dbSave();
  q.splice(i,1);
  qSave();

  return{...nr};
},

  /** GET /ai/priority-queue  -> [{id, level, reason}]   (TODO(ai))
   *  DEMO: returns the hand-written sample list from js/demo-insights.js. It is NOT an AI result. */
  async getPriorityQueue(){return DEMO_PRIORITY.map(x=>({...x,demo:true}))},

  /** POST /auth/login   (TODO(auth)) DEMO: any non-empty details are accepted */
  /** Server mode: POST /api/admin/login (the password is checked on the server; the session is an HttpOnly cookie).
   *  Demo mode (a static copy with no server): simulated. Any non-empty details work and nothing is protected. */
  async signIn(email,password){
    if(API.mode==='server'){
      try{const r=await ServerAPI.adminLogin(email,password);
        if(r.ok){API.adminInfo={configured:true,authenticated:true,name:r.name,writes:r.writes};API.adminWrites=r.writes;return{ok:true,user:{name:r.name}}}
        return{ok:false,message:r.message,clearPassword:true}}
      catch(e){return{ok:false,message:(e&&e.userMessage)||'Could not sign in. Please try again.'}}}
  await wait(350);if(!(email&&password))return{ok:false};try{sessionStorage.setItem('readylink-demo-admin','1')}catch(e){}return{ok:true,user:{name:'LGU Admin'}}},
  /** POST /auth/logout  (TODO(auth)) */
  async signOut(){try{sessionStorage.removeItem('readylink-demo-admin')}catch(e){}
    if(API.mode==='server'){API.adminInfo=API.adminInfo?{...API.adminInfo,authenticated:false}:null;
      try{await ServerAPI.adminLogout()}catch(e){return{ok:false,message:'You were signed out here, but the server could not be reached to end the session. It will end by itself.'}}}
    return{ok:true}},
  /** Is the browser still signed in? Server mode asks the server (the cookie is HttpOnly, so this page cannot tell by itself). */
  async refreshAdminSession(){
    if(API.mode!=='server')return API.hasSession();
    try{const s=await ServerAPI.adminSession();API.adminInfo=s;API.adminWrites=s.writes;return s.authenticated}
    catch(e){return false}},
  /** DEMO: remembers the fake sign-in for this tab only. TODO(auth): read the real session/token instead. */
  hasSession(){try{return sessionStorage.getItem('readylink-demo-admin')==='1'}catch(e){return false}},

  /** DEMO ONLY: restore the sample data. Delete when a real DB exists. */
  async resetDemo(){if(API.mode==='server'){_q=[];qSave();return}  // never touches server data
    _db=SEED();dbSave();_q=[];qSave()}
};
async function loadReports(){R.splice(0,R.length,...await API.listReports())}
async function loadQueue(){Q.splice(0,Q.length,...await API.listPending())}
async function loadInsights(){PRIORITY.splice(0,PRIORITY.length,...await API.getPriorityQueue())}
async function loadMine(){MY.splice(0,MY.length,...await API.listMyReports())}
