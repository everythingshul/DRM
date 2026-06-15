'use strict';
// DRM — Donor Relationship Manager
// Single-file JS bundle

// ── Global ────────────────────────────────────────────────────────────────────
window.DRM = { user: null, org: null, orgs: [] };
let _currentPage = 'dashboard';
let _allOrgs = [];
let _redirecting = false; // prevent reload loops

// ── API ───────────────────────────────────────────────────────────────────────
const API = {
  orgId: null,

  async req(method, path, data) {
    const url = path.startsWith('/api') ? path : '/api' + path;
    const token = localStorage.getItem('drm_token');
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-org-id': API.orgId || '',
        // Send token in header as fallback if cookie doesn't work
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      credentials: 'include'
    };
    if (data && method !== 'GET') opts.body = JSON.stringify(data);
    let res;
    try { res = await fetch(url, opts); } catch(e) { throw new Error('Network error: ' + e.message); }
    if (res.status === 401) {
      // Don't redirect if already on login, to prevent loops
      if (!_redirecting) {
        _redirecting = true;
        showLogin();
        _redirecting = false;
      }
      throw new Error('Session expired');
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      const txt = await res.text();
      throw new Error('Server error (non-JSON): ' + txt.slice(0, 80));
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  },

  get:  (p)    => API.req('GET',    p),
  post: (p, d) => API.req('POST',   p, d),
  put:  (p, d) => API.req('PUT',    p, d),
  del:  (p)    => API.req('DELETE', p),

  async dl(path, filename, method, body) {
    const opts = {
      method: method || 'GET',
      headers: { 'x-org-id': API.orgId || '' },
      credentials: 'include'
    };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  o: {
    donors:      ()   => `/api/orgs/${API.orgId}/donors`,
    donor:       (id) => `/api/orgs/${API.orgId}/donors/${id}`,
    stats:       ()   => `/api/orgs/${API.orgId}/stats`,
    email:       ()   => `/api/orgs/${API.orgId}/email-settings`,
    kvitel:      ()   => `/api/orgs/${API.orgId}/kvitel-settings`,
    hoods:       ()   => `/api/orgs/${API.orgId}/donors/meta/neighborhoods`,
    labels:      ()   => `/api/orgs/${API.orgId}/donors/meta/labels`,
    failures:    ()   => `/api/orgs/${API.orgId}/charge-failures`,
    verify:      ()   => `/api/orgs/${API.orgId}/donors/needs-verification`,
    users:       ()   => `/api/orgs/${API.orgId}/users`,
    log:         ()   => `/api/orgs/${API.orgId}/login-log`,
    schedEmails: ()   => `/api/orgs/${API.orgId}/scheduled-emails`,
    daf:         ()   => `/api/orgs/${API.orgId}/daf`,
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const val = (id) => $(id)?.value || '';

function toast(msg, type='ok') {
  const c = $('toast-wrap');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 350); }, 3200);
}

const Modal = {
  open(title, html, opts={}) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    const box = $('modal-box');
    box.className = 'modal-box' + (opts.lg ? ' lg' : '') + (opts.sm ? ' sm' : '') + (opts.tall ? ' tall' : '');
    $('modal-overlay').style.display = 'flex';
    if (opts.cb) setTimeout(opts.cb, 0);
  },
  close() { $('modal-overlay').style.display = 'none'; $('modal-body').innerHTML = ''; },
  body(h) { $('modal-body').innerHTML = h; },
  title(t) { $('modal-title').textContent = t; }
};

function confirmDlg(msg, yes) {
  Modal.open('Confirm', `<p style="margin-bottom:14px;color:var(--gray-7)">${msg}</p>
    <div class="bg">
      <button class="btn btn-red btn-sm" id="_conf_yes">Confirm</button>
      <button class="btn btn-ghost btn-sm" onclick="Modal.close()">Cancel</button>
    </div>`, { sm: true });
  $('_conf_yes').onclick = () => { Modal.close(); yes(); };
}

function fmt$(n) { return '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtD(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return d; } }
function fmtDT(d) { if (!d) return '—'; try { return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return d; } }
function age(m) { if (!m && m !== 0) return '—'; const mo = parseInt(m); if (mo < 12) return mo + 'mo'; const y = Math.floor(mo / 12), r = mo % 12; return r ? `${y}y ${r}mo` : `${y}y`; }
function fmtMethod(m) { return { credit_card: 'Credit Card', daf: 'DAF', check: 'Check', cash: 'Cash', wire: 'Wire', other: 'Other' }[m] || m; }
function fmtFreq(f) { return { weekly: 'Weekly', biweekly: 'Bi-Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly', once: 'One-Time' }[f] || f; }
function toLocalDT(d) { if (!d) return ''; try { const dt = new Date(d), p = n => String(n).padStart(2, '0'); return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`; } catch { return ''; } }
function inits(f, l) { return ((f || '')[0] || '').toUpperCase() + ((l || '')[0] || '').toUpperCase(); }
function avatar(d, sz=30) { return `<div class="av" style="width:${sz}px;height:${sz}px;font-size:${Math.round(sz/2.8)}px">${inits(d.first_name, d.last_name)}</div>`; }
function sbadge(s) { const m = { completed:'Completed', pending:'Pending', failed:'Failed', scheduled:'Scheduled', cancelled:'Cancelled', active:'Active', paused:'Paused', refunded:'Refunded', partial_refund:'Partial Refund' }; return `<span class="sbadge s-${s}">${m[s] || s}</span>`; }
function cbrand(brand, last4) { const cls = (brand || '').toLowerCase().replace(/\s/g, ''); return `<span class="cb cb-${cls}">${brand || 'Card'}</span>${last4 ? ` ••${last4}` : ''}`; }
function jsonParse(s, def) { try { return JSON.parse(s || '[]'); } catch { return def !== undefined ? def : []; } }

function pagHtml(page, pages, fn) {
  if (pages <= 1) return '';
  let h = '<div class="pagination">';
  if (page > 1) h += `<button class="btn btn-ghost btn-sm" onclick="${fn}(${page-1})">&#8249;</button>`;
  const s = Math.max(1, page-2), e = Math.min(pages, page+2);
  if (s > 1) { h += `<button class="btn btn-ghost btn-sm" onclick="${fn}(1)">1</button>`; if (s > 2) h += '<span style="padding:0 4px">…</span>'; }
  for (let i = s; i <= e; i++) h += `<button class="btn btn-sm ${i===page?'btn-primary':'btn-ghost'}" onclick="${fn}(${i})">${i}</button>`;
  if (e < pages) { if (e < pages-1) h += '<span style="padding:0 4px">…</span>'; h += `<button class="btn btn-ghost btn-sm" onclick="${fn}(${pages})">${pages}</button>`; }
  if (page < pages) h += `<button class="btn btn-ghost btn-sm" onclick="${fn}(${page+1})">&#8250;</button>`;
  return h + '</div>';
}

function tabsInit(scope) {
  document.querySelectorAll(scope + ' .tab').forEach(t => {
    t.onclick = function() {
      document.querySelectorAll(scope + ' .tab').forEach(x => x.classList.remove('on'));
      document.querySelectorAll(scope + ' .tc').forEach(x => x.classList.remove('on'));
      this.classList.add('on');
      $(this.dataset.tc)?.classList.add('on');
    };
  });
}

function lwInit(id, init=[]) {
  const c = $(id); let arr = [...init];
  const render = () => {
    c.innerHTML = `
      <div class="bg" style="flex-wrap:wrap;gap:4px;margin-bottom:6px">
        ${arr.map((l, i) => `<span class="pill pill-blue">${l} <span style="cursor:pointer" onclick="window['_lw_rm_${id}'](${i})">×</span></span>`).join('')}
      </div>
      <div class="bg">
        <input id="${id}-in" type="text" placeholder="Add label…" style="flex:1" autocomplete="off">
        <button type="button" class="btn btn-ghost btn-sm" onclick="window['_lw_add_${id}']()">Add</button>
      </div>`;
    $(`${id}-in`)?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); window[`_lw_add_${id}`](); } });
  };
  window[`_lw_add_${id}`] = () => { const v = $(`${id}-in`)?.value.trim(); if (v && !arr.includes(v)) { arr.push(v); render(); } };
  window[`_lw_rm_${id}`] = i => { arr.splice(i, 1); render(); };
  render();
  return { get: () => arr, set: a => { arr = [...a]; render(); } };
}

function renderPie(el, data) {
  if (!data?.length) { el.innerHTML = '<div class="empty">No data</div>'; return; }
  const total = data.reduce((s, d) => s + (d.v || 0), 0);
  if (!total) { el.innerHTML = '<div class="empty">No data</div>'; return; }
  const cols = ['#1a3a6b','#2d8dc4','#22a06b','#f0a500','#d63031','#9333ea','#0891b2','#16a34a'];
  let paths = '', angle = -90;
  data.forEach((d, i) => {
    const v = d.v || 0, sweep = (v/total)*360; if (!sweep) return;
    const r=78,cx=90,cy=90,a1=(angle*Math.PI)/180,a2=((angle+sweep)*Math.PI)/180;
    paths += `<path d="M${cx},${cy} L${cx+r*Math.cos(a1)},${cy+r*Math.sin(a1)} A${r},${r} 0 ${sweep>180?1:0},1 ${cx+r*Math.cos(a2)},${cy+r*Math.sin(a2)} Z" fill="${cols[i%cols.length]}" stroke="#fff" stroke-width="2"><title>${d.label}: ${fmt$(v)}</title></path>`;
    angle += sweep;
  });
  const legend = data.map((d, i) => `<div class="pie-legend-item"><div class="pdot" style="background:${cols[i%cols.length]}"></div><span>${d.label}</span><span style="color:var(--gray-5);margin-left:4px">${fmt$(d.v||0)}</span></div>`).join('');
  el.innerHTML = `<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap"><svg viewBox="0 0 180 180" width="130" height="130" style="flex-shrink:0">${paths}</svg><div class="pie-legend">${legend}</div></div>`;
}

function renderBar(el, data, lk, vk) {
  if (!data?.length) { el.innerHTML = '<div class="empty">No data</div>'; return; }
  const max = Math.max(...data.map(d => d[vk] || 0)); if (!max) { el.innerHTML = '<div class="empty">No data</div>'; return; }
  const items = data.slice(-14), w=480, h=180, pad=30, bw=Math.max(12,(w-pad*2)/items.length-4);
  let bars='', lbls='';
  items.forEach((d, i) => {
    const v=d[vk]||0, bh=Math.max(2,(v/max)*(h-pad*1.4)), x=pad+i*((w-pad*2)/items.length)+2, y=h-pad-bh;
    bars += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="#2d8dc4" rx="2" opacity=".85"><title>${d[lk]}: ${fmt$(v)}</title></rect>`;
    if (i % Math.ceil(items.length/7) === 0) lbls += `<text x="${x+bw/2}" y="${h-3}" text-anchor="middle" font-size="9" fill="#6b7280">${String(d[lk]||'').slice(-7)}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-height:200px">${bars}${lbls}</svg>`;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function toggleSidebar() {
  const sb = $('sidebar'), mc = $('main-content'), mobile = window.innerWidth <= 768;
  if (mobile) {
    sb.classList.toggle('mob-open');
    $('sidebar-overlay').classList.toggle('show');
  } else {
    const c = sb.classList.toggle('collapsed');
    mc.style.marginLeft = c ? 'var(--sb-cw)' : 'var(--sb-w)';
    localStorage.setItem('sb-c', c ? '1' : '0');
  }
}
function closeSidebar() {
  $('sidebar')?.classList.remove('mob-open');
  $('sidebar-overlay')?.classList.remove('show');
}

// ── App boot ──────────────────────────────────────────────────────────────────
async function init() {
  // Invite/setup token in URL?
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (token && location.pathname.includes('new-account')) { showNewAcct(token); return; }

  // Check if first-run setup needed
  let status;
  try { status = await fetch('/api/setup-status').then(r => r.json()); }
  catch(e) { console.error('Setup status error:', e); showLogin(); return; }

  if (status?.needsSetup) { showSetup(); return; }

  // Try to restore existing session
  try {
    const me = await API.get('/auth/me');
    DRM.user = me.user;
    _allOrgs = me.orgs;
    if (me.orgs.length) await setOrg(me.orgs[0]);
    showApp();
  } catch {
    showLogin();
  }
}

function showSetup() {
  _show('setup-screen'); _hide('login-screen'); _hide('app'); _hide('newacct-screen');
  $('setup-form').onsubmit = async e => {
    e.preventDefault();
    const err = $('setup-err'); err.style.display = 'none';
    try {
      await API.post('/auth/setup', { full_name: val('s-name'), email: val('s-email'), password: val('s-pass'), org_name: val('s-org') });
      toast('Account created! Please sign in.');
      showLogin();
    } catch(e) { err.textContent = e.message; err.style.display = 'block'; }
  };
}

function showLogin() {
  _show('login-screen'); _hide('setup-screen'); _hide('app'); _hide('newacct-screen');
  const form = $('login-form');
  form.onsubmit = async e => {
    e.preventDefault();
    const err = $('login-err'); err.style.display = 'none';
    try {
      const res = await API.post('/auth/login', { email: val('l-email'), password: val('l-pass') });
      DRM.user = res.user; _allOrgs = res.orgs;
      // Store token in localStorage as fallback for environments where cookies don't persist
      if (res.token) localStorage.setItem('drm_token', res.token);
      if (res.orgs.length) await setOrg(res.activeOrg || res.orgs[0]);
      showApp();
    } catch(e) { err.textContent = e.message; err.style.display = 'block'; }
  };
}

function showNewAcct(token) {
  _show('newacct-screen'); _hide('login-screen'); _hide('setup-screen'); _hide('app');
  $('newacct-form').onsubmit = async e => {
    e.preventDefault();
    const err = $('newacct-err'); err.style.display = 'none';
    const p1 = val('na-pass'), p2 = val('na-pass2');
    if (p1 !== p2) { err.textContent = 'Passwords do not match'; err.style.display = 'block'; return; }
    try {
      await API.post('/auth/new-account', { token, full_name: val('na-name'), org_name: val('na-org'), password: p1 });
      history.replaceState({}, '', '/');
      toast('Account created! Please sign in.');
      showLogin();
    } catch(e) { err.textContent = e.message; err.style.display = 'block'; }
  };
}

async function setOrg(org) {
  DRM.org = org; API.orgId = org.id;
  DRM.orgs = _allOrgs;
  const sel = $('org-select');
  if (!sel) return;
  sel.innerHTML = _allOrgs.map(o => `<option value="${o.id}" ${o.id===org.id?'selected':''}>${o.name}</option>`).join('');
  sel.onchange = async () => {
    const found = _allOrgs.find(x => x.id === sel.value);
    if (found) { await setOrg(found); navigateTo(_currentPage); }
  };
}

function showApp() {
  _show('app'); _hide('login-screen'); _hide('setup-screen'); _hide('newacct-screen');
  const sbUser = $('sb-user'); if (sbUser) sbUser.textContent = DRM.user?.full_name || '';
  // Restore sidebar state
  const sb = $('sidebar');
  if (sb && localStorage.getItem('sb-c') === '1' && window.innerWidth > 768) {
    sb.classList.add('collapsed');
    const mc = $('main-content'); if (mc) mc.style.marginLeft = 'var(--sb-cw)';
  }
  // Nav clicks
  document.querySelectorAll('.nav-item').forEach(item => {
    item.onclick = () => { if (window.innerWidth <= 768) closeSidebar(); navigateTo(item.dataset.page); };
  });
  $('logout-btn').onclick = async () => { try { await API.post('/auth/logout', {}); } catch {} localStorage.removeItem('drm_token'); showLogin(); };
  $('add-org-btn').onclick = () => Modal.open('New Organization', `
    <label>Organization Name</label>
    <input id="no-name" placeholder="My Organization">
    <div class="bg mt">
      <button class="btn btn-primary btn-sm" onclick="createOrg()">Create</button>
      <button class="btn btn-ghost btn-sm" onclick="Modal.close()">Cancel</button>
    </div>`, { sm: true });
  // Navigate to hash if present, else dashboard
  const initPage = location.hash.replace('#','') || 'dashboard';
  const validPages = ['dashboard','donors','donations','verification','failures','bank','emails','kvitel','reports','settings'];
  navigateTo(validPages.includes(initPage) ? initPage : 'dashboard');
  loadBadges();
  setInterval(loadBadges, 60000);
}

async function createOrg() {
  try {
    const res = await API.post('/auth/orgs', { name: val('no-name') });
    _allOrgs.push(res.org); await setOrg(res.org);
    Modal.close(); toast('Organization created'); navigateTo('dashboard');
  } catch(e) { toast(e.message, 'err'); }
}

function navigateTo(page, force=false) {
  const wasOnPage = _currentPage === page;
  _currentPage = page;
  if (location.hash !== '#' + page) history.pushState(null, '', '#' + page);
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = $('page-' + page);
  if (el) {
    el.classList.add('active');
    // Don't re-render if already on same page and not forced (preserves scroll/state)
    if (!wasOnPage || force || !el.innerHTML.trim()) renderPage(page, el);
  }
}
// Re-render current page (call after mutations)
function reloadPage() { const el = $('page-' + _currentPage); if(el) renderPage(_currentPage, el); }
window.addEventListener('popstate', () => {
  const page = location.hash.replace('#','') || 'dashboard';
  const valid = ['dashboard','donors','donations','verification','failures','bank','emails','kvitel','reports','settings'];
  if (valid.includes(page)) navigateTo(page);
});

function renderPage(page, el) {
  const map = {
    dashboard:    renderDashboard,
    donors:       el => Donors.render(el),
    donations:    renderDonations,
    verification: renderVerification,
    failures:     renderFailures,
    bank:         renderBank,
    emails:       renderEmails,
    kvitel:       renderKvitel,
    reports:      renderReports,
    settings:     renderSettings,
  };
  map[page]?.(el);
}

async function loadBadges() {
  if (!API.orgId) return;
  try {
    const s = await API.get(API.o.stats());
    const vb = $('verify-badge');
    if (vb) { vb.textContent = s.needsVerification; vb.style.display = s.needsVerification > 0 ? 'inline' : 'none'; }
    const fb = $('fail-badge');
    if (fb) { fb.textContent = s.failedCharges; fb.style.display = s.failedCharges > 0 ? 'inline' : 'none'; }
  } catch {}
}

function _show(id) { const e = $(id); if (e) e.style.display = ''; }
function _hide(id) { const e = $(id); if (e) e.style.display = 'none'; }

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function renderDashboard(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const s = await API.get(API.o.stats());
    el.innerHTML = `
      <div class="ph">
        <div><div class="ph-title">Dashboard</div></div>
        <div class="bg">
          ${s.failedCharges > 0 ? `<button class="btn btn-red btn-sm" onclick="navigateTo('failures')">! ${s.failedCharges} Failed</button>` : ''}
          ${s.needsVerification > 0 ? `<button class="btn btn-outline btn-sm" onclick="navigateTo('verification')">${s.needsVerification} Need Verification</button>` : ''}
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-lbl">Total Donors</div><div class="stat-val">${(s.totalDonors||0).toLocaleString()}</div><div class="stat-sub">${s.activeDonors||0} active</div></div>
        <div class="stat g"><div class="stat-lbl">Total Raised</div><div class="stat-val">${fmt$(s.totalAmount)}</div><div class="stat-sub">${s.totalDonations||0} donations</div></div>
        <div class="stat o"><div class="stat-lbl">Avg Donation</div><div class="stat-val">${fmt$(s.avgDonation)}</div></div>
        <div class="stat"><div class="stat-lbl">AutoPay Active</div><div class="stat-val">${s.autopayStats?.active||0}</div><div class="stat-sub">${s.autopayStats?.paused||0} paused</div></div>
      </div>
      <div class="g2" style="margin-bottom:14px">
        <div class="card"><div class="card-title">Monthly Donations</div><div id="ch-monthly"></div></div>
        <div class="card"><div class="card-title">By Method</div><div id="ch-method"></div></div>
      </div>
      <div class="g2">
        <div class="card"><div class="card-title">By Neighborhood</div><div id="ch-nh"></div></div>
        <div class="card"><div class="card-title">Top Donors</div>
          <div class="tw"><table>
            <thead><tr><th>Donor</th><th>Gifts</th><th>Total</th></tr></thead>
            <tbody>${(s.topDonors||[]).map(d=>`<tr><td><strong>${d.first_name} ${d.last_name}</strong></td><td>${d.count}</td><td>${fmt$(d.total)}</td></tr>`).join('')||'<tr><td colspan="3" class="empty">No data</td></tr>'}</tbody>
          </table></div>
        </div>
      </div>`;
    renderBar($('ch-monthly'), [...(s.byMonth||[])].reverse(), 'month', 'total');
    renderPie($('ch-method'), (s.byMethod||[]).map(m => ({ label: fmtMethod(m.method), v: m.total })));
    renderPie($('ch-nh'), (s.byNeighborhood||[]).slice(0,8).map(n => ({ label: n.name_he||'Other', v: n.total })));
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

// ── Donors ────────────────────────────────────────────────────────────────────
const Donors = {
  donors:[], total:0, page:1, perPage:25,
  search:'', hood:'', label:'', autopay:'',
  sortBy:'last_name', sortDir:'asc', selected:new Set(),
  hoods:[], labelList:[],

  async render(el) {
    el.innerHTML = this.shell();
    await this.loadMeta();
    await this.load();
    this.bindEvents();
  },

  shell() {
    return `
    <div class="ph">
      <div><div class="ph-title">Donors</div><div class="ph-sub" id="d-count"></div></div>
      <div class="bg">
        <button class="btn btn-ghost btn-sm" onclick="Donors.importXlsx()">&#8679; Import</button>
        <button class="btn btn-ghost btn-sm" onclick="Donors.exportXlsx()">&#8681; Export</button>
        <button class="btn btn-primary btn-sm" onclick="Donors.openAdd()">+ Add Donor</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:12px;padding:12px 14px">
      <div class="search-bar">
        <div class="sw" style="flex:2">
          <input id="d-search" placeholder="Search name, email, phone, Hebrew…" autocomplete="off" autocorrect="off" spellcheck="false">
        </div>
        <select id="d-hood"><option value="">All Neighborhoods</option></select>
        <select id="d-label"><option value="">All Labels</option></select>
        <select id="d-ap"><option value="">All AutoPay</option><option value="1">On</option><option value="0">Off</option></select>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:6px">
        <div class="bg">
          <button class="btn btn-ghost btn-sm" onclick="Donors.pauseAll()">Pause All AutoPay</button>
          <button class="btn btn-ghost btn-sm" onclick="Donors.resumeAll()">Resume All</button>
        </div>
        <div class="ppw">Show <select id="d-pp"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select> per page</div>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div id="d-bulk" class="bulk-bar">
        <span id="d-bulk-cnt">0 selected</span>
        <button class="btn btn-ghost btn-sm" onclick="Donors.bulkDelete()">Delete Selected</button>
        <button class="btn btn-ghost btn-sm" onclick="Donors.clearSel()">Clear</button>
      </div>
      <div class="tw"><table>
        <thead><tr>
          <th style="width:28px"><input type="checkbox" id="sel-all" onchange="Donors.toggleAll(this.checked)"></th>
          <th class="sort" onclick="Donors.sort('last_name')">Name</th>
          <th>Hebrew</th>
          <th>Contact</th>
          <th class="sort" onclick="Donors.sort('neighborhood_name')">Neighborhood</th>
          <th class="sort" onclick="Donors.sort('months_old')">Age</th>
          <th class="sort" onclick="Donors.sort('total_amount')">Total</th>
          <th>AutoPay</th>
          <th></th>
        </tr></thead>
        <tbody id="d-tbody"><tr><td colspan="9"><div class="spinner"></div></td></tr></tbody>
      </table></div>
      <div style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--gray-1)">
        <div id="d-pag"></div><div id="d-info" class="pag-info"></div>
      </div>
    </div>`;
  },

  async loadMeta() {
    try {
      [this.hoods, this.labelList] = await Promise.all([API.get(API.o.hoods()), API.get(API.o.labels())]);
      const hs = $('d-hood');
      if (hs) hs.innerHTML = '<option value="">All Neighborhoods</option>' + this.hoods.map(h=>`<option value="${h.id}">${h.name_he}</option>`).join('');
      const ls = $('d-label');
      if (ls) ls.innerHTML = '<option value="">All Labels</option>' + this.labelList.map(l=>`<option value="${l}">${l}</option>`).join('');
    } catch {}
  },

  async load() {
    const p = new URLSearchParams({ page: this.page, limit: this.perPage });
    if (this.search) p.set('search', this.search);
    if (this.hood) p.set('neighborhood', this.hood);
    if (this.label) p.set('label', this.label);
    if (this.autopay !== '') p.set('autopay', this.autopay);
    try {
      const res = await API.get(API.o.donors() + '?' + p);
      this.donors = res.donors || []; this.total = res.total || 0;
      this.renderTable();
      const cnt = $('d-count'); if (cnt) cnt.textContent = `${this.total.toLocaleString()} donor${this.total!==1?'s':''}`;
      const info = $('d-info'); if (info && this.total > 0) info.textContent = `${(this.page-1)*this.perPage+1}–${Math.min(this.page*this.perPage,this.total)} of ${this.total}`;
    } catch(e) { const tb = $('d-tbody'); if (tb) tb.innerHTML = `<tr><td colspan="9"><div class="alert alert-err" style="margin:10px">${e.message}</div></td></tr>`; }
  },

  renderTable() {
    const tb = $('d-tbody'); if (!tb) return;
    if (!this.donors.length) { tb.innerHTML = '<tr><td colspan="9"><div class="empty"><h3>No donors found</h3></div></td></tr>'; return; }
    const sorted = [...this.donors].sort((a,b) => {
      const av = a[this.sortBy] ?? '', bv = b[this.sortBy] ?? '';
      const r = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return this.sortDir === 'asc' ? r : -r;
    });
    tb.innerHTML = sorted.map(d => {
      const lbls = jsonParse(d.labels);
      const ap = d.autopay_enabled ? (d.autopay_paused ? '<span class="sbadge s-paused">Paused</span>' : '<span class="sbadge s-active">On</span>') : '<span style="color:var(--gray-3)">Off</span>';
      return `<tr>
        <td><input type="checkbox" value="${d.id}" ${this.selected.has(d.id)?'checked':''} onchange="Donors.toggleOne('${d.id}',this.checked)"></td>
        <td><div style="display:flex;align-items:center;gap:8px">
          ${avatar(d, 28)}
          <div>
            <div style="font-weight:600;font-size:13px">${d.title?d.title+' ':''}${d.first_name} ${d.last_name}</div>
            ${lbls.length ? `<div class="bg" style="gap:3px;margin-top:2px;flex-wrap:wrap">${lbls.map(l=>`<span class="pill pill-blue" style="font-size:10px">${l}</span>`).join('')}</div>` : ''}
            ${d.needs_verification ? '<div style="font-size:10px;color:var(--amber);font-weight:600">⚠ Verify</div>' : ''}
          </div>
        </div></td>
        <td style="font-family:var(--font-he);direction:rtl;font-size:12px">${d.hebrew_full_name||'—'}</td>
        <td style="font-size:12px">${d.cell?`<div>${d.cell}</div>`:''}${d.email?`<div style="color:var(--gray-5)">${d.email}</div>`:''}</td>
        <td style="font-family:var(--font-he);font-size:12px">${d.neighborhood_name||'—'}</td>
        <td style="font-size:12px">${age(d.months_old)}</td>
        <td style="font-weight:600">${fmt$(d.total_amount)}</td>
        <td>${ap}</td>
        <td><div class="actions">
          <button class="btn btn-blue btn-sm" onclick="DonorDetail.open('${d.id}')">View</button>
          <button class="btn btn-ghost btn-sm" onclick="Donors.openEdit('${d.id}')">Edit</button>
          <button class="btn btn-icon" style="color:var(--red)" onclick="Donors.del('${d.id}','${d.first_name} ${d.last_name}')">&#10005;</button>
        </div></td>
      </tr>`;
    }).join('');
    document.querySelectorAll('#page-donors th.sort').forEach(th => {
      th.classList.remove('sa','sd');
      if (th.onclick?.toString().includes(`'${this.sortBy}'`)) th.classList.add(this.sortDir==='asc'?'sa':'sd');
    });
    $('d-pag').innerHTML = pagHtml(this.page, Math.ceil(this.total/this.perPage), 'Donors.goPage');
    this.updateBulk();
  },

  sort(col) { if (this.sortBy===col) this.sortDir=this.sortDir==='asc'?'desc':'asc'; else {this.sortBy=col;this.sortDir='asc';} this.renderTable(); },
  goPage(p) { Donors.page = p; Donors.load(); },
  bindEvents() {
    let t;
    const s = $('d-search');
    if (s) s.oninput = () => { clearTimeout(t); t = setTimeout(() => { Donors.search=s.value; Donors.page=1; Donors.load(); }, 320); };
    $('d-hood')?.addEventListener('change', e => { Donors.hood=e.target.value; Donors.page=1; Donors.load(); });
    $('d-label')?.addEventListener('change', e => { Donors.label=e.target.value; Donors.page=1; Donors.load(); });
    $('d-ap')?.addEventListener('change', e => { Donors.autopay=e.target.value; Donors.page=1; Donors.load(); });
    $('d-pp')?.addEventListener('change', e => { Donors.perPage=parseInt(e.target.value); Donors.page=1; Donors.load(); });
  },
  toggleAll(c) { document.querySelectorAll('#d-tbody input[type=checkbox]').forEach(cb => { cb.checked=c; if(c)Donors.selected.add(cb.value); else Donors.selected.delete(cb.value); }); Donors.updateBulk(); },
  toggleOne(id, c) { if(c) this.selected.add(id); else this.selected.delete(id); this.updateBulk(); },
  clearSel() { this.selected.clear(); const a=$('sel-all'); if(a)a.checked=false; document.querySelectorAll('#d-tbody input[type=checkbox]').forEach(c=>c.checked=false); this.updateBulk(); },
  updateBulk() { const bar=$('d-bulk'),cnt=$('d-bulk-cnt'); if(bar)bar.className='bulk-bar'+(this.selected.size>0?' show':''); if(cnt)cnt.textContent=`${this.selected.size} selected`; },
  bulkDelete() { if(!this.selected.size)return; confirmDlg(`Delete ${this.selected.size} donor(s)?`,async()=>{for(const id of this.selected)await API.del(API.o.donor(id)).catch(()=>{}); this.selected.clear(); toast('Deleted'); Donors.load(); }); },
  async pauseAll() { confirmDlg('Pause AutoPay for all donors?',async()=>{await API.post(`/api/orgs/${API.orgId}/donors/autopay/pause-all`,{}); toast('Paused'); Donors.load();}); },
  async resumeAll() { await API.post(`/api/orgs/${API.orgId}/donors/autopay/resume-all`,{}); toast('Resumed'); this.load(); },
  openAdd() { this.form(null); },
  async openEdit(id) { try { const d = await API.get(API.o.donor(id)); this.form(d.donor); } catch(e) { toast(e.message||'Unknown error','err'); } },
  del(id, name) { confirmDlg(`Delete "${name}"?`, async () => { await API.del(API.o.donor(id)); toast('Deleted'); Donors.load(); }); },
  exportXlsx() { API.dl(`/api/orgs/${API.orgId}/reports/donors?format=xlsx`, 'donors.xlsx').catch(e=>toast(e.message||'Unknown error','err')); },
  importXlsx() {
    Modal.open('Import Donors', `<p style="color:var(--gray-5);margin-bottom:10px;font-size:13px">Excel columns: First Name, Last Name, Hebrew Name, Email, Cell, Street, City, State, Zip</p>
      <input type="file" id="imp-f" accept=".xlsx,.xls">
      <div class="bg mt"><button class="btn btn-primary" onclick="Donors.doImport()">Import</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`, { sm: true });
  },
  async doImport() {
    const f = $('imp-f')?.files[0]; if (!f) { toast('Select a file','err'); return; }
    const fd = new FormData(); fd.append('file', f);
    try {
      const r = await fetch(`/api/orgs/${API.orgId}/import/donors`, { method:'POST', body:fd, credentials:'include', headers:{'x-org-id':API.orgId} }).then(r=>r.json());
      toast(`Imported ${r.imported}${r.errors?.length?` (${r.errors.length} errors)`:''}`);
      Modal.close(); this.load();
    } catch(e) { toast(e.message||'Unknown error','err'); }
  },

  form(donor) {
    const ie = !!donor;
    Modal.open(ie?'Edit Donor':'Add Donor', '<div class="spinner"></div>', { lg: true, cb: async () => {
      const hs = await API.get(API.o.hoods()).catch(()=>[]);
      const lbls = jsonParse(donor?.labels);
      Modal.body(`
        <div class="tabs">
          <div class="tab on" data-tc="df-basic">Basic</div>
          <div class="tab" data-tc="df-contact">Contact</div>
          <div class="tab" data-tc="df-extra">Labels & Kvitel</div>
        </div>
        <div id="df-basic" class="tc on">
          <div class="r4">
            <div><label>Title</label><input id="df-title" value="${donor?.title||''}" autocomplete="off"></div>
            <div style="grid-column:span 2"><label>First Name *</label><input id="df-first" value="${donor?.first_name||''}"></div>
            <div><label>Last Name *</label><input id="df-last" value="${donor?.last_name||''}"></div>
          </div>
          <div class="r2">
            <div><label>Hebrew Title</label><input id="df-htitle" dir="rtl" style="font-family:var(--font-he)" value="${donor?.hebrew_title||''}"></div>
            <div><label>Hebrew Full Name</label><input id="df-hname" dir="rtl" style="font-family:var(--font-he)" value="${donor?.hebrew_full_name||''}"></div>
          </div>
          <div class="r2">
            <div><label>Neighborhood</label>
              <div class="bg"><select id="df-nh" style="flex:1"><option value="">— None —</option>${hs.map(h=>`<option value="${h.id}" ${h.id===donor?.neighborhood_id?'selected':''}>${h.name_he}</option>`).join('')}</select>
              <button type="button" class="btn btn-ghost btn-sm" onclick="Donors.addHood()">+</button></div>
            </div>
            <div><label>Created</label><input type="date" id="df-created" value="${donor?.created_at?donor.created_at.slice(0,10):new Date().toISOString().slice(0,10)}" ${ie?'readonly':''}></div>
          </div>
        </div>
        <div id="df-contact" class="tc">
          <div class="r2">
            <div><label>Cell</label><input id="df-cell" type="tel" value="${donor?.cell||''}"></div>
            <div><label>Home Phone</label><input id="df-home" type="tel" value="${donor?.home_phone||''}"></div>
          </div>
          <label>Email</label><input id="df-email" type="email" value="${donor?.email||''}">
          <hr class="divider">
          <label>Street</label><input id="df-street" value="${donor?.street||''}">
          <div class="r4">
            <div><label>Apt</label><input id="df-apt" value="${donor?.apt||''}"></div>
            <div style="grid-column:span 2"><label>City</label><input id="df-city" value="${donor?.city||''}"></div>
            <div><label>State</label><input id="df-state" value="${donor?.state||''}" maxlength="2"></div>
          </div>
          <div style="max-width:130px"><label>ZIP</label><input id="df-zip" value="${donor?.zip||''}"></div>
        </div>
        <div id="df-extra" class="tc">
          <label>Labels</label><div id="lw-donor"></div>
          <hr class="divider">
          <label>Kvitel <span style="font-size:11px;color:var(--gray-5)">(Hebrew, RTL)</span></label>
          <textarea id="df-kvitel" class="rtl-input" style="min-height:110px">${donor?.kvitel||''}</textarea>
          <div class="trow" style="margin-top:10px">
            <div>Include in Kvitel generation</div>
            <label class="tgl"><input type="checkbox" id="df-kvon" ${donor?.kvitel_enabled!==0?'checked':''}><span class="tgl-s"></span></label>
          </div>
        </div>
        <hr class="divider">
        <div class="bg">
          <button class="btn btn-primary" onclick="Donors.save('${donor?.id||''}')">${ie?'Save':'Add Donor'}</button>
          <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        </div>`);
      window._lwDonor = lwInit('lw-donor', lbls);
      tabsInit('#modal-body');
    }});
  },

  async addHood() {
    const n = prompt('Hebrew neighborhood name:'); if (!n) return;
    try { const r = await API.post(API.o.hoods(), {name_he:n}); toast('Added'); const s=$('df-nh'); if(s)s.innerHTML+=`<option value="${r.neighborhood.id}" selected>${r.neighborhood.name_he}</option>`; }
    catch(e) { toast(e.message||'Unknown error','err'); }
  },

  async save(id) {
    const data = { title:val('df-title'), first_name:val('df-first'), last_name:val('df-last'), hebrew_title:val('df-htitle'), hebrew_full_name:val('df-hname'), neighborhood_id:val('df-nh')||null, cell:val('df-cell'), home_phone:val('df-home'), email:val('df-email'), street:val('df-street'), apt:val('df-apt'), city:val('df-city'), state:val('df-state'), zip:val('df-zip'), kvitel:val('df-kvitel'), kvitel_enabled:$('df-kvon')?.checked?1:0, labels:window._lwDonor?.get()||[] };
    if (!data.first_name || !data.last_name) { toast('First and last name required','err'); return; }
    try { if(id) await API.put(API.o.donor(id),data); else await API.post(API.o.donors(),data); toast(id?'Saved':'Added'); Modal.close(); this.load(); this.loadMeta(); }
    catch(e) { toast(e.message||'Unknown error','err'); }
  },
};

// ── Donor Detail ──────────────────────────────────────────────────────────────
const DonorDetail = {
  data: null,
  async open(id) {
    Modal.open('Loading…', '<div class="spinner"></div>', { lg: true, tall: true });
    try {
      this.data = await API.get(API.o.donor(id));
      this.data.recurring = await API.get(`/api/orgs/${API.orgId}/donors/${id}/recurring`).catch(()=>[]);
      this.render();
    } catch(e) { Modal.body(`<div class="alert alert-err">${e.message}</div>`); }
  },

  render() {
    const { donor, paymentMethods, donations, recurring } = this.data;
    const lbls = jsonParse(donor.labels);
    Modal.title('');
    Modal.body(`
      <div class="donor-detail-hdr">
        <div class="dd-av">${inits(donor.first_name, donor.last_name)}</div>
        <div style="flex:1">
          <div style="font-size:19px;font-weight:700">${donor.title?donor.title+' ':''}${donor.first_name} ${donor.last_name}</div>
          ${donor.hebrew_full_name?`<div style="font-family:var(--font-he);direction:rtl;opacity:.85;font-size:14px">${donor.hebrew_title||''} ${donor.hebrew_full_name}</div>`:''}
          <div style="font-size:12px;opacity:.7;margin-top:3px">${age(donor.months_old)} · ${donor.email||''} ${donor.cell?'· '+donor.cell:''} ${donor.neighborhood_name?'· '+donor.neighborhood_name:''}</div>
          <div class="bg" style="gap:4px;margin-top:5px;flex-wrap:wrap">${lbls.map(l=>`<span class="pill pill-blue" style="font-size:10px">${l}</span>`).join('')}${donor.needs_verification?'<span class="pill pill-amber" style="font-size:10px">⚠ Verify</span>':''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:22px;font-weight:700">${fmt$(donor.total_amount)}</div>
          <div style="opacity:.7;font-size:12px">${donor.total_donations||0} donations</div>
          <div class="bg" style="justify-content:flex-end;margin-top:6px">
            <button class="btn btn-blue btn-sm" onclick="Donors.openEdit('${donor.id}')">Edit</button>
            ${donor.needs_verification?`<button class="btn btn-green btn-sm" onclick="DonorDetail.verify('${donor.id}')">Verify</button>`:''}
          </div>
        </div>
      </div>
      <div class="tabs" style="margin-top:0;border-radius:0">
        <div class="tab on" data-tc="dd-ov">Overview</div>
        <div class="tab" data-tc="dd-cards">Cards</div>
        <div class="tab" data-tc="dd-don">Donations</div>
        <div class="tab" data-tc="dd-rec">Recurring</div>
        <div class="tab" data-tc="dd-kv">Kvitel</div>
        <div class="tab" data-tc="dd-notes">Notes</div>
      </div>
      <div id="dd-ov" class="tc on" style="padding:16px">
        <div class="g2">
          <div>
            <div class="card-title">Contact</div>
            ${donor.cell?`<p style="font-size:13px;margin-bottom:4px">Cell: ${donor.cell}</p>`:''}
            ${donor.home_phone?`<p style="font-size:13px;margin-bottom:4px">Home: ${donor.home_phone}</p>`:''}
            ${donor.email?`<p style="font-size:13px">Email: ${donor.email}</p>`:''}
            <hr class="divider">
            <div class="card-title">Address</div>
            <p style="font-size:13px">${[donor.street,donor.apt,donor.city,donor.state,donor.zip].filter(Boolean).join(', ')||'—'}</p>
          </div>
          <div>
            <div class="card-title">Email Preferences</div>
            <div class="trow"><div style="font-size:13px">Donation receipts</div><label class="tgl"><input type="checkbox" ${!donor.donation_emails_paused?'checked':''} onchange="DonorDetail.pref('${donor.id}','donation_emails_paused',!this.checked)"><span class="tgl-s"></span></label></div>
            <div class="trow"><div style="font-size:13px">Marketing emails</div><label class="tgl"><input type="checkbox" ${!donor.marketing_emails_paused?'checked':''} onchange="DonorDetail.pref('${donor.id}','marketing_emails_paused',!this.checked)"><span class="tgl-s"></span></label></div>
          </div>
        </div>
      </div>
      <div id="dd-cards" class="tc" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong>Payment Methods</strong>
          <button class="btn btn-blue btn-sm" onclick="DonorDetail.addCard('${donor.id}')">+ Add</button>
        </div>
        <div id="pm-list">${paymentMethods.length ? paymentMethods.map(pm=>this.pmCard(pm,donor.id)).join('') : '<p style="color:var(--gray-5)">No payment methods yet</p>'}</div>
      </div>
      <div id="dd-don" class="tc" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong>Donations</strong>
          <div class="bg">
            <button class="btn btn-ghost btn-sm" onclick="DonorDetail.manual('${donor.id}')">+ Manual</button>
            <button class="btn btn-blue btn-sm" onclick="DonorDetail.chargeNow('${donor.id}')">Charge Card</button>
          </div>
        </div>
        <div class="scroll-box"><table>
          <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Trans ID</th><th>Status</th><th>Notes</th><th></th></tr></thead>
          <tbody>${donations.length ? donations.map(d=>this.donRow(d,donor.id)).join('') : '<tr><td colspan="7"><div class="empty">No donations yet</div></td></tr>'}</tbody>
        </table></div>
      </div>
      <div id="dd-rec" class="tc" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong>Recurring Schedules</strong>
          <button class="btn btn-primary btn-sm" onclick="DonorDetail.addRecurring('${donor.id}')">+ Add</button>
        </div>
        ${recurring.length ? recurring.map(s=>this.recCard(s,donor.id)).join('') : '<div class="alert alert-info">No recurring schedules. Add one to charge weekly, bi-weekly, or monthly automatically.</div>'}
      </div>
      <div id="dd-kv" class="tc" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>Kvitel</strong>
          <label class="tgl"><input type="checkbox" id="kv-on" ${donor.kvitel_enabled!==0?'checked':''} onchange="DonorDetail.pref('${donor.id}','kvitel_enabled',this.checked?1:0)"><span class="tgl-s"></span></label>
        </div>
        <textarea id="kv-txt" class="rtl-input" style="min-height:160px;width:100%">${donor.kvitel||''}</textarea>
        <button class="btn btn-primary btn-sm mt" onclick="DonorDetail.saveKv('${donor.id}')">Save</button>
      </div>
      <div id="dd-notes" class="tc" style="padding:16px">
        <div style="margin-bottom:12px">
          <textarea id="new-note" placeholder="Add a note…" style="min-height:70px;width:100%"></textarea>
          <button class="btn btn-primary btn-sm" style="margin-top:6px" onclick="DonorDetail.addNote('${donor.id}')">Add Note</button>
        </div>
        ${this.notesList(donor)}
      </div>`);
    tabsInit('#modal-body');
  },

  pmCard(pm, did) {
    const tok = pm.sola_token ? '<span class="pill pill-blue" style="font-size:10px">Tokenized</span>' : '';
    let info = '';
    if (pm.type==='credit_card') info = cbrand(pm.card_brand, pm.last_four);
    else if (pm.type==='daf') { const parts=pm.other_description?.split('|')||['']; info = `DAF: ${pm.daf_name||''}${parts[0]?' ••'+parts[0].slice(-4):''}` }
    else info = pm.other_description || fmtMethod(pm.type);
    return `<div class="sched-item">
      <div>
        <div class="sched-main">${info} ${pm.label?`<span style="font-size:12px;color:var(--gray-5)">${pm.label}</span>`:''} ${pm.is_default?'<span class="pill pill-green" style="font-size:10px">Default</span>':''} ${tok}</div>
      </div>
      <div class="bg">
        ${pm.type==='credit_card'&&pm.sola_token?`<button class="btn btn-ghost btn-sm" onclick="DonorDetail.chargeCard('${did}','${pm.id}')">Charge</button>`:''}
        <button class="btn btn-icon" style="color:var(--red)" onclick="DonorDetail.delPM('${did}','${pm.id}')">&#10005;</button>
      </div>
    </div>`;
  },

  donRow(d, did) {
    const dn = jsonParse(d.donation_notes);
    return `<tr>
      <td style="font-size:12px;white-space:nowrap">${fmtD(d.donation_date)}</td>
      <td style="font-weight:600">${fmt$(d.amount)}${d.refund_amount>0?`<br><span style="font-size:11px;color:var(--red)">−${fmt$(d.refund_amount)}</span>`:''}</td>
      <td style="font-size:12px">${fmtMethod(d.method)}${d.last_four?` ••${d.last_four}`:''}</td>
      <td style="font-size:11px;color:var(--gray-5);max-width:100px;word-break:break-all">${d.transaction_id||'—'}</td>
      <td>${sbadge(d.status)}</td>
      <td style="font-size:12px;max-width:130px">${d.notes||''}${dn.map(n=>`<div style="font-style:italic;color:var(--gray-5);font-size:11px">${fmtD(n.at)}: ${n.text}</div>`).join('')}</td>
      <td><div class="actions">
        <button class="btn btn-icon" title="Add note" onclick="DonorDetail.addDonNote('${did}','${d.id}')">&#9997;</button>
        ${(d.status==='completed'||d.status==='partial_refund')?`<button class="btn btn-icon" title="Refund" onclick="DonorDetail.refund('${did}','${d.id}','${d.amount}','${d.transaction_id||''}')">&#8617;</button>`:''}
      </div></td>
    </tr>`;
  },

  recCard(s, did) {
    const pm = s.pm_label || (s.pm_type==='credit_card' ? `${s.card_brand||'Card'} ••${s.last_four||''}` : fmtMethod(s.pm_type));
    const lim = s.occurrences_limit ? `${s.occurrences_count||0}/${s.occurrences_limit}` : 'Unlimited';
    return `<div class="sched-item">
      <div>
        <div class="sched-main">${fmt$(s.amount)} / ${fmtFreq(s.frequency)} ${sbadge(s.status)}</div>
        <div class="sched-sub">${pm} · Next: ${fmtD(s.next_run)} · ${lim}</div>
        ${s.last_failure?`<div style="font-size:11px;color:var(--red);margin-top:2px">Last error: ${s.last_failure}</div>`:''}
      </div>
      <div class="bg">
        ${s.status==='active'?`<button class="btn btn-ghost btn-sm" onclick="DonorDetail.toggleRec('${did}','${s.id}','paused')">Pause</button>`:`<button class="btn btn-ghost btn-sm" onclick="DonorDetail.toggleRec('${did}','${s.id}','active')">Resume</button>`}
        <button class="btn btn-ghost btn-sm" onclick="DonorDetail.editRec('${did}','${s.id}','${s.amount}','${s.frequency}','${s.next_run||''}')">Edit</button>
        <button class="btn btn-icon" style="color:var(--red)" onclick="DonorDetail.delRec('${did}','${s.id}')">&#10005;</button>
      </div>
    </div>`;
  },

  notesList(donor) {
    const notes = jsonParse(donor.notes);
    if (!notes.length) return '<p style="color:var(--gray-5)">No notes yet</p>';
    return notes.slice().reverse().map(n=>`<div class="note-item"><div class="note-meta">${fmtDT(n.at)}${n.by?' · '+n.by:''}</div><div>${n.text}</div></div>`).join('');
  },

  async verify(id) { await API.post(`/api/orgs/${API.orgId}/donors/${id}/verify`,{}); toast('Verified ✓'); this.open(id); loadBadges(); },
  async pref(id, f, v) { await API.put(API.o.donor(id), {[f]:v}); },
  async saveKv(id) { await API.put(API.o.donor(id), {kvitel:val('kv-txt'),kvitel_enabled:$('kv-on')?.checked?1:0}); toast('Saved'); },
  async addNote(id) {
    const txt = $('new-note')?.value?.trim(); if (!txt) return;
    const notes = jsonParse(this.data?.donor?.notes);
    notes.push({text:txt, at:new Date().toISOString(), by:DRM.user?.full_name||''});
    await API.put(API.o.donor(id), {notes}); toast('Note added'); this.open(id);
  },

  addCard(did) {
    Modal.open('Add Payment Method', `
      <label>Type</label>
      <select id="pm-type" onchange="DonorDetail._pmTypeChange()">
        <option value="credit_card">Credit Card (Sola)</option>
        <option value="daf">DAF</option>
        <option value="check">Check</option>
        <option value="other">Other</option>
      </select>
      <div id="cc-f">
        <div class="alert alert-info" style="margin-top:10px;font-size:12px">Card tokenized via Sola — raw number never stored.</div>
        <div class="r2"><div><label>Card Number</label><input id="pm-num" maxlength="19" autocomplete="cc-number"></div><div><label>Expiry (MMYY)</label><input id="pm-exp" maxlength="4" autocomplete="cc-exp" placeholder="0128"></div></div>
        <div class="r2"><div><label>CVV</label><input id="pm-cvv" type="password" maxlength="4"></div><div><label>ZIP</label><input id="pm-zip" maxlength="5"></div></div>
        <label>Card Brand</label>
        <select id="pm-brand"><option value="">— Select —</option><option>Visa</option><option>Mastercard</option><option>Amex</option><option>Discover</option></select>
      </div>
      <div id="daf-f" style="display:none">
        <div class="alert alert-info" style="font-size:12px;margin-top:8px">DAF donations are processed via Sola using the donor's DAF card. Sola auto-routes to the correct DAF provider (Matbia, OJC, Pledger, DonorsFund, iMasser).</div>
        <label>DAF Provider</label>
        <select id="pm-dafprov"><option value="Matbia">Matbia</option><option value="OJC">OJC</option><option value="Pledger">Pledger</option><option value="DonorsFund">DonorsFund</option><option value="iMasser">iMasser</option><option value="Other">Other</option></select>
        <label>DAF Card Number *</label>
        <input id="pm-daf" placeholder="Enter DAF card number" autocomplete="off">
        <label>Expiry (MMYY, or leave 1299 for no expiry)</label>
        <input id="pm-dafexp" value="1299" maxlength="4">
      </div>
      <div id="oth-f" style="display:none"><label>Description</label><input id="pm-oth" placeholder="Check, Cash, Wire…"></div>
      <label>Nickname (optional)</label><input id="pm-lbl" autocomplete="off">
      <div class="trow mt"><div>Set as default</div><label class="tgl"><input type="checkbox" id="pm-def" checked><span class="tgl-s"></span></label></div>
      <div class="bg mt">
        <button class="btn btn-primary" id="pm-btn" onclick="DonorDetail.saveCard('${did}')">Save & Tokenize</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, { sm: true });
  },
  _pmTypeChange() {
    const t = val('pm-type');
    $('cc-f').style.display = t==='credit_card'?'':'none';
    $('daf-f').style.display = t==='daf'?'':'none';
    $('oth-f').style.display = (t==='check'||t==='other')?'':'none';
    const btn=$('pm-btn'); if(btn) btn.textContent = t==='credit_card'?'Save & Tokenize':'Add Method';
  },
  async saveCard(did) {
    const type=val('pm-type'), lbl=val('pm-lbl'), def=$('pm-def')?.checked?1:0, btn=$('pm-btn');
    try {
      if (type==='credit_card') {
        const num=val('pm-num').replace(/\s/g,''), exp=val('pm-exp').replace(/\D/g,''), cvv=val('pm-cvv'), brand=val('pm-brand');
        if (!num||!exp) { toast('Card number and expiry required','err'); return; }
        if (btn) { btn.textContent='Tokenizing…'; btn.disabled=true; }
        const r = await API.post(`/api/orgs/${API.orgId}/payments/save-card`, {donor_id:did,card_num:num,exp,cvv,label:lbl});
        if (brand && r.paymentMethod?.id) await API.put(`/api/orgs/${API.orgId}/donors/${did}/payment-methods/${r.paymentMethod.id}`, {card_brand:brand}).catch(()=>{});
        toast(`Card ••${r.paymentMethod?.last_four||'??'} saved`);
      } else if (type === 'daf') {
        const dafCard = val('pm-daf');
        if (!dafCard) { toast('DAF card number required','err'); return; }
        // Store DAF as payment method with card num in daf_name field for charging
        await API.post(`/api/orgs/${API.orgId}/donors/${did}/payment-methods`, {
          type:'daf', label:lbl||val('pm-dafprov')||'DAF',
          daf_name: val('pm-dafprov'),
          other_description: dafCard + '|' + val('pm-dafexp'), // card|exp stored here
          is_default:def
        });
        toast('DAF method added');
      } else {
        await API.post(`/api/orgs/${API.orgId}/donors/${did}/payment-methods`, {type, label:lbl||null, other_description:val('pm-oth')||null, is_default:def});
        toast('Added');
      }
      Modal.close(); this.open(did);
    } catch(e) { if(btn){btn.textContent='Save & Tokenize';btn.disabled=false;} toast(e.message||'Unknown error','err'); }
  },
  async delPM(did, pmId) { confirmDlg('Remove payment method?', async()=>{ await API.del(`/api/orgs/${API.orgId}/donors/${did}/payment-methods/${pmId}`); toast('Removed'); DonorDetail.open(did); }); },

  chargeNow(did) {
    const pms = (this.data?.paymentMethods||[]).filter(p=>p.type==='credit_card'&&p.sola_token);
    if (!pms.length) { toast('No tokenized cards on file. Add a card first.','err'); return; }
    Modal.open('Charge Card', `
      <label>Payment Method</label>
      <select id="cn-pm">${pms.map(p=>`<option value="${p.id}">${cbrand(p.card_brand,p.last_four)} ${p.label?'('+p.label+')':''}</option>`).join('')}</select>
      <label>Amount ($)</label><input type="number" id="cn-amt" step="0.01" placeholder="0.00">
      <label>Notes (optional)</label><input id="cn-notes" autocomplete="off">
      <div class="bg mt">
        <button class="btn btn-primary" onclick="DonorDetail._doCharge('${did}')">Charge Now</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, { sm: true });
  },
  chargeCard(did, pmId) {
    Modal.open('Charge Card', `
      <label>Amount ($)</label><input type="number" id="cn-amt" step="0.01" placeholder="0.00">
      <label>Notes (optional)</label><input id="cn-notes" autocomplete="off">
      <div class="bg mt">
        <button class="btn btn-primary" onclick="DonorDetail._doCharge('${did}','${pmId}')">Charge Now</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, { sm: true });
  },
  async _doCharge(did, pmId) {
    const amt = parseFloat(val('cn-amt')); if (!amt||amt<=0) { toast('Enter amount','err'); return; }
    try {
      const r = await API.post(`/api/orgs/${API.orgId}/payments/charge`, {donor_id:did,payment_method_id:pmId||val('cn-pm'),amount:amt,notes:val('cn-notes')});
      toast(`Charged ${fmt$(amt)} · Trans: ${r.transaction_id}`); Modal.close(); this.open(did);
    } catch(e) { toast(e.message||'Unknown error','err'); }
  },

  manual(did) {
    const now = new Date().toISOString().slice(0,16);
    Modal.open('Manual Donation', `
      <div class="r2">
        <div><label>Amount ($) *</label><input type="number" id="md-amt" step="0.01" placeholder="0.00"></div>
        <div><label>Method *</label>
          <select id="md-meth" onchange="DonorDetail._manualMethodChange()">
            <option value="check">Check</option><option value="cash">Cash</option>
            <option value="daf">DAF</option><option value="wire">Wire</option><option value="other">Other</option>
          </select>
        </div>
      </div>
      <div id="check-num-row"><label>Check Number *</label><input id="md-chknum" placeholder="e.g. 1042" autocomplete="off"></div>
      <div id="daf-row" style="display:none">
        <label>DAF Provider</label>
        <select id="md-dafprov"><option value="Matbia">Matbia</option><option value="OJC">OJC</option><option value="Pledger">Pledger</option><option value="DonorsFund">DonorsFund</option><option value="iMasser">iMasser</option><option value="Other">Other</option></select>
        <label>DAF Card Number (optional — charges via Sola)</label>
        <input id="md-dafcard" placeholder="Enter card number to charge via Sola, or leave blank to record manually" autocomplete="off">
      </div>
      <div class="r2">
        <div><label>Date *</label><input type="datetime-local" id="md-date" value="${now}"></div>
        <div><label>Trans ID (auto-assigned if blank)</label><input id="md-tx" autocomplete="off" placeholder="ES…"></div>
      </div>
      <label>Notes</label><input id="md-notes" autocomplete="off">
      <div class="bg mt">
        <button class="btn btn-primary" onclick="DonorDetail._saveManual('${did}')">Record</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, { sm: true });
  },
  _manualMethodChange() {
    const m = val('md-meth');
    const checkRow = $('check-num-row'), dafRow = $('daf-row');
    if (checkRow) checkRow.style.display = m==='check' ? '' : 'none';
    if (dafRow)   dafRow.style.display   = m==='daf'   ? '' : 'none';
  },
  async _saveManual(did) {
    const amt = parseFloat(val('md-amt')); if (!amt||amt<=0) { toast('Amount required','err'); return; }
    const method = val('md-meth');
    // DAF with card number — charge via Sola
    if (method === 'daf' && val('md-dafcard').trim()) {
      try {
        const r = await API.post(`/api/orgs/${API.orgId}/payments/daf-grant`, {
          donor_id: did, daf_card_num: val('md-dafcard'), daf_provider: val('md-dafprov'),
          amount: amt, notes: val('md-notes')
        });
        toast(`DAF grant submitted · Trans: ${r.transaction_id}`); Modal.close(); this.open(did);
      } catch(e) { toast(e.message, 'err'); }
      return;
    }
    try {
      await API.post(`/api/orgs/${API.orgId}/donors/${did}/donations`, {
        amount: amt, method,
        check_number: method==='check' ? val('md-chknum') : undefined,
        donation_date: val('md-date') || new Date().toISOString(),
        transaction_id: val('md-tx') || null,
        notes: val('md-notes') || null
      });
      toast('Recorded'); Modal.close(); this.open(did);
    } catch(e) { toast(e.message, 'err'); }
  },

  addDonNote(did, donId) { Modal.open('Add Note to Donation', `<textarea id="dn-txt" style="min-height:80px;width:100%" placeholder="Note…"></textarea><div class="bg mt"><button class="btn btn-primary" onclick="DonorDetail._saveDonNote('${did}','${donId}')">Add</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`, {sm:true}); },
  async _saveDonNote(did, donId) { const txt=val('dn-txt').trim(); if(!txt)return; try{await API.post(`/api/orgs/${API.orgId}/donors/${did}/donations/${donId}/notes`,{text:txt}); toast('Added'); Modal.close(); this.open(did);}catch(e){toast(e.message||'Unknown error','err');} },

  refund(did, donId, amt, txId) { Modal.open('Refund', `<p style="margin-bottom:10px;font-size:13px;color:var(--gray-5)">Original: ${fmt$(amt)}</p><label>Refund Amount ($)</label><input type="number" id="rf-amt" step="0.01" max="${amt}" value="${amt}"><label>Reason</label><input id="rf-rsn" autocomplete="off">${txId?`<div class="alert alert-info" style="margin-top:10px;font-size:12px">Sola Ref: ${txId}</div>`:''}<div class="bg mt"><button class="btn btn-red" onclick="DonorDetail._doRefund('${did}','${donId}','${txId}')">Refund</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`, {sm:true}); },
  async _doRefund(did, donId, txId) {
    const amt = parseFloat(val('rf-amt')); if (!amt||amt<=0) { toast('Enter amount','err'); return; }
    try {
      await API.post(`/api/orgs/${API.orgId}/payments/refund`, {donation_id:donId, donor_id:did, amount:amt, notes:val('rf-rsn')});
      toast(`Refund of ${fmt$(amt)} processed`); Modal.close(); this.open(did);
    } catch(e) { toast(e.message||'Unknown error','err'); }
  },

  addRecurring(did) {
    const pms = this.data?.paymentMethods||[];
    if (!pms.length) { toast('Add a payment method first','err'); return; }
    Modal.open('Add Recurring Schedule', `
      <label>Payment Method</label>
      <select id="rec-pm">${pms.map(p=>`<option value="${p.id}">${p.type==='credit_card'?((p.card_brand||'Card')+' ••'+(p.last_four||'??')):fmtMethod(p.type)} ${p.label?'('+p.label+')':''}</option>`).join('')}</select>
      <div class="r2"><div><label>Amount ($) *</label><input type="number" id="rec-amt" step="0.01" placeholder="0.00"></div><div><label>Frequency *</label>
        <select id="rec-freq"><option value="weekly">Weekly</option><option value="biweekly">Bi-Weekly</option><option value="monthly" selected>Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option><option value="once">One-Time</option></select></div></div>
      <div class="r2"><div><label>Start Date *</label><input type="date" id="rec-start" value="${new Date().toISOString().slice(0,10)}"></div><div><label>End Date (optional)</label><input type="date" id="rec-end"></div></div>
      <label>Max Charges (blank = unlimited)</label>
      <input type="number" id="rec-lim" placeholder="e.g. 12 for one year of monthly" min="1">
      <label>Notes</label><input id="rec-notes" autocomplete="off">
      <div class="bg mt"><button class="btn btn-primary" onclick="DonorDetail._saveRec('${did}')">Save</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`, {sm:true});
  },
  async _saveRec(did) { const amt=parseFloat(val('rec-amt')); if(!amt||amt<=0){toast('Amount required','err');return;} try{await API.post(`/api/orgs/${API.orgId}/donors/${did}/recurring`,{payment_method_id:val('rec-pm'),amount:amt,frequency:val('rec-freq'),start_date:val('rec-start'),end_date:val('rec-end')||null,occurrences_limit:val('rec-lim')?parseInt(val('rec-lim')):null,notes:val('rec-notes')||null}); toast('Schedule created'); Modal.close(); this.open(did);}catch(e){toast(e.message||'Unknown error','err');} },
  async toggleRec(did, sid, status) { await API.put(`/api/orgs/${API.orgId}/donors/${did}/recurring/${sid}`,{status}); toast(status==='paused'?'Paused':'Resumed'); this.open(did); },
  editRec(did, sid, amt, freq, nextRun) { Modal.open('Edit Schedule', `<label>Amount ($)</label><input type="number" id="er-amt" value="${amt}" step="0.01"><label>Frequency</label><select id="er-freq">${['weekly','biweekly','monthly','quarterly','yearly','once'].map(f=>`<option value="${f}" ${f===freq?'selected':''}>${fmtFreq(f)}</option>`).join('')}</select><label>Next Run</label><input type="date" id="er-next" value="${nextRun?nextRun.slice(0,10):''}"><div class="bg mt"><button class="btn btn-primary" onclick="DonorDetail._saveEditRec('${did}','${sid}')">Save</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true}); },
  async _saveEditRec(did, sid) { await API.put(`/api/orgs/${API.orgId}/donors/${did}/recurring/${sid}`,{amount:parseFloat(val('er-amt')),frequency:val('er-freq'),next_run:val('er-next')}); toast('Updated'); Modal.close(); this.open(did); },
  async delRec(did, sid) { confirmDlg('Cancel this schedule?', async()=>{ await API.del(`/api/orgs/${API.orgId}/donors/${did}/recurring/${sid}`); toast('Cancelled'); DonorDetail.open(did); }); },
};

// ── Other pages ───────────────────────────────────────────────────────────────
async function renderDonations(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const rows = await API.get(`/api/orgs/${API.orgId}/reports/donations`);
    window._donAll = rows;
    el.innerHTML = `
      <div class="ph"><div><div class="ph-title">Donations</div><div class="ph-sub">${rows.length} records</div></div>
        <button class="btn btn-ghost btn-sm" onclick="API.dl('/api/orgs/${API.orgId}/reports/donations?format=xlsx','donations.xlsx').catch(e=>toast(e.message||'Unknown error','err'))">&#8681; XLSX</button>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:12px 14px;border-bottom:1px solid var(--gray-1)">
          <div class="search-bar">
            <div class="sw" style="flex:1"><input id="don-s" placeholder="Search donor or trans ID…" oninput="_filterDon()" autocomplete="off"></div>
            <select id="don-meth" onchange="_filterDon()"><option value="">All Methods</option>${[...new Set(rows.map(d=>d.method))].map(m=>`<option value="${m}">${fmtMethod(m)}</option>`).join('')}</select>
            <select id="don-stat" onchange="_filterDon()"><option value="">All Status</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="failed">Failed</option></select>
          </div>
        </div>
        <div class="tw"><table>
          <thead><tr><th>Date</th><th>Donor</th><th>Amount</th><th>Method</th><th>Trans ID</th><th>Status</th><th></th></tr></thead>
          <tbody id="don-tb">${_donRows(rows)}</tbody>
        </table></div>
      </div>`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
function _donRows(rows) {
  if (!rows.length) return '<tr><td colspan="8"><div class="empty">No donations</div></td></tr>';
  return rows.map(d => `<tr>
    <td style="font-size:12px;white-space:nowrap">${fmtD(d.donation_date)}</td>
    <td><a href="#" onclick="DonorDetail.open('${d.donor_id}');return false;" style="font-weight:600;color:var(--navy);text-decoration:none">${d.first_name} ${d.last_name}</a></td>
    <td style="font-weight:600">${fmt$(d.amount)}${d.refund_amount>0?`<br><span style="font-size:11px;color:var(--red)">−${fmt$(d.refund_amount)}</span>`:''}</td>
    <td style="font-size:12px">${fmtMethod(d.method)}${d.last_four?` ••${d.last_four}`:''}</td>
    <td style="font-size:11px;color:var(--gray-5);max-width:100px;word-break:break-all">${d.transaction_id||'—'}</td>
    <td>${sbadge(d.status)}</td>
    <td><div class="actions">
      <button class="btn btn-icon" title="Add note" onclick="_addDonationNote('${d.donor_id}','${d.id}')">&#9997;</button>
      <a class="btn btn-ghost btn-sm" href="/api/orgs/${API.orgId}/payments/receipt/${d.id}" download="receipt-${d.transaction_id||d.id}.pdf" title="Download receipt">&#8681; Receipt</a>
      ${(d.status==='completed'||d.status==='partial_refund')?`<button class="btn btn-icon" title="Refund" onclick="_refundFromList('${d.donor_id}','${d.id}','${d.amount}','${d.transaction_id||''}')">&#8617;</button>`:''}
    </div></td>
  </tr>`).join('');
}
function _addDonationNote(did, donId) { Modal.open('Add Note', `<textarea id="dn-txt" style="min-height:80px;width:100%" placeholder="Note…"></textarea><div class="bg mt"><button class="btn btn-primary" onclick="DonorDetail._saveDonNote('${did}','${donId}')">Add</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true}); }
function _refundFromList(did, donId, amt, txId) { DonorDetail.refund(did, donId, amt, txId); }
function _filterDon() { const s=val('don-s').toLowerCase(),m=val('don-meth'),st=val('don-stat'); const f=(window._donAll||[]).filter(d=>(!s||`${d.first_name} ${d.last_name} ${d.transaction_id||''}`.toLowerCase().includes(s))&&(!m||d.method===m)&&(!st||d.status===st)); const tb=$('don-tb'); if(tb)tb.innerHTML=_donRows(f); }

async function renderVerification(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const donors = await API.get(API.o.verify());
    window._verDonors = donors;
    el.innerHTML = `
      <div class="ph"><div><div class="ph-title">Info Check</div><div class="ph-sub">${donors.length} need verification</div></div>
        ${donors.length?`<button class="btn btn-green btn-sm" onclick="_verifyAll()">Verify All</button>`:''}
      </div>
      ${donors.length?`<div class="alert alert-warn">These donors haven't had their info verified in over 6 months.</div>`:'' }
      ${donors.length ? `
        <div class="card" style="padding:0;overflow:hidden"><div class="tw"><table>
          <thead><tr><th>Donor</th><th>Contact</th><th>Neighborhood</th><th>Age</th><th>Last Verified</th><th></th></tr></thead>
          <tbody>${donors.map(d=>`<tr id="vr-${d.id}">
            <td><div style="display:flex;align-items:center;gap:8px">${avatar(d,26)}<div><div style="font-weight:600;font-size:13px">${d.first_name} ${d.last_name}</div>${d.hebrew_full_name?`<div style="font-family:var(--font-he);font-size:11px">${d.hebrew_full_name}</div>`:''}</div></div></td>
            <td style="font-size:12px">${d.cell||''}${d.email?`<br>${d.email}`:''}</td>
            <td style="font-family:var(--font-he);font-size:12px">${d.neighborhood_name||'—'}</td>
            <td style="font-size:12px">${age(d.months_old)}</td>
            <td style="font-size:12px;color:var(--red)">${d.info_verified_at?fmtD(d.info_verified_at):'Never'}</td>
            <td><div class="actions"><button class="btn btn-blue btn-sm" onclick="DonorDetail.open('${d.id}')">View</button><button class="btn btn-green btn-sm" onclick="_verifyOne('${d.id}')">Verify</button></div></td>
          </tr>`).join('')}</tbody>
        </table></div></div>` :
        `<div class="card"><div class="empty"><h3>All donors verified!</h3><p>No info checks needed right now.</p></div></div>`}`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
async function _verifyOne(id) { await API.post(`/api/orgs/${API.orgId}/donors/${id}/verify`,{}); const row=$(`vr-${id}`); if(row){row.style.opacity=0;row.style.transition='opacity .3s';setTimeout(()=>row.remove(),320);} toast('Verified'); loadBadges(); }
function _verifyAll() { confirmDlg(`Verify all ${(window._verDonors||[]).length} donors?`, async()=>{ for(const d of window._verDonors||[])await API.post(`/api/orgs/${API.orgId}/donors/${d.id}/verify`,{}).catch(()=>{}); toast('All verified'); renderVerification($('page-verification')); loadBadges(); }); }

async function renderFailures(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const fs = await API.get(API.o.failures());
    const un = fs.filter(f=>!f.acknowledged);
    el.innerHTML = `
      <div class="ph"><div><div class="ph-title">Failed Charges</div><div class="ph-sub">${un.length} unacknowledged</div></div>
        ${un.length?`<button class="btn btn-ghost btn-sm" onclick="_ackAll()">Acknowledge All</button>`:''}
      </div>
      ${un.length?`<div class="alert alert-err">${un.length} charge${un.length>1?'s':''} failed — admins notified.</div>`:''}
      ${fs.length ? `
        <div class="card" style="padding:0;overflow:hidden"><div class="tw"><table>
          <thead><tr><th>Date</th><th>Donor</th><th>Amount</th><th>Reason</th><th>Status</th><th></th></tr></thead>
          <tbody>${fs.map(f=>`<tr id="fr-${f.id}" style="${f.acknowledged?'opacity:.6':''}">
            <td style="font-size:12px">${fmtDT(f.occurred_at)}</td>
            <td><strong>${f.first_name} ${f.last_name}</strong>${f.email?`<br><span style="font-size:11px;color:var(--gray-5)">${f.email}</span>`:''}</td>
            <td style="font-weight:600">${fmt$(f.amount)}</td>
            <td style="font-size:12px;color:var(--red)">${f.failure_reason||'Unknown'}</td>
            <td>${f.acknowledged?'<span class="pill pill-green">Acked</span>':'<span class="pill pill-red">New</span>'}</td>
            <td><div class="actions"><button class="btn btn-blue btn-sm" onclick="DonorDetail.open('${f.donor_id}')">View</button>${!f.acknowledged?`<button class="btn btn-ghost btn-sm" onclick="_ackOne('${f.id}')">Ack</button>`:''}</div></td>
          </tr>`).join('')}</tbody>
        </table></div></div>` :
        `<div class="card"><div class="empty"><h3>No failed charges</h3></div></div>`}`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
async function _ackOne(id) { await API.post(`/api/orgs/${API.orgId}/charge-failures/${id}/acknowledge`,{}); toast('Acknowledged'); const r=$(`fr-${id}`); if(r){r.style.opacity=.6; const btn=r.querySelector('.btn-ghost'); if(btn&&btn.textContent==='Ack')btn.remove();} loadBadges(); }
async function _ackAll() { confirmDlg('Acknowledge all?',async()=>{await API.post(`/api/orgs/${API.orgId}/charge-failures/acknowledge-all`,{}); toast('All acknowledged'); renderFailures($('page-failures')); loadBadges();}); }

async function renderBank(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const txs = await API.get(`/api/orgs/${API.orgId}/bank/transactions`);
    el.innerHTML = `
      <div class="ph"><div><div class="ph-title">Bank</div></div>
        <div class="bg">
          <button class="btn btn-ghost btn-sm" onclick="API.post('/api/orgs/${API.orgId}/bank/sync',{}).then(()=>toast('Sync initiated')).catch(e=>toast(e.message||'Unknown error','err'))">&#8635; Sync</button>
          <button class="btn btn-primary btn-sm" onclick="_connectBank()">+ Connect Bank</button>
        </div>
      </div>
      <div class="alert alert-info">Chase bank requires API credentials or Plaid integration. Contact support to set up.</div>
      ${txs.length ? `<div class="card" style="padding:0;overflow:hidden"><div class="tw"><table>
        <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Type</th><th>Label</th><th></th></tr></thead>
        <tbody>${txs.map(t=>`<tr>
          <td style="font-size:12px">${fmtD(t.transaction_date)}</td>
          <td>${t.description||t.merchant||'—'}</td>
          <td style="font-weight:600;color:${t.direction==='credit'?'var(--green)':'var(--red)'}">${t.direction==='debit'?'−':''}${fmt$(t.amount)}</td>
          <td>${t.direction==='credit'?'<span class="pill pill-green">Credit</span>':'<span class="pill pill-red">Debit</span>'}</td>
          <td>${t.label?`<span class="pill pill-blue">${t.label}</span>`:'—'}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="_labelTx('${t.id}')">Label</button></td>
        </tr>`).join('')}</tbody>
      </table></div></div>` : `<div class="card"><div class="empty"><h3>No transactions</h3><p>Connect your bank to see transactions.</p></div></div>`}`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
function _connectBank(){Modal.open('Connect Bank',`<div class="alert alert-info">Chase requires OAuth credentials or Plaid.</div><label>API Key</label><input id="bk-key" type="password"><label>API Secret</label><input id="bk-sec" type="password"><div class="bg mt"><button class="btn btn-primary" onclick="API.post('/api/orgs/${API.orgId}/bank',{api_key:val('bk-key'),api_secret:val('bk-sec')}).then(()=>{toast('Connected');Modal.close()}).catch(e=>toast(e.message||'Unknown error','err'))">Connect</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}
function _labelTx(id){Modal.open('Label Transaction',`<label>Label</label><input id="tx-lbl" placeholder="e.g. Donation, Expense…"><div class="bg mt"><button class="btn btn-primary" onclick="API.post('/api/orgs/${API.orgId}/bank/transactions/${id}/label',{label:val('tx-lbl')}).then(()=>{toast('Labeled');Modal.close();renderBank($('page-bank'))}).catch(e=>toast(e.message||'Unknown error','err'))">Save</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}

async function renderEmails(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const [cfg, sched] = await Promise.all([API.get(API.o.email()), API.get(API.o.schedEmails())]);
    el.innerHTML = `
      <div class="ph"><div class="ph-title">Emails</div></div>
      <div class="tabs"><div class="tab on" data-tc="em-smtp">SMTP</div><div class="tab" data-tc="em-tpl">Template</div><div class="tab" data-tc="em-sched">Scheduled</div></div>
      <div id="em-smtp" class="tc on"><div class="card">
        <div class="trow"><div>Pause all donation receipt emails</div><label class="tgl"><input type="checkbox" id="em-pause" ${cfg?.donation_emails_paused?'checked':''}><span class="tgl-s"></span></label></div>
        <hr class="divider">
        <div class="r2"><div><label>SMTP Email</label><input id="em-email" value="${cfg?.smtp_email||''}" autocomplete="email"></div><div><label>From Name</label><input id="em-name" value="${cfg?.from_name||''}"></div></div>
        <div class="r2"><div><label>SMTP Host</label><input id="em-host" value="${cfg?.smtp_host||'smtp.gmail.com'}"></div><div><label>Port</label><input id="em-port" type="number" value="${cfg?.smtp_port||587}"></div></div>
        <label>App Password <span style="font-size:11px;color:var(--gray-5)">(blank = keep existing)</span></label>
        <input id="em-pass" type="password" placeholder="Paste app password here">
        <small style="color:var(--gray-5)">Gmail: Google Account → Security → App Passwords</small>
        <div class="bg mt">
          <button class="btn btn-primary" onclick="_saveEmailCfg()">Save</button>
          <button class="btn btn-ghost btn-sm" onclick="_testEmail()">Send Test</button>
        </div>
      </div></div>
      <div id="em-tpl" class="tc"><div class="card">
        <p style="color:var(--gray-5);font-size:12px;margin-bottom:10px">Variables: {first_name} {last_name} {title} {amount} {date} {transaction_id} {method} {org_name}</p>
        <label>Donation Receipt Template (HTML)</label>
        <textarea id="em-tpl-txt" style="min-height:240px;font-size:12px;font-family:monospace">${cfg?.receipt_template||''}</textarea>
        <div class="bg mt"><button class="btn btn-primary" onclick="API.put(API.o.email(),{receipt_template:val('em-tpl-txt')}).then(()=>toast('Saved')).catch(e=>toast(e.message||'Unknown error','err'))">Save Template</button></div>
      </div></div>
      <div id="em-sched" class="tc"><div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong>Scheduled Emails</strong>
          <button class="btn btn-primary btn-sm" onclick="_schedEmail()">+ Schedule</button>
        </div>
        <div class="tw"><table>
          <thead><tr><th>Subject</th><th>Scheduled</th><th>Status</th><th></th></tr></thead>
          <tbody>${sched.map(e=>`<tr>
            <td style="max-width:180px;font-size:13px">${e.subject}</td>
            <td style="font-size:12px;white-space:nowrap">${fmtDT(e.scheduled_for)}</td>
            <td>${sbadge(e.status)}</td>
            <td><div class="actions">
              ${e.status==='pending'?`<button class="btn btn-ghost btn-sm" onclick="_editSchedEmail('${e.id}')">Edit</button>`:''}
              <button class="btn btn-ghost btn-sm" onclick="_testSchedEmail('${e.id}')">Test</button>
              ${e.status==='pending'?`<button class="btn btn-icon" style="color:var(--red)" onclick="API.del('/api/orgs/${API.orgId}/scheduled-emails/${e.id}').then(()=>{toast('Cancelled');renderEmails($('page-emails'))}).catch(e=>toast(e.message||'Unknown error','err'))">&#10005;</button>`:''}
            </div></td>
          </tr>`).join('')||'<tr><td colspan="4"><div class="empty">No scheduled emails</div></td></tr>'}</tbody>
        </table></div>
      </div></div>`;
    tabsInit('#page-emails');
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
async function _saveEmailCfg(){try{const d={smtp_email:val('em-email'),smtp_host:val('em-host'),smtp_port:parseInt(val('em-port')),from_name:val('em-name'),donation_emails_paused:$('em-pause')?.checked?1:0};if(val('em-pass'))d.smtp_password=val('em-pass');await API.put(API.o.email(),d);toast('Saved');}catch(e){toast(e.message||'Unknown error','err');}}
function _testEmail(){Modal.open('Send Test Email',`
  <p style="font-size:13px;color:var(--gray-5);margin-bottom:10px">Sends a test receipt email with placeholder data. Tax ID 11-6076986 will be included.</p>
  <label>Send to</label><input id="te-to" type="email" placeholder="your@email.com">
  <div class="bg mt">
    <button class="btn btn-primary" onclick="API.post('/api/orgs/${API.orgId}/email-settings/test',{to:val('te-to')}).then(()=>{toast('Sent ✓');Modal.close()}).catch(e=>toast(e.message||'Unknown error','err'))">Send Test</button>
    <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
  </div>`,{sm:true});}
function _editSchedEmail(id, subject, scheduledFor) {
  Modal.open('Edit Scheduled Email', `
    <label>Subject</label><input id="ese-subj" value="${subject}">
    <label>Body (HTML)</label><textarea id="ese-body" style="min-height:140px;font-size:12px"></textarea>
    <label>Send At</label><input type="datetime-local" id="ese-at" value="${toLocalDT(scheduledFor)}">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="API.put(API.o.schedEmails()+'/'+id,{subject:val('ese-subj'),html_body:val('ese-body'),scheduled_for:val('ese-at')}).then(()=>{toast('Updated');Modal.close();renderEmails($('page-emails'))}).catch(e=>toast(e.message||'Unknown error','err'))">Save</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}
function _testSchedEmail(id) {
  Modal.open('Test Send', `
    <p style="font-size:13px;color:var(--gray-5);margin-bottom:10px">Send this email now as a test.</p>
    <label>Send to</label><input id="tse-to" type="email" placeholder="your@email.com">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="API.post(API.o.schedEmails()+'/'+id+'/test',{to:val('tse-to')}).then(()=>{toast('Test sent!');Modal.close()}).catch(e=>toast(e.message||'Unknown error','err'))">Send Test</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}
function _schedEmail(){const now=new Date();now.setHours(now.getHours()+1);Modal.open('Schedule Email',`<label>Subject</label><input id="se-subj"><label>Body (HTML)</label><textarea id="se-body" style="min-height:140px;font-size:12px"></textarea><label>Send At</label><input type="datetime-local" id="se-at" value="${toLocalDT(now.toISOString())}"><div class="bg mt"><button class="btn btn-primary" onclick="API.post(API.o.schedEmails(),{subject:val('se-subj'),html_body:val('se-body'),scheduled_for:val('se-at')}).then(()=>{toast('Scheduled');Modal.close();renderEmails($('page-emails'))}).catch(e=>toast(e.message||'Unknown error','err'))">Schedule</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}

async function renderKvitel(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const [s, donors] = await Promise.all([API.get(API.o.kvitel()), API.get(API.o.donors()+'?limit=200')]);
    const c = s || {};
    const fonts = ['Noto Sans Hebrew','Frank Ruhl Libre','Heebo','Narkisim','Times New Roman','Livvorn'];
    el.innerHTML = `
      <div class="ph"><div class="ph-title">Kvitel</div>
        <div class="bg">
          <button class="btn btn-outline btn-sm" onclick="API.dl('/api/orgs/${API.orgId}/kvitel/generate-pdf','kvitel.pdf','POST',{}).catch(e=>toast(e.message||'Unknown error','err'))">&#8681; PDF</button>
          <button class="btn btn-primary btn-sm" onclick="API.dl('/api/orgs/${API.orgId}/kvitel/generate-docx','kvitel.docx','POST',{}).catch(e=>toast(e.message||'Unknown error','err'))">&#8681; DOCX</button>
        </div>
      </div>
      <div class="g2">
        <div class="card">
          <div class="card-title">Header</div>
          <div class="r2"><div><label>Text</label><input id="kh-txt" value="${c.header_text||''}"></div><div><label>Font</label><select id="kh-font">${fonts.map(f=>`<option ${c.header_font===f?'selected':''}>${f}</option>`).join('')}</select></div></div>
          <div class="r4">
            <div><label>Size (pt)</label><input type="number" id="kh-sz" value="${c.header_size||18}" min="10" max="60"></div>
            <div><label>Bold</label><br><label class="tgl" style="margin-top:6px"><input type="checkbox" id="kh-bold" ${c.header_bold!==0?'checked':''}><span class="tgl-s"></span></label></div>
            <div><label>Align</label><select id="kh-align"><option value="center" ${c.header_align==='center'?'selected':''}>Center</option><option value="right" ${c.header_align==='right'?'selected':''}>Right</option><option value="left" ${c.header_align==='left'?'selected':''}>Left</option></select></div>
            <div><label>Direction</label><select id="kh-dir"><option value="rtl" ${(c.header_dir||'rtl')==='rtl'?'selected':''}>RTL</option><option value="ltr" ${c.header_dir==='ltr'?'selected':''}>LTR</option></select></div>
          </div>
          <hr class="divider">
          <div class="card-title">Body</div>
          <div class="r2"><div><label>Font</label><select id="kb-font" onchange="$('kv-prev').style.fontFamily=this.value">${fonts.map(f=>`<option ${c.font_family===f?'selected':''}>${f}</option>`).join('')}</select></div><div><label>Size (pt)</label><input type="number" id="kb-sz" value="${c.font_size||12}" step="0.5" min="8" max="24"></div></div>
          <div class="r2"><div><label>Line Height</label><input type="number" id="kb-lh" value="${c.line_height||1.6}" step="0.1" min="1" max="3"></div><div><label>Columns</label><select id="kb-cols">${[1,2,3,4].map(n=>`<option ${c.columns==n?'selected':''}>${n}</option>`).join('')}</select></div></div>
          <div class="r2"><div><label>Column Gap (in)</label><input type="number" id="kb-gap" value="${c.column_gap||0.5}" step="0.1" min="0" max="2"></div><div><label>Page</label><select id="kb-page"><option value="letter" ${c.page_size==='letter'?'selected':''}>Letter 8.5×11</option><option value="legal" ${c.page_size==='legal'?'selected':''}>Legal 8.5×14</option><option value="a4" ${c.page_size==='a4'?'selected':''}>A4</option></select></div></div>
          <div class="r4" style="margin-top:4px">${['top','bottom','left','right'].map(m=>`<div><label>Margin ${m} (in)</label><input type="number" id="km-${m}" value="${c['margin_'+m]||1}" step="0.25" min="0" max="3"></div>`).join('')}</div>
          <div class="trow mt"><div>Group by Neighborhood</div><label class="tgl"><input type="checkbox" id="kb-nh" ${c.group_by_neighborhood!==0?'checked':''}><span class="tgl-s"></span></label></div>
          <div class="bg mt"><button class="btn btn-primary" onclick="_saveKvitelCfg()">Save Settings</button></div>
        </div>
        <div class="card">
          <div class="card-title">Preview <span style="font-size:11px;color:var(--gray-5)">(RTL always)</span></div>
          <div id="kv-prev" class="kv-preview" style="font-family:${c.font_family||'Noto Sans Hebrew'}">
            ${(donors.donors||[]).filter(d=>d.kvitel).slice(0,15).map(d=>`<div style="margin-bottom:14px"><strong>${d.hebrew_full_name||d.first_name+' '+d.last_name}</strong>${d.neighborhood_name?`<span style="font-size:11px;color:var(--gray-5)"> — ${d.neighborhood_name}</span>`:''}<div style="font-size:13px;white-space:pre-line;margin-top:3px">${d.kvitel}</div></div>`).join('<hr style="border:none;border-top:1px solid #eee;margin:8px 0">') || '<p style="color:var(--gray-5)">No donors with kvitel content</p>'}
          </div>
          <p style="font-size:12px;color:var(--gray-5);margin-top:8px">${(donors.donors||[]).filter(d=>d.kvitel).length} donors with kvitel</p>
        </div>
      </div>`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
async function _saveKvitelCfg(){
  try{
    const ht=val('kh-txt'),hf=val('kh-font'),hs=parseFloat(val('kh-sz')),hb=$('kh-bold')?.checked,ha=val('kh-align'),hd=val('kh-dir');
    await API.put(API.o.kvitel(),{
      header_text:ht,header_font:hf,header_size:hs,header_bold:hb?1:0,header_align:ha,header_dir:hd,
      header_html:`<p style="font-family:${hf};font-size:${hs}pt;font-weight:${hb?'bold':'normal'};text-align:${ha};direction:${hd}">${ht}</p>`,
      font_family:val('kb-font'),font_size:parseFloat(val('kb-sz')),line_height:parseFloat(val('kb-lh')),
      columns:parseInt(val('kb-cols')),column_gap:parseFloat(val('kb-gap')),page_size:val('kb-page'),
      group_by_neighborhood:$('kb-nh')?.checked?1:0,
      margin_top:parseFloat(val('km-top')),margin_bottom:parseFloat(val('km-bottom')),
      margin_left:parseFloat(val('km-left')),margin_right:parseFloat(val('km-right')),
    });
    toast('Settings saved');
  }catch(e){toast(e.message||'Unknown error','err');}
}

async function renderReports(el) {
  const today = new Date().toISOString().slice(0,10);
  const m1 = today.slice(0,7)+'-01';
  el.innerHTML = `
    <div class="ph"><div class="ph-title">Reports</div></div>
    <div class="card" style="margin-bottom:14px">
      <div class="r4">
        <div><label>From</label><input type="date" id="rp-from" value="${m1}"></div>
        <div><label>To</label><input type="date" id="rp-to" value="${today}"></div>
        <div><label>Method</label><select id="rp-meth"><option value="">All</option>${['credit_card','daf','check','cash','wire','other'].map(m=>`<option value="${m}">${fmtMethod(m)}</option>`).join('')}</select></div>
        <div><label>Status</label><select id="rp-stat"><option value="">All</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="failed">Failed</option></select></div>
      </div>
      <div class="bg mt">
        <button class="btn btn-primary" onclick="_runReport()">Generate</button>
        <button class="btn btn-ghost btn-sm" onclick="_dlReport()">&#8681; XLSX</button>
        <button class="btn btn-ghost btn-sm" onclick="API.dl('/api/orgs/${API.orgId}/reports/donors?format=xlsx','donors.xlsx').catch(e=>toast(e.message||'Unknown error','err'))">&#8681; Donors XLSX</button>
      </div>
    </div>
    <div id="rp-out"></div>`;
}
async function _runReport(){const p=new URLSearchParams({from:val('rp-from'),to:val('rp-to'),method:val('rp-meth'),status:val('rp-stat')});const out=$('rp-out');out.innerHTML='<div class="spinner"></div>';try{const rows=await API.get(`/api/orgs/${API.orgId}/reports/donations?${p}`);const tot=rows.reduce((s,r)=>s+(r.amount||0),0);out.innerHTML=`<div class="card" style="padding:0;overflow:hidden"><div style="padding:10px 14px;border-bottom:1px solid var(--gray-1)"><strong>${rows.length} donations · Total: ${fmt$(tot)}</strong></div><div class="tw"><table><thead><tr><th>Date</th><th>Donor</th><th>Amount</th><th>Method</th><th>Trans ID</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(d=>`<tr><td style="font-size:12px">${fmtD(d.donation_date)}</td><td><strong>${d.first_name} ${d.last_name}</strong></td><td style="font-weight:600">${fmt$(d.amount)}</td><td style="font-size:12px">${fmtMethod(d.method)}</td><td style="font-size:11px;color:var(--gray-5)">${d.transaction_id||'—'}</td><td>${sbadge(d.status)}</td></tr>`).join('')||'<tr><td colspan="8"><div class="empty">No results</div></td></tr>'}</tbody></table></div></div>`;}catch(e){out.innerHTML=`<div class="alert alert-err">${e.message}</div>`;}}
function _dlReport(){const p=new URLSearchParams({from:val('rp-from'),to:val('rp-to'),method:val('rp-meth'),status:val('rp-stat'),format:'xlsx'});API.dl(`/api/orgs/${API.orgId}/reports/donations?${p}`,'report.xlsx').catch(e=>toast(e.message||'Unknown error','err'));}

async function renderSettings(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const [users, log, hoods] = await Promise.all([API.get(API.o.users()), API.get(API.o.log()), API.get(API.o.hoods())]);
    const daf = []; // DAF accounts are per-donor payment methods, not global settings
    el.innerHTML = `
      <div class="ph"><div class="ph-title">Settings</div></div>
      <div class="tabs"><div class="tab on" data-tc="st-users">Users</div><div class="tab" data-tc="st-nh">Neighborhoods</div><div class="tab" data-tc="st-daf">DAF</div><div class="tab" data-tc="st-log">Login Log</div></div>
      <div id="st-users" class="tc on"><div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Users</strong>
          <div class="bg">
            ${DRM.user?.is_super_admin?`<button class="btn btn-outline btn-sm" onclick="_inviteAcct()">+ Invite New Account</button>`:''}
            <button class="btn btn-primary btn-sm" onclick="_inviteUser()">+ Invite User</button>
          </div>
        </div>
        <div class="tw"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Login</th><th></th></tr></thead>
          <tbody>${users.map(u=>`<tr><td><strong>${u.full_name}</strong></td><td style="font-size:12px">${u.email}</td><td><span class="pill ${u.role==='admin'?'pill-blue':'pill-gray'}">${u.role}</span></td><td style="font-size:12px">${fmtDT(u.last_login)}</td><td><div class="actions"><button class="btn btn-ghost btn-sm" onclick="_resetPw('${u.id}','${u.full_name}')">Reset PW</button><button class="btn btn-icon" style="color:var(--red)" onclick="_removeUser('${u.id}','${u.full_name}')">&#10005;</button></div></td></tr>`).join('')}</tbody>
        </table></div>
      </div></div>
      <div id="st-nh" class="tc"><div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><strong>Neighborhoods</strong><button class="btn btn-primary btn-sm" onclick="_addHood()">+ Add</button></div>
        ${hoods.map(h=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--gray-1)"><span style="font-family:var(--font-he);font-size:15px">${h.name_he}</span><button class="btn btn-icon" style="color:var(--red)" onclick="API.del(API.o.hoods()+'/${h.id}').then(()=>{toast('Removed');renderSettings($('page-settings'))}).catch(e=>toast(e.message||'Unknown error','err'))">&#10005;</button></div>`).join('')||'<p style="color:var(--gray-5)">No neighborhoods yet</p>'}
      </div></div>
      <div id="st-daf" class="tc"><div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><strong>DAF Accounts</strong><button class="btn btn-primary btn-sm" onclick="_addDaf()">+ Add DAF</button></div>
        ${daf.map(d=>`<div class="sched-item"><div><div class="sched-main">${d.name}</div>${d.contact_email?`<div class="sched-sub">${d.contact_name||''} ${d.contact_email}</div>`:''}</div><button class="btn btn-icon" style="color:var(--red)" onclick="API.del(API.o.daf()+'/${d.id}').then(()=>{toast('Removed');renderSettings($('page-settings'))}).catch(e=>toast(e.message||'Unknown error','err'))">&#10005;</button></div>`).join('')||'<p style="color:var(--gray-5)">No DAF accounts</p>'}
      </div></div>
      <div id="st-log" class="tc"><div class="card">
        <div class="card-title">Login Audit Log</div>
        <div class="scroll-box"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>IP</th></tr></thead>
        <tbody>${log.slice(0,100).map(l=>`<tr><td style="font-size:12px">${fmtDT(l.created_at)}</td><td>${l.full_name}</td><td><span class="pill ${l.action==='login'?'pill-green':'pill-gray'}">${l.action}</span></td><td style="font-size:11px;color:var(--gray-5)">${l.ip||'—'}</td></tr>`).join('')}</tbody>
        </table></div>
      </div></div>`;
    tabsInit('#page-settings');
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
function _inviteUser(){Modal.open('Invite User',`<p style="color:var(--gray-5);font-size:13px;margin-bottom:12px">They'll receive a setup link to create their own password.</p><label>Email *</label><input id="iu-email" type="email" autocomplete="off"><label>Role</label><select id="iu-role"><option value="staff">Staff</option><option value="admin">Admin</option></select><div id="iu-res" style="display:none;margin-top:10px"></div><div class="bg mt"><button class="btn btn-primary" onclick="_doInviteUser()">Send Invite</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}
async function _doInviteUser(){try{const r=await API.post(`/api/orgs/${API.orgId}/users/invite`,{email:val('iu-email'),role:val('iu-role')});const res=$('iu-res');res.innerHTML=r.emailSent?`<div class="alert alert-ok">Invite sent to ${val('iu-email')}</div>`:`<div class="alert alert-warn">Email not configured. Share this link:<br><a href="${r.setupUrl}" target="_blank" style="font-size:11px;word-break:break-all">${r.setupUrl}</a></div>`;res.style.display='block';renderSettings($('page-settings'));}catch(e){toast(e.message||'Unknown error','err');}}
function _inviteAcct(){Modal.open('Invite New Account',`<p style="color:var(--gray-5);font-size:13px;margin-bottom:12px">They'll get a link to create their org and admin account.</p><label>Email *</label><input id="ia-email" type="email" autocomplete="off"><div id="ia-res" style="display:none;margin-top:10px"></div><div class="bg mt"><button class="btn btn-primary" onclick="_doInviteAcct()">Send Invite</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}
async function _doInviteAcct(){try{const r=await API.post('/auth/invite-account',{email:val('ia-email')});const res=$('ia-res');res.innerHTML=r.emailSent?`<div class="alert alert-ok">Invite sent to ${val('ia-email')}</div>`:`<div class="alert alert-warn">Email not configured. Share this link:<br><a href="${r.setupUrl}" target="_blank" style="font-size:11px;word-break:break-all">${r.setupUrl}</a></div>`;res.style.display='block';}catch(e){toast(e.message||'Unknown error','err');}}
function _resetPw(id,name){Modal.open('Reset Password',`<p style="margin-bottom:10px">New password for <strong>${name}</strong></p><label>Password</label><input id="rp-pw" type="password"><div class="bg mt"><button class="btn btn-primary" onclick="API.put('/api/orgs/${API.orgId}/users/${id}/password',{password:val('rp-pw')}).then(()=>{toast('Updated');Modal.close()}).catch(e=>toast(e.message||'Unknown error','err'))">Set</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}
function _removeUser(id,name){confirmDlg(`Remove ${name}?`,async()=>{await API.del(`/api/orgs/${API.orgId}/users/${id}`);toast('Removed');renderSettings($('page-settings'));});}
function _uploadLogo() {
  Modal.open('Upload Receipt Logo', `
    <p style="font-size:13px;color:var(--gray-5);margin-bottom:10px">Upload your organization logo to appear on PDF receipts.</p>
    <input type="file" id="logo-file" accept="image/png,image/jpeg">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_doUploadLogo()">Upload</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}
async function _doUploadLogo() {
  const file = $('logo-file')?.files?.[0]; if (!file) { toast('Select a file','err'); return; }
  const reader = new FileReader();
  reader.onload = async e => {
    const base64 = e.target.result.split(',')[1];
    try {
      await API.post('/api/orgs/' + API.orgId + '/upload-logo', {logo_base64: base64, mime_type: file.type});
      toast('Logo uploaded ✓'); Modal.close();
    } catch(err) { toast(err.message||'Upload failed','err'); }
  };
  reader.readAsDataURL(file);
}
function _addHood(){Modal.open('Add Neighborhood',`<label>Hebrew Name</label><input id="nh-he" dir="rtl" style="font-family:var(--font-he)" placeholder="שם השכונה"><label>English (optional)</label><input id="nh-en"><div class="bg mt"><button class="btn btn-primary" onclick="API.post(API.o.hoods(),{name_he:val('nh-he'),name_en:val('nh-en')}).then(()=>{toast('Added');Modal.close();renderSettings($('page-settings'))}).catch(e=>toast(e.message||'Unknown error','err'))">Add</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}
function _addDaf(){Modal.open('Add DAF Account',`<label>DAF Name *</label><input id="df-nm" placeholder="Fidelity Charitable"><label>Contact Name</label><input id="df-cn"><label>Contact Email</label><input id="df-ce" type="email"><div class="bg mt"><button class="btn btn-primary" onclick="API.post(API.o.daf(),{name:val('df-nm'),contact_name:val('df-cn'),contact_email:val('df-ce')}).then(()=>{toast('Added');Modal.close();renderSettings($('page-settings'))}).catch(e=>toast(e.message||'Unknown error','err'))">Add</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}

// ── Boot ──────────────────────────────────────────────────────────────────────
// ── Outstanding Manual Charges ────────────────────────────────────────────────
async function renderOutstanding(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const charges = await API.get('/api/orgs/' + API.orgId + '/outstanding-charges');
    const badge = $('outstanding-badge');
    if (badge) { if(charges.length){badge.textContent=charges.length;badge.style.display='inline';}else{badge.style.display='none';} }
    el.innerHTML = `
      <div class="ph">
        <div><div class="ph-title">Pending Manual Collection</div>
        <div class="ph-sub">Scheduled charges that need to be collected manually (check, cash, wire, etc.)</div></div>
      </div>
      ${charges.length ? `
      <div class="card" style="padding:0;overflow:hidden">
        <div class="tw"><table>
          <thead><tr><th>Scheduled</th><th>Donor</th><th>Amount</th><th>Method</th><th>Notes</th><th></th></tr></thead>
          <tbody>${charges.map(c => `<tr id="oc-${c.id}">
            <td style="font-size:12px;white-space:nowrap">${fmtD(c.scheduled_for)}</td>
            <td><strong>${c.first_name} ${c.last_name}</strong>${c.cell?`<br><span style="font-size:11px;color:var(--gray-5)">${c.cell}</span>`:''}</td>
            <td style="font-weight:600">${fmt$(c.amount)}</td>
            <td style="font-size:12px">${c.pm_label||c.pm_type||'Manual'}</td>
            <td style="font-size:12px">${c.notes||''}</td>
            <td><div class="actions">
              <button class="btn btn-primary btn-sm" onclick="_collectCharge('${c.id}','${c.amount}')">Collect</button>
              <button class="btn btn-ghost btn-sm" onclick="DonorDetail.open('${c.donor_id}')">View Donor</button>
            </div></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>` : `<div class="card"><div class="empty"><h3>No outstanding charges</h3><p>All manual charges have been collected.</p></div></div>`}`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message||'Error'}</div>`; }
}
function _collectCharge(chargeId, amount) {
  Modal.open('Mark as Collected', `
    <p style="font-size:13px;color:var(--gray-5);margin-bottom:12px">Enter the transaction details for this collected payment.</p>
    <label>Amount Collected ($)</label>
    <input type="number" id="oc-amt" value="${amount}" step="0.01">
    <label>Transaction ID / Check # (auto-assigned if blank)</label>
    <input id="oc-tx" placeholder="e.g. check #1042 or wire ref" autocomplete="off">
    <label>Notes (optional)</label>
    <input id="oc-notes" autocomplete="off">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_doCollectCharge('${chargeId}')">Mark Collected</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}
function _doCollectCharge(chargeId) {
  API.post('/api/orgs/' + API.orgId + '/outstanding-charges/' + chargeId + '/collect', {
    amount: parseFloat(val('oc-amt')),
    transaction_id: val('oc-tx') || null,
    notes: val('oc-notes') || null
  }).then(() => {
    toast('Collected ✓'); Modal.close();
    const row = $('oc-' + chargeId);
    if (row) { row.style.opacity='0'; row.style.transition='opacity .3s'; setTimeout(()=>row.remove(),320); }
    renderOutstanding($('page-outstanding'));
  }).catch(e => toast(e.message||'Error','err'));
}

document.addEventListener('DOMContentLoaded', init);
