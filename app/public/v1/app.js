// my-os v1 UI. Ported from the design prototype (design/prototypes/app.html): same views, gestures and markup, with
// sample data replaced by /api/v1/state. Local edits are made on plain objects (as in the prototype) and a sync pass
// diffs them against the last server state and sends small PATCH/POST requests (model.js: wire / diffPatch).
import {
  dnum, diso, dow, fmtD, dom, monthOf, yearOf, firstOfMonth, zoned, fmtT, fmtDur,
  occurs, repeatText, repeatFromRule, ordinal, fromServer, claudeFromServer, wire, diffPatch, createBody, buildEvents, parseWhen, parseBrief,
} from './model.js?v=3';

const VERSION = 'v1-p3';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const I = {
  inbox:'<svg viewBox="0 0 24 24"><path d="M3.5 13.5 6 5.5a1.5 1.5 0 0 1 1.4-1h9.2a1.5 1.5 0 0 1 1.4 1l2.5 8V18a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18z" fill="var(--inbox)"/><path d="M3.8 13.5H8.5a3.5 3.5 0 0 0 7 0h4.7" fill="none" stroke="var(--bg-elev)" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  star:'<svg viewBox="0 0 24 24"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z" fill="var(--today)" stroke="var(--today)" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  moon:'<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="var(--evening)"/></svg>',
  upcoming:'<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="3" fill="var(--upcoming)"/><path d="M3.5 10h17" stroke="var(--bg-elev)" stroke-width="1.6"/><path d="M8 3v4M16 3v4" stroke="var(--upcoming)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  anytime:'<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="5" rx="1.5" fill="var(--anytime)"/><rect x="4" y="10.5" width="16" height="4" rx="1.5" fill="var(--anytime)" opacity=".75"/><rect x="4" y="16" width="16" height="4" rx="1.5" fill="var(--anytime)" opacity=".5"/></svg>',
  someday:'<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="5" rx="1.5" fill="var(--someday)"/><path d="M5 9.5h14V18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" fill="var(--someday)" opacity=".75"/><path d="M10 13h4" stroke="var(--bg-elev)" stroke-width="1.6" stroke-linecap="round"/></svg>',
  logbook:'<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="3" fill="var(--logbook)"/><path d="M8.3 12.2l2.6 2.6 4.9-5.3" stroke="var(--bg-elev)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trash:'<svg viewBox="0 0 24 24"><path d="M5 7h14l-1.2 12.2A2 2 0 0 1 15.8 21H8.2a2 2 0 0 1-2-1.8z" fill="var(--trash)"/><rect x="3.5" y="4" width="17" height="3" rx="1.2" fill="var(--trash)"/><path d="M10 11v6M14 11v6" stroke="var(--bg-elev)" stroke-width="1.6" stroke-linecap="round"/></svg>',
  brief:'<svg viewBox="0 0 24 24"><rect x="5" y="3.5" width="14" height="17" rx="2.5" fill="var(--claude)"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.5" stroke="var(--bg-elev)" stroke-width="1.6" stroke-linecap="round"/></svg>',
  claude:'<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" stroke="var(--claude)" stroke-width="2.2" stroke-linecap="round"/></svg>',
  gear:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="var(--fg-2)" stroke-width="1.8"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5" stroke="var(--fg-2)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  area:'<svg viewBox="0 0 24 24"><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z M4 7.5 12 12l8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  search:'<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15 15 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  cal:'<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  flag:'<svg viewBox="0 0 24 24"><path d="M6 21V4m0 0h10.5l-2 4 2 4H6" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  flagLine:'<svg viewBox="0 0 24 24"><path d="M6 21V4m0 0h10.5l-2 4 2 4H6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  tag:'<svg viewBox="0 0 24 24"><path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.2 8.2-8.8 8.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/></svg>',
  list:'<svg viewBox="0 0 24 24"><path d="M9 7h11M9 12h11M9 17h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="4.5" cy="7" r="1.3" fill="currentColor"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor"/><circle cx="4.5" cy="17" r="1.3" fill="currentColor"/></svg>',
  deadline:'<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 9v4l2.5 2M9 3h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  dots:'<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/></svg>',
  bell:'<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  repeat:'<svg viewBox="0 0 24 24" style="width:13px;height:13px;color:var(--fg-3)"><path d="M4 11V9a3 3 0 0 1 3-3h11m0 0-3-3m3 3-3 3M20 13v2a3 3 0 0 1-3 3H6m0 0 3 3m-3-3 3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play:'<svg viewBox="0 0 14 14"><path d="M3.5 2.2v9.6L11.5 7z" fill="currentColor"/></svg>',
  pause:'<svg viewBox="0 0 14 14"><rect x="3" y="2.5" width="3" height="9" rx="1" fill="currentColor"/><rect x="8" y="2.5" width="3" height="9" rx="1" fill="currentColor"/></svg>',
  check:'<svg viewBox="0 0 14 14"><path d="M2.8 7.4l2.7 2.7 5.7-6"/></svg>',
  x:'<svg viewBox="0 0 14 14"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>',
  chev:'<svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  select:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 12.2l2.4 2.4 4.6-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  back:'<svg width="12" height="20" viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const sized = (svg, px, extra='') => svg.replace('<svg', `<svg style="width:${px}px;height:${px}px;${extra}"`);
function pie(frac, s=18){
  const c=s/2, r=c-1.2, R=r-2.4; let w='';
  if (frac >= 1) w = `<circle cx="${c}" cy="${c}" r="${R}" fill="var(--pie)"/>`;
  else if (frac > 0) { const a=frac*2*Math.PI, x=c+R*Math.sin(a), y=c-R*Math.cos(a); w = `<path d="M${c} ${c}L${c} ${c-R}A${R} ${R} 0 ${frac>.5?1:0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z" fill="var(--pie)"/>`; }
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--pie)" stroke-width="1.5"/>${w}</svg>`;
}

/* ---------- local preferences (per device) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('myos.v1.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('myos.v1.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
const DEFAULT_SET = {checkins:{every_minutes:60, start:'07:00', end:'22:00'}, freeLines:true, workFold:true, suggestions:true, cals:{family:true, personal:true, work:true}, workStart:480, workEnd:1065, showPlace:false};

/* ---------- state ---------- */
const S = {
  loaded:false, tz:'America/Los_Angeles', day:0, min:0,
  todos:[], claude:[], projects:[], areas:[], completions:[], events:{}, brief:null, theme:null, health:[], timer:null, time:{},
  route: 'today', open:null, select:false, sel:new Set(), showLogged:{}, showClaudeDone:false,
  undo:null, nid:1, tagF:null, evOpen:false, showWork:false,
  seen: store.get('seen', {}), briefSeen: store.get('briefSeen', null), feedbackSent: 0,
  set: Object.assign({}, DEFAULT_SET, store.get('settings', {})),
};
S.set.cals = Object.assign({}, DEFAULT_SET.cals, S.set.cals);
// Settings are shared across devices (server); the local copy only paints the first screen before /state arrives
const SET_MAP = {workStart:'work_start', workEnd:'work_end', freeLines:'free_lines', workFold:'work_fold', showPlace:'show_place', suggestions:'suggestions', cals:'cals', checkins:'checkins'};
let setTimer = null;
function saveSet(){
  store.set('settings', S.set);
  clearTimeout(setTimer);
  setTimer = setTimeout(() => {
    const body = {}; for (const [k, sk] of Object.entries(SET_MAP)) body[sk] = S.set[k];
    api('PUT', '/api/v1/settings', body).catch(e => toast('Couldn’t save settings: ' + e.message));
  }, 400);
}
function applySettings(srv){ if (!srv) return; for (const [k, sk] of Object.entries(SET_MAP)) if (srv[sk] !== undefined) S.set[k] = sk === 'cals' ? {...DEFAULT_SET.cals, ...srv[sk]} : srv[sk]; store.set('settings', S.set); }

/* ---------- dates ---------- */
const isWeekend = d => [0,6].includes(dow(d));
const dayLabel = d => { const k = d - S.day; if (k===0) return 'Today'; if (k===1) return 'Tomorrow'; if (k===-1) return 'Yesterday'; if (k>1 && k<7) return fmtD(d,{weekday:'long'}); return fmtD(d,{month:'short',day:'numeric'}) + (yearOf(d)!==yearOf(S.day)?', '+yearOf(d):''); };
const dlText = d => { const k = d - S.day; return k<0 ? `${-k} day${k<-1?'s':''} overdue` : k===0 ? 'Due today' : `${k} day${k>1?'s':''} left`; };
function tick(){ const z = zoned(Date.now(), S.tz); const dayChanged = S.loaded && z.day !== S.day; S.min = z.min; if (dayChanged) { S.day = z.day; load(); } }

/* ---------- model helpers ---------- */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const byId = id => S.todos.find(t => t.id === id);
const proj = id => S.projects.find(p => p.id === id);
const area = id => S.areas.find(a => a.id === id);
const live = t => !t.logged && !t.trashed && t.sugg === undefined && !t.done && !t._complete;
const inToday = t => !t.logged && !t.trashed && t.sugg === undefined && !t._complete && ((t.start==='date' && t.date<=S.day) || (t.deadline!==undefined && t.deadline<=S.day && t.start!=='someday'));
const dueNow = t => t.deadline!==undefined && t.deadline<=S.day;
const areaOf = t => t.project ? proj(t.project)?.area : t.area;
const isWork = t => areaOf(t) === 'a-work';
const progress = pid => { const all = S.todos.filter(t => t.project===pid && !t.trashed); return all.length ? all.filter(t=>t.logged||t.done).length / all.length : 0; };
const placeOf = t => t.project ? (proj(t.project)?.title || 'Project') : t.area ? (area(t.area)?.title || 'Area') : 'Inbox';
// Sidebar layout only on big screens: a phone turned sideways keeps the phone layout (as in Things)
const wide = () => innerWidth > 820 && innerHeight >= 600;
const isEvening = () => S.min >= S.set.workEnd;
const isWorkday = d => !isWeekend(d);
const openProjects = () => S.projects.filter(p => !p.done);
const byKey = key => (a, b) => (a[key] ?? Infinity) - (b[key] ?? Infinity);

/* ---------- Brief ---------- */
const evToday = d => (S.events[d]||[]).filter(e => S.set.cals[e[3]] !== false);
function briefOf(){
  if (!S.brief) return {title:'Brief', from:'', blocks:[{k:'p', text:'No brief yet. Claude posts one each morning.'}]};
  const b = parseBrief(S.brief.body_md), z = zoned(S.brief.created_at, S.tz);
  return {title: b.title || 'Brief', from: (z.day===S.day ? '' : dayLabel(z.day)+' ') + fmtT(z.min), blocks: b.blocks};
}
const briefKey = () => S.brief ? S.brief.created_at : null;
const briefUnseen = () => !!S.brief && S.briefSeen !== briefKey();
function briefViewHTML(){
  const b = briefOf(), th = S.theme;
  const week = th && (th.through_line || th.work_title || th.personal_title) ? `<div class="brief-week"><span class="lbl">This week</span>${th.through_line?`<span class="line">${esc(th.through_line)}</span>`:''}${th.work_title?`<span class="th">Work: ${esc(th.work_title)}</span>`:''}${th.personal_title?`<span class="th">Personal: ${esc(th.personal_title)}</span>`:''}</div>` : '';
  let body = '', inList = false;
  for (const x of b.blocks) {
    if (x.k === 'li' && !inList) { body += '<ul>'; inList = true; }
    if (x.k !== 'li' && inList) { body += '</ul>'; inList = false; }
    body += x.k === 'h' ? `<h3>${esc(x.text)}</h3>` : x.k === 'li' ? `<li>${esc(x.text)}</li>` : `<p>${esc(x.text)}</p>`;
  }
  if (inList) body += '</ul>';
  return week + `<div class="brief"><span class="brief-title">${esc(b.title)}</span>${body}</div>`;
}

/* ---------- Today events ---------- */
function eventsHTML(){
  const now = S.min, evs = evToday(S.day), allDay = evs.filter(e => e[0]===null), timed = evs.filter(e => e[0]!==null).sort((a,b)=>a[0]-b[0]);
  const past = timed.filter(e => e[1] <= now), rest = timed.filter(e => e[1] > now);
  const row = (e, cls, note) => `<div class="ev ${cls} ${e[4]?'ev-busy':''}"><span class="ev-time"><span>${e[0]===null?'All day':fmtT(e[0])}</span></span><span class="ev-dot" style="--c:var(--cal-${e[3]})"></span><span class="ev-title">${esc(e[2])}</span>${note?`<span class="ev-note">${note}</span>`:''}</div>`;
  if (!evs.length) return '';
  let h = allDay.map(e => row(e,'')).join('');
  if (past.length) { h += `<button class="ev-fold" id="ev-fold" aria-expanded="${S.evOpen}">${I.chev}${past.length} earlier event${past.length>1?'s':''}</button>`; if (S.evOpen) h += past.map(e => row(e,'ev-past')).join(''); }
  let end = 0;
  rest.forEach((e,i) => {
    const isNow = e[0] <= now, soon = !isNow && e[0]-now <= 30;
    h += row(e, isNow?'ev-now':'', isNow ? 'Now' : soon ? `in ${e[0]-now} min` : '');
    end = Math.max(end, e[1]); const n = rest[i+1];
    if (S.set.freeLines && n && isWorkday(S.day)) { const a = Math.max(end, S.set.workStart, now), z = Math.min(n[0], S.set.workEnd); if (z > a) h += `<div class="gap">${fmtDur(z-a)} free</div>`; }
  });
  return `<div class="events">${h}<div class="events-end"></div></div>`;
}

/* ---------- list chooser ---------- */
function navHTML(){
  const inbox = S.todos.filter(t => t.start==='inbox' && live(t)).length, sug = S.set.suggestions && S.todos.some(t => t.sugg !== undefined && !t.trashed);
  const today = S.todos.filter(t => inToday(t) && !t.done), red = today.filter(dueNow).length;
  const claude = S.claude.filter(c => !c.done).length;
  const item = (r, icon, label, cnt='', cls='') => `<button class="nav-i ${cls} ${S.route===r?'on':''}" data-r="${r}" data-drop="${r}">${icon}<span class="lbl">${esc(label)}</span><span class="cnt">${cnt}</span></button>`;
  let h = `<button class="find" id="find">${I.search}Quick Find</button>
    <div class="nav">${item('inbox', I.inbox, 'Inbox', (inbox||'') + (sug?' <span class="dot" aria-label="Suggestions waiting">●</span>':''))}</div>
    <div class="nav">${item('today', I.star, 'Today', (red?`<span class="red">${red}</span>`:'') + (today.length-red||''))}${item('brief', I.brief, 'Brief', briefUnseen()?'<span class="dot" aria-label="Updated">●</span>':'')}${item('upcoming', I.upcoming, 'Upcoming')}${item('anytime', I.anytime, 'Anytime')}${item('someday', I.someday, 'Someday')}</div>
    <div class="nav">${item('logbook', I.logbook, 'Logbook')}${item('trash', I.trash, 'Trash')}</div>
    <div class="nav">${item('claude', I.claude, 'Claude', claude||'')}</div>`;
  openProjects().filter(p => !p.area).forEach(p => h += item('project:'+p.id, pie(progress(p.id)), p.title||'New Project'));
  S.areas.forEach(a => {
    h += item('area:'+a.id, I.area, a.title||'New Area', '', 'area');
    openProjects().filter(p => p.area===a.id).forEach(p => h += item('project:'+p.id, pie(progress(p.id)), p.title||'New Project'));
  });
  h += `<div class="nav-foot">${item('settings', I.gear, 'Settings')}</div>`;
  return h;
}
function bindNav(root){
  root.querySelectorAll('[data-r]').forEach(b => b.onclick = () => go(b.dataset.r));
  const f = root.querySelector('#find'); if (f) f.onclick = () => openFind('');
}

/* ---------- views ---------- */
const titleHTML = (icon, text, editable) => `<h1 class="list-title">${icon}<span class="t" ${editable?'contenteditable="true" spellcheck="false" id="title-edit"':''}>${esc(text)}</span></h1>`;
function tagBar(list){ const tags = [...new Set(list.flatMap(t => t.tags||[]))]; if (!tags.length) return ''; return `<div class="tagbar">${['All',...tags].map(x => `<button class="tchip ${(S.tagF||'All')===x?'on':''}" data-tf="${esc(x)}">${esc(x)}</button>`).join('')}</div>`; }
const tf = list => S.tagF ? list.filter(t => (t.tags||[]).includes(S.tagF)) : list;
// Area filter chips (Today, Upcoming, Anytime, Someday): All + each area with something in the view, single-select, tasks
// only. Remembered per view on this device until local midnight; to-dos with no area show only under All.
const areaF = () => { const v = store.get('areaF', null); return v && v.day === S.day && v.f && v.f[S.route] && area(v.f[S.route]) ? v.f[S.route] : null; };
const setAreaF = id => { const v = store.get('areaF', null), f = v && v.day === S.day && v.f ? v.f : {}; if (id) f[S.route] = id; else delete f[S.route]; store.set('areaF', {day: S.day, f}); };
const af = list => { const a = areaF(); return a ? list.filter(t => areaOf(t) === a) : list; };
function areaBar(list){
  const sel = areaF(), has = new Set(list.map(areaOf).filter(Boolean)), as = S.areas.filter(a => has.has(a.id) || a.id === sel);
  if (!as.length) return '';
  return `<div class="tagbar areabar" role="group" aria-label="Filter by area">${[{id:'', title:'All'}, ...as].map(a => `<button class="tchip ${(sel||'')===a.id?'on':''}" data-af="${esc(a.id)}" aria-pressed="${(sel||'')===a.id}">${esc(a.title)}</button>`).join('')}</div>`;
}
const ul = (list, o) => `<ul class="todos">${list.map(t => rowHTML(t,o)).join('')}</ul>`;
const todayItems = () => S.todos.filter(t => inToday(t) && !t.logged).sort(byKey('ti'));
const inboxItems = () => S.todos.filter(t => t.start==='inbox' && t.sugg === undefined && !t.logged && !t.trashed && !t._complete).sort(byKey('si'));

function viewHTML(){
  const r = S.route;
  if (!S.loaded) return `<div class="loading">${S.loadError ? 'Can’t reach my-os. Retrying…' : 'Loading…'}</div>`;
  if (r === 'home') return navHTML();
  const back = `<div class="appbar"><button class="back" id="back">${I.back}&nbsp;Lists</button>${['today','inbox','anytime','someday','upcoming'].includes(r)||r.startsWith('area:')||r.startsWith('project:')?`<button class="more" id="more" aria-label="Select to-dos">•••</button>`:'<span></span>'}</div>`;
  if (r === 'today') {
    let items = todayItems();
    const all = items; items = tf(af(items));
    let day = items.filter(t => !t.evening), eve = items.filter(t => t.evening), folded = [];
    if (S.set.workFold && isEvening() && !isWeekend(S.day)) { folded = day.filter(t => isWork(t) && !t.flag && !dueNow(t) && !t.done); day = day.filter(t => !folded.includes(t)); }
    return back + titleHTML(I.star,'Today') + areaBar(all) + eventsHTML() + tagBar(all) + ul(day,{today:true}) +
      (folded.length ? `<button class="work-fold" id="work-fold" aria-expanded="${S.showWork}">${I.chev}${S.showWork?'Hide':'Show'} work (${folded.length})</button>` + (S.showWork ? ul(folded,{today:true}) : '') : '') +
      (eve.length ? `<div class="sec-head" data-evening>${I.moon}This Evening</div>${ul(eve,{today:true})}` : '') +
      (!items.length ? `<div class="empty">${areaF() && all.length ? `Nothing in ${esc(area(areaF()).title)} today.` : 'Nothing planned. Enjoy the day.'}</div>` : '');
  }
  if (r === 'inbox') {
    const own = inboxItems(), sug = S.set.suggestions ? S.todos.filter(t => t.sugg !== undefined && !t.trashed) : [];
    return back + titleHTML(I.inbox,'Inbox') + tagBar(own) + ul(tf(own)) +
      (own.length ? '' : '<div class="empty">Nothing waiting. New to-dos without a date land here.</div>') +
      (sug.length ? `<div class="grp-head">${sized(I.claude,15)}Suggested by Claude</div><ul class="todos">${sug.map(suggHTML).join('')}</ul>` : '');
  }
  if (r === 'brief') {
    // freshness, in the data-health dot style: "Updated 5:30 AM" (or "Updated yesterday 4:12 PM"), green under 12 h, gray after
    let fresh = '';
    if (S.brief) { const z = zoned(S.brief.created_at, S.tz), hrs = (Date.now() - Date.parse(S.brief.created_at)) / 3600000;
      const when = (z.day === S.day ? '' : z.day === S.day - 1 ? 'yesterday ' : dayLabel(z.day) + ' ') + fmtT(z.min);
      fresh = `<span class="health ${hrs < 12 ? '' : 'stale'}" aria-hidden="true"></span><span class="${briefUnseen() ? 'upd' : ''}" id="brief-updated">Updated ${esc(when)}</span><span>· from Claude</span>`; }
    return back + titleHTML(I.brief,'Brief') + (S.brief ? `<div class="brief-meta">${fresh}</div>` : '') + briefViewHTML();
  }
  if (r === 'claude') {
    const lv = S.claude.filter(c => !c.done).sort((a,b)=>(a.date??Infinity)-(b.date??Infinity)), done = S.claude.filter(c => c.done);
    return back + titleHTML(I.claude,'Claude') + `<p class="list-sub">What Claude has said it will do for you. Change a date or drop anything you no longer need.</p>` +
      `<ul class="todos">${lv.map(claudeHTML).join('')}</ul>` + (lv.length?'':'<div class="empty">Claude has nothing pending.</div>') +
      (done.length ? `<button class="show-more" id="cl-done">${S.showClaudeDone?'Hide':'Show'} ${done.length} done by Claude</button>` + (S.showClaudeDone ? `<ul class="todos">${done.map(claudeHTML).join('')}</ul>` : '') : '');
  }
  if (r.startsWith('area:')) {
    const a = area(r.slice(5)); if (!a) return back + '<div class="empty">This area is gone.</div>';
    const ps = openProjects().filter(p => p.area===a.id), loose = S.todos.filter(t => t.area===a.id && !t.project && !t.logged && !t.trashed && t.sugg === undefined && t.start!=='inbox' && !t._complete).sort(byKey('si'));
    return back + titleHTML(`<span style="color:var(--area)">${I.area}</span>`, a.title, true) + `<ul class="todos">${ps.map(p=>prowHTML(p)).join('')}</ul>` +
      (ps.length && loose.length ? '<div style="height:14px"></div>' : '') + tagBar(loose) + ul(tf(loose),{marks:true}) +
      (!ps.length && !loose.length ? '<div class="empty">No projects or to-dos yet. Tap + to add one.</div>' : '');
  }
  if (r.startsWith('project:')) {
    const p = proj(r.slice(8)); if (!p) return back + '<div class="empty">This project is gone.</div>';
    const all = S.todos.filter(t => t.project===p.id && !t.trashed), lv = all.filter(t => !t.logged && !t._complete).sort(byKey('si')), logged = all.filter(t => t.logged);
    const hids = p.headings.map(h => h.id);
    let h = back + titleHTML(`<span id="big-pie">${pie(progress(p.id), 26)}</span>`, p.title, true) +
      `<p class="list-sub" contenteditable="true" spellcheck="false" id="proj-notes">${esc(p.notes||'')}</p>` +
      (p.deadline!==undefined ? `<div class="dl-line ${p.deadline<=S.day?'red':''}">${I.deadline}Deadline ${dayLabel(p.deadline)} · ${dlText(p.deadline)}</div>` : '');
    h += ul(lv.filter(t => !t.heading || !hids.includes(t.heading)),{marks:true});
    p.headings.forEach(hd => { const l = lv.filter(t => t.heading===hd.id); h += `<div class="heading"><span contenteditable="true" spellcheck="false" data-hid="${esc(hd.id)}">${esc(hd.title)}</span><span class="n">${l.length||''}</span></div>` + ul(l,{marks:true}); });
    if (logged.length) h += `<button class="show-more" id="show-logged">${S.showLogged[p.id]?'Hide':'Show'} ${logged.length} logged item${logged.length>1?'s':''}</button>` + (S.showLogged[p.id] ? ul(logged) : '');
    if (lv.length===0 && all.length) h += `<button class="btn primary" id="complete-proj" style="margin-top:12px">Complete project</button>`;
    if (!all.length) h += '<div class="empty">No to-dos yet. Tap + to add one.</div>';
    return h;
  }
  if (r === 'upcoming') return back + titleHTML(I.upcoming,'Upcoming') + areaBar(S.todos.filter(t => live(t) && ((t.start==='date' && t.date > S.day) || t.repeat || (t.deadline!==undefined && t.deadline > S.day)))) + upcomingHTML();
  if (r === 'anytime') return back + titleHTML(I.anytime,'Anytime') + groupedHTML(t => live(t) && (t.start==='anytime' || (t.start==='date' && t.date<=S.day)));
  if (r === 'someday') return back + titleHTML(I.someday,'Someday') + groupedHTML(t => live(t) && t.start==='someday');
  if (r === 'logbook') return back + titleHTML(I.logbook,'Logbook') + logbookHTML();
  if (r === 'trash') {
    const tr = S.todos.filter(t => t.trashed && !t.dismissed);
    return back + titleHTML(I.trash,'Trash') + (tr.length ? `<ul class="todos">${tr.map(t => `<li class="row" data-tid="${esc(t.id)}"><div class="row-main"><span class="cb" style="opacity:.5"></span><span class="title"><span class="tx" style="color:var(--fg-2)">${esc(t.title)}</span></span><span class="meta"><button class="btn quiet restore" data-restore="${esc(t.id)}">Restore</button></span></div></li>`).join('')}</ul>` : '<div class="empty">Trash is empty.</div>');
  }
  if (r === 'settings') return back + titleHTML(sized(I.gear,26),'Settings') + settingsHTML();
  if (r.startsWith('tag:')) { const tg = r.slice(4); return back + titleHTML(sized(I.tag,26,'color:var(--fg-2)'), tg) + ul(S.todos.filter(t => live(t) && (t.tags||[]).includes(tg)),{marks:true}); }
  if (r === 'find:deadlines') return back + titleHTML(sized(I.deadline,26,'color:var(--deadline)'),'Deadlines') + ul(S.todos.filter(t => live(t) && t.deadline!==undefined).sort((a,b)=>a.deadline-b.deadline),{marks:true});
  if (r === 'find:repeating') return back + titleHTML(sized(I.repeat,26),'Repeating') + ul(S.todos.filter(t => live(t) && t.repeat),{marks:true,rep:true});
  return back;
}
function upcomingHTML(){
  const ev = d => evToday(d).map(e => `<div class="uev"><span>${e[0]===null?'All day':fmtT(e[0])}</span><span>${esc(e[2])}</span></div>`).join('');
  const itemsOn = (d, withDate) => {
    let h = '';
    const md = s => withDate ? s.replace('<span class="meta">', `<span class="meta"><span>${fmtD(d,{month:'short',day:'numeric'})}</span>`) : s;
    const todos = af(S.todos), sel = areaF();
    todos.filter(t => live(t) && t.start==='date' && t.date===d).sort(byKey('si')).forEach(t => h += md(rowHTML(t,{upc:true})));
    todos.filter(t => live(t) && t.repeat && t.start==='date' && d > t.date && occurs(t,d) && !(withDate && ['daily','weekly'].includes(t.repeat.kind))).forEach(t => h += md(`<li class="row ghost"><div class="row-main"><span class="cb"></span><span class="title"><span class="tx">${esc(t.title)}</span>${I.repeat}</span><span class="meta"></span></div></li>`));
    todos.filter(t => live(t) && t.deadline===d && !(t.start==='date' && t.date===d)).forEach(t => h += md(rowHTML(t,{upc:true,dlday:true})));
    openProjects().filter(p => p.deadline===d && (!sel || p.area === sel)).forEach(p => h += md(prowHTML(p, true)));
    return h;
  };
  let h = '';
  for (let d=S.day+1; d<=S.day+7; d++) h += `<div class="day-head" data-day="${d}"><span class="dn">${dom(d)}</span><span class="dw">${d===S.day+1?'Tomorrow':fmtD(d,{weekday:'long'})}</span></div>${ev(d)}<ul class="todos">${itemsOn(d)}</ul>`;
  let d = S.day+8; const endD = S.day + 120;
  while (d <= endD) {
    const m = monthOf(d), y = yearOf(d); let rows = '', first = d;
    while (d <= endD && monthOf(d)===m) { rows += itemsOn(d, true); d++; }
    const label = (m===monthOf(S.day) && y===yearOf(S.day) ? 'Rest of ' : '') + fmtD(first,{month:'long'}) + (y!==yearOf(S.day)?' '+y:'');
    h += `<div class="day-head month" data-day="${first}"><span class="dn">${label}</span></div><ul class="todos">${rows || '<li class="none">Nothing yet</li>'}</ul>`;
  }
  return h;
}
function groupedHTML(pred){
  const all = S.todos.filter(pred).sort(byKey('si')); let h = areaBar(all) + tagBar(all); const list = tf(af(all));
  const loose = list.filter(t => !t.area && !t.project);
  if (loose.length) h += ul(loose,{marks:true});
  S.areas.forEach(a => {
    const aLoose = list.filter(t => t.area===a.id && !t.project), ps = S.projects.filter(p => p.area===a.id && list.some(t => t.project===p.id));
    if (!aLoose.length && !ps.length) return;
    h += `<button class="grp-area" data-r="area:${esc(a.id)}">${I.area}${esc(a.title)}</button>${ul(aLoose,{marks:true})}`;
    ps.forEach(p => h += `<button class="grp-proj" data-r="project:${esc(p.id)}">${pie(progress(p.id),16)}${esc(p.title)}</button>${ul(list.filter(t => t.project===p.id),{marks:true})}`);
  });
  const orphan = list.filter(t => t.project && !proj(t.project));
  if (orphan.length) h += ul(orphan,{marks:true});
  return h || '<div class="empty">Nothing here.</div>';
}
function logbookHTML(){
  const items = [
    ...S.todos.filter(t => t.logged && !t.trashed && t.list !== 'Claude').map(t => ({t, stop: t.stop ?? S.day})),
    ...S.completions.filter(c => c.list !== 'Claude').map(c => ({rc:c, stop: zoned(c.completed_at, S.tz).day})),
    ...S.claude.filter(c => c.done).map(c => ({c, stop: c.stop ?? S.day})),
  ].sort((a,b) => b.stop - a.stop);
  const label = d => d===S.day ? 'Today' : d===S.day-1 ? 'Yesterday' : fmtD(d,{weekday:'long',month:'short',day:'numeric'});
  let h = '', cur = null;
  items.forEach(({t,c,rc,stop}) => {
    if (stop !== cur) { if (cur !== null) h += '</ul>'; h += `<div class="log-head">${label(stop)}</div><ul class="todos">`; cur = stop; }
    if (c) h += `<li class="row lb lb-claude"><div class="row-main"><span class="cl-mark">${I.claude}</span><span class="title"><span class="tx">${esc(c.title)}</span></span><span class="meta">Claude</span></div></li>`;
    else if (rc) h += `<li class="row lb"><div class="row-main"><span class="cb">${I.check}</span><span class="title"><span class="tx">${esc(rc.title)}</span>${I.repeat}</span><span class="meta"></span></div></li>`;
    else h += `<li class="row lb ${t.canceled?'canceled':''}" data-lid="${esc(t.id)}"><div class="row-main"><button class="cb" aria-label="${t.canceled?'Canceled':'Completed'}. Restore">${t.canceled?I.x:I.check}</button><span class="title"><span class="tx">${esc(t.title)}</span></span><span class="meta">${S.time[t.id] != null ? fmtDur(Math.max(1, Math.round(S.time[t.id]/60))) : ''}</span></div></li>`;
  });
  return h + (cur!==null ? '</ul>' : '<div class="empty">Finished to-dos show up here.</div>');
}
function timeSel(k, v, from, to){ let o=''; for (let m=from; m<=to; m+=15) o += `<option value="${m}" ${m===v?'selected':''}>${fmtT(m)}</option>`; return `<select id="set-${k}" data-time="${k}" aria-label="${k==='workStart'?'Work starts':'Work ends'}">${o}</select>`; }
function settingsHTML(){
  const sw = (k, on) => `<button class="sw" role="switch" aria-checked="${on}" data-set="${k}"></button>`;
  const row = (lbl, ctl, sub='', cls='') => `<div class="set-row ${cls}"><span class="lbl">${lbl}${sub?`<small>${sub}</small>`:''}</span>${ctl}</div>`;
  const ago = h => h == null ? 'never' : h < 1 ? Math.max(1, Math.round(h*60)) + ' min ago' : h < 48 ? Math.round(h) + ' h ago' : Math.round(h/24) + ' days ago';
  const hl = s => `<div class="set-row"><span class="health ${s.status==='ok'?'':'warn'}"></span><span class="lbl">${esc(s.label)}${s.error?`<small>${esc(s.error)}</small>`:''}</span><span class="val">${s.status==='off'?'not set up':ago(s.age_hours)}</span></div>`;
  return `<div class="set-sec">Today</div><div class="set-card">
      ${row('Work schedule', `<span style="display:flex;gap:6px;align-items:center">${timeSel('workStart', S.set.workStart, 300, 720)}<span class="val">to</span>${timeSel('workEnd', S.set.workEnd, 840, 1260)}</span>`, 'Mon–Fri. Free time shows inside it; work folds after it.', 'stack')}
      ${row('Show free time between events', sw('freeLines', S.set.freeLines))}
      ${row('Fold work after the work day', sw('workFold', S.set.workFold), `After ${fmtT(S.set.workEnd)}; flagged and due items stay.`)}
      ${row('Show project or area under titles', sw('showPlace', S.set.showPlace), 'In Today and Upcoming.')}</div>
    <div class="set-sec">Calendars</div><div class="set-card">
      ${row('<span style="display:flex;gap:8px;align-items:center"><span class="ev-dot" style="--c:var(--cal-family)"></span>Shared calendars</span>', sw('cal:family', S.set.cals.family))}
      ${row('<span style="display:flex;gap:8px;align-items:center"><span class="ev-dot" style="--c:var(--cal-personal)"></span>Personal</span>', sw('cal:personal', S.set.cals.personal))}
      ${row('<span style="display:flex;gap:8px;align-items:center"><span class="ev-dot" style="--c:var(--cal-work)"></span>Work</span>', sw('cal:work', S.set.cals.work), 'Free/busy only.')}</div>
    <div class="set-sec">Claude</div><div class="set-card">
      ${row('Suggestions in Inbox', sw('suggestions', S.set.suggestions))}
      ${(() => { const c = S.set.checkins, hm = v => { const [h, m] = v.split(':').map(Number); return h*60+m; }, opt = (k, from, to) => { let o=''; for (let m=from; m<=to; m+=60) { const v = String(Math.floor(m/60)).padStart(2,'0')+':00'; o += `<option value="${v}" ${v===c[k]?'selected':''}>${fmtT(m)}</option>`; } return `<select data-ci="${k}">${o}</select>`; };
        return row('Claude check-ins', `<span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><select data-ci="every_minutes">${[60,120,180,240].map(n => `<option value="${n}" ${n===c.every_minutes?'selected':''}>Every ${n/60} h</option>`).join('')}</select>${opt('start', 300, 720)}<span class="val">to</span>${opt('end', hm('13:00'), 1380)}</span>`, 'How often Claude looks for new mail, calendar changes and messages.', 'stack'); })()}</div>
    <div class="set-sec">Feedback</div><div class="set-card">
      ${row('<button class="btn" id="send-fb" style="padding:4px 0;background:none;color:var(--accent)">Send feedback…</button>', `<span class="val">${S.feedbackSent ? S.feedbackSent+' sent' : ''}</span>`, 'On your phone, shake the device to send feedback from any screen.')}</div>
    <div class="set-sec">Devices</div><div class="set-card" id="devices">${S.devices ? (S.devices.length ? S.devices.map(dv => row(esc(dv.label), `<button class="btn quiet" data-revoke="${esc(dv.id)}">Revoke</button>`, `Paired ${fmtD(dnum(dv.created_at), {month:'short', day:'numeric'})}${dv.last_used_at ? ' · last used ' + fmtD(dnum(dv.last_used_at), {month:'short', day:'numeric'}) : ''}`)).join('') : row('No paired devices', '', 'The Android app pairs itself when you sign in there.')) : row('Loading…', '')}</div>
    <div class="set-sec">Data health</div><div class="set-card">
      ${S.health.map(hl).join('')}${row('To-dos stored', `<span class="val">${S.todos.filter(t => !t.logged && !t.trashed).length} open</span>`)}</div>
    <p class="list-sub" style="margin-top:18px">my-os ${VERSION}</p>`;
}

/* ---------- rows ---------- */
function rowHTML(t, o={}){
  if (o.dlday) return rowHTML({...t, deadline: undefined}, {...o, dlday:false}).replace('<span class="meta">', `<span class="meta">${sized(I.deadline,13)}<span>Deadline</span>`);
  const red = dueNow(t), td = inToday(t);
  const mark = o.marks && td ? `<span class="mk" aria-label="${t.evening?'This Evening':'In Today'}">${t.evening?I.moon:I.star}</span>` : '';
  const date = o.marks && !o.upc && t.start==='date' && t.date > S.day ? `<span>${dayLabel(t.date)}</span>` : '';
  const meta = `${date}${t.flag?`<span class="flag" aria-label="Flagged">${I.flag}</span>`:''}${t.deadline!==undefined && !t.done && !t.logged?`<span class="${red?'red':''}">${dlText(t.deadline)}</span>`:''}${o.rep?I.repeat:''}`;
  const isNew = o.today && t.start==='date' && t.date===S.day && !S.seen[S.day] && !t.done;
  const cls = ['row', t.done&&'done', t.logged&&'done', t.canceled&&'canceled', S.open===t.id&&'open', S.sel.has(t.id)&&'selected'].filter(Boolean).join(' ');
  let det = '';
  if (S.open === t.id) {
    det = `<div class="detail">
      <textarea id="notes" rows="2" placeholder="Notes">${esc(t.notes||'')}</textarea>
      ${t.checklist?`<ul class="checklist">${t.checklist.map((c,i)=>`<li class="${c.d?'d':''}" data-ci="${i}"><span class="ck"></span>${esc(c.t)}</li>`).join('')}<li class="add-ck"><span class="ck" style="opacity:.4"></span><input id="ck-add" placeholder="Add item"></li></ul>`:''}
      ${t.tags?`<div class="tags">${t.tags.map(x=>`<span class="tag">${esc(x)}</span>`).join('')}</div>`:''}
      ${t.deadline!==undefined?`<div class="dline ${red?'red':''}">${I.deadline}Deadline ${dayLabel(t.deadline)} · ${dlText(t.deadline)}</div>`:''}
      ${t.reminder?`<div class="dline">${I.bell}Reminder ${(z => dayLabel(z.day)+' at '+fmtT(z.min))(zoned(t.reminder, S.tz))}</div>`:''}
      ${t.repeat?`<div class="dline">${sized(I.repeat,15)}Repeats ${repeatText(t.repeat, t.rule)}</div>`:''}
      ${t.reason?`<div class="dline"><span style="color:var(--claude);font-weight:600">Claude</span>${esc(t.reason)}</div>`:''}
      ${(() => { const run = S.timer && S.timer.id===t.id, secs = elapsed(t.id); return `<div class="timer ${run?'running':''}"><button id="timer-btn">${run?I.pause+'Stop timer':I.play+'Start timer'}</button><span id="t-elapsed">${secs?fmtClock(secs)+' spent':''}</span></div>`; })()}
      <div class="dfoot">
        <button class="chip" id="d-when">${whenChip(t)}</button>
        <button class="chip muted" id="d-move">${t.project?pie(progress(t.project),15):t.area?I.area:I.inbox}<span>${esc(placeOf(t))}</span></button>
        <span class="sp"></span>
        <button class="ibtn" id="d-tags" aria-label="Tags">${I.tag}</button>
        <button class="ibtn" id="d-check" aria-label="Checklist">${I.list}</button>
        <button class="ibtn ${t.flag?'on':''}" id="d-flag" aria-label="${t.flag?'Remove flag':'Flag as important'}">${t.flag?I.flag:I.flagLine}</button>
        <button class="ibtn" id="d-dl" aria-label="Deadline">${I.deadline}</button>
        <button class="ibtn" id="d-more" aria-label="More">${I.dots}</button>
      </div></div>`;
  }
  const showPlace = (o.today||o.upc) && S.set.showPlace && (t.project||t.area) && S.open!==t.id;
  return `<li class="${cls}" data-id="${esc(t.id)}">
    <div class="swipe-bg"><span class="sb-when">${I.cal}When</span><span class="sb-sel">Select${I.select}</span></div>
    <div class="row-main">${isNew?'<span class="new-dot" aria-label="New today"></span>':''}<button class="cb" aria-label="Complete">${t.canceled?I.x:I.check}</button><span class="title">${mark}${showPlace ? `<span class="tcol"><span class="tx">${esc(t.title)}</span><span class="tsub">${esc(placeOf(t))}</span></span>` : `<span class="tx" ${S.open===t.id?'contenteditable="true" spellcheck="false"':''}>${esc(t.title)}</span>`}</span><span class="meta">${meta}</span></div>${det}</li>`;
}
function whenChip(t){
  if (t.start==='date' && t.date<=S.day) return t.evening ? I.moon+'<span>This Evening</span>' : I.star+'<span>Today</span>';
  if (t.start==='someday') return I.someday+'<span>Someday</span>';
  if (t.start==='date') return I.upcoming+`<span>${dayLabel(t.date)}</span>`;
  if (t.start==='anytime') return I.anytime+'<span>Anytime</span>';
  return sized(I.cal,15,'color:var(--fg-3)')+'<span style="color:var(--fg-2)">When</span>';
}
function suggHTML(t){
  const o = S.open === t.id;
  return `<li class="row sugg ${o?'open':''}" data-id="${esc(t.id)}">
    <div class="swipe-bg"><span class="sb-when">${I.cal}Accept…</span><span class="sb-sel">Dismiss</span></div>
    <div class="row-main"><button class="cb" aria-label="Accept suggestion"></button>
      <span class="sugg-body"><span class="title"><span class="tx" ${o?'contenteditable="true" spellcheck="false"':''}>${esc(t.title)}</span></span>
      <span class="reason"><span class="who">Claude</span><span class="rt">${esc(t.sugg)}</span></span></span></div>
    ${o ? `<div class="sugg-actions"><button class="btn primary" id="s-accept">Accept</button><button class="btn" id="s-when">Schedule…</button><button class="btn quiet" id="s-dismiss">Dismiss</button></div>` : ''}</li>`;
}
function claudeHTML(c){
  const o = S.open === c.id;
  return `<li class="row cl ${c.done?'done-cl':''} ${o?'open':''}" data-cid="${esc(c.id)}">
    <div class="swipe-bg"><span class="sb-when">${I.cal}New date</span><span class="sb-sel"></span></div>
    <div class="row-main"><span class="cl-mark">${c.done ? sized(I.check,14,'stroke:var(--claude);stroke-width:2.4;fill:none') : I.claude}</span><span class="title"><span class="tx">${esc(c.title)}</span></span><span class="meta">${c.done ? (c.stop!==undefined?dayLabel(c.stop):'') : c.date!==undefined ? dayLabel(c.date) : ''}</span></div>
    ${o ? `<div class="cl-detail"><div>${esc(c.notes||'')}</div><div class="acts"><button class="btn" id="c-date">${sized(I.cal,15,'display:inline;vertical-align:-2px;margin-right:6px')}${c.date!==undefined?dayLabel(c.date):'Set a date'}</button><button class="btn quiet" id="c-drop">Drop</button></div></div>` : ''}</li>`;
}
function prowHTML(p, dlday){
  return `<li class="row prow" data-pid="${esc(p.id)}"><div class="row-main">${pie(progress(p.id),20)}<span class="title"><span class="tx">${esc(p.title||'New Project')}</span></span><span class="meta">${dlday?'<span>Deadline</span>':p.deadline!==undefined?`<span class="${p.deadline<=S.day?'red':''}">${dlText(p.deadline)}</span>`:''}</span></div></li>`;
}

/* ---------- render ---------- */
function render(keepScroll=true){
  $('#device').classList.toggle('wide', wide());
  if (wide() && S.route==='home') S.route = 'today';
  const sc = $('#scroller'), y = sc.scrollTop;
  $('#view').innerHTML = viewHTML();
  $('#side').innerHTML = S.loaded ? navHTML() : ''; bindNav($('#side'));
  if (S.route==='home') bindNav($('#view'));
  const b = $('#back'); if (b) b.onclick = goBack;
  const m = $('#more'); if (m) m.onclick = () => S.select ? exitSelect() : enterSelect(null);
  if (S.route==='today') { const f=$('#ev-fold'); if (f) f.onclick = () => { S.evOpen=!S.evOpen; render(); }; const w=$('#work-fold'); if (w) w.onclick = () => { S.showWork=!S.showWork; render(); }; }
  $$('#view .row[data-id]:not(.sugg)').forEach(bindRow);
  $$('#view .sugg').forEach(bindSugg);
  $$('#view .cl').forEach(bindClaude);
  $$('#view .prow').forEach(li => { li.onclick = () => go('project:'+li.dataset.pid); });
  $$('#view .grp-area,#view .grp-proj').forEach(x => x.onclick = () => go(x.dataset.r));
  $$('#view [data-tf]').forEach(x => x.onclick = () => { S.tagF = x.dataset.tf==='All' ? null : x.dataset.tf; render(); });
  $$('#view [data-af]').forEach(x => x.onclick = () => { setAreaF(x.dataset.af || null); render(); });
  $$('#view .lb[data-lid] .cb').forEach(cb => cb.onclick = () => { const t = byId(cb.closest('.lb').dataset.lid); snap(); t.done=false; t.logged=false; t.canceled=false; delete t.stop; render(); toast(`Restored “${t.title}”`, true); });
  $$('#view [data-restore]').forEach(x => x.onclick = () => { const t = byId(x.dataset.restore); snap(); t.trashed=false; render(); toast(`Restored “${t.title}”`, true); });
  const sl = $('#show-logged'); if (sl) sl.onclick = () => { const id = S.route.slice(8); S.showLogged[id] = !S.showLogged[id]; render(); };
  const cp = $('#complete-proj'); if (cp) cp.onclick = () => { const p = proj(S.route.slice(8)); snap(); p.done = true; toast(`Completed project “${p.title}”`, true); goBack(); };
  const cd = $('#cl-done'); if (cd) cd.onclick = () => { S.showClaudeDone = !S.showClaudeDone; render(); };
  const te = $('#title-edit'); if (te) { te.oninput = () => { const o = S.route.startsWith('area:') ? area(S.route.slice(5)) : proj(S.route.slice(8)); o.title = te.textContent; $('#side').innerHTML = navHTML(); bindNav($('#side')); scheduleSync(); }; te.onkeydown = e => { if (e.key==='Enter') { e.preventDefault(); te.blur(); } }; }
  $$('#view [data-hid]').forEach(el => { el.oninput = () => { const p = proj(S.route.slice(8)), hd = p && p.headings.find(x => x.id === el.dataset.hid); if (hd) { hd.title = el.textContent; scheduleSync(); } }; el.onkeydown = e => { if (e.key==='Enter') { e.preventDefault(); el.blur(); } }; el.onblur = () => { const p = proj(S.route.slice(8)), hd = p && p.headings.find(x => x.id === el.dataset.hid); if (hd && !hd.title.trim()) { hd.title = 'Untitled'; el.textContent = hd.title; scheduleSync(); } }; });
  const pn = $('#proj-notes'); if (pn) pn.oninput = () => { proj(S.route.slice(8)).notes = pn.textContent; scheduleSync(); };
  $$('#view [data-set]').forEach(x => x.onclick = () => { const k = x.dataset.set; if (k.startsWith('cal:')) S.set.cals[k.slice(4)] = !S.set.cals[k.slice(4)]; else S.set[k] = !S.set[k]; saveSet(); render(); });
  $$('#view select[data-time]').forEach(x => x.onchange = () => { S.set[x.dataset.time] = +x.value; saveSet(); render(); });
  $$('#view select[data-ci]').forEach(x => x.onchange = () => { const k = x.dataset.ci; S.set.checkins = {...S.set.checkins, [k]: k==='every_minutes' ? +x.value : x.value}; saveSet(); });
  const sf = $('#send-fb'); if (sf) sf.onclick = openFeedback;
  if (S.route === 'settings' && !S.devices && !S.devicesLoading) { S.devicesLoading = true; api('GET', '/api/v1/devices').then(r => { S.devices = r.devices; S.devicesLoading = false; if (S.route === 'settings') render(); }).catch(() => { S.devicesLoading = false; }); }
  $$('#view [data-revoke]').forEach(x => x.onclick = async () => { try { await api('DELETE', '/api/v1/devices/' + encodeURIComponent(x.dataset.revoke)); S.devices = S.devices.filter(d => d.id !== x.dataset.revoke); render(); toast('Device revoked'); } catch (e) { toast('Couldn’t revoke: ' + e.message); } });
  $('#app').classList.toggle('select-mode', S.select);
  $('#plus').hidden = !S.loaded || S.select || ['logbook','claude','trash','settings','brief'].includes(S.route) || S.route.startsWith('find:') || S.route.startsWith('tag:');
  sc.scrollTop = keepScroll ? y : 0;
  if (S.open !== null && byId(S.open)) bindDetail(byId(S.open));
  renderTimer();
  scheduleSync();
}
function leaveRoute(){
  if (S.route==='today') { S.seen = {[S.day]: true}; store.set('seen', S.seen); }
  if (S.route==='brief' && S.brief) { S.briefSeen = briefKey(); store.set('briefSeen', S.briefSeen); }
}
// Navigation depth decides the slide direction on phone: Lists (0) -> a list (1) -> a project (2)
const depthOf = r => r === 'home' ? 0 : r.startsWith('project:') ? 2 : 1;
function go(r, push=true, after){
  if (r===S.route) { if (after) after(); return; }
  const from = S.route;
  const swap = () => { leaveRoute(); S.tagF = null; closeOpen(false); exitSelect(false); S.route = r; render(false); if (after) after(); };
  if (push) try { history.pushState({r}, '', '#' + r); } catch (e) { /* sandboxed */ }
  const dir = wide() ? null : depthOf(r) > depthOf(from) ? 'fwd' : depthOf(r) < depthOf(from) ? 'back' : null;
  transition(swap, dir);
}
// View Transitions API when available (phone slides, web crossfade-free); otherwise a CSS slide on the new view
function transition(update, dir){
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!dir || reduce) return update();
  if (document.startViewTransition) {
    document.documentElement.dataset.nav = dir;
    const t = document.startViewTransition(update);
    t.finished.finally(() => { delete document.documentElement.dataset.nav; });
    return;
  }
  update();
  const v = $('#view'); v.classList.remove('view-in-fwd', 'view-in-back'); void v.offsetWidth; v.classList.add('view-in-' + dir);
}
function goBack(){ if (history.state && history.state.r && history.length > 1) history.back(); else go(wide() ? 'today' : 'home'); }
addEventListener('popstate', e => { const r = (e.state && e.state.r) || (wide() ? 'today' : 'home'); if (S.route !== r) go(r, false); });

/* ---------- swipe / rows ---------- */
// One gesture recognizer per row: horizontal swipe (phone), long-press then drag (phone, 400 ms), press-and-move drag (web mouse).
function swipe(li, onRight, onLeft, onTap, dragIds){
  const main = li.querySelector('.row-main'); let sx=null, sy=0, dx=0, mode=null, sup=false, lp=null;
  const webMouse = e => e.pointerType==='mouse' && wide();
  main.addEventListener('contextmenu', e => e.preventDefault());
  main.addEventListener('pointerdown', e => {
    if (li.classList.contains('open') || e.target.closest('.cb') || S.select && !dragIds) return;
    sx=e.clientX; sy=e.clientY; dx=0; mode=null;
    // the row can re-render during the 400 ms (detached node, or the pointer already gone): setPointerCapture then throws, so drop the press
    if (dragIds && !webMouse(e)) lp = setTimeout(() => { if (mode!==null || sx===null) return;
      try { if (!main.isConnected) throw 0; main.setPointerCapture(e.pointerId); } catch (err) { sx=null; return; }
      mode='drag'; beginDrag(li, dragIds(), sx, sy); }, 400);
  });
  main.addEventListener('pointermove', e => {
    if (sx===null) return; dx=e.clientX-sx; const dy=e.clientY-sy;
    if (mode==='drag') return moveDrag(e.clientX, e.clientY);
    if (mode===null) {
      if (Math.abs(dx)>8 || Math.abs(dy)>8) clearTimeout(lp);
      if (webMouse(e)) { if (dragIds && Math.hypot(dx,dy)>6) { mode='drag'; main.setPointerCapture(e.pointerId); beginDrag(li, dragIds(), e.clientX, e.clientY); } return; }
      if (Math.abs(dx)>8 && Math.abs(dx)>Math.abs(dy)) { mode='swipe'; main.setPointerCapture(e.pointerId); li.classList.add('swiping'); } else if (Math.abs(dy)>8) { sx=null; return; }
    }
    if (mode==='swipe') {
      // rubber band past the 70 px threshold; a light tick when it arms
      const raw = onLeft ? dx : Math.max(0, dx), a = Math.abs(raw), d = Math.sign(raw) * (a <= 70 ? a : Math.min(130, 70 + (a - 70) * 0.35));
      main.style.transform=`translateX(${d}px)`; li.dataset.dir = d>0?'right':'left';
      const armed = a > 70; if (armed && !li.classList.contains('armed') && navigator.vibrate) try { navigator.vibrate(6); } catch (e) { /* no haptics */ }
      li.classList.toggle('armed', armed);
    }
  });
  const end = (cancel) => { clearTimeout(lp); if (sx===null) return; sx=null; const m = mode; mode=null; if (!m) return; sup=true;
    if (m==='drag') return endDrag(cancel===true);
    li.classList.remove('swiping','armed'); main.style.transform=''; if (dx>70) onRight(); else if (dx<-70 && onLeft) onLeft(); }; // snaps back via the CSS transition
  main.addEventListener('pointerup', () => end(false)); main.addEventListener('pointercancel', () => end(true));
  main.addEventListener('click', e => { if (sup) { sup=false; return; } if (e.target.closest('.cb')) return; onTap(); });
}
let D = null;
document.addEventListener('touchmove', e => { if (D) e.preventDefault(); }, {passive:false});
function beginDrag(li, ids, x, y){
  closeOpen(false);
  const r = li.getBoundingClientRect();
  const g = document.createElement('div'); g.className = 'drag-ghost'; g.appendChild(li.querySelector('.row-main').cloneNode(true));
  if (ids.length > 1) g.insertAdjacentHTML('beforeend', `<span class="badge">${ids.length}</span>`);
  g.style.width = r.width+'px'; $('#app').appendChild(g);
  D = {ids, g, ox: x - r.left, oy: y - r.top, target:null};
  if (!wide()) { $('#dropbar').hidden = false; $('#plus').hidden = true; } // phone: lists to drop onto (the sidebar's job on web)
  ids.forEach(id => document.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.classList.add('dragging'));
  if (!wide() && navigator.vibrate) try { navigator.vibrate(10); } catch(e) { /* no haptics */ }
  moveDrag(x, y);
}
function clearHL(){ $$('.drop-hl,.nav-i.drop,.day-head.drop,#dropbar .drop').forEach(x => x.classList.remove('drop-hl','drop')); $('#ins').hidden = true; }
function moveDrag(x, y){
  if (!D) return; const app = $('#app').getBoundingClientRect();
  D.g.style.left = (x - app.left - D.ox)+'px'; D.g.style.top = (y - app.top - D.oy)+'px';
  const sc = $('#scroller').getBoundingClientRect(); if (y < sc.top + 40) $('#scroller').scrollTop -= 10; else if (y > sc.bottom - 40) $('#scroller').scrollTop += 10;
  clearHL(); const el = document.elementFromPoint(x, y); D.target = null; if (!el) return;
  const bar = el.closest('#dropbar [data-drop]');
  if (bar) { bar.classList.add('drop'); D.target = bar.dataset.drop === 'evening' ? {kind:'evening'} : bar.dataset.drop === 'move' ? {kind:'move'} : {kind:'nav', dest:bar.dataset.drop}; return; }
  const nav = el.closest('#side [data-drop]');
  if (nav && !['upcoming','logbook','claude','settings','brief'].includes(nav.dataset.drop)) { nav.classList.add('drop'); D.target = {kind:'nav', dest:nav.dataset.drop}; return; }
  const day = el.closest('#view .day-head[data-day]'); if (day) { day.classList.add('drop'); D.target = {kind:'day', day:+day.dataset.day}; return; }
  const pr = el.closest('#view .prow'); if (pr) { pr.classList.add('drop-hl'); D.target = {kind:'nav', dest:'project:'+pr.dataset.pid}; return; }
  const ev = el.closest('#view .sec-head[data-evening]'); if (ev) { ev.classList.add('drop-hl'); D.target = {kind:'evening'}; return; }
  const row = el.closest('#view .row[data-id]:not(.sugg):not(.lb):not(.dragging)');
  if (row && !byId(row.dataset.id)?.logged) {
    const r = row.getBoundingClientRect(), after = y > r.top + r.height/2, ins = $('#ins');
    ins.hidden = false; ins.classList.remove('heading'); ins.style.top = ((after?r.bottom:r.top) - app.top - 1)+'px'; ins.style.left = (r.left-app.left+24)+'px'; ins.style.width = (r.width-24)+'px';
    D.target = {kind:'row', id:row.dataset.id, after};
  }
}
// The list a row sits in (for ordering): Today uses its own order (today_index); every other list uses sort_index
function orderKey(){ return S.route==='today' ? 'ti' : 'si'; }
function placeRelative(moving, ref, after){
  const key = orderKey();
  const ids = $$('#view .row[data-id]:not(.sugg):not(.lb)').map(li => li.dataset.id).filter(id => !moving.some(t => t.id === id));
  let i = ids.indexOf(ref.id); if (i < 0) return; if (after) i++;
  ids.splice(i, 0, ...moving.map(t => t.id));
  ids.forEach((id, k) => { const t = byId(id); if (t) t[key] = (k + 1) * 10; });
}
function endDrag(cancel){
  if (!D) return; const {ids, g, target} = D; D = null; g.remove(); clearHL(); $('#dropbar').hidden = true; $$('.row.dragging').forEach(x => x.classList.remove('dragging'));
  if (cancel || !target) return render();
  if (target.kind==='move') { render(); return openMove(ids); }
  if (target.kind==='nav') return dropTo(ids, target.dest);
  if (target.kind==='day') return applyWhen(ids, 'd'+(target.day - S.day));
  if (target.kind==='evening') { snap(); ids.map(byId).forEach(t => { t.start='date'; if (!(t.date<=S.day)) t.date=S.day; t.evening=true; }); return render(); }
  // reorder: move the dragged to-dos next to the target and take on that spot's section
  const ref = byId(target.id); if (!ref || ids.includes(ref.id)) return render(); snap();
  const moving = ids.map(byId).filter(Boolean);
  moving.forEach(t => {
    if (S.route==='today') { t.evening = !!ref.evening; if (!inToday(t)) { t.start='date'; t.date=S.day; } }
    if (S.route.startsWith('project:')) t.heading = ref.heading;
    if (S.route==='upcoming' && ref.start==='date') { t.start='date'; t.date=ref.date; }
  });
  placeRelative(moving, ref, target.after);
  if (S.select) { S.select=false; S.sel.clear(); renderSel(); }
  render();
}
function bindRow(li){
  const id = li.dataset.id, t = byId(id); if (!t) return;
  if (t.logged) { li.querySelector('.cb').onclick = e => { e.stopPropagation(); snap(); t.done=false; t.logged=false; t.canceled=false; delete t.stop; render(); }; return; }
  li.querySelector('.cb').addEventListener('click', e => { e.stopPropagation(); if (S.select) return toggleSel(id); complete(t, li); });
  swipe(li, () => openWhen([id]), () => enterSelect(id), () => { if (S.select) return toggleSel(id); if (S.open !== id) openRow(id); }, () => S.select && S.sel.has(id) ? [...S.sel] : [id]);
}
function bindDetail(t){
  if (!t) return; const li = document.querySelector(`.row[data-id="${CSS.escape(t.id)}"]`); if (!li || li.classList.contains('sugg')) return;
  const tx = li.querySelector('.tx'); tx.oninput = () => { t.title = tx.textContent; scheduleSync(); };
  tx.onkeydown = e => { if (e.key==='Enter') { e.preventDefault(); $('#notes').focus(); } };
  $('#notes').oninput = e => { t.notes = e.target.value; scheduleSync(); };
  $('#d-when').onclick = () => openWhen([t.id]);
  $('#d-move').onclick = () => openMove([t.id]);
  $('#d-flag').onclick = () => { t.flag = !t.flag; render(); };
  $('#d-check').onclick = () => { if (!t.checklist) t.checklist = []; render(); const a = $('#ck-add'); a && a.focus(); };
  $('#d-tags').onclick = () => openTags(t);
  $('#d-dl').onclick = () => openWhen([t.id], {deadline:true});
  $('#d-more').onclick = () => showPop(`<button class="opt" data-a="cancel">${sized(I.x,18,'stroke:currentColor;stroke-width:2')}${t.repeat?'Skip this one':'Cancel to-do'}</button><button class="opt" data-a="repeat">${sized(I.repeat,18,'color:currentColor')}${t.repeat?'Change repeat…':'Repeat…'}</button><button class="opt" data-a="dup">${I.plus}Duplicate</button><button class="opt danger" data-a="del">${sized(I.trash,18)}Delete</button>`, e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; closePop();
    if (a==='repeat') return setTimeout(() => openRepeat(t), 220);
    snap();
    if (a==='cancel') { stopTimerFor(t.id); t.done=true; t.canceled=true; t.logged=true; t.stop=S.day; S.open=null; render(); toast(t.repeat ? `Skipped “${t.title}” this time` : `Canceled “${t.title}”`, true); }
    if (a==='dup') { const c = {...t, id:'new-'+S.nid++, checklist: t.checklist && t.checklist.map(x=>({...x})), tags: t.tags && [...t.tags]}; delete c.repeat; delete c.rule; S.todos.splice(S.todos.indexOf(t)+1, 0, c); S.open=null; render(); toast('Duplicated', true); }
    if (a==='del') { stopTimerFor(t.id); t.trashed=true; S.open=null; render(); toast(`Moved “${t.title}” to Trash`, true); }
  });
  $('#timer-btn').onclick = () => { (S.timer && S.timer.id===t.id) ? stopTimer() : startTimer(t); };
  li.querySelectorAll('.checklist li[data-ci]').forEach(c => c.onclick = () => { const x=t.checklist[+c.dataset.ci]; x.d=!x.d; c.classList.toggle('d', x.d); scheduleSync(); });
  const ca = $('#ck-add'); if (ca) ca.onkeydown = e => { if (e.key==='Enter' && ca.value.trim()) { t.checklist.push({t:ca.value.trim(), d:false}); render(); $('#ck-add').focus(); } };
}
function openRow(id){
  const sel = `[data-id="${CSS.escape(id)}"],[data-cid="${CSS.escape(id)}"]`;
  const show = () => { closeOpen(false); S.open = id; openedAt = Date.now(); render(); openScroll = { id, y: $('#scroller').scrollTop }; const li = document.querySelector(sel); if (li) li.style.viewTransitionName = 'card'; };
  const before = document.querySelector(sel);
  if (document.startViewTransition && before && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    before.style.viewTransitionName = 'card';
    const t = document.startViewTransition(show);
    t.finished.finally(() => { const li = document.querySelector(sel); if (li) { li.style.viewTransitionName = ''; li.scrollIntoView({block:'nearest',behavior:'smooth'}); } });
  } else { show(); const li = document.querySelector(sel); if (li) { li.style.viewTransitionName = ''; li.scrollIntoView({block:'nearest',behavior:'smooth'}); } }
}
function closeOpen(rr=true){
  if (S.open === null) return; const t = byId(S.open);
  if (t && !t.title.trim()) {
    const b = base.todos.get(t.id);
    if (b) t.title = b.title; // a saved to-do keeps its last title
    else S.todos = S.todos.filter(x => x !== t); // an unsaved empty one is discarded
  }
  S.open = null; if (rr) render();
}
// Tap outside an open card closes it, and that tap does nothing else (not the row, checkbox or link underneath).
// While typing in the card, the first outside tap only closes the keyboard; the next one closes the card (Things 3).
let swallowClick = false;
const cardTyping = () => { const a = document.activeElement; return !!(a && a.closest && a.closest('.row.open') && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName))); };
document.addEventListener('pointerdown', e => {
  swallowClick = false; // only the tap that closed a card (or its keyboard) is swallowed, never the next one
  if (S.open === null) return; if (e.target.closest('.row.open,.scrim,.toast,.selbar,#timerbar,#dropbar')) return;
  if (cardTyping()) document.activeElement.blur(); else closeOpen();
  swallowClick = true;
});
document.addEventListener('click', e => { if (!swallowClick) return; swallowClick = false; e.stopPropagation(); e.preventDefault(); }, true);
// Scrolling the list away from an open card closes it too (a touch scroll already did, through its pointerdown; this covers
// wheel, trackpad and keys). Not while typing (the keyboard scrolls the page), and not the card's own scroll into view.
let openScroll = null, openedAt = 0;
$('#scroller').addEventListener('scroll', () => {
  const sc = $('#scroller');
  if (S.open === null || cardTyping()) { openScroll = null; return; }
  if (!openScroll || openScroll.id !== S.open || Date.now() - openedAt < 700) { openScroll = { id: S.open, y: sc.scrollTop }; return; }
  if (Math.abs(sc.scrollTop - openScroll.y) > 60) { openScroll = null; closeOpen(); }
}, { passive: true });

/* completion: lingers ~1.6s, tap again to undo; repeats roll to their next date (on the server) */
function complete(t, li){
  if (t.done) { t.done=false; clearTimeout(t._to); li.classList.remove('done'); return; }
  t.done = true; li.classList.add('done');
  try { window.myosShell?.haptic?.('success'); } catch (e) { /* no shell */ }
  if (S.timer && S.timer.id === t.id) { const secs = elapsed(t.id); stopTimer(); toast(`✓ ${t.title} · ${fmtDur(Math.max(1, Math.round(secs/60)))} logged`); }
  t._to = setTimeout(() => {
    if (!t.done) return;
    const finish = () => {
      if (t.repeat) { t.done=false; t._complete = true; S.undo = null; }
      else { t.logged = true; t.stop = S.day; }
      if (S.open===t.id) S.open=null; render();
    };
    const el = document.querySelector(`.row[data-id="${CSS.escape(t.id)}"]`); if (!el) return finish();
    el.style.height = el.offsetHeight+'px'; el.offsetHeight; el.classList.add('leaving'); el.style.height='0px'; setTimeout(finish, 300);
  }, 1600);
  if (t.project) setTimeout(() => { const bp = $('#big-pie'); if (bp) bp.innerHTML = pie(progress(t.project), 26); $('#side').innerHTML = navHTML(); bindNav($('#side')); }, 60);
}

/* ---------- timer ---------- */
const fmtClock = sec => { sec=Math.floor(sec); const h=Math.floor(sec/3600), m=Math.floor(sec%3600/60), s=sec%60; return (h?h+':'+String(m).padStart(2,'0'):m)+':'+String(s).padStart(2,'0'); };
const elapsed = id => (S.time[id] || 0) + (S.timer && S.timer.id===id ? (Date.now()-S.timer.t0)/1000 : 0);
async function startTimer(t){
  if (t.id.startsWith('new-')) { if (!t.title.trim()) return toast('Give the to-do a title first'); await syncNow(); }
  const prev = S.timer; if (prev) S.time[prev.id] = elapsed(prev.id);
  S.timer = {id:t.id, t0:Date.now()}; render();
  try { const r = await api('POST', '/api/v1/timer', {action:'start', task_id:t.id}); S.timer = {id:r.running.task_id, t0:Date.parse(r.running.started_at)};
    if (r.stopped) { const k = r.stopped.task_id; base.time[k] = (base.time[k] || 0) + r.stopped.seconds; S.time[k] = base.time[k]; }
    renderTimer(); }
  catch (e) { S.timer = prev; toast('Couldn’t start the timer: ' + e.message); render(); }
}
async function stopTimer(){
  if (!S.timer) return; const id = S.timer.id; S.time[id] = elapsed(id); S.timer = null; renderTimer();
  const el = $('#timer-btn'); if (el && S.open === id) render();
  try { const r = await api('POST', '/api/v1/timer', {action:'stop'}); if (r.stopped) { base.time[id] = (base.time[id] || 0) + r.stopped.seconds; S.time[id] = base.time[id]; } }
  catch (e) { toast('Couldn’t stop the timer on the server; it will be capped'); }
}
function stopTimerFor(id){ if (S.timer && S.timer.id===id) stopTimer(); }
function renderTimer(){
  const bar = $('#timerbar'); bar.hidden = !S.timer; if (!S.timer) return;
  const t = byId(S.timer.id); $('#tb-title').textContent = t ? (t.title || 'New To-Do') : (S.timerTitle || ''); $('#tb-time').textContent = fmtClock(elapsed(S.timer.id));
}
setInterval(() => { if (!S.timer) return; renderTimer(); const el=$('#t-elapsed'); if (el && S.open===S.timer.id) el.textContent = fmtClock(elapsed(S.timer.id))+' spent'; }, 1000);
$('#tb-stop').onclick = () => stopTimer();
$('#tb-main').onclick = () => { if (!S.timer) return; const t = byId(S.timer.id); if (!t) return; const r = inToday(t) ? 'today' : t.project ? 'project:'+t.project : t.area ? 'area:'+t.area : 'inbox'; go(r, true, () => openRow(t.id)); };

