
/* Static constants: risk types, categories, levels, statuses, mock AI reasons, small lookups. */

const TYPES={
  tree:{t:'Leaning tree',c:'Environmental'},
  drain:{t:'Clogged drainage',c:'Flood'},
  road:{t:'Roadside crack',c:'Road Hazard'},
  pole:{t:'Damaged electrical pole',c:'Electrical'},
  flood:{t:'Flood-prone area',c:'Flood'},
  slope:{t:'Landslide-prone slope',c:'Environmental'},
  river:{t:'Eroded creek bank',c:'Flood'},
  wall:{t:'Cracked retaining wall',c:'Structural'},
  other:{t:'Other Hazard',c:'Other'}
};

const CATS=['Structural','Environmental','Flood','Electrical','Road Hazard','Other'];

const LV={hi:'High',mod:'Moderate',lo:'Low'};

const STS=['Pending','Verified','Under monitoring','Resolved'];

const BASE_LV={
  tree:'mod',
  drain:'mod',
  road:'lo',
  pole:'hi',
  flood:'hi',
  slope:'hi',
  river:'hi',
  wall:'mod',
  other:'mod'
};

const AI_REASON={
  tree:'The tree appears to lean noticeably toward a nearby house.',
  drain:'Debris visibly blocks the drainage opening, which may cause water to pool during heavy rain.',
  road:'Visible cracking along the road edge suggests deterioration on a frequently used route.',
  pole:'Visible damage on the pole and loose wiring near a walkway may be a safety hazard.',
  flood:'Water marks and low ground suggest the area could be inundated during sustained rain.',
  slope:'Surface cracks and exposed soil on a steep slope above homes may indicate instability.',
  river:'The bank shows visible erosion that may undermine nearby structures.',
  wall:'Cracking and bulging on the wall suggest its structure may be compromised.',
  other:'The submission describes another possible community hazard that requires administrator inspection.'
};

const UNKNOWN_TYPE={t:'Hazard report',c:'Other'};

const assessmentEvent=r=>{
  if(!r||!Array.isArray(r.log))return null;
  return r.log.find(e=>
    e&&typeof e.t==='string'&&
    (
      e.t.startsWith('AI-assisted assessment generated (Gemini)')||
      e.t.startsWith('Rule-based assessment generated')
    )
  )||null;
};

const assessmentHazardName=r=>{
  if(!r||r.type!=='other')return null;
  const e=assessmentEvent(r);
  if(!e||typeof e.t!=='string')return null;
  const match=e.t.match(/^(?:AI-assisted assessment generated \(Gemini\)|Rule-based assessment generated):\s*(.+)$/);
  const name=match&&match[1]?match[1].trim():null;
  return name&&name.length>=3&&name.length<=60?name:null;
};

const assessmentLabel=r=>{
  const e=assessmentEvent(r);
  if(e){
    if(e.t.startsWith('AI-assisted assessment generated (Gemini)'))return 'Gemini-assisted assessment';
    if(e.t.startsWith('Rule-based assessment generated'))return 'Text-only fallback assessment';
  }
  if(r&&r.assessment&&r.assessment.source==='demo')return 'Demo assessment';
  return 'Preliminary assessment';
};

const cat=r=>(TYPES[r.type]||UNKNOWN_TYPE).c;
const title=r=>assessmentHazardName(r)||((TYPES[r.type]||UNKNOWN_TYPE).t);
const si=r=>Math.max(0,STS.indexOf(r.st));
const plottable=r=>Number.isFinite(r.x)&&Number.isFinite(r.y);
const aiReason=r=>{
  const e=assessmentEvent(r);
  if(e&&typeof e.n==='string'&&e.n.trim())return e.n.trim();
  return AI_REASON[r.type]||'No suggestion is available for this report.';
};