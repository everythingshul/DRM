// public/js/utils.js

// ── Icons (SVG, no emojis) ──────────────────────────────────────────────
const Icon = {
  _s: (path, vb='0 0 24 24') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;display:inline-block;vertical-align:-2px">${path}</svg>`,
  dashboard:  () => Icon._s('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'),
  donors:     () => Icon._s('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  donations:  () => Icon._s('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  check:      () => Icon._s('<polyline points="20 6 9 17 4 12"/>'),
  x:          () => Icon._s('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  bank:       () => Icon._s('<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/>'),
  email:      () => Icon._s('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  scroll:     () => Icon._s('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>'),
  chart:      () => Icon._s('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
  settings:   () => Icon._s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  alert:      () => Icon._s('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
  search:     () => Icon._s('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  plus:       () => Icon._s('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  edit:       () => Icon._s('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
  trash:      () => Icon._s('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
  eye:        () => Icon._s('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  card:       () => Icon._s('<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>'),
  repeat:     () => Icon._s('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  refund:     () => Icon._s('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.67"/>'),
  down:       () => Icon._s('<polyline points="6 9 12 15 18 9"/>'),
  up:         () => Icon._s('<polyline points="18 15 12 9 6 15"/>'),
  menu:       () => Icon._s('<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>'),
  note:       () => Icon._s('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>'),
  user:       () => Icon._s('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  signout:    () => Icon._s('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  calendar:   () => Icon._s('<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  download:   () => Icon._s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  upload:     () => Icon._s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
};

// ── Toast ───────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity 0.3s'; setTimeout(()=>t.remove(),350); }, 3500);
}

// ── Modal ───────────────────────────────────────────────────────────────
const Modal = {
  open(title, bodyHtml, opts={}) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    const box = document.getElementById('modal-box');
    box.className = 'modal-box' + (opts.large?' modal-lg':'') + (opts.small?' modal-sm':'');
    document.getElementById('modal-overlay').style.display = 'flex';
    if (opts.onOpen) setTimeout(opts.onOpen, 0);
  },
  close() {
    document.getElementById('modal-overlay').style.display = 'none';
    document.getElementById('modal-body').innerHTML = '';
  },
  setBody(html)  { document.getElementById('modal-body').innerHTML = html; },
  setTitle(t)    { document.getElementById('modal-title').textContent = t; }
};
document.getElementById('modal-close')?.addEventListener('click', Modal.close);
document.getElementById('modal-overlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) Modal.close();
});

// ── Formatters ──────────────────────────────────────────────────────────
function fmt$(n) {
  return '$' + parseFloat(n||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'}); }
  catch { return d; }
}
function fmtDateTime(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-US', {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}); }
  catch { return d; }
}
function accountAge(months) {
  if (!months && months!==0) return '—';
  const m = parseInt(months);
  if (m < 12) return m+'mo';
  const y = Math.floor(m/12), r = m%12;
  return r>0 ? `${y}y ${r}mo` : `${y}y`;
}
function fmtMethod(method) {
  const map = { credit_card:'Credit Card', daf:'DAF', check:'Check', cash:'Cash', wire:'Wire', other:'Other' };
  return map[method] || method;
}
function fmtFrequency(f) {
  const map = { weekly:'Weekly', biweekly:'Bi-Weekly', monthly:'Monthly', quarterly:'Quarterly', yearly:'Yearly', once:'One-Time' };
  return map[f] || f;
}
function toLocalInput(d) {
  if (!d) return '';
  try {
    const dt = new Date(d), pad = n => String(n).padStart(2,'0');
    return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  } catch { return ''; }
}

// ── Avatar ──────────────────────────────────────────────────────────────
function initials(f,l){ return ((f||'')[0]||'')+((l||'')[0]||''); }
function avatarHtml(donor, size=32) {
  return `<div class="donor-avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size/2.7)}px">${initials(donor.first_name,donor.last_name)}</div>`;
}

// ── Status badge ────────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    completed:'Completed', pending:'Pending', failed:'Failed',
    scheduled:'Scheduled', cancelled:'Cancelled',
    refunded:'Refunded', partial_refund:'Partial Refund', active:'Active', paused:'Paused'
  };
  return `<span class="status-badge status-${status}">${map[status]||status}</span>`;
}

// ── Confirm dialog ──────────────────────────────────────────────────────
function confirm(msg, onYes) {
  Modal.open('Confirm', `
    <p style="margin-bottom:18px;color:var(--gray-700)">${msg}</p>
    <div class="btn-group">
      <button class="btn btn-danger btn-sm" id="confirm-yes">Confirm</button>
      <button class="btn btn-ghost btn-sm" id="confirm-no">Cancel</button>
    </div>
  `, {small:true});
  document.getElementById('confirm-yes').onclick = ()=>{ Modal.close(); onYes(); };
  document.getElementById('confirm-no').onclick = Modal.close;
}

// ── Pagination ──────────────────────────────────────────────────────────
function paginationHtml(page, pages, onPageFn) {
  if (pages <= 1) return '';
  let html = '<div class="pagination">';
  if (page > 1) html += `<button class="btn btn-ghost btn-sm" onclick="${onPageFn}(${page-1})">&#8249;</button>`;
  const start = Math.max(1, page-2), end = Math.min(pages, page+2);
  if (start > 1) html += `<button class="btn btn-ghost btn-sm" onclick="${onPageFn}(1)">1</button>${start>2?'<span style="padding:0 4px">…</span>':''}`;
  for (let i=start; i<=end; i++) {
    html += `<button class="btn btn-sm ${i===page?'btn-primary':'btn-ghost'}" onclick="${onPageFn}(${i})">${i}</button>`;
  }
  if (end < pages) html += `${end<pages-1?'<span style="padding:0 4px">…</span>':''}<button class="btn btn-ghost btn-sm" onclick="${onPageFn}(${pages})">${pages}</button>`;
  if (page < pages) html += `<button class="btn btn-ghost btn-sm" onclick="${onPageFn}(${page+1})">&#8250;</button>`;
  html += '</div>';
  return html;
}

// ── Labels input widget ─────────────────────────────────────────────────
function labelsInput(containerId, initial=[]) {
  const c = document.getElementById(containerId);
  let labels = [...initial];
  function render() {
    c.innerHTML = `
      <div class="labels-wrap" id="${containerId}-tags">
        ${labels.map((l,i)=>`<span class="pill pill-blue">${l} <span style="cursor:pointer;margin-left:2px" onclick="window.__removeLabel_${containerId}(${i})">×</span></span>`).join('')}
      </div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input type="text" id="${containerId}-input" placeholder="Add label…" style="flex:1" autocomplete="off">
        <button type="button" class="btn btn-ghost btn-sm" onclick="window.__addLabel_${containerId}()">Add</button>
      </div>`;
    document.getElementById(`${containerId}-input`)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); window[`__addLabel_${containerId}`](); }
    });
  }
  window[`__addLabel_${containerId}`] = () => {
    const v = document.getElementById(`${containerId}-input`)?.value.trim();
    if (v && !labels.includes(v)) { labels.push(v); render(); }
    else if (document.getElementById(`${containerId}-input`)) document.getElementById(`${containerId}-input`).value = '';
  };
  window[`__removeLabel_${containerId}`] = i => { labels.splice(i,1); render(); };
  render();
  return { getLabels: ()=>labels, setLabels: l=>{ labels=[...l]; render(); } };
}

// ── Simple SVG charts ───────────────────────────────────────────────────
function renderPie(container, data, colors) {
  if (!data?.length) { container.innerHTML='<div class="empty-state" style="padding:20px">No data</div>'; return; }
  const total = data.reduce((s,d)=>s+(d.value||d.total||0),0);
  if (!total) { container.innerHTML='<div class="empty-state" style="padding:20px">No data</div>'; return; }
  const cols = colors || ['#1a3a6b','#2d8dc4','#22a06b','#f0a500','#d63031','#9333ea','#0891b2','#16a34a','#dc7834'];
  let paths='', angle=-90;
  data.forEach((d,i) => {
    const val=d.value||d.total||0, pct=val/total, sweep=pct*360;
    if (!sweep) return;
    const r=80,cx=100,cy=100,a1=(angle*Math.PI)/180,a2=((angle+sweep)*Math.PI)/180;
    paths+=`<path d="M${cx},${cy} L${cx+r*Math.cos(a1)},${cy+r*Math.sin(a1)} A${r},${r} 0 ${sweep>180?1:0},1 ${cx+r*Math.cos(a2)},${cy+r*Math.sin(a2)} Z" fill="${cols[i%cols.length]}" stroke="white" stroke-width="2" opacity="0.9"><title>${d.label||d.method||'—'}: ${fmt$(val)}</title></path>`;
    angle+=sweep;
  });
  const legend = data.map((d,i)=>`<div class="pie-legend-item"><div class="pie-dot" style="background:${cols[i%cols.length]}"></div><span>${d.label||d.method||'—'}</span><span style="color:var(--gray-500);margin-left:4px">${fmt$(d.value||d.total||0)}</span></div>`).join('');
  container.innerHTML=`<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap"><svg viewBox="0 0 200 200" width="150" height="150" style="flex-shrink:0">${paths}</svg><div class="pie-legend">${legend}</div></div>`;
}

function renderBar(container, data, labelKey, valueKey, color='#2d8dc4') {
  if (!data?.length) { container.innerHTML='<div class="empty-state" style="padding:20px">No data</div>'; return; }
  const max = Math.max(...data.map(d=>d[valueKey]||0));
  if (!max) { container.innerHTML='<div class="empty-state" style="padding:20px">No data</div>'; return; }
  const items = data.slice(-16);
  const w=520,h=200,pad=36,bw=Math.max(14,(w-pad*2)/items.length-5);
  let bars='',labels='';
  items.forEach((d,i)=>{
    const val=d[valueKey]||0, bh=Math.max(2,(val/max)*(h-pad*1.5));
    const x=pad+i*((w-pad*2)/items.length)+3, y=h-pad-bh;
    bars+=`<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${color}" rx="2" opacity="0.85"><title>${d[labelKey]}: ${fmt$(val)}</title></rect>`;
    if (i%Math.ceil(items.length/8)===0) labels+=`<text x="${x+bw/2}" y="${h-4}" text-anchor="middle" font-size="9" fill="#6b7280">${(d[labelKey]||'').toString().slice(-7)}</text>`;
  });
  container.innerHTML=`<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-height:220px">${bars}${labels}</svg>`;
}