/* ---------- suggestions ---------- */
function bindSugg(li){
  const id = li.dataset.id, t = byId(id); if (!t) return;
  li.querySelector('.cb').onclick = e => { e.stopPropagation(); accept(t); };
  swipe(li, () => openWhen([id], {accept:true}), () => dismiss(t), () => { if (S.open !== id) openRow(id); });
  if (S.open === id) {
    const tx = li.querySelector('.tx'); tx.oninput = () => { t.title = tx.textContent; scheduleSync(); }; tx.onkeydown = e => { if (e.key==='Enter') { e.preventDefault(); tx.blur(); } };
    $('#s-accept').onclick = () => accept(t); $('#s-when').onclick = () => openWhen([id], {accept:true}); $('#s-dismiss').onclick = () => dismiss(t);
  }
}
function accept(t){ snap(); t.reason = t.sugg; delete t.sugg; t.start = 'inbox'; S.open = null; render(); toast(`Accepted “${t.title}”`, true); }
function dismiss(t){ snap(); t.trashed = true; t.dismissed = true; S.open = null; render(); toast('Dismissed. Claude won’t suggest it again soon', true); }

/* ---------- Claude list ---------- */
function bindClaude(li){
  const c = S.claude.find(x => x.id === li.dataset.cid); if (!c || c.done) return;
  swipe(li, () => openWhen([c.id], {claude:true}), null, () => { if (S.open !== c.id) openRow(c.id); });
  if (S.open === c.id) { $('#c-date').onclick = () => openWhen([c.id], {claude:true}); $('#c-drop').onclick = () => { snap(); S.claude = S.claude.filter(x => x !== c); S.open=null; render(); toast('Dropped. Claude will let it go', true); }; }
}

/* ---------- select mode ---------- */
function enterSelect(id){ closeOpen(false); S.select = true; S.sel = new Set(id == null ? [] : [id]); render(); renderSel(); }
function toggleSel(id){ S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); render(); renderSel(); }
function exitSelect(rr=true){ if (!S.select) return; S.select=false; S.sel.clear(); renderSel(); if (rr) render(); }
function renderSel(){ $('#selbar').hidden = !S.select; $('#sel-count').textContent = S.sel.size ? `${S.sel.size} selected` : 'Tap to select'; ['#sel-when','#sel-move','#sel-del'].forEach(q => $(q).disabled = !S.sel.size); if (S.select) $('#plus').hidden = true; }
$('#sel-done').onclick = () => exitSelect();
$('#sel-when').onclick = () => openWhen([...S.sel]);
$('#sel-move').onclick = () => openMove([...S.sel]);
$('#sel-del').onclick = () => { snap(); const k = S.sel.size; S.todos.forEach(t => { if (S.sel.has(t.id)) { stopTimerFor(t.id); t.trashed = true; } }); exitSelect(); toast(`${k} moved to Trash`, true); };

/* ---------- popovers ---------- */
// popGen: a popover closed within its first frame must not be shown again by its pending fade-in (the scrim then stuck over the list)
let popGen = 0;
function showPop(html, onClick){
  const sc = $('#scrim'), g = ++popGen; sc.innerHTML = `<div class="pop" role="dialog">${html}</div>`; sc.hidden = false; requestAnimationFrame(() => { if (g === popGen) sc.classList.add('show'); });
  sc.onclick = e => { if (e.target === sc) return closePop(); onClick(e); };
}
function closePop(){ const sc=$('#scrim'), g = ++popGen; sc.classList.remove('show'); setTimeout(() => { if (g === popGen) { sc.hidden = true; sc.innerHTML=''; } }, 200); }
let calMonth = 0;
function calHTML(){
  const y0 = yearOf(S.day), m0 = monthOf(S.day) + calMonth, first = firstOfMonth(y0, m0), y = yearOf(first), m = monthOf(first), days = new Date(Date.UTC(y, m+1, 0)).getUTCDate();
  let h = ['S','M','T','W','T','F','S'].map(d=>`<span class="dow">${d}</span>`).join('') + '<span></span>'.repeat(dow(first));
  for (let i=0; i<days; i++) { const d = first + i, k = d - S.day; h += k===0 ? `<button class="tdy" data-w="d0" aria-label="Today">${I.star}</button>` : `<button ${k<0?'disabled':''} data-w="d${k}">${i+1}</button>`; }
  return `<div class="cal-nav"><button data-cal="-1" ${calMonth<=0?'style="visibility:hidden"':''} aria-label="Previous month">‹</button><span>${fmtD(first,{month:'long',year:'numeric'})}</span><button data-cal="1" aria-label="Next month">›</button></div><div class="cal" id="cal">${h}</div>`;
}
function openWhen(ids, o={}){
  calMonth = 0;
  const head = o.accept ? 'Accept and schedule' : o.claude ? 'New date' : o.deadline ? 'Deadline' : 'When';
  const simple = o.claude || o.deadline;
  const html = `<div class="pop-head">${head}</div>
    <input id="when-input" placeholder="Type: tomorrow, next fri, in 2 weeks" autocomplete="off"><div class="pop-hint" id="when-hint"></div>
    ${simple ? '' : `<button class="opt" data-w="today">${I.star}Today</button><button class="opt" data-w="evening">${I.moon}This Evening</button>`}
    <div id="cal-wrap">${calHTML()}</div>
    ${simple ? (o.deadline ? `<button class="wclear" data-w="clear">Remove deadline</button>` : '') : `<button class="opt" data-w="someday">${I.someday}Someday</button><button class="wclear" data-w="clear">${o.accept?'Anytime':'Clear'}</button>`}`;
  showPop(html, e => { const c = e.target.closest('[data-cal]'); if (c) { calMonth = Math.max(0, calMonth + +c.dataset.cal); $('#cal-wrap').innerHTML = calHTML(); return; } const b = e.target.closest('[data-w]'); if (b) applyWhen(ids, b.dataset.w, o); });
  const inp = $('#when-input');
  inp.oninput = () => { const w = parseWhen(inp.value, S.day); $('#when-hint').textContent = inp.value ? (w && !(simple && !w.startsWith('d')) ? '→ ' + whenLabel(w) : 'Try “tomorrow”, “fri”, “in 3 days”') : ''; };
  inp.onkeydown = e => { if (e.key==='Enter') { const w = parseWhen(inp.value, S.day); if (w && !(simple && !w.startsWith('d'))) applyWhen(ids, w, o); } if (e.key==='Escape') closePop(); };
  setTimeout(() => wide() && inp.focus(), 50);
}
const whenLabel = w => w==='today'?'Today':w==='evening'?'This Evening':w==='someday'?'Someday':w==='clear'?'Anytime':dayLabel(S.day + +w.slice(1));
function applyWhen(ids, w, o={}){
  const k = w.startsWith('d') ? +w.slice(1) : (w==='today' ? 0 : null);
  if (o.claude) { if (k===null) return; snap(); ids.forEach(id => { const c = S.claude.find(x=>x.id===id); if (c) c.date = S.day + k; }); closePop(); render(); return toast(`New date for Claude: ${dayLabel(S.day+k)}`, true); }
  if (o.deadline) { snap(); ids.map(byId).filter(Boolean).forEach(t => { if (w==='clear') delete t.deadline; else if (k!==null) t.deadline = S.day + k; }); closePop(); render(); return toast(w==='clear' ? 'Deadline removed' : `Deadline ${dayLabel(S.day+k)}`, true); }
  const ts = ids.map(byId).filter(Boolean); if (!ts.length) return closePop();
  if (ts.some(t => t.repeat) && (w==='someday' || w==='clear')) { closePop(); return toast('Repeating to-dos need a date'); }
  snap(); closePop();
  ts.forEach(t => {
    if (o.accept) { t.reason = t.sugg; delete t.sugg; }
    if (w==='today' || k===0) { t.start='date'; t.date=S.day; t.evening=false; }
    else if (w==='evening') { t.start='date'; t.date=S.day; t.evening=true; }
    else if (w==='someday') { t.start='someday'; delete t.date; t.evening=false; }
    else if (w==='clear') { t.start='anytime'; delete t.date; t.evening=false; }
    else { t.start='date'; t.date=S.day+k; t.evening=false; }
  });
  if (S.select) { S.select=false; S.sel.clear(); renderSel(); }
  S.open = null; render();
  toast(`${ts.length>1?ts.length+' to-dos':'“'+ts[0].title+'”'} → ${k>0 ? 'Upcoming, '+dayLabel(S.day+k) : whenLabel(k===0?'today':w)}`, true);
}
// Repeat picker: on a schedule (every day / weekday / week / month / year) or after completion; optional end
function openRepeat(t){
  const d = t.start==='date' && t.date!==undefined ? t.date : S.day, wd = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow(d)];
  const opts = [
    ['daily', 'Every day', {freq:'daily'}], ['weekdays', 'Every weekday', {freq:'weekly', byweekday:[1,2,3,4,5]}],
    ['weekly', `Every week on ${wd}`, {freq:'weekly', byweekday:[dow(d)]}], ['biweekly', `Every 2 weeks on ${wd}`, {freq:'weekly', interval:2, byweekday:[dow(d)]}],
    ['monthly', `Every month on the ${ordinal(dom(d))}`, {freq:'monthly', bymonthday:dom(d)}],
    ['yearly', `Every year on ${fmtD(d,{month:'short',day:'numeric'})}`, {freq:'yearly'}],
    ['a-1d', 'A day after I finish', {mode:'after', freq:'daily'}], ['a-1w', 'A week after I finish', {mode:'after', freq:'weekly'}],
    ['a-2w', '2 weeks after I finish', {mode:'after', freq:'weekly', interval:2}], ['a-1m', 'A month after I finish', {mode:'after', freq:'monthly'}],
  ];
  const html = `<div class="pop-head">Repeat</div>${opts.slice(0,6).map(([k,l]) => `<button class="opt" data-rp="${k}">${esc(l)}</button>`).join('')}
    <div class="pop-hint" style="padding-top:8px">After completion</div>${opts.slice(6).map(([k,l]) => `<button class="opt" data-rp="${k}">${esc(l)}</button>`).join('')}
    <input id="rp-end" placeholder="Ends: after 10 times, or a date (blank = never)" autocomplete="off" style="margin-top:8px"><div class="pop-hint" id="rp-hint"></div>
    ${t.repeat ? `<button class="wclear" data-rp="never">Don’t repeat</button>` : ''}`;
  const parseEnd = v => { v = v.trim().toLowerCase(); if (!v) return {}; let m = v.match(/^(?:after )?(\d{1,3})(?: times?)?$/); if (m && +m[1] > 0) return {end:{after:+m[1]}}; const w = parseWhen(v.replace(/^(on|until) /, ''), S.day); if (w && w.startsWith('d')) return {end:{on:diso(S.day + +w.slice(1))}}; return null; };
  showPop(html, e => {
    const b = e.target.closest('[data-rp]'); if (!b) return;
    const end = parseEnd($('#rp-end').value); if (end === null) { $('#rp-hint').textContent = 'Try “10 times” or a date like “dec 31”'; return; }
    closePop(); snap();
    if (b.dataset.rp === 'never') { delete t.rule; delete t.repeat; render(); return toast(`“${t.title}” won’t repeat`, true); }
    const rule = {mode:'schedule', interval:1, ...opts.find(o => o[0] === b.dataset.rp)[2], ...end};
    if (!(t.start === 'date' && t.date !== undefined)) { t.start = 'date'; t.date = S.day; }
    t.rule = rule; t.repeat = repeatFromRule(rule, t.date); render();
    toast(`Repeats ${repeatText(t.repeat, t.rule)}`, true);
  });
  $('#rp-end').oninput = () => { const v = parseEnd($('#rp-end').value); $('#rp-hint').textContent = v === null ? 'Try “10 times” or a date like “dec 31”' : v.end ? (v.end.after ? `Ends after ${v.end.after} times` : `Ends ${dayLabel(dnum(v.end.on))}`) : ''; };
}
function openMove(ids){
  const cur = ids.length===1 ? byId(ids[0]) : null;
  let h = `<div class="pop-head">Move</div><button class="opt" data-m="inbox">${I.inbox}Inbox</button>`;
  S.areas.forEach(a => {
    h += `<button class="opt ${cur&&cur.area===a.id&&!cur.project?'cur':''}" data-m="area:${esc(a.id)}"><span style="color:var(--area)">${I.area}</span>${esc(a.title)}</button>`;
    openProjects().filter(p => p.area===a.id).forEach(p => h += `<button class="opt sub ${cur&&cur.project===p.id?'cur':''}" data-m="project:${esc(p.id)}">${pie(progress(p.id),16)}${esc(p.title)}</button>`);
  });
  showPop(h, e => { const b = e.target.closest('[data-m]'); if (!b) return; closePop(); dropTo(ids, b.dataset.m); });
}
function openTags(t){
  const all = [...new Set(S.todos.flatMap(x => x.tags||[]))].sort();
  const draw = () => `<div class="pop-head">Tags</div>${all.map(g => `<button class="opt" data-tag="${esc(g)}">${sized(I.tag,18,'color:var(--fg-3)')}${esc(g)}<span style="margin-left:auto;color:var(--accent)">${(t.tags||[]).includes(g)?'✓':''}</span></button>`).join('')}<input id="new-tag" placeholder="New tag" maxlength="40" style="margin-top:6px">`;
  showPop(draw(), e => { const b = e.target.closest('[data-tag]'); if (!b) return; const g = b.dataset.tag; t.tags = t.tags || []; t.tags = t.tags.includes(g) ? t.tags.filter(x=>x!==g) : [...t.tags, g]; if (!t.tags.length) delete t.tags; $('.pop').innerHTML = draw(); bindNew(); render(); });
  const bindNew = () => { const n = $('#new-tag'); if (n) n.onkeydown = e => { const v = n.value.trim(); if (e.key==='Enter' && v) { if (!all.includes(v)) all.push(v); t.tags = [...new Set([...(t.tags||[]), v])]; $('.pop').innerHTML = draw(); bindNew(); render(); } }; };
  bindNew();
}
function dropTo(ids, dest){
  const ts = ids.map(byId).filter(Boolean); if (!ts.length) return;
  if (dest==='someday' && ts.some(t => t.repeat)) return toast('Repeating to-dos need a date');
  snap();
  ts.forEach(t => {
    if (dest==='inbox') { if (t.repeat) return; t.start='inbox'; delete t.area; delete t.project; delete t.heading; delete t.date; t.evening=false; }
    else if (dest==='today') { t.start='date'; t.date=S.day; t.evening=false; }
    else if (dest==='someday') { t.start='someday'; delete t.date; t.evening=false; }
    else if (dest==='anytime') { if (!(t.start==='date' && t.date<=S.day) && !t.repeat) { t.start='anytime'; delete t.date; t.evening=false; } }
    else if (dest==='trash') t.trashed = true;
    else if (dest.startsWith('area:')) { t.area=dest.slice(5); delete t.project; delete t.heading; if (t.start==='inbox') t.start='anytime'; }
    else if (dest.startsWith('project:')) { t.project=dest.slice(8); t.area = proj(t.project)?.area; delete t.heading; if (t.start==='inbox') t.start='anytime'; }
  });
  if (S.select) { S.select=false; S.sel.clear(); renderSel(); }
  S.open = null; render();
  const name = {inbox:'Inbox',today:'Today',someday:'Someday',anytime:'Anytime',trash:'Trash'}[dest] || (dest.startsWith('area:') ? area(dest.slice(5))?.title : proj(dest.slice(8))?.title);
  toast(`${ts.length>1?ts.length+' to-dos':'“'+ts[0].title+'”'} → ${name}`, true);
}

/* ---------- Quick Find ---------- */
function openFind(q){ closeOpen(false); exitSelect(false); $('#find-ov').hidden = false; const inp = $('#find-input'); inp.value = q; inp.focus(); findResults(q); }
function closeFind(){ $('#find-ov').hidden = true; }
function findResults(q){
  q = q.trim().toLowerCase(); const m = s => String(s||'').toLowerCase().includes(q);
  const lists = [['inbox','Inbox',I.inbox],['today','Today',I.star],['upcoming','Upcoming',I.upcoming],['anytime','Anytime',I.anytime],['someday','Someday',I.someday],['logbook','Logbook',I.logbook],['trash','Trash',I.trash],['claude','Claude',I.claude],['settings','Settings',I.gear],['find:deadlines','Deadlines',sized(I.deadline,18,'color:var(--deadline)')],['find:repeating','Repeating',sized(I.repeat,18)]];
  const tags = [...new Set(S.todos.flatMap(t => t.tags||[]))];
  const res = [];
  if (!q) { res.push(['Quick lists', lists.slice(9).map(([r,l,i]) => ({r,l,i}))]); res.push(['Tags', tags.map(tg => ({r:'tag:'+tg,l:tg,i:I.tag}))]); }
  else {
    res.push(['Lists', lists.filter(x => m(x[1])).map(([r,l,i]) => ({r,l,i}))]);
    res.push(['Areas', S.areas.filter(a => m(a.title)).map(a => ({r:'area:'+a.id,l:a.title,i:`<span style="color:var(--area)">${I.area}</span>`}))]);
    res.push(['Projects', openProjects().filter(p => m(p.title)).map(p => ({r:'project:'+p.id,l:p.title,i:pie(progress(p.id),18)}))]);
    res.push(['Tags', tags.filter(m).map(tg => ({r:'tag:'+tg,l:tg,i:I.tag}))]);
    res.push(['To-dos', S.todos.filter(t => live(t) && m(t.title)).slice(0,12).map(t => ({tid:t.id,l:t.title,sub:placeOf(t),i:'<span class="cb sm"></span>'}))]);
  }
  const html = res.filter(g => g[1].length).map(([g, items]) => `<div class="fr-head">${g}</div>` + items.map(x => `<button class="fr" ${x.r?`data-r="${esc(x.r)}"`:`data-tid="${esc(x.tid)}"`}>${x.i}<span class="fr-l">${esc(x.l)}</span>${x.sub?`<span class="fr-sub">${esc(x.sub)}</span>`:''}</button>`).join('')).join('');
  $('#find-res').innerHTML = html || `<div class="empty">No matches for “${esc(q)}”.</div>`;
  $$('#find-res .fr').forEach(b => b.onclick = () => {
    closeFind();
    if (b.dataset.r) return go(b.dataset.r);
    const t = byId(b.dataset.tid), r = inToday(t) ? 'today' : t.project ? 'project:'+t.project : t.area ? 'area:'+t.area : t.start==='inbox' ? 'inbox' : 'anytime';
    go(r, true, () => openRow(t.id));
  });
}
$('#find-input').oninput = e => findResults(e.target.value);
$('#find-input').onkeydown = e => { if (e.key==='Escape') closeFind(); if (e.key==='Enter') { const f = $('#find-res .fr'); f && f.click(); } };
$('#find-cancel').onclick = closeFind;
document.addEventListener('keydown', e => {
  if (!S.loaded || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || !/\S/.test(e.key)) return;
  if (e.target.closest && e.target.closest('input,textarea,select,[contenteditable="true"]')) return;
  if (!$('#find-ov').hidden || !$('#scrim').hidden || !wide()) return;
  e.preventDefault(); openFind(e.key);
});

/* ---------- Plus: tap = new here (menu on Lists); drag = place it ---------- */
(() => {
  const plus = $('#plus'); let st=null, dragging=false, sup=false, target=null;
  const ghost = $('#ghostp'), ins = $('#ins'), inboxT = $('#inbox-target');
  plus.addEventListener('pointerdown', e => { st = {x:e.clientX, y:e.clientY}; dragging=false; });
  plus.addEventListener('pointermove', e => {
    if (!st) return;
    if (!dragging && Math.hypot(e.clientX-st.x, e.clientY-st.y) > 10) { dragging = true; plus.setPointerCapture(e.pointerId); ghost.hidden = false; inboxT.hidden = false; plus.style.opacity = '.35'; }
    if (!dragging) return;
    const app = $('#app').getBoundingClientRect(); ghost.style.left = (e.clientX-app.left-20)+'px'; ghost.style.top = (e.clientY-app.top-20)+'px';
    target = findTarget(e.clientX, e.clientY); inboxT.classList.toggle('hot', !!target && target.kind==='inbox');
    if (target && (target.kind==='row' || target.kind==='heading-split')) {
      const r = target.el.getBoundingClientRect(), y = target.after ? r.bottom : r.top, hs = target.kind==='heading-split';
      ins.hidden = false; ins.classList.toggle('heading', hs); ins.style.top = (y-app.top-1)+'px'; ins.style.left = (r.left-app.left+(hs?0:24))+'px'; ins.style.width = (r.width-(hs?0:24))+'px';
    } else if (target && target.kind==='day') { const r = target.el.getBoundingClientRect(); ins.hidden=false; ins.classList.remove('heading'); ins.style.top=(r.bottom-app.top+2)+'px'; ins.style.left=(r.left-app.left)+'px'; ins.style.width=r.width+'px'; }
    else ins.hidden = true;
  });
  const end = () => { if (!st) return; st = null; plus.style.opacity = ''; ghost.hidden = true; ins.hidden = true; inboxT.hidden = true; inboxT.classList.remove('hot'); if (!dragging) return; sup = true; dragging = false; if (target) dropNew(target); target = null; };
  plus.addEventListener('pointerup', end); plus.addEventListener('pointercancel', end);
  plus.addEventListener('click', e => { e.stopPropagation(); if (sup) { sup=false; return; } tapPlus(); });
  function findTarget(x, y){
    ghost.hidden = true; const el = document.elementFromPoint(x, y); ghost.hidden = false; if (!el) return null;
    if (el.closest('#inbox-target')) return {kind:'inbox'};
    const day = el.closest('#view .day-head[data-day]'); if (day) return {kind:'day', el:day, day:+day.dataset.day};
    const row = el.closest('#view .row[data-id]:not(.sugg):not(.lb)');
    if (row && !byId(row.dataset.id)?.logged) { const r = row.getBoundingClientRect(), after = y > r.top + r.height/2;
      if (S.route.startsWith('project:') && x - r.left < 28) return {kind:'heading-split', el:row, id:row.dataset.id, after};
      return {kind:'row', el:row, id:row.dataset.id, after}; }
    return null;
  }
  function dropNew(tg){
    if (tg.kind === 'inbox') { return go('inbox', true, () => { const t = newTodo({start:'inbox'}); S.todos.unshift(t); S.open = t.id; render(); focusNew(t); }); }
    if (tg.kind === 'day') { const t = newTodo({start:'date', date:tg.day}); S.todos.push(t); S.open = t.id; render(); return focusNew(t); }
    const ref = byId(tg.id); if (!ref) return;
    if (tg.kind === 'heading-split') return splitHeading(ref, tg.after);
    const t = newTodo({start:ref.start, evening:ref.evening, date:ref.date, area:ref.area, project:ref.project, heading:ref.heading});
    if (S.route==='today') { t.start='date'; t.date=S.day; }
    if (t.start!=='date') delete t.date;
    S.todos.push(t); placeRelative([t], ref, tg.after); S.open = t.id; render(); focusNew(t);
  }
})();
function newTodo(o){ return {id:'new-'+S.nid++, title:'', notes:'', ...o}; }
// Plus dropped at the far left in a project: a new heading that takes this row (or the rows below it) with it
function splitHeading(ref, after){
  const p = proj(ref.project); if (!p) return;
  snap();
  const name = (() => { let n = 'New Heading', k = 2; while (p.headings.some(h => h.title === n)) n = 'New Heading ' + k++; return n; })();
  const h = {id:'new-h'+S.nid++, title:name};
  const group = $$('#view .row[data-id]:not(.sugg):not(.lb)').map(li => byId(li.dataset.id)).filter(t => t && t.project===p.id && !t.logged && (t.heading||null)===(ref.heading||null));
  group.slice(group.indexOf(ref) + (after ? 1 : 0)).forEach(t => t.heading = h.id);
  const hi = ref.heading ? p.headings.findIndex(x => x.id===ref.heading) + 1 : 0;
  p.headings.splice(hi, 0, h); render();
  const el = document.querySelector(`[data-hid="${CSS.escape(h.id)}"]`); if (el) { el.focus(); document.getSelection().selectAllChildren(el); }
  toast('New heading', true);
}
function focusNew(t){ const tx = document.querySelector(`.row[data-id="${CSS.escape(t.id)}"] .tx`); tx && tx.focus(); }
function tapPlus(){
  closeOpen(false);
  if (S.route === 'home') return showPop(`<button class="opt" data-n="todo">${I.plus}<span class="opt-desc">New To-Do<small>Quickly add a to-do to your Inbox.</small></span></button>
      <button class="opt" data-n="project">${pie(.6,18)}<span class="opt-desc">New Project<small>Define a goal, then work toward it one to-do at a time.</small></span></button>
      <button class="opt" data-n="area"><span style="color:var(--area)">${I.area}</span><span class="opt-desc">New Area<small>Group projects and to-dos by responsibility, like Family or Work.</small></span></button>`,
      ev => { const b = ev.target.closest('[data-n]'); if (!b) return; closePop(); newThing(b.dataset.n); });
  newThing('todo');
}
function newThing(kind){
  if (kind === 'area') { const id='new-a'+S.nid++; S.areas.push({id,title:''}); return go('area:'+id, true, () => $('#title-edit')?.focus()); }
  if (kind === 'project') { const id='new-p'+S.nid++; const a = S.route.startsWith('area:') ? S.route.slice(5) : undefined; S.projects.push({id,area:a,title:'',notes:'',headings:[]}); return go('project:'+id, true, () => $('#title-edit')?.focus()); }
  const r = S.route, t = newTodo({start:'inbox'});
  if (r==='home') { S.route = 'inbox'; try { history.pushState({r:'inbox'}, '', '#inbox'); } catch (e) { /* ok */ } }
  if (r==='today') { t.start='date'; t.date=S.day; }
  if (r==='anytime') t.start='anytime';
  if (r==='someday') t.start='someday';
  if (r==='upcoming') { t.start='date'; t.date=S.day+1; }
  if (r.startsWith('area:')) { t.area=r.slice(5); t.start='anytime'; }
  if (r.startsWith('project:')) { t.project=r.slice(8); t.area=proj(t.project)?.area; t.start='anytime'; }
  const key = r==='today' ? 'ti' : 'si', others = S.todos.filter(x => x[key] !== undefined);
  if (others.length) t[key] = Math.min(...others.map(x => x[key])) - 10; // new to-dos go on top
  S.todos.unshift(t); S.open = t.id; render(); focusNew(t);
}

/* ---------- Feedback (shake on phone; Settings on web) ---------- */
function openFeedback(){
  showPop(`<div class="pop-head">Send feedback</div><textarea class="fb-note" id="fb-note" placeholder="What happened, or what would you change?"></textarea>
    <p class="pop-hint">Sent with the name of this screen. Saved as feedback, not as a to-do.</p><button class="wclear" data-send style="background:var(--accent);color:var(--on-accent)">Send</button><button class="wclear" data-cancel>Cancel</button>`,
    async e => {
      if (e.target.closest('[data-cancel]')) return closePop();
      if (!e.target.closest('[data-send]')) return;
      const note = $('#fb-note').value.trim(); if (!note) return $('#fb-note').focus();
      closePop();
      try { await api('POST', '/api/v1/feedback', {note, screen: S.route.split(':')[0], app_version: VERSION, device: (navigator.userAgent||'').slice(0,120)}); S.feedbackSent++; toast('Feedback sent. Thank you'); if (S.route==='settings') render(); }
      catch (err) { toast('Couldn’t send feedback. Try again in a moment'); }
    });
  setTimeout(() => $('#fb-note')?.focus(), 50);
}
let lastShake = 0;
addEventListener('devicemotion', e => { const a = e.accelerationIncludingGravity; if (!a) return; const f = Math.hypot(a.x||0, a.y||0, a.z||0); if (f > 30 && $('#scrim').hidden && Date.now() - lastShake > 3000 && S.loaded) { lastShake = Date.now(); openFeedback(); } });

/* ---------- toast + undo ---------- */
const clone = t => ({...t, _to:undefined, _busy:undefined, checklist: t.checklist && t.checklist.map(c=>({...c})), tags: t.tags && [...t.tags]});
function snap(){ S.undo = {todos: S.todos.map(clone), claude: S.claude.map(c=>({...c})), projects: S.projects.map(p=>({...p, _busy:undefined, headings: p.headings.map(h=>({...h}))}))}; }
let tt;
function toast(msg, undo=false){ $('#toast-text').textContent = msg; $('#toast-undo').hidden = !undo; $('#toast').classList.add('show'); clearTimeout(tt); tt = setTimeout(() => { $('#toast').classList.remove('show'); S.undo = null; }, 3400); }
$('#toast-undo').onclick = () => { if (S.undo) { S.todos = S.undo.todos; S.claude = S.undo.claude; S.projects = S.undo.projects; S.undo = null; S.open = null; render(); } $('#toast').classList.remove('show'); };

/* ---------- server ---------- */
async function api(method, path, body){
  const r = await fetch(path, {method, credentials:'same-origin', headers: body ? {'content-type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const d = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error((d && d.error) || ('HTTP ' + r.status)), {status:r.status});
  return d;
}
// Last known server state, as wire() objects (to-dos) and plain records (Claude items, projects, areas)
const base = {todos:new Map(), claude:new Map(), projects:new Map(), areas:new Map(), headings:new Map(), time:{}};
const projWire = p => ({title:(p.title||'').trim(), notes:(p.notes||'').trim() || null, area_id:p.area||null, status:p.done?'completed':'open'});

function applyState(st){
  S.tz = st.tz || S.tz; S.day = dnum(st.today); S.min = zoned(Date.now(), S.tz).min;
  const rows = st.tasks || [];
  const mine = rows.filter(r => r.list !== 'Claude'), cl = rows.filter(r => r.list === 'Claude' && r.status !== 'canceled' && r.status !== 'trashed');
  const keepOpen = S.open;
  S.todos = mine.map(r => fromServer(r, S.tz));
  S.claude = cl.map(r => claudeFromServer(r, S.tz));
  S.completions = st.completions || [];
  S.areas = (st.areas || []).map(a => ({id:a.id, title:a.title}));
  S.projects = (st.projects || []).map(p => ({id:p.id, area:p.area_id || undefined, title:p.title, notes:p.notes || '', deadline: p.deadline ? dnum(p.deadline) : undefined, done: p.status !== 'open', headings: p.headings || []}));
  S.events = buildEvents(st.events || [], S.tz);
  S.brief = st.brief; S.theme = st.theme; S.health = st.health || [];
  applySettings(st.settings);
  S.time = {...(st.time || {})}; base.time = {...S.time};
  S.timer = st.timer ? {id: st.timer.task_id, t0: Date.parse(st.timer.started_at)} : null; S.timerTitle = st.timer ? st.timer.title : '';
  base.todos = new Map(S.todos.map(t => [t.id, wire(t)]));
  base.claude = new Map(S.claude.map(c => [c.id, {date:c.date, dropped:false}]));
  base.projects = new Map(S.projects.map(p => [p.id, projWire(p)]));
  base.areas = new Map(S.areas.map(a => [a.id, a.title]));
  base.headings = new Map(S.projects.map(p => [p.id, p.headings.map((h, i) => ({id:h.id, title:h.title, pos:i}))]));
  // Items already in Today before this load don't get the "new" dot again today
  S.open = keepOpen && byId(keepOpen) ? keepOpen : null;
  S.loaded = true; S.loadError = false;
}
async function load(){
  try { await syncNow(); } catch (e) { /* keep going: the reload shows the server state */ }
  try { const st = await api('GET', '/api/v1/state'); applyState(st); render(); saveCache(st); }
  catch (e) { if (!S.loaded) { S.loadError = true; render(false); } setTimeout(load, 15000); }
}
// Instant launch: the last state (this device only) paints first, the network replaces it (stale-while-revalidate)
function saveCache(st){ try { localStorage.setItem('myos.v1.state', JSON.stringify(st)); } catch (e) { /* quota/private mode: skip */ } }
function paintCached(){
  try {
    const st = JSON.parse(localStorage.getItem('myos.v1.state') || 'null');
    if (!st || !st.today) return false;
    applyState(st); S.stale = true; render(false); return true;
  } catch (e) { return false; }
}

// Send what changed since the last server state. Runs after renders and edits (debounced), one pass at a time.
let syncTimer = null, syncing = null, syncAgain = false, failures = 0;
function scheduleSync(ms=600){ clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow().catch(() => {}), ms); }
async function syncNow(){
  if (!S.loaded) return;
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    try {
      for (const a of [...S.areas]) await syncArea(a);
      for (const p of [...S.projects]) await syncProject(p);
      for (const t of [...S.todos]) await syncTodo(t);
      await syncClaude();
      failures = 0; $('#sync-err').hidden = true;
    } catch (e) {
      failures++; $('#sync-err').hidden = false;
      if (e.status === 400 || e.status === 404) { toast('Couldn’t save that change: ' + e.message); await reloadAfterError(); }
      else setTimeout(() => syncNow().catch(() => {}), Math.min(30000, 2000 * failures));
    } finally {
      syncing = null;
      if (syncAgain) { syncAgain = false; scheduleSync(50); }
    }
  })();
  return syncing;
}
async function reloadAfterError(){ try { applyState(await api('GET', '/api/v1/state')); $('#sync-err').hidden = true; render(); } catch (e) { /* retry on the next sync */ } }

function renameId(kind, oldId, newId){
  const u = S.undo;
  if (u) { const list = kind === 'todo' ? u.todos : kind === 'project' ? u.projects : []; list.forEach(x => { if (x.id === oldId) x.id = newId; });
    if (kind === 'project') u.todos.forEach(x => { if (x.project === oldId) x.project = newId; });
    if (kind === 'area') { u.todos.forEach(x => { if (x.area === oldId) x.area = newId; }); u.projects.forEach(x => { if (x.area === oldId) x.area = newId; }); } }
  if (kind === 'todo') { if (S.timer && S.timer.id === oldId) S.timer.id = newId; if (S.open === oldId) S.open = newId; if (S.sel.has(oldId)) { S.sel.delete(oldId); S.sel.add(newId); } }
  if (kind === 'project') { S.todos.forEach(t => { if (t.project === oldId) t.project = newId; }); if (S.route === 'project:'+oldId) { S.route = 'project:'+newId; try { history.replaceState({r:S.route}, '', '#'+S.route); } catch (e) { /* ok */ } } }
  if (kind === 'area') { S.todos.forEach(t => { if (t.area === oldId) t.area = newId; }); S.projects.forEach(p => { if (p.area === oldId) p.area = newId; }); if (S.route === 'area:'+oldId) { S.route = 'area:'+newId; try { history.replaceState({r:S.route}, '', '#'+S.route); } catch (e) { /* ok */ } } }
  const ed = document.querySelector(`[data-id="${CSS.escape(oldId)}"]`); if (ed) ed.dataset.id = newId;
}
async function syncTodo(t){
  if (t._busy) return;
  const b = base.todos.get(t.id);
  if (!b) {
    if (!t.title.trim() || t.trashed || t.logged) return; // empty drafts stay local; discarded on close
    if (String(t.project||'').startsWith('new-') || String(t.area||'').startsWith('new-') || String(t.heading||'').startsWith('new-')) return; // its project/area/heading is saved first
    t._busy = true;
    try {
      const r = await api('POST', '/api/v1/tasks', createBody(t));
      const old = t.id; t.id = r.id; renameId('todo', old, r.id);
      base.todos.set(r.id, wire(fromServer(r, S.tz)));
    } finally { t._busy = false; }
    return syncTodo(t); // anything typed while the create was in flight
  }
  if (String(t.heading||'').startsWith('new-')) return; // waits for its heading
  const w = wire(t), p = diffPatch(b, w);
  if (t._complete) p.completed = true;
  if (!Object.keys(p).length) return;
  t._busy = true;
  try {
    const r = await api('PATCH', '/api/v1/tasks/' + encodeURIComponent(t.id), p);
    const srv = fromServer(r, S.tz);
    base.todos.set(t.id, wire(srv));
    if (p.completed !== undefined || p.canceled !== undefined) {
      // The server decides what a completion means (repeats move to their next date)
      if (t._complete) S.completions.unshift({id:'local-'+S.nid++, task_id:t.id, title:t.title, completed_at:new Date().toISOString(), area_id:t.area, project_id:t.project});
      for (const k of Object.keys(t)) if (k !== '_to') delete t[k];
      Object.assign(t, srv);
      render();
    }
  } finally { t._busy = false; }
}
async function syncClaude(){
  for (const c of S.claude) {
    const b = base.claude.get(c.id); if (!b) continue;
    if (b.dropped) { await api('PATCH', '/api/v1/tasks/' + encodeURIComponent(c.id), {canceled:false}); b.dropped = false; }
    if (c.date !== b.date && c.date !== undefined) { await api('PATCH', '/api/v1/tasks/' + encodeURIComponent(c.id), {start:'date', start_date: diso(c.date)}); b.date = c.date; }
  }
  for (const [id, b] of base.claude) {
    if (!b.dropped && !S.claude.some(c => c.id === id)) { await api('PATCH', '/api/v1/tasks/' + encodeURIComponent(id), {canceled:true}); b.dropped = true; }
  }
}
async function syncProject(p){
  if (p._busy) return;
  const b = base.projects.get(p.id), w = projWire(p);
  if (!b) {
    if (!w.title || (p.area && p.area.startsWith('new-'))) return;
    p._busy = true;
    try { const r = await api('POST', '/api/v1/projects', {title:w.title, area_id:w.area_id, notes:w.notes}); const old = p.id; p.id = r.id; renameId('project', old, r.id); base.projects.set(r.id, {...w, status:'open'}); }
    finally { p._busy = false; }
    return syncProject(p);
  }
  const patch = {};
  if (w.title !== b.title && w.title) patch.title = w.title;
  if (w.notes !== b.notes) patch.notes = w.notes;
  if (w.area_id !== b.area_id) patch.area_id = w.area_id;
  if (w.status !== b.status) patch.status = w.status;
  p._busy = true;
  try {
    if (Object.keys(patch).length) { await api('PATCH', '/api/v1/projects/' + encodeURIComponent(p.id), patch); base.projects.set(p.id, {...b, ...patch}); }
    await syncHeadings(p);
  } finally { p._busy = false; }
}
// Headings: create new ones, rename, and keep their order (sort = position * 10); removed ones are archived
async function syncHeadings(p){
  const known = base.headings.get(p.id) || [];
  for (const h of p.headings) {
    if (!h.id.startsWith('new-')) continue;
    const r = await api('POST', '/api/v1/headings', {project_id:p.id, title:(h.title||'').trim() || 'Untitled'});
    const old = h.id; h.id = r.id; S.todos.forEach(t => { if (t.heading === old) t.heading = r.id; });
    if (S.undo) S.undo.todos.forEach(t => { if (t.heading === old) t.heading = r.id; });
    const el = document.querySelector(`[data-hid="${CSS.escape(old)}"]`); if (el) el.dataset.hid = r.id;
    known.push({id:r.id, title:r.title, pos:-1});
  }
  for (let i = 0; i < p.headings.length; i++) {
    const h = p.headings[i], k = known.find(x => x.id === h.id), title = (h.title||'').trim(), patch = {};
    if (!k) continue;
    if (title && title !== k.title) patch.title = title;
    if (k.pos !== i) patch.sort = (i + 1) * 10;
    if (Object.keys(patch).length) { await api('PATCH', '/api/v1/headings/' + encodeURIComponent(h.id), patch); Object.assign(k, {title: patch.title ?? k.title, pos: i}); }
  }
  for (const k of known) if (!k.archived && !p.headings.some(h => h.id === k.id)) { await api('PATCH', '/api/v1/headings/' + encodeURIComponent(k.id), {archived:true}); k.archived = true; }
  base.headings.set(p.id, known.filter(k => !k.archived || p.headings.some(h => h.id === k.id)));
}
async function syncArea(a){
  if (a._busy) return;
  const title = (a.title||'').trim(), b = base.areas.get(a.id);
  if (b === undefined) {
    if (!title) return;
    a._busy = true;
    try { const r = await api('POST', '/api/v1/areas', {title}); const old = a.id; a.id = r.id; renameId('area', old, r.id); base.areas.set(r.id, title); }
    finally { a._busy = false; }
    return;
  }
  if (title && title !== b) { a._busy = true; try { await api('PATCH', '/api/v1/areas/' + encodeURIComponent(a.id), {title}); base.areas.set(a.id, title); } finally { a._busy = false; } }
}

/* ---------- start ---------- */
addEventListener('resize', () => { const w = wide(); if (w !== $('#device').classList.contains('wide')) render(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { leaveRoute(); syncNow().catch(() => {}); }
  else if (S.loaded && Date.now() - (S.loadedAt || 0) > 120000) { S.loadedAt = Date.now(); load(); }
});
setInterval(() => { if (!S.loaded) return; const before = S.min; tick(); if (S.min !== before && S.route === 'today' && S.open === null && !D && $('#scrim').hidden) render(); }, 30000);
const fromHash = decodeURIComponent(location.hash.slice(1));
S.route = fromHash || (wide() ? 'today' : 'home');
try { history.replaceState({r:S.route}, '', '#'+S.route); } catch (e) { /* ok */ }
$('#dropbar').innerHTML = [['today', I.star, 'Today'], ['evening', I.moon, 'Evening'], ['someday', I.someday, 'Someday'], ['inbox', I.inbox, 'Inbox'], ['move', sized(I.dots, 22, 'color:var(--accent)'), 'Move…']]
  .map(([k, icon, l]) => `<span data-drop="${k}">${sized(icon, 22)}${l}</span>`).join('');
// Android shell: back button handling. Returns true when the app handled it (closed something or went back a level).
// Exposed as window.myosBack too, in case the shell injects myosShell after the page loads.
const onShellBack = () => {
  if (!$('#find-ov').hidden) { closeFind(); return true; }
  if (!$('#scrim').hidden) { closePop(); return true; }
  if (S.open !== null) { closeOpen(); return true; }
  if (S.select) { exitSelect(); return true; }
  const top = wide() ? 'today' : 'home';
  if (S.route !== top) { goBack(); return true; }
  return false; // at the top: let the shell exit / background the app
};
window.myosBack = onShellBack;
if (window.myosShell) window.myosShell.onBack = onShellBack;
// Keyboard: keep bottom controls above it and the layout still (visualViewport)
if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => { const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)); document.documentElement.style.setProperty('--kb', (kb > 80 ? kb : 0) + 'px'); };
  vv.addEventListener('resize', onVV); vv.addEventListener('scroll', onVV);
}
// App shell cache (works in a browser and inside a Capacitor WebView; skipped where unsupported)
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
document.documentElement.classList.toggle('in-shell', !!window.Capacitor);

if (!paintCached()) render(false);
S.loadedAt = Date.now();
load();
