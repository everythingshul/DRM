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
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      credentials: 'include'
    };
    if (data && method !== 'GET') opts.body = JSON.stringify(data);
    let res;
    try { res = await fetch(url, opts); } catch(e) { throw new Error('Network error: ' + e.message); }
    if (res.status === 401) {
      // Clear any stale token before redirecting
      localStorage.removeItem('drm_token');
      if (!_redirecting) {
        _redirecting = true;
        showLogin();
        // Don't reset _redirecting — keep it true until user logs in successfully
      }
      throw new Error('Session expired');
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      const txt = await res.text();
      // Strip HTML tags to get readable error text
      const clean = txt.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
      throw new Error(clean.slice(0, 300) || `Server error (${res.status})`);
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || json.message || (typeof json==='string'?json:JSON.stringify(json)) || `Request failed (${res.status})`);
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
    kvitel:      ()   => `/api/orgs/${API.orgId}/kvitel/settings`,  // routed through kvitel.js
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
  // Fully JS-driven — no CSS animation to conflict with
  const c = $('toast-wrap');
  if (!c) return;
  const t = document.createElement('div');
  const text = String(msg || 'An error occurred');
  // Inline all styles — guaranteed to show regardless of CSS issues
  const bg = type==='err' ? '#d63031' : type==='warn' ? '#f0a500' : '#22a06b';
  const color = type==='warn' ? '#1a1a2e' : '#ffffff';
  t.setAttribute('style',
    `background:${bg};color:${color};padding:11px 16px;border-radius:6px;` +
    `font-size:13px;font-family:Arial,sans-serif;font-weight:500;` +
    `box-shadow:0 4px 16px rgba(0,0,0,0.22);max-width:340px;` +
    `word-break:break-word;line-height:1.4;` +
    `position:relative;right:-320px;opacity:0;` +
    `transition:right 0.25s ease, opacity 0.25s ease`
  );
  t.textContent = text;
  c.appendChild(t);
  // Slide in after a tick
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      t.style.right = '0';
      t.style.opacity = '1';
    });
  });
  // Fade out and remove
  const dur = type==='err' ? 7000 : 3500;
  setTimeout(() => {
    t.style.right = '-320px';
    t.style.opacity = '0';
    setTimeout(() => { if(t.parentNode) t.parentNode.removeChild(t); }, 300);
  }, dur);
}

const Modal = {
  open(title, html, opts={}) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    const box = $('modal-box');
    box.className = 'modal-box'
      + (opts.lg   ? ' lg'   : '')
      + (opts.sm   ? ' sm'   : '')
      + (opts.tall ? ' tall' : '')
      + (opts.full ? ' full' : '');
    $('modal-overlay').style.display = 'flex';
    if (opts.cb) setTimeout(opts.cb, 0);
  },
  close() { $('modal-overlay').style.display = 'none'; $('modal-body').innerHTML = ''; window._donorDetailId = null; },
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
function fmtD(d) {
  if (!d) return '—';
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [y,m,day]=d.split('-').map(Number);
      return new Date(y,m-1,day).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});
    }
    return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});
  } catch { return d; }
}
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

// Preset-only label picker. labelType: 'donor_labels' or 'donation_labels' from org label-lists.
// Renders selected labels as removable pills + a dropdown of remaining org-defined labels.
// No free text is ever accepted — labels must come from Settings > Labels.
function labelPicker(id, initSelected = [], labelType = 'donor_labels') {
  const c = $(id);
  let selected = [...initSelected];
  let available = []; // org's full label list for this type

  const render = () => {
    const remaining = available.filter(l => !selected.includes(l));
    c.innerHTML = `
      <div class="bg" style="flex-wrap:wrap;gap:4px;margin-bottom:6px">
        ${selected.length ? selected.map((l, i) => `<span class="pill pill-blue">${l} <span style="cursor:pointer" onclick="window['_lp_rm_${id}'](${i})">×</span></span>`).join('') : '<span style="font-size:12px;color:var(--gray-5)">No labels selected</span>'}
      </div>
      <select id="${id}-sel" style="width:100%">
        <option value="">${remaining.length ? '— Add label —' : (available.length ? '— All labels added —' : '— No labels defined in Settings —')}</option>
        ${remaining.map(l => `<option value="${l}">${l}</option>`).join('')}
      </select>`;
    $(`${id}-sel`)?.addEventListener('change', function () {
      if (this.value && !selected.includes(this.value)) { selected.push(this.value); render(); }
    });
  };
  window[`_lp_rm_${id}`] = i => { selected.splice(i, 1); render(); };

  // Load the org's label list for this type, then render
  API.get(`/api/orgs/${API.orgId}/label-lists`).then(ll => {
    available = ll[labelType] || [];
    render();
  }).catch(() => { available = []; render(); });

  render(); // render immediately with empty available so UI isn't blank while loading
  return { get: () => selected, set: a => { selected = [...a]; render(); } };
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

  // Only show setup if truly first run AND no existing token
  // (a token means they've logged in before — disk may have reset on Render)
  const existingToken = localStorage.getItem('drm_token');
  if (status?.needsSetup && !existingToken) { showSetup(); return; }
  if (status?.needsSetup && existingToken) {
    // DB was reset but user has a token — show login with a helpful message
    localStorage.removeItem('drm_token');
    showLogin();
    setTimeout(() => {
      const err = $('login-err');
      if (err) {
        err.textContent = 'Your session was reset. Please sign in again.';
        err.style.display = 'block';
      }
    }, 100);
    return;
  }

  // Try to restore existing session
  try {
    const me = await API.get('/auth/me');
    DRM.user = me.user;
    _allOrgs = me.orgs;
    if (me.orgs.length) await setOrg(me.orgs[0]);
    showApp();
  } catch {
    localStorage.removeItem('drm_token');
    _redirecting = false;
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
    const email = val('l-email').trim();
    const password = val('l-pass');
    if (!email || !password) { err.textContent = 'Enter email and password'; err.style.display = 'block'; return; }
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.status === 403 && data.error === 'expired') {
        err.innerHTML = `<strong>Account Expired</strong><br>${data.message}`;
        err.style.display = 'block'; return;
      }
      if (!res.ok) { throw new Error(data.error || 'Login failed'); }
      DRM.user = data.user; _allOrgs = data.orgs;
      if (data.token) localStorage.setItem('drm_token', data.token);
      _redirecting = false;
      if (data.orgs.length) await setOrg(data.activeOrg || data.orgs[0]);
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
  // Poll notifications every 60 seconds
  setInterval(_loadNotifications, 60000);
  setTimeout(_loadNotifications, 1000);
  // Show recovery link for super admins
  if (DRM.user?.is_super_admin) {
    document.querySelectorAll('.nav-super-admin').forEach(el => el.style.display = '');
  }
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

function navigateTo(page) {
  _currentPage = page;
  if (location.hash !== '#' + page) history.pushState(null, '', '#' + page);
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = $('page-' + page);
  if (!el) return;
  el.classList.add('active');
  // For donors page: if already rendered, just reload data (no flicker)
  if (page === 'donors' && el.querySelector('#d-tbody')) {
    Donors.load();
  } else if (page === 'leads' && el.querySelector('#leads-list')) {
    _loadLeads();
  } else {
    renderPage(page, el);
  }
}
// Re-render current page (call after mutations)
function reloadPage() { const el = $('page-' + _currentPage); if(el) renderPage(_currentPage, el); }
window.addEventListener('popstate', () => {
  const page = location.hash.replace('#','') || 'dashboard';
  const valid = ['dashboard','donors','leads','followups','donations','verification','failures','bank','emails','kvitel','reports','settings','whatsapp','recovery'];
  if (valid.includes(page)) { const el=$('page-'+page); if(el) el.innerHTML=''; navigateTo(page); }
});

function renderPage(page, el) {
  const map = {
    dashboard:    renderDashboard,
    donors:       el => Donors.render(el),
    leads:        renderLeads,
    followups:    renderScheduledFollowups,
    donations:    renderDonations,
    verification: renderVerification,
    failures:     renderFailures,
    bank:         renderBank,
    emails:       renderEmails,
    kvitel:       renderKvitel,
    whatsapp:     renderWhatsApp,
    recovery:     renderRecovery,
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
          <button class="btn btn-ghost btn-sm" onclick="_addExpense()">+ Expense</button>
          <button class="btn btn-ghost btn-sm" onclick="API.dl('/api/orgs/${API.orgId}/reports/full-export','full-report.xlsx').catch(e=>toast(e.message||'Export failed','err'))">&#8681; Export All</button>
          ${s.failedCharges > 0 ? `<button class="btn btn-red btn-sm" onclick="navigateTo('failures')">! ${s.failedCharges} Failed</button>` : ''}
          ${s.needsVerification > 0 ? `<button class="btn btn-outline btn-sm" onclick="navigateTo('verification')">${s.needsVerification} Need Verification</button>` : ''}
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-lbl">Total Donors</div><div class="stat-val">${(s.totalDonors||0).toLocaleString()}</div><div class="stat-sub">${s.activeDonors||0} active</div></div>
        <div class="stat g"><div class="stat-lbl">Total Raised</div><div class="stat-val">${fmt$(s.totalAmount)}</div><div class="stat-sub">${s.totalDonations||0} donations</div></div>
        <div class="stat r"><div class="stat-lbl">Total Expenses</div><div class="stat-val">${fmt$(s.totalExpenses||0)}</div><div class="stat-sub">Net: ${fmt$((s.totalAmount||0)-(s.totalExpenses||0))}</div></div>
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
          <input id="d-search" placeholder="Search name, email, phone, Hebrew…" autocomplete="new-password" autocorrect="off" spellcheck="false">
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
        <button class="btn btn-ghost btn-sm" onclick="Donors.bulkLabel()">+ Label</button>
        <button class="btn btn-ghost btn-sm" onclick="Donors.bulkAutopay()">⚡ AutoPay</button>
        <button class="btn btn-ghost btn-sm" onclick="Donors.bulkDelete()">Delete</button>
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
  async bulkLabel() {
    if(!this.selected.size) return;
    const labels = await API.get(`/api/orgs/${API.orgId}/label-lists`);
    const donorLabels = (labels?.donor_labels || []);
    Modal.open(`Add Label to ${this.selected.size} Donor(s)`, `
      <div style="margin-bottom:10px">
        <div style="font-size:12px;color:var(--gray-5);margin-bottom:8px">Select a label to add to all selected donors:</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px" id="bulk-label-pills">
          ${donorLabels.map(l=>`<button type="button" class="btn btn-ghost btn-sm" id="blp-${l.replace(/[^a-z0-9]/gi,'_')}"
            onclick="_bulkLabelSelect('${l.replace(/'/g,"\\'")}',this)">${l}</button>`).join('')}
        </div>
        <input id="bulk-label-custom" placeholder="Or type a new label…" autocomplete="new-password"
          style="padding:8px 12px;border:1.5px solid var(--gray-3);border-radius:6px;width:100%;box-sizing:border-box">
        <input type="hidden" id="bulk-label-val" value="">
      </div>
      <div class="bg mt">
        <button class="btn btn-primary" onclick="_bulkLabelApplyDonors()">Add Label</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, {sm:true});
  },
  bulkDelete() { if(!this.selected.size)return; confirmDlg(`Delete ${this.selected.size} donor(s)?`,async()=>{for(const id of this.selected)await API.del(API.o.donor(id)).catch(()=>{}); this.selected.clear(); toast('Deleted'); Donors.load(); }); },
  async pauseAll() { confirmDlg('Pause AutoPay for all donors?',async()=>{await API.post(`/api/orgs/${API.orgId}/donors/autopay/pause-all`,{}); toast('Paused'); Donors.load();}); },
  async resumeAll() { await API.post(`/api/orgs/${API.orgId}/donors/autopay/resume-all`,{}); toast('Resumed'); this.load(); },
  openAdd() { this.form(null); },
  async openEdit(id) { try { const d = await API.get(API.o.donor(id)); this.form(d.donor); } catch(e) { toast(e.message||'Unknown error','err'); } },
  del(id, name) { confirmDlg(`Delete "${name}"?`, async () => { await API.del(API.o.donor(id)); toast('Deleted'); Donors.load(); }); },
  exportXlsx() { API.dl(`/api/orgs/${API.orgId}/reports/donors?format=xlsx`, 'donors.xlsx').catch(e=>toast(e.message||'Unknown error','err')); },
  importXlsx() {
    Modal.open('Import Donors', `
      <div class="alert alert-info" style="font-size:12px;margin-bottom:12px">
        <strong>Step 1:</strong> Download the template, fill it in, then upload it below.<br>
        Duplicates are detected automatically by name, email, or phone — they'll be skipped.
      </div>
      <div class="bg" style="margin-bottom:14px">
        <a class="btn btn-outline btn-sm" href="/api/orgs/${API.orgId}/import/donors/template" download="donor-import-template.xlsx">
          &#8681; Download Template
        </a>
      </div>
      <label>Upload filled Excel file</label>
      <input type="file" id="imp-f" accept=".xlsx,.xls" style="margin-bottom:4px">
      <div id="imp-res" style="display:none;margin-top:10px"></div>
      <div class="bg mt">
        <button class="btn btn-primary" id="imp-btn" onclick="Donors.doImport()">Import</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, { sm: true });
  },
  async doImport() {
    const f = $('imp-f')?.files[0]; if (!f) { toast('Select a file','err'); return; }
    const btn = $('imp-btn'); if(btn){btn.textContent='Importing…';btn.disabled=true;}
    const fd = new FormData(); fd.append('file', f);
    try {
      const r = await fetch(`/api/orgs/${API.orgId}/import/donors`,
        { method:'POST', body:fd, credentials:'include', headers:{'x-org-id':API.orgId} }
      ).then(r=>r.json());
      if (r.error) throw new Error(r.error);
      const res = $('imp-res');
      if (res) {
        const flaggedHtml = r.flagged?.length ? `
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:12px;color:var(--amber)">
              ⚠ ${r.flagged.length} possible duplicate${r.flagged.length>1?'s':''} imported — review recommended
            </summary>
            <div style="margin-top:6px;max-height:160px;overflow-y:auto">
              ${r.flagged.map(f=>`<div style="font-size:11px;padding:3px 0;border-bottom:1px solid var(--gray-1)">
                <strong>${f.name}</strong> — matched on: ${f.reasons.join(', ')}
              </div>`).join('')}
            </div>
          </details>` : '';
        const errHtml = r.errors?.length ? `
          <details style="margin-top:6px">
            <summary style="cursor:pointer;font-size:11px;color:var(--red)">${r.errors.length} row${r.errors.length>1?'s':''} skipped</summary>
            <pre style="font-size:11px;margin-top:4px;white-space:pre-wrap">${r.errors.join('\n')}</pre>
          </details>` : '';
        res.innerHTML = `<div class="alert alert-ok" style="font-size:13px">
          <strong>✓ Import complete</strong><br>
          <strong>${r.imported}</strong> donor${r.imported!==1?'s':''} imported
          ${r.flagged?.length ? `· <span style="color:var(--amber)">${r.flagged.length} flagged as possible duplicates</span>` : ''}
          ${flaggedHtml}${errHtml}
        </div>`;
        res.style.display = 'block';
      }
      if (btn){btn.textContent='Import';btn.disabled=false;}
      this.load();
    } catch(e) {
      toast(e.message||'Import failed','err');
      if (btn){btn.textContent='Import';btn.disabled=false;}
    }
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
      window._lwDonor = labelPicker('lw-donor', lbls, 'donor_labels');
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
    try { if(id) await API.put(API.o.donor(id),data); else await API.post(API.o.donors(),data); toast(id?'Saved':'Added'); Modal.close(); if(id){ DonorDetail.open(id); }else{ this.load(); this.loadMeta(); } }
    catch(e) { toast(e.message||'Unknown error','err'); }
  },
};

// ── Donor Detail ──────────────────────────────────────────────────────────────
const DonorDetail = {
  data: null,
  async open(id) {
    window._donorDetailId = id;
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
        ${pm.type==='daf'?`<button class="btn btn-ghost btn-sm" onclick="DonorDetail._chargeDaf('${did}','${pm.id}')">Process DAF</button>`:''}
        <button class="btn btn-icon" style="color:var(--red)" onclick="DonorDetail.delPM('${did}','${pm.id}')">&#10005;</button>
      </div>
    </div>`;
  },

  donRow(d, did) {
    const dn = jsonParse(d.donation_notes);
    const rid = 'dpr-'+d.id;
    return `<tr>
      <td style="font-size:12px;white-space:nowrap">${fmtD(d.donation_date)}</td>
      <td style="font-weight:600">${fmt$(d.amount)}${d.refund_amount>0?`<br><span style="font-size:11px;color:var(--red)">−${fmt$(d.refund_amount)}</span>`:''}</td>
      <td style="font-size:12px">${fmtMethod(d.method)}${d.last_four?` ••${d.last_four}`:''}</td>
      <td style="font-size:11px;color:var(--gray-5)">${d.transaction_id||'—'}</td>
      <td>${sbadge(d.status)}${d.label?` <span class="pill pill-blue" style="font-size:10px">${d.label}</span>`:''}</td>
      <td><div class="actions">
        <button class="btn btn-icon" title="Expand" onclick="DonorDetail._togDPR('${d.id}')">&#8964;</button>
        <button class="btn btn-icon" title="Edit" onclick="DonorDetail._editDon('${did}','${d.id}')">&#9998;</button>
        <button class="btn btn-icon" title="Add note" onclick="DonorDetail.addDonNote('${did}','${d.id}')">&#9997;</button>
        ${(d.status==='completed'||d.status==='partial_refund')?`<button class="btn btn-icon" title="Refund" onclick="DonorDetail.refund('${did}','${d.id}','${d.amount}','${d.transaction_id||''}')">&#8617;</button>`:''}
        <button class="btn btn-icon" title="Label" onclick="DonorDetail._lblDon('${did}','${d.id}')">&#9990;</button>
        <button class="btn btn-icon" style="color:var(--red)" title="Delete" onclick="DonorDetail._delDon('${did}','${d.id}')">&#10005;</button>
      </div></td>
    </tr>
    <tr id="${rid}" style="display:none;background:var(--gray-05)">
      <td colspan="6" style="padding:10px 14px;font-size:12px">
        <strong style="color:var(--navy)">Full Details</strong><br>
        Date &amp; Time: ${fmtDT(d.donation_date)} | Trans ID: ${d.transaction_id||'—'} | Status: ${d.status}<br>
        ${d.refund_amount>0?'Refunded: '+fmt$(d.refund_amount)+(d.refund_notes?' — '+d.refund_notes:'')+'<br>':''}
        ${d.notes?`<span style="color:var(--gray-5)">${d.notes}</span><br>`:''}
        <div style="margin-top:8px;font-weight:600">Notes (${dn.length})</div>
        <div id="dpr-n-${d.id}" style="margin-top:4px">${_renderNotesList(dn, d.id, did, true)}</div>
      </td>
    </tr>`;
  },
  _togDPR(id){const r=$('dpr-'+id);if(r)r.style.display=r.style.display==='none'?'table-row':'none';},
  async _editDon(did, donId) {
    const don=(this.data?.donations||[]).find(d=>d.id===donId);
    if(!don){toast('Not found','err');return;}
    Modal.open('Edit Donation',`
      <div class="alert alert-info" style="font-size:12px;margin-bottom:8px">Amount cannot be changed after recording.</div>
      <label>Amount (locked)</label><input value="${fmt$(don.amount)}" disabled style="background:var(--gray-1)">
      <label>Method</label><select id="edd-meth">${['check','cash','wire','daf','other'].map(m=>`<option value="${m}" ${don.method===m?'selected':''}>${fmtMethod(m)}</option>`).join('')}</select>
      <label>Date & Time</label><input type="datetime-local" id="edd-date" value="${toLocalDT(don.donation_date)}">
      <label>Transaction ID</label><input id="edd-tx" value="${don.transaction_id||''}" autocomplete="off">
      <label>Notes</label><input id="edd-notes" value="${(don.notes||'').replace(/"/g,'&quot;')}" autocomplete="off">
      <div class="bg mt">
        <button class="btn btn-primary" onclick="DonorDetail._saveEditDon('${did}','${donId}')">Save</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`,{sm:true});
  },
  async _saveEditDon(did, donId){
    try{await API.put(`/api/orgs/${API.orgId}/donations/${donId}/edit`,{method:val('edd-meth'),donation_date:val('edd-date'),transaction_id:val('edd-tx')||null,notes:val('edd-notes')||null});toast('Updated ✓');Modal.close();DonorDetail.open(did);}catch(e){toast(e.message,'err');}
  },
  _delDon(did, donId){
    confirmDlg('Delete this donation? Cannot be undone.',async()=>{
      try{await API.del(`/api/orgs/${API.orgId}/donations/${donId}`);toast('Deleted');DonorDetail.open(did);}catch(e){toast(e.message,'err');}
    });
  },
  async _lblDon(did, donId){
    const cur=(this.data?.donations||[]).find(d=>d.id===donId)?.label||'';
    _labelDonationModal(donId, cur, () => DonorDetail.open(did));
  },

  recCard(s, did) {
    const pm = s.pm_label || (s.pm_type==='credit_card' ? `${s.card_brand||'Card'} ••${s.last_four||''}` : fmtMethod(s.pm_type));
    const lim = s.occurrences_limit ? `${s.occurrences_count||0}/${s.occurrences_limit}` : 'Unlimited';
    // Check if next_run is today or past
    const nextRunDate = s.next_run ? new Date(s.next_run) : null;
    const today = new Date(); today.setHours(0,0,0,0);
    const isDueToday = nextRunDate && nextRunDate <= today && s.status==='active';
    const nextLabel = isDueToday
      ? `<span style="color:var(--red);font-weight:600">Due today!</span>`
      : `Next: ${fmtD(s.next_run)}`;
    return `<div class="sched-item" style="${isDueToday?'border-color:var(--amber);background:var(--amber-l)':''}">
      <div>
        <div class="sched-main">${fmt$(s.amount)} / ${fmtFreq(s.frequency)} ${sbadge(s.status)}</div>
        <div class="sched-sub">${pm} · ${nextLabel} · ${lim}</div>
        ${s.last_failure?`<div style="font-size:11px;color:var(--red);margin-top:2px">Last error: ${s.last_failure}</div>`:''}
      </div>
      <div class="bg">
        ${isDueToday?`<button class="btn btn-primary btn-sm" onclick="DonorDetail._chargeRecurringNow('${did}','${s.id}','${s.payment_method_id||''}','${s.amount}')">Charge Now</button>`:''}
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
        <div class="r2"><div><label>Card Number</label><input id="pm-num" maxlength="19" autocomplete="cc-number" oninput="DonorDetail._detectCardType(this.value)"></div><div><label>Expiry (MMYY)</label><input id="pm-exp" maxlength="4" autocomplete="cc-exp" placeholder="0128"></div></div>
        <div class="r2"><div><label>CVV</label><input id="pm-cvv" type="password" maxlength="4"></div><div><label>ZIP</label><input id="pm-zip" maxlength="5"></div></div>
        <label>Card Brand</label>
        <div class="bg" style="align-items:center"><select id="pm-brand" style="flex:1"><option value="">— Auto —</option><option>Visa</option><option>Mastercard</option><option>Amex</option><option>Discover</option></select><span id="pm-brand-icon" style="font-size:12px;font-weight:700;padding:0 8px;color:var(--blue);min-width:36px"></span></div>
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
        const dafExp  = val('pm-dafexp');
        if (!dafCard) { toast('DAF card number required','err'); return; }
        if (!dafExp || dafExp.length < 4) { toast('DAF card expiry required (MMYY)','err'); return; }
        // Store DAF: other_description = "cardNum|exp" (pipe-separated)
        await API.post(`/api/orgs/${API.orgId}/donors/${did}/payment-methods`, {
          type:'daf',
          label: lbl || val('pm-dafprov') || 'DAF',
          daf_name: val('pm-dafprov') || 'DAF',
          other_description: dafCard.replace(/\s/g,'') + '|' + (val('pm-dafexp')||'1299'),
          is_default: def
        });
        toast('DAF method added');
      } else {
        await API.post(`/api/orgs/${API.orgId}/donors/${did}/payment-methods`, {type, label:lbl||null, other_description:val('pm-oth')||null, is_default:def});
        toast('Added');
      }
      this.open(did);
    } catch(e) { if(btn){btn.textContent='Save & Tokenize';btn.disabled=false;} toast(e.message||'Unknown error','err'); }
  },
  _chargeDaf(did, pmId) {
    const pm = (this.data?.paymentMethods||[]).find(p=>p.id===pmId);
    if (!pm) { toast('Payment method not found','err'); return; }
    const parts = (pm.other_description||'').split('|');
    const cardNum = parts[0]||''; const exp = parts[1]||'1299';
    if (!cardNum) { toast('No DAF card number stored. Re-add this payment method.','err'); return; }
    Modal.open('Process DAF Grant', `
      <div class="alert alert-info" style="font-size:13px;margin-bottom:12px">
        <strong>${pm.daf_name||'DAF'}</strong> ••${cardNum.slice(-4)}<br>
        Sola will route to the correct DAF provider automatically.
      </div>
      <label>Amount ($) *</label>
      <input type="number" id="daf-amt" step="0.01" min="0.01" placeholder="0.00">
      <label>Notes (optional)</label>
      <input id="daf-notes" autocomplete="off">
      <div class="bg mt">
        <button class="btn btn-primary" id="daf-charge-btn" onclick="DonorDetail._doChargeDaf('${did}','${pmId}')">Process Grant</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, {sm:true});
  },
  async _doChargeDaf(did, pmId) {
    const amt = parseFloat(val('daf-amt'));
    if (!amt||amt<=0) { toast('Enter amount','err'); return; }
    const pm = (this.data?.paymentMethods||[]).find(p=>p.id===pmId);
    const parts = (pm?.other_description||'').split('|');
    const btn = document.getElementById('daf-charge-btn');
    if (btn) { btn.textContent='Processing…'; btn.disabled=true; }
    try {
      const r = await API.post(`/api/orgs/${API.orgId}/payments/charge-daf`, {
        donor_id: did, payment_method_id: pmId,
        amount: amt, notes: val('daf-notes')||null
      });
      toast(`DAF grant processed · ${r.transaction_id}`);
      Modal.close(); DonorDetail.open(did);
    } catch(e) {
      if (btn) { btn.textContent='Process Grant'; btn.disabled=false; }
      toast(e.message||'DAF charge failed','err');
    }
  },
  async delPM(did, pmId) { confirmDlg('Remove payment method?', async()=>{ try{await API.del(`/api/orgs/${API.orgId}/donors/${did}/payment-methods/${pmId}`); toast('Removed'); DonorDetail.open(did);}catch(e){toast(e.message,'err');} }); },

  chargeNow(did) {
    const allPms  = this.data?.paymentMethods||[];
    const ccPms   = allPms.filter(p => p.type==='credit_card' && p.sola_token);
    const dafPms  = allPms.filter(p => p.type==='daf' && (p.other_description||'').split('|')[0]);
    if (!ccPms.length && !dafPms.length) {
      toast('No chargeable payment methods. Add a credit card or DAF card first.','err'); return;
    }
    const opts = [
      ...ccPms.map(p  => `<option value="cc|${p.id}">${cbrand(p.card_brand,p.last_four)} ${p.label?'('+p.label+')':''}</option>`),
      ...dafPms.map(p => `<option value="daf|${p.id}">DAF: ${p.daf_name||'DAF'} ••${((p.other_description||'').split('|')[0]).slice(-4)} ${p.label?'('+p.label+')':''}</option>`)
    ].join('');
    Modal.open('Charge', `
      <label>Payment Method</label>
      <select id="cn-pm">${opts}</select>
      <label>Amount ($) *</label>
      <input type="number" id="cn-amt" step="0.01" min="0.01" placeholder="0.00">
      <label>Notes (optional)</label>
      <input id="cn-notes" autocomplete="off">
      <div class="bg mt">
        <button class="btn btn-primary" id="cn-btn" onclick="DonorDetail._doChargeNow('${did}')">Charge Now</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, {sm:true});
  },
  async _doChargeNow(did) {
    const amt = parseFloat(val('cn-amt'));
    if (!amt||amt<=0) { toast('Enter amount','err'); return; }
    const sel   = val('cn-pm');
    const [type, pmId] = sel.split('|');
    const notes = val('cn-notes')||null;
    const btn   = $('cn-btn');
    if (btn) { btn.textContent='Charging…'; btn.disabled=true; }
    try {
      let r;
      if (type==='daf') {
        r = await API.post(`/api/orgs/${API.orgId}/payments/charge-daf`,
          {donor_id:did, payment_method_id:pmId, amount:amt, notes});
      } else {
        r = await API.post(`/api/orgs/${API.orgId}/payments/charge`,
          {donor_id:did, payment_method_id:pmId, amount:amt, notes});
      }
      toast(`Charged ${fmt$(amt)} · ${r.transaction_id}`);
      Modal.close(); DonorDetail.open(did);
    } catch(e) {
      if (btn) { btn.textContent='Charge Now'; btn.disabled=false; }
      toast(e.message||'Charge failed','err');
    }
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
      toast(`Charged ${fmt$(amt)} · Trans: ${r.transaction_id}`); this.open(did);
    } catch(e) { toast(e.message||'Unknown error','err'); }
  },

  manual(did) {
    const now = toLocalDT(new Date().toISOString()); // local time for datetime-local input
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
      <label>Label</label>
      <select id="md-label-sel"><option value="">— Select label (optional) —</option></select>
      <label style="margin-top:8px">Notes</label>
      <input id="md-notes" autocomplete="off" placeholder="Additional notes (optional)…">
      <div class="trow mt" style="padding:8px 0;border-top:1px solid var(--gray-1);margin-top:8px">
        <div style="font-size:13px">Send donation receipt email</div>
        <label class="tgl"><input type="checkbox" id="md-send-receipt" checked><span class="tgl-s"></span></label>
      </div>
      <div class="bg mt">
        <button class="btn btn-primary" onclick="DonorDetail._saveManual('${did}')">Record</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, { sm: true });
    // Populate label dropdown from org's donation_labels list (preset only)
    API.get(`/api/orgs/${API.orgId}/label-lists`).then(lists => {
      const sel = $('md-label-sel');
      if (sel && lists.donation_labels) {
        lists.donation_labels.forEach(l => {
          const o = document.createElement('option'); o.value=l; o.textContent=l; sel.appendChild(o);
        });
      }
    }).catch(()=>{});
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
    const label = val('md-label-sel') || null;
    // DAF with card number — charge via Sola
    if (method === 'daf' && val('md-dafcard').trim()) {
      try {
        const r = await API.post(`/api/orgs/${API.orgId}/payments/daf-grant`, {
          donor_id: did, daf_card_num: val('md-dafcard'), daf_provider: val('md-dafprov'),
          amount: amt, notes: val('md-notes')
        });
        if (label && r.donation?.id) await API.put(`/api/orgs/${API.orgId}/donations/${r.donation.id}/label`, {label}).catch(()=>{});
        toast(`DAF grant submitted · Trans: ${r.transaction_id}`); Modal.close(); this.open(did);
      } catch(e) { toast(e.message, 'err'); }
      return;
    }
    try {
      const r = await API.post(`/api/orgs/${API.orgId}/donors/${did}/donations`, {
        amount: amt, method,
        check_number: method==='check' ? val('md-chknum') : undefined,
        donation_date: val('md-date') || new Date().toISOString(),
        transaction_id: val('md-tx') || null,
        notes: val('md-notes') || null,
        send_receipt: $('md-send-receipt')?.checked !== false
      });
      if (label && r.donation?.id) await API.put(`/api/orgs/${API.orgId}/donations/${r.donation.id}/label`, {label}).catch(()=>{});
      const receiptMsg = r.receipt_sent ? ' · Receipt sent' : (($('md-send-receipt')?.checked !== false) ? ' · Receipt failed (check Render logs)' : '');
      toast(`Recorded${receiptMsg}`); Modal.close(); this.open(did);
    } catch(e) { toast(e.message, 'err'); }
  },

  addDonNote(did, donId) { Modal.open('Add Note to Donation', `<textarea id="dn-txt" style="min-height:80px;width:100%" placeholder="Note…"></textarea><div class="bg mt"><button class="btn btn-primary" onclick="DonorDetail._saveDonNote('${did}','${donId}')">Add</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`, {sm:true}); },
  async _saveDonNote(did, donId) {
    const txt = val('dn-txt').trim(); if(!txt){toast('Enter a note','err');return;}
    try {
      await API.post(`/api/orgs/${API.orgId}/donations/${donId}/notes`, {text:txt});
      toast('Note added ✓'); Modal.close();
      DonorDetail.open(did);  // reopen donor profile, NOT donations page
    } catch(e){toast(e.message||'Unknown error','err');}
  },

  refund(did, donId, amt, txId) {
    Modal.open('Refund Donation', `
      <p style="margin-bottom:10px;font-size:13px;color:var(--gray-5)">
        Original amount: <strong>${fmt$(amt)}</strong>
      </p>
      <label>Refund Amount ($) *</label>
      <input type="number" id="rf-amt" step="0.01" min="0.01" max="${parseFloat(amt).toFixed(2)}" value="${parseFloat(amt).toFixed(2)}">
      <label>Reason (optional)</label>
      <input id="rf-rsn" autocomplete="off" placeholder="Reason for refund">
      ${txId && !txId.startsWith('ES') ? `<div class="alert alert-info" style="margin-top:10px;font-size:12px">Sola Trans ID: <strong>${txId}</strong> — will attempt gateway refund/void.</div>` : '<div class="alert alert-warn" style="margin-top:10px;font-size:12px">Manual payment — will mark as refunded in system only.</div>'}
      <div id="rf-err" style="display:none" class="alert alert-err mt"></div>
      <div class="bg mt">
        <button class="btn btn-red" id="rf-btn" onclick="DonorDetail._doRefund('${did}','${donId}','${txId||''}')">Process Refund</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, {sm:true});
  },
  async _doRefund(did, donId, txId) {
    // Read values from inputs while modal is still open
    const amtInput = document.getElementById('rf-amt');
    const rsnInput = document.getElementById('rf-rsn');
    const errEl    = document.getElementById('rf-err');
    const btn      = document.getElementById('rf-btn');

    const amt = parseFloat(amtInput?.value);
    if (!amt || amt <= 0) { toast('Enter a valid amount', 'err'); return; }
    const notes = rsnInput?.value || '';

    if (btn) { btn.textContent = 'Processing…'; btn.disabled = true; }
    if (errEl) errEl.style.display = 'none';

    try {
      const r = await API.post(`/api/orgs/${API.orgId}/payments/refund`, {
        donation_id: donId,
        donor_id: did,
        amount: amt,
        notes: notes || null
      });
      const label = r.method === 'void' ? 'Voided' : 'Refunded';
      toast(`${label} ${fmt$(amt)} ✓`);
      Modal.close();
      DonorDetail.open(did);
      // Also refresh donations page if it's currently visible
      const donPage = $('page-donations');
      if (donPage && donPage.classList.contains('active')) renderDonations(donPage);
    } catch(e) {
      const msg = e.message || 'Refund failed';
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
      if (btn) { btn.textContent = 'Process Refund'; btn.disabled = false; }
      toast(msg, 'err');
    }
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
  async _saveRec(did) { const amt=parseFloat(val('rec-amt')); if(!amt||amt<=0){toast('Amount required','err');return;} try{await API.post(`/api/orgs/${API.orgId}/donors/${did}/recurring`,{payment_method_id:val('rec-pm'),amount:amt,frequency:val('rec-freq'),start_date:val('rec-start'),end_date:val('rec-end')||null,occurrences_limit:val('rec-lim')?parseInt(val('rec-lim')):null,notes:val('rec-notes')||null}); toast('Schedule created'); this.open(did);}catch(e){toast(e.message||'Unknown error','err');} },
  async toggleRec(did, sid, status) {
    try {
      const body = { status };
      if (status === 'active') {
        // When resuming, set next_run to next upcoming date based on frequency
        const sched = (this.data?.recurring||[]).find(r=>r.id===sid);
        if (sched) {
          const nextRun = _calcNextRunFromNow(sched);
          body.next_run = nextRun;
        }
      }
      await API.put(`/api/orgs/${API.orgId}/donors/${did}/recurring/${sid}`, body);
      toast(status==='paused'?'Paused':'Resumed');
      this.open(did);
    } catch(e) { toast(e.message||'Error','err'); }
  },
  editRec(did, sid, amt, freq, nextRun) { Modal.open('Edit Schedule', `<label>Amount ($)</label><input type="number" id="er-amt" value="${amt}" step="0.01"><label>Frequency</label><select id="er-freq">${['weekly','biweekly','monthly','quarterly','yearly','once'].map(f=>`<option value="${f}" ${f===freq?'selected':''}>${fmtFreq(f)}</option>`).join('')}</select><label>Next Run</label><input type="date" id="er-next" value="${nextRun?nextRun.slice(0,10):''}"><div class="bg mt"><button class="btn btn-primary" onclick="DonorDetail._saveEditRec('${did}','${sid}')">Save</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true}); },
  async _saveEditRec(did, sid) { await API.put(`/api/orgs/${API.orgId}/donors/${did}/recurring/${sid}`,{amount:parseFloat(val('er-amt')),frequency:val('er-freq'),next_run:val('er-next')}); toast('Updated'); this.open(did); },
  async delRec(did, sid) { confirmDlg('Cancel this schedule?', async()=>{ await API.del(`/api/orgs/${API.orgId}/donors/${did}/recurring/${sid}`); toast('Cancelled'); DonorDetail.open(did); }); },
};

// ── Other pages ───────────────────────────────────────────────────────────────

function _renderNotesList(notes, donId, did, onSave) {
  if (!notes || !notes.length) return '<p style="color:var(--gray-5);font-size:12px;margin:4px 0">No notes yet.</p>';
  return notes.map((n, i) => `
    <div style="padding:6px 8px;border-bottom:1px solid var(--gray-1);display:flex;gap:8px;align-items:flex-start">
      <div style="flex:1">
        <div id="note-text-${donId}-${i}" style="font-size:13px">${n.text}</div>
        <div style="font-size:10px;color:var(--gray-5);margin-top:2px">${fmtDT(n.at)}${n.by?' · '+n.by:''}${n.edited_at?' (edited)':''}</div>
      </div>
      <div class="actions" style="flex-shrink:0">
        <button class="btn btn-icon" title="Edit" onclick="_editDonationNote('${donId}','${i}','${n.text.replace(/'/g,"\\'").replace(/"/g,'&quot;')}','${did||''}',${onSave?'true':'false'})">&#9998;</button>
        <button class="btn btn-icon" style="color:var(--red)" title="Delete" onclick="_deleteDonationNote('${donId}','${i}','${did||''}',${onSave?'true':'false'})">&#10005;</button>
      </div>
    </div>`).join('');
}

function _editDonationNote(donId, idx, currentText, did, fromDonorProfile) {
  Modal.open('Edit Note', `
    <textarea id="en-txt" style="min-height:80px;width:100%">${currentText}</textarea>
    <div class="bg mt">
      <button class="btn btn-primary" onclick="window._doEditDonationNote('${donId}','${idx}','${did}',${fromDonorProfile})">Save</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}
window._doEditDonationNote = async (donId, idx, did, fromDonorProfile) => {
  const txt = val('en-txt').trim(); if(!txt){toast('Enter text','err');return;}
  try {
    await API.put(`/api/orgs/${API.orgId}/donations/${donId}/notes/${idx}`, {text:txt});
    toast('Note updated ✓'); Modal.close();
    if (fromDonorProfile && did) DonorDetail.open(did);
    else renderDonations($('page-donations'));
  } catch(e){toast(e.message,'err');}
};

function _deleteDonationNote(donId, idx, did, fromDonorProfile) {
  confirmDlg('Delete this note?', async () => {
    try {
      await API.del(`/api/orgs/${API.orgId}/donations/${donId}/notes/${idx}`);
      toast('Note deleted ✓');
      if (fromDonorProfile && did) DonorDetail.open(did);
      else renderDonations($('page-donations'));
    } catch(e){toast(e.message,'err');}
  });
}

async function renderDonations(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const rows = await API.get(`/api/orgs/${API.orgId}/reports/donations`);
    window._donAll = rows;
    el.innerHTML = `
      <div class="ph"><div><div class="ph-title">Donations</div><div class="ph-sub">${rows.length} records</div></div>
        <div class="bg"><button class="btn btn-primary btn-sm" onclick="_addUnlinkedDonation()">+ Add Donation</button>
        <button class="btn btn-outline btn-sm" onclick="_addRecurringFromList()">+ Recurring</button>
        <button class="btn btn-ghost btn-sm" onclick="API.dl('/api/orgs/${API.orgId}/reports/donations?format=xlsx','donations.xlsx').catch(e=>toast(e.message||'Unknown error','err'))">&#8681; XLSX</button></div>
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
          <thead><tr>
            <th class="sort" onclick="_sortDon('donation_date')">Date</th>
            <th class="sort" onclick="_sortDon('last_name')">Donor</th>
            <th class="sort" onclick="_sortDon('amount')">Amount</th>
            <th class="sort" onclick="_sortDon('method')">Method</th>
            <th>Trans ID</th>
            <th class="sort" onclick="_sortDon('status')">Status</th>
            <th></th>
          </tr></thead>
          <tbody id="don-tb">${_donRows(rows)}</tbody>
        </table></div>
      </div>`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
function _donRows(rows) {
  if (!rows.length) return '<tr><td colspan="7"><div class="empty">No donations</div></td></tr>';
  return rows.map(d => {
    const dn = (() => { try{return JSON.parse(d.donation_notes||'[]');}catch{return[];} })();
    const rid = 'dlr-'+d.id;
    return `<tr>
      <td style="font-size:12px;white-space:nowrap">${fmtD(d.donation_date)}</td>
      <td>${d.donor_id&&d.donor_id!='null'?`<a href="#" onclick="event.preventDefault();DonorDetail.open('${d.donor_id}')" style="font-weight:600;color:var(--navy);text-decoration:none">${d.first_name||''} ${d.last_name||''}</a>`:`<span style="font-weight:600;color:var(--gray-5)">${d.notes||'Unlinked'}</span>`}</td>
      <td style="font-weight:600">${fmt$(d.amount)}${d.refund_amount>0?`<br><span style="font-size:11px;color:var(--red)">−${fmt$(d.refund_amount)}</span>`:''}</td>
      <td style="font-size:12px">${fmtMethod(d.method)}${d.last_four?` ••${d.last_four}`:''}</td>
      <td style="font-size:11px;color:var(--gray-5)">${d.transaction_id||'—'}</td>
      <td>${sbadge(d.status)}${d.label?` <span class="pill pill-blue" style="font-size:10px">${d.label}</span>`:''}</td>
      <td><div class="actions">
        <button class="btn btn-icon" title="Expand" onclick="_togDlr('${d.id}')">&#8964;</button>
        <button class="btn btn-icon" title="Add note" onclick="_addDonationNote('${d.donor_id}','${d.id}')">&#9997;</button>
        <button class="btn btn-icon" title="Edit" onclick="_editDonList('${d.id}')">&#9998;</button>
        <a class="btn btn-ghost btn-sm" href="/api/orgs/${API.orgId}/payments/receipt/${d.id}" download="receipt.pdf" title="Receipt">&#8681;</a>
        ${(d.status==='completed'||d.status==='partial_refund')?`<button class="btn btn-icon" title="Refund" onclick="_refundFromList('${d.donor_id}','${d.id}','${d.amount}','${d.transaction_id||''}')">&#8617;</button>`:''}
        <button class="btn btn-icon" title="Label" onclick="_labelDonation('${d.id}')">&#9990;</button>
        ${d.donor_id&&d.donor_id!='null'?`<button class="btn btn-icon" title="Unlink" onclick="_unlinkDonation('${d.id}')">&#8854;</button>`:`<button class="btn btn-icon" title="Link" onclick="_linkDonation('${d.id}')">&#8853;</button>`}
        <button class="btn btn-icon" style="color:var(--red)" title="Delete" onclick="_delDonList('${d.id}')">&#10005;</button>
      </div></td>
    </tr>
    <tr id="${rid}" style="display:none;background:var(--gray-05)">
      <td colspan="7" style="padding:12px 16px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div style="font-size:12px;line-height:1.9">
            <strong>Full Details</strong><br>
            Date &amp; Time: ${fmtDT(d.donation_date)}<br>
            Amount: ${fmt$(d.amount)}<br>
            Method: ${fmtMethod(d.method)}${d.last_four?' ••'+d.last_four:''}<br>
            Transaction ID: ${d.transaction_id||'—'}<br>
            Status: ${d.status}<br>
            ${d.refund_amount>0?'Refunded: '+fmt$(d.refund_amount)+(d.refund_notes?' — '+d.refund_notes:'')+'<br>':''}
            ${d.notes?'Notes: '+d.notes+'<br>':''}
            ${d.label?'Label: '+d.label:''}
          </div>
          <div>
            <div style="font-size:12px;font-weight:600;margin-bottom:6px">Notes (${dn.length})</div>
            <div id="dlr-n-${d.id}">${_renderNotesList(dn, d.id, d.donor_id, false)}</div>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}
function _togDlr(id){const r=$('dlr-'+id);if(r)r.style.display=r.style.display==='none'?'table-row':'none';}
async function _editDonList(donId){
  const don=(window._donAll||[]).find(d=>d.id===donId);
  if(!don){toast('Not found','err');return;}
  Modal.open('Edit Donation',`
    <div class="alert alert-info" style="font-size:12px;margin-bottom:8px">Amount cannot be changed.</div>
    <label>Amount (locked)</label><input value="${fmt$(don.amount)}" disabled style="background:var(--gray-1)">
    <label>Method</label><select id="edl-meth">${['check','cash','wire','daf','other'].map(m=>`<option value="${m}" ${don.method===m?'selected':''}>${fmtMethod(m)}</option>`).join('')}</select>
    <label>Date & Time</label><input type="datetime-local" id="edl-date" value="${toLocalDT(don.donation_date)}">
    <label>Transaction ID</label><input id="edl-tx" value="${don.transaction_id||''}" autocomplete="off">
    <label>Notes</label><input id="edl-notes" value="${(don.notes||'').replace(/"/g,'&quot;')}" autocomplete="off">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_saveEditDonList('${donId}')">Save</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`,{sm:true});
}
async function _saveEditDonList(id){
  try{await API.put(`/api/orgs/${API.orgId}/donations/${id}/edit`,{method:val('edl-meth'),donation_date:val('edl-date'),transaction_id:val('edl-tx')||null,notes:val('edl-notes')||null});toast('Updated ✓');Modal.close();renderDonations($('page-donations'));}catch(e){toast(e.message,'err');}
}
async function _delDonList(id){
  confirmDlg('Delete this donation? Cannot be undone.',async()=>{
    try{await API.del(`/api/orgs/${API.orgId}/donations/${id}`);toast('Deleted');renderDonations($('page-donations'));}catch(e){toast(e.message,'err');}
  });
}
function _addDonationNote(did, donId) {
  Modal.open('Add Note to Donation', `
    <textarea id="dn-txt" style="min-height:90px;width:100%" placeholder="Note…"></textarea>
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_saveDonationNoteFromList('${did}','${donId}')">Add Note</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}
async function _saveDonationNoteFromList(did, donId) {
  const txt = val('dn-txt').trim();
  if (!txt) { toast('Enter a note', 'err'); return; }
  try {
    // Use org-level route that works for both linked and unlinked donations
    await API.post(`/api/orgs/${API.orgId}/donations/${donId}/notes`, {text: txt});
    toast('Note added ✓');
    Modal.close();
    renderDonations($('page-donations'));
  } catch(e) { toast(e.message || 'Failed to add note', 'err'); }
}
function _refundFromList(did, donId, amt, txId) {
  if (!did || did === 'null') { toast('Cannot refund an unlinked donation from here — open the donor record', 'err'); return; }
  DonorDetail.refund(did, donId, amt, txId);
}
function _sortDon(key) {
  window._donSort = window._donSort || {key:'donation_date', dir:'desc'};
  const s = window._donSort;
  s.dir = (s.key===key && s.dir==='asc') ? 'desc' : 'asc';
  s.key = key;
  _filterDon();
}
function _filterDon() {
  const s=val('don-s').toLowerCase(),m=val('don-meth'),st=val('don-stat');
  let f=(window._donAll||[]).filter(d=>(!s||`${d.first_name} ${d.last_name} ${d.transaction_id||''}`.toLowerCase().includes(s))&&(!m||d.method===m)&&(!st||d.status===st));
  const srt = window._donSort;
  if (srt) {
    f = [...f].sort((a,b) => {
      const av=a[srt.key]??'', bv=b[srt.key]??'';
      const r = typeof av==='number' ? av-bv : String(av).localeCompare(String(bv));
      return srt.dir==='asc' ? r : -r;
    });
  }
  const tb=$('don-tb'); if(tb)tb.innerHTML=_donRows(f);
}

async function renderVerification(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const donors = await API.get(API.o.verify());
    window._verDonors = donors;
    window._verSort = window._verSort || {key:'last_name', dir:'asc'};
    el.innerHTML = `
      <div class="ph"><div><div class="ph-title">Info Check</div><div class="ph-sub">${donors.length} need verification</div></div>
        ${donors.length?`<button class="btn btn-green btn-sm" onclick="_verifyAll()">Verify All</button>`:''}
      </div>
      ${donors.length?`<div class="alert alert-warn">These donors haven't had their info verified in over 6 months.</div>`:'' }
      ${donors.length ? `
        <div class="card" style="padding:0;overflow:hidden">
          <div style="padding:12px 14px;border-bottom:1px solid var(--gray-1)">
            <div class="sw"><input id="ver-search" autocomplete="new-password" placeholder="Search name, email, phone…" oninput="_filterVer()" autocomplete="off"></div>
          </div>
          <div class="tw"><table>
            <thead><tr>
              <th class="sort" onclick="_sortVer('last_name')">Donor</th>
              <th>Contact</th>
              <th class="sort" onclick="_sortVer('neighborhood_name')">Neighborhood</th>
              <th class="sort" onclick="_sortVer('months_old')">Age</th>
              <th class="sort" onclick="_sortVer('info_verified_at')">Last Verified</th>
              <th></th>
            </tr></thead>
            <tbody id="ver-tb">${_verRows(donors)}</tbody>
          </table></div>
        </div>` :
        `<div class="card"><div class="empty"><h3>All donors verified!</h3><p>No info checks needed right now.</p></div></div>`}`;
  // Load unassigned vault cards below the verification list
  setTimeout(() => _loadUnassignedCards(el), 100);
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
function _verRows(donors) {
  if (!donors.length) return '<tr><td colspan="6"><div class="empty">No matches</div></td></tr>';
  return donors.map(d=>`<tr id="vr-${d.id}">
    <td><div style="display:flex;align-items:center;gap:8px">${avatar(d,26)}<div><div style="font-weight:600;font-size:13px">${d.first_name} ${d.last_name}</div>${d.hebrew_full_name?`<div style="font-family:var(--font-he);font-size:11px">${d.hebrew_full_name}</div>`:''}</div></div></td>
    <td style="font-size:12px">${d.cell||''}${d.email?`<br>${d.email}`:''}</td>
    <td style="font-family:var(--font-he);font-size:12px">${d.neighborhood_name||'—'}</td>
    <td style="font-size:12px">${age(d.months_old)}</td>
    <td style="font-size:12px;color:var(--red)">${d.info_verified_at?fmtD(d.info_verified_at):'Never'}</td>
    <td><div class="actions"><button class="btn btn-blue btn-sm" onclick="DonorDetail.open('${d.id}')">View</button><button class="btn btn-green btn-sm" onclick="_verifyOne('${d.id}')">Verify</button></div></td>
  </tr>`).join('');
}
function _sortVer(key) {
  const s = window._verSort;
  s.dir = (s.key===key && s.dir==='asc') ? 'desc' : 'asc';
  s.key = key;
  _filterVer();
}
function _filterVer() {
  const q = (val('ver-search')||'').toLowerCase();
  let rows = (window._verDonors||[]).filter(d =>
    !q || `${d.first_name} ${d.last_name} ${d.email||''} ${d.cell||''} ${d.hebrew_full_name||''}`.toLowerCase().includes(q));
  const s = window._verSort || {key:'last_name', dir:'asc'};
  rows = [...rows].sort((a,b) => {
    const av=a[s.key]??'', bv=b[s.key]??'';
    const r = typeof av==='number' ? av-bv : String(av).localeCompare(String(bv));
    return s.dir==='asc' ? r : -r;
  });
  const tb = $('ver-tb'); if(tb) tb.innerHTML = _verRows(rows);
}
async function _verifyOne(id) { await API.post(`/api/orgs/${API.orgId}/donors/${id}/verify`,{}); const row=$(`vr-${id}`); if(row){row.style.opacity=0;row.style.transition='opacity .3s';setTimeout(()=>row.remove(),320);} toast('Verified'); loadBadges(); }
function _verifyAll() { confirmDlg(`Verify all ${(window._verDonors||[]).length} donors?`, async()=>{ for(const d of window._verDonors||[])await API.post(`/api/orgs/${API.orgId}/donors/${d.id}/verify`,{}).catch(()=>{}); toast('All verified'); renderVerification($('page-verification')); loadBadges(); }); }

async function renderFailures(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const fs = await API.get(API.o.failures());
    const un = fs.filter(f=>!f.acknowledged);
    window._failAll = fs;
    window._failSort = window._failSort || {key:'occurred_at', dir:'desc'};
    el.innerHTML = `
      <div class="ph"><div><div class="ph-title">Failed Charges</div><div class="ph-sub">${un.length} unacknowledged</div></div>
        ${un.length?`<button class="btn btn-ghost btn-sm" onclick="_ackAll()">Acknowledge All</button>`:''}
      </div>
      ${un.length?`<div class="alert alert-err">${un.length} charge${un.length>1?'s':''} failed — admins notified.</div>`:''}
      ${fs.length ? `
        <div class="card" style="padding:0;overflow:hidden">
          <div style="padding:12px 14px;border-bottom:1px solid var(--gray-1)">
            <div class="search-bar">
              <div class="sw" style="flex:1"><input id="fail-search" placeholder="Search donor, reason…" oninput="_filterFail()" autocomplete="off"></div>
              <select id="fail-stat" onchange="_filterFail()">
                <option value="">All</option><option value="ack">Acknowledged</option><option value="unack">Unacknowledged</option>
              </select>
            </div>
          </div>
          <div class="tw"><table>
            <thead><tr>
              <th class="sort" onclick="_sortFail('occurred_at')">Date</th>
              <th class="sort" onclick="_sortFail('first_name')">Donor</th>
              <th class="sort" onclick="_sortFail('amount')">Amount</th>
              <th>Reason</th><th>Status</th><th></th>
            </tr></thead>
            <tbody id="fail-tb">${_failRows(fs)}</tbody>
          </table></div>
        </div>` :
        `<div class="card"><div class="empty"><h3>No failed charges</h3></div></div>`}`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
function _failRows(fs) {
  if (!fs.length) return '<tr><td colspan="6"><div class="empty">No matches</div></td></tr>';
  return fs.map(f=>`<tr id="fr-${f.id}" style="${f.acknowledged?'opacity:.6':''}">
    <td style="font-size:12px">${fmtDT(f.occurred_at)}</td>
    <td><strong>${f.first_name} ${f.last_name}</strong>${f.email?`<br><span style="font-size:11px;color:var(--gray-5)">${f.email}</span>`:''}</td>
    <td style="font-weight:600">${fmt$(f.amount)}</td>
    <td style="font-size:12px;color:var(--red)">${f.failure_reason||'Unknown'}</td>
    <td>${f.acknowledged?'<span class="pill pill-green">Acked</span>':'<span class="pill pill-red">New</span>'}</td>
    <td><div class="actions">
      <button class="btn btn-blue btn-sm" onclick="DonorDetail.open('${f.donor_id}')">View</button>
      ${!f.acknowledged
        ?`<button class="btn btn-ghost btn-sm" onclick="_ackOne('${f.id}')">Ack</button>`
        :`<button class="btn btn-ghost btn-sm" onclick="_unackOne('${f.id}',this)">Un-Ack</button>`}
    </div></td>
  </tr>`).join('');
}
function _sortFail(key) {
  const s = window._failSort;
  s.dir = (s.key===key && s.dir==='asc') ? 'desc' : 'asc';
  s.key = key;
  _filterFail();
}
function _filterFail() {
  const q = (val('fail-search')||'').toLowerCase();
  const stat = val('fail-stat');
  let rows = (window._failAll||[]).filter(f => {
    const matchQ = !q || `${f.first_name} ${f.last_name} ${f.failure_reason||''}`.toLowerCase().includes(q);
    const matchStat = !stat || (stat==='ack' ? f.acknowledged : !f.acknowledged);
    return matchQ && matchStat;
  });
  const s = window._failSort || {key:'occurred_at', dir:'desc'};
  rows = [...rows].sort((a,b) => {
    const av=a[s.key]??'', bv=b[s.key]??'';
    const r = typeof av==='number' ? av-bv : String(av).localeCompare(String(bv));
    return s.dir==='asc' ? r : -r;
  });
  const tb = $('fail-tb'); if(tb) tb.innerHTML = _failRows(rows);
}
async function _ackOne(id) {
  try {
    await API.post(`/api/orgs/${API.orgId}/charge-failures/${id}/acknowledge`,{});
    toast('Acknowledged');
    const r=$('fr-'+id);
    if(r){
      r.style.opacity='.6';
      // Replace Ack button with Un-Ack button instantly
      const actions=r.querySelector('.actions');
      if(actions){
        const oldBtn=actions.querySelector('[onclick*="_ackOne"]');
        if(oldBtn){ const nb=document.createElement('button'); nb.className='btn btn-ghost btn-sm'; nb.textContent='Un-Ack'; nb.onclick=()=>_unackOne(id,nb); oldBtn.replaceWith(nb); }
      }
    }
    loadBadges();
  } catch(e){toast(e.message||'Error','err');}
}
async function _unackOne(id, btn) {
  try {
    await API.post(`/api/orgs/${API.orgId}/charge-failures/${id}/unacknowledge`, {});
    toast('Unacknowledged');
    const row = $('fr-'+id);
    if (row) {
      row.style.opacity='1';
      const pill=row.querySelector('.pill-green'); if(pill)pill.outerHTML='<span class="pill pill-red">New</span>';
      if(btn){const nb=document.createElement('button');nb.className='btn btn-ghost btn-sm';nb.textContent='Ack';nb.onclick=()=>_ackOne(id);btn.replaceWith(nb);}
    }
    loadBadges();
  } catch(e){toast(e.message||'Error','err');}
}
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
// Single shared label modal used by donations page, donor profile, everywhere.
// Always preset-only from the org's donation_labels list (Settings > Labels).
async function _labelDonationModal(donId, currentLabel, onSaved) {
  let lbls = [];
  try { const r = await API.get(`/api/orgs/${API.orgId}/label-lists`); lbls = r.donation_labels||[]; } catch{}
  window._saveDonationLabel = async () => {
    const v = ($('ldon-sel')?.value || '').trim();
    const btn = $('ldon-save-btn');
    if(btn){btn.textContent='Saving…';btn.disabled=true;}
    try {
      await API.put(`/api/orgs/${API.orgId}/donations/${donId}/label`, {label: v||null});
      toast('Label saved ✓'); Modal.close();
      if (onSaved) onSaved();
    } catch(e) {
      if(btn){btn.textContent='Save';btn.disabled=false;}
      toast(e.message||'Failed to save label','err');
    }
  };
  Modal.open('Label Donation', `
    <label>Label</label>
    <select id="ldon-sel" style="margin-bottom:4px">
      <option value="">${lbls.length?'— Select label —':'— No labels defined in Settings —'}</option>
      ${lbls.map(l=>`<option value="${l}" ${currentLabel===l?'selected':''}>${l}</option>`).join('')}
    </select>
    <div class="bg mt">
      <button class="btn btn-primary" id="ldon-save-btn" onclick="window._saveDonationLabel()">Save</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}
async function _labelDonation(donId, currentLabel) {
  if (currentLabel === undefined) currentLabel = (window._donAll||[]).find(d=>d.id===donId)?.label || '';
  _labelDonationModal(donId, currentLabel, () => renderDonations($('page-donations')));
}
function _linkDonation(donId) {
  let _linkDonorId = null;
  Modal.open('Link to Donor', `
    <p style="font-size:13px;color:var(--gray-5);margin-bottom:10px">Search for the donor to link this donation to.</p>
    <input id="ld-search" placeholder="Name, email, phone…" autocomplete="off" oninput="_ldSearch(this.value,'${donId}')">
    <div id="ld-results" style="margin-top:6px"></div>
    <div class="bg mt">
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
  window._ldSelectedId = null;
}
let _ldTimeout = null;
async function _ldSearch(q, donId) {
  clearTimeout(_ldTimeout);
  const c = $('ld-results'); if(!c)return;
  if(!q.trim()){c.innerHTML='';return;}
  _ldTimeout = setTimeout(async()=>{
    try {
      const donors = await API.get(`/api/orgs/${API.orgId}/donors/search?q=${encodeURIComponent(q)}`);
      c.innerHTML = donors.length ? donors.map(d=>`<div onclick="_ldLink('${donId}','${d.id}','${d.first_name} ${d.last_name}')"
        style="padding:8px 10px;cursor:pointer;border:1px solid var(--gray-1);border-radius:5px;margin-bottom:4px;font-size:13px"
        onmouseover="this.style.background='var(--blue-pale)'" onmouseout="this.style.background=''">
        <strong>${d.first_name} ${d.last_name}</strong>${d.email?`<span style="color:var(--gray-5)"> · ${d.email}</span>`:''}
      </div>`).join('') : '<p style="color:var(--gray-5);font-size:13px">No donors found</p>';
    } catch{}
  }, 300);
}
async function _ldLink(donId, donorId, name) {
  try {
    await API.put(`/api/orgs/${API.orgId}/donations/${donId}/link`, {donor_id: donorId});
    toast(`Linked to ${name} ✓`); Modal.close();
    renderDonations($('page-donations'));
  } catch(e) { toast(e.message||'Error','err'); }
}
async function _unlinkDonation(donId) {
  if (!confirm('Unlink this donation from its donor?')) return;
  try {
    await API.put(`/api/orgs/${API.orgId}/donations/${donId}/link`, {donor_id: null});
    toast('Unlinked ✓'); renderDonations($('page-donations'));
  } catch(e) { toast(e.message||'Error','err'); }
}
function _labelTx(id){Modal.open('Label Transaction',`<label>Label</label><input id="tx-lbl" placeholder="e.g. Donation, Expense…"><div class="bg mt"><button class="btn btn-primary" onclick="API.post('/api/orgs/${API.orgId}/bank/transactions/${id}/label',{label:val('tx-lbl')}).then(()=>{toast('Labeled');Modal.close();renderBank($('page-bank'))}).catch(e=>toast(e.message||'Unknown error','err'))">Save</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}

async function renderEmails(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const [cfg, templates] = await Promise.all([
      API.get(API.o.email()),
      API.get(`/api/orgs/${API.orgId}/email-templates`)
    ]);

    el.innerHTML = `
      <div class="ph">
        <div><div class="ph-title">Email Designer</div>
          <div class="ph-sub">Design templates, set a default receipt, schedule campaigns</div>
        </div>
        <div class="bg">
          <button class="btn btn-primary btn-sm" onclick="_emailNewTemplate()">+ New Template</button>
        </div>
      </div>

      <div class="tabs">
        <div class="tab on" data-tc="em-templates">Templates</div>
        <div class="tab" data-tc="em-log">Sent Emails</div>
        <div class="tab" data-tc="em-smtp">SMTP Settings</div>
        <div class="tab" data-tc="em-sched">Scheduled Sends</div>
      </div>

      <div id="em-templates" class="tc on">
        ${!templates.length ? `
          <div class="card" style="text-align:center;padding:48px">
            <div style="font-size:48px;margin-bottom:12px">✉️</div>
            <h3 style="color:var(--navy);margin-bottom:8px">No email templates yet</h3>
            <p style="color:var(--gray-5);margin-bottom:20px">Create beautiful HTML emails with drag-and-drop blocks. Set one as your default donation receipt.</p>
            <button class="btn btn-primary" onclick="_emailNewTemplate()">+ Create First Template</button>
          </div>` : `
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">
            ${templates.map(t => `
              <div class="card" style="cursor:default">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">
                  <div>
                    <div style="font-weight:700;font-size:14px;color:var(--navy)">${t.name}</div>
                    ${t.description?`<div style="font-size:12px;color:var(--gray-5);margin-top:2px">${t.description}</div>`:''}
                  </div>
                  ${t.is_default_receipt?`<span class="pill pill-green" style="font-size:10px;flex-shrink:0;margin-left:8px">Default Receipt</span>`:''}
                </div>
                <div style="font-size:12px;color:var(--gray-5);margin-bottom:12px">
                  Subject: <em>${t.subject}</em>
                </div>
                <div class="bg" style="flex-wrap:wrap">
                  <button class="btn btn-primary btn-sm" onclick="_emailEdit('${t.id}')">&#9998; Edit</button>
                  <button class="btn btn-ghost btn-sm" onclick="_emailPreview('${t.id}')">&#128065; Preview</button>
                  <button class="btn btn-ghost btn-sm" onclick="_emailTestSend('${t.id}')">&#9993; Test</button>
                  ${!t.is_default_receipt?`<button class="btn btn-ghost btn-sm" onclick="_emailSetDefault('${t.id}')">&#9733; Set Default</button>`:`<button class="btn btn-ghost btn-sm" onclick="_emailClearDefault()">&#9734; Unset</button>`}
                  <button class="btn btn-icon" style="color:var(--red)" onclick="_emailDelete('${t.id}','${t.name.replace(/'/g,"\\'")}')">&#10005;</button>
                </div>
              </div>`).join('')}
          </div>`}
      </div>

      <div id="em-smtp" class="tc"><div class="card">
        <div id="em-status" style="margin-bottom:12px"></div>
        <div class="trow"><div>Pause all donation receipt emails</div>
          <label class="tgl"><input type="checkbox" id="em-pause" ${cfg?.donation_emails_paused?'checked':''}>
          <span class="tgl-s"></span></label></div>
        <hr class="divider">

        <div style="background:var(--green-pale,#f0fdf4);border:1.5px solid var(--green,#16a34a);border-radius:6px;padding:12px 14px;margin-bottom:10px">
          <div style="font-weight:700;color:#15803d;margin-bottom:4px">🆓 Brevo API (recommended — 300/day free, works on Render)</div>
          <div style="font-size:11px;color:var(--gray-6);margin-bottom:8px">
            Uses HTTPS instead of SMTP — never blocked by hosting providers. Your domain is already verified in Brevo.<br>
            Brevo → top right menu → <strong>SMTP & API → API Settings</strong> tab → Generate a new API key → paste below.
          </div>
          <label>Brevo API Key <span style="font-size:11px;color:var(--gray-5)">(leave blank to keep existing)</span></label>
          <input id="em-brevokey" type="password" placeholder="xkeysib-..." value="">
          <small style="font-size:11px;color:var(--gray-5)">When set, all emails send via Brevo API (HTTPS) — ignores SMTP settings below.</small>
        </div>




        <div style="font-size:12px;font-weight:600;color:var(--gray-7);margin-bottom:8px">Or: Gmail / Brevo / Resend / Any SMTP</div>
        <div class="r2">
          <div><label>Email / Login</label><input id="em-email" type="email" value="${cfg?.smtp_email||''}" autocomplete="email" placeholder="you@gmail.com or your Brevo login"></div>
          <div><label>From Name</label><input id="em-name" value="${cfg?.from_name||''}" placeholder="Your Shul Name"></div>
        </div>
        <div class="r2">
          <div><label>SMTP Host</label><input id="em-host" value="${cfg?.smtp_host||'smtp.gmail.com'}" placeholder="smtp.gmail.com or smtp-relay.brevo.com"></div>
          <div><label>Port</label><input id="em-port" type="number" value="${cfg?.smtp_port||587}"></div>
        </div>
        <label>Password / App Password <span style="font-size:11px;color:var(--gray-5)">(leave blank to keep existing)</span></label>
        <input id="em-pass" type="password" placeholder="Gmail App Password or Brevo SMTP password">
        <small style="color:var(--gray-5);font-size:11px">Gmail: Google Account → Security → 2-Step Verification → App Passwords → Create<br>Brevo: smtp-relay.brevo.com · port 587 · login = your Brevo email · password = Brevo SMTP key</small>

        <div class="bg mt">
          <button class="btn btn-primary" onclick="_saveEmailSettings()">Save</button>
          <button class="btn btn-ghost btn-sm" onclick="_testEmail()">Send Test Email</button>
        </div>
      </div></div>

      <div id="em-log" class="tc">
        <div id="em-log-body"><div class="spinner"></div></div>
      </div>

      <div id="em-sched" class="tc">
        <div id="em-sched-list"><div class="spinner"></div></div>
      </div>`;

    tabsInit('#page-emails');
    _loadEmailStatus();
    // Load email log when tab clicked
    document.querySelector('#page-emails .tab[data-tc="em-log"]')
      ?.addEventListener('click', _loadEmailLog);

    // Load scheduled emails on tab click
    document.querySelector('#page-emails .tab[data-tc="em-sched"]').addEventListener('click', _loadSchedEmails);
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message||'Error'}</div>`; }
}

async function _loadEmailLog() {
  const c = $('em-log-body'); if(!c) return;
  c.innerHTML = '<div class="spinner"></div>';
  try {
    const [log] = await Promise.all([
      API.get(`/api/orgs/${API.orgId}/email-log?limit=200`)
    ]);

    const typeLabels = {
      receipt: 'Donation Receipt',
      charge_success: 'Charge Success',
      charge_failed: 'Charge Failed',
      expiry_warning: 'Expiry Warning',
      scheduled: 'Scheduled Email',
      test: 'Test Email',
      invite: 'Account Invite'
    };
    const typePills = {
      receipt: 'pill-blue',
      charge_success: 'pill-green',
      charge_failed: 'pill-red',
      expiry_warning: 'pill-amber',
      scheduled: 'pill-blue',
      test: 'pill-gray',
      invite: 'pill-gray'
    };

    c.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
        <div class="sw" style="flex:1;min-width:180px">
          <input id="elog-q" placeholder="Search by recipient or subject…" oninput="_filterEmailLog()" autocomplete="off">
        </div>
        <select id="elog-type" onchange="_filterEmailLog()">
          <option value="">All types</option>
          ${Object.entries(typeLabels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}
        </select>
        <select id="elog-status" onchange="_filterEmailLog()">
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="tw"><table>
          <thead><tr>
            <th>Sent At</th><th>To</th><th>Subject</th>
            <th>Type</th><th>Status</th><th>Donor</th><th></th>
          </tr></thead>
          <tbody id="elog-tb">${_emailLogRows(log, typeLabels, typePills)}</tbody>
        </table></div>
      </div>`;
    window._emailLogAll = log;
    window._emailLogMeta = { typeLabels, typePills };
  } catch(e) { c.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

function _emailLogRows(rows, typeLabels, typePills) {
  if(!rows.length) return '<tr><td colspan="7"><div class="empty">No emails sent yet</div></td></tr>';
  return rows.map(r => `<tr>
    <td style="font-size:11px;white-space:nowrap;color:var(--gray-5)">${fmtDT(r.sent_at)}</td>
    <td style="font-size:12px">${r.to_email}</td>
    <td style="font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.subject}">${r.subject}</td>
    <td><span class="pill ${typePills[r.type]||'pill-gray'}" style="font-size:10px">${typeLabels[r.type]||r.type}</span></td>
    <td>${r.status==='sent'
      ? '<span class="pill pill-green" style="font-size:10px">✓ Sent</span>'
      : `<span class="pill pill-red" style="font-size:10px" title="${(r.error||'').replace(/"/g,"'")}">✗ Failed</span>`}</td>
    <td style="font-size:12px">${r.first_name?`<a href="#" onclick="event.preventDefault();DonorDetail.open('${r.donor_id}')" style="color:var(--navy)">${r.first_name} ${r.last_name}</a>`:'—'}</td>
    <td><div class="actions">
      <button class="btn btn-ghost btn-sm" onclick="_emailLogPreview('${r.id}')">Preview</button>
      <button class="btn btn-ghost btn-sm" onclick="_emailLogViewHtml('${r.id}')">HTML</button>
      <button class="btn btn-ghost btn-sm" onclick="_emailLogForward('${r.id}')">Forward</button>
    </div></td>
  </tr>`).join('');
}
function _emailLogPreview(id) {
  const row = (window._emailLogAll||[]).find(r=>r.id===id);
  const subject = row?.subject || 'Email Preview';
  Modal.open(subject, `
    <div style="border:1px solid var(--gray-1);border-radius:6px;overflow:hidden;height:520px">
      <iframe src="/api/orgs/${API.orgId}/email-log/${id}/body"
        style="width:100%;height:100%;border:none"
        sandbox="allow-same-origin"></iframe>
    </div>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--gray-2)">
      <button class="btn btn-ghost" onclick="Modal.close()">Close</button>
      <button class="btn btn-primary" onclick="_emailLogForward('${id}')">Forward</button>
    </div>`, {lg:true, tall:true});
}

function _emailLogForward(id) {
  Modal.open('Forward Email', `
    <label>Forward to *</label>
    <input id="fwd-to" type="email" placeholder="recipient@example.com" autocomplete="email">
    <div class="bg mt">
      <button class="btn btn-primary" id="fwd-btn" onclick="
        const to=val('fwd-to').trim();
        if(!to){toast('Enter an email address','err');return;}
        const btn=$('fwd-btn');
        btn.textContent='Sending…';btn.disabled=true;
        API.post('/api/orgs/${API.orgId}/email-log/${id}/forward',{to})
          .then(()=>{toast('Forwarded ✓');Modal.close();})
          .catch(e=>{toast(e.message||'Forward failed','err');btn.textContent='Forward';btn.disabled=false;})
      ">Forward</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

function _filterEmailLog() {
  const q = (val('elog-q')||'').toLowerCase();
  const type = val('elog-type'), status = val('elog-status');
  const meta = window._emailLogMeta || {typeLabels:{},typePills:{}};
  const rows = (window._emailLogAll||[]).filter(r =>
    (!q || r.to_email.toLowerCase().includes(q) || r.subject.toLowerCase().includes(q)) &&
    (!type || r.type === type) &&
    (!status || r.status === status));
  const tb = $('elog-tb'); if(tb) tb.innerHTML = _emailLogRows(rows, meta.typeLabels, meta.typePills);
}

async function _loadSchedEmails() {
  const c = $('em-sched-list'); if(!c) return;
  c.innerHTML = '<div class="spinner"></div>';
  try {
    const sched = await API.get(API.o.schedEmails());
    c.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong>Scheduled Emails</strong>
        <button class="btn btn-primary btn-sm" onclick="_schedEmail()">+ Schedule</button>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="tw"><table>
          <thead><tr><th>Subject</th><th>Scheduled For</th><th>Status</th><th></th></tr></thead>
          <tbody>${sched.length ? sched.map(e=>`<tr>
            <td style="max-width:180px;font-size:13px">${e.subject}</td>
            <td style="font-size:12px;white-space:nowrap">${fmtDT(e.scheduled_for)}</td>
            <td>${sbadge(e.status)}</td>
            <td><div class="actions">
              ${e.status==='pending'?`<button class="btn btn-ghost btn-sm" onclick="_editSchedEmail('${e.id}')">Edit</button>`:''}
              <button class="btn btn-ghost btn-sm" onclick="_testSchedEmail('${e.id}')">Test</button>
              ${e.status==='pending'?`<button class="btn btn-icon" style="color:var(--red)" onclick="API.del('/api/orgs/${API.orgId}/scheduled-emails/${e.id}').then(()=>{toast('Cancelled');_loadSchedEmails()}).catch(e=>toast(e.message||'Error','err'))">&#10005;</button>`:''}
            </div></td>
          </tr>`).join('') : '<tr><td colspan="4"><div class="empty">No scheduled emails</div></td></tr>'}</tbody>
        </table></div>
      </div>`;
  } catch(e) { c.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

// Template list actions
async function _emailSetDefault(id) {
  await API.post(`/api/orgs/${API.orgId}/email-templates/${id}/set-default-receipt`, {}).catch(e=>toast(e.message||'Error','err'));
  toast('Set as default receipt ✓'); renderEmails($('page-emails'));
}
async function _emailClearDefault() {
  await API.post(`/api/orgs/${API.orgId}/email-templates/clear-default-receipt`, {}).catch(e=>toast(e.message||'Error','err'));
  toast('Default cleared'); renderEmails($('page-emails'));
}
async function _emailDelete(id, name) {
  confirmDlg(`Delete template "${name}"?`, async () => {
    await API.del(`/api/orgs/${API.orgId}/email-templates/${id}`);
    toast('Deleted'); renderEmails($('page-emails'));
  });
}
async function _emailTestSend(id) {
  Modal.open('Send Test Email', `
    <p style="font-size:13px;color:var(--gray-5);margin-bottom:10px">Send this template with sample data to verify it looks correct.</p>
    <label>Send to *</label>
    <input id="et-to" type="email" placeholder="your@email.com">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="API.post('/api/orgs/${API.orgId}/email-templates/${id}/test-send',{to:val('et-to')}).then(()=>{toast('Test sent ✓');Modal.close()}).catch(e=>toast(e.message||'Error','err'))">Send Test</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}
async function _emailPreview(id) {
  const r = await API.post(`/api/orgs/${API.orgId}/email-templates/${id}/preview`, {}).catch(e=>{toast(e.message||'Error','err');return null;});
  if (!r) return;
  Modal.open('Preview', `
    <div style="border:1px solid var(--gray-1);border-radius:6px;overflow:hidden">
      <iframe srcdoc="${r.html.replace(/"/g,'&quot;')}" style="width:100%;height:520px;border:none"></iframe>
    </div>
    <div class="bg mt">
      <button class="btn btn-ghost" onclick="Modal.close()">Close</button>
    </div>`, {lg:true});
}

// ─── EMAIL DESIGNER ────────────────────────────────────────────────────────────
function _emailNewTemplate() {
  // Start with the donation receipt template pre-built
  const defaultBlocks = [
    { type:'header', text:'Thank you for your donation!', bg:'#1a3a6b', color:'#ffffff', size:26, dir:'ltr', align:'center', padding:'28px 32px' },
    { type:'text', text:'Dear {{title}} {{first_name}} {{last_name}},', size:15, color:'#333', dir:'ltr', align:'left', padding:'20px 32px 4px' },
    { type:'text', text:'We are grateful for your generous support. Your contribution makes a real difference.', size:15, color:'#333', dir:'ltr', align:'left', padding:'4px 32px 16px' },
    { type:'donation_details', title:'Donation Details', headerBg:'#f0f4ff', headerColor:'#1a3a6b', size:14, padding:'0 32px' },
    { type:'divider', color:'#e5e7eb', padding:'16px 32px' },
    { type:'tax_footer', text:'Tax ID: 11-6076986 | {{org_name}}<br>No goods or services were provided in exchange for this contribution.', size:12, color:'#6b7280', bg:'#f9fafb', padding:'16px 32px' },
  ];
  _emailOpenDesigner(null, 'New Donation Receipt', 'Thank you for your donation — {{org_name}}', defaultBlocks);
}

async function _emailEdit(id) {
  const t = await API.get(`/api/orgs/${API.orgId}/email-templates/${id}`).catch(e=>{toast(e.message||'Error','err');return null;});
  if (!t) return;
  const blocks = (() => { try { return JSON.parse(t.blocks||'[]'); } catch { return []; } })();
  _emailOpenDesigner(id, t.name, t.subject, blocks);
}

function _emailOpenDesigner(id, name, subject, blocks) {
  // Store state globally
  window._edId = id;
  window._edBlocks = JSON.parse(JSON.stringify(blocks)); // deep copy
  window._edSelected = null;

  Modal.open(id ? 'Edit Template' : 'New Template', '', {lg:true, tall:true, full:true, cb: () => {
    $('modal-body').innerHTML = _edRenderShell(name, subject);
    _edRenderCanvas();
    _edRenderProps();
  }});
}

function _edRenderShell(name, subject) {
  return `
    <div style="display:grid;grid-template-columns:220px 1fr 280px;height:calc(100vh - 80px);gap:0;margin:-20px">

      <!-- Left: Block palette -->
      <div style="background:var(--gray-05);border-right:1px solid var(--gray-1);overflow-y:auto;padding:12px 10px">
        <div style="font-size:11px;font-weight:700;color:var(--gray-5);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Add Block</div>
        ${[
          ['header',         '◼', 'Header'],
          ['text',           '¶',  'Text'],
          ['image',          '🖼', 'Image'],
          ['image_text',     '⊞',  'Image + Text'],
          ['donation_details','$', 'Donation Info'],
          ['button',         '▶',  'Button'],
          ['columns',        '⊟',  'Columns'],
          ['divider',        '—',  'Divider'],
          ['image_overlay',  '⊡',  'Image + Text Overlay'],
          ['spacer',         '↕',  'Spacer'],
          ['tax_footer',     '©',  'Tax Footer'],
        ].map(([type,icon,label]) => `
          <div class="ed-block-pill" onclick="_edAddBlock('${type}')"
            style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:4px;
            background:#fff;border:1px solid var(--gray-1);border-radius:6px;cursor:pointer;
            font-size:13px;transition:all .15s"
            onmouseover="this.style.background='var(--blue-pale)';this.style.borderColor='var(--blue)'"
            onmouseout="this.style.background='#fff';this.style.borderColor='var(--gray-1)'">
            <span style="font-size:16px;width:20px;text-align:center">${icon}</span>
            <span>${label}</span>
          </div>`).join('')}

        <div style="font-size:11px;font-weight:700;color:var(--gray-5);text-transform:uppercase;letter-spacing:.5px;margin:16px 0 8px">Merge Tags</div>
        ${['{{first_name}}','{{last_name}}','{{title}}','{{hebrew_title}}','{{hebrew_name}}','{{amount}}','{{date}}','{{transaction_id}}','{{method}}','{{org_name}}'].map(tag =>
          `<div onclick="navigator.clipboard.writeText('${tag}').then(()=>toast('Copied'))"
            style="font-size:11px;font-family:monospace;background:#fff;border:1px solid var(--gray-1);
            border-radius:4px;padding:4px 8px;margin-bottom:3px;cursor:pointer;color:var(--blue)"
            title="Click to copy">${tag}</div>`
        ).join('')}
      </div>

      <!-- Center: Canvas -->
      <div style="overflow-y:auto;background:#e5e7eb;padding:16px" id="ed-canvas-wrap">
        <div style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;padding:12px 16px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
          <input id="ed-name" value="${name||''}" placeholder="Template name *" autocomplete="new-password"
            style="flex:1;min-width:160px;font-size:14px;padding:11px 16px;border:2px solid var(--gray-3);border-radius:7px">
          <input id="ed-subject" value="${subject||''}" placeholder="Email subject *" autocomplete="new-password"
            style="flex:2;min-width:220px;font-size:14px;padding:11px 16px;border:2px solid var(--gray-3);border-radius:7px">
          <button class="btn btn-primary btn-sm" onclick="_edSave()">Save</button>
          <button class="btn btn-ghost btn-sm" onclick="_edScheduleModal()">Schedule</button>
          <button class="btn btn-ghost btn-sm" onclick="_edPreviewModal()">Preview</button>
          <button class="btn btn-ghost btn-sm" id="ed-html-btn" onclick="_edToggleHtml()">‹/› HTML</button>
          <button class="btn btn-ghost btn-sm" onclick="Modal.close()">Cancel</button>
        </div>
        <div id="ed-canvas" style="background:#fff;max-width:600px;margin:0 auto;
          box-shadow:0 2px 12px rgba(0,0,0,.15);border-radius:6px;overflow:hidden;min-height:300px">
          <!-- blocks rendered here -->
        </div>
        <p style="text-align:center;font-size:11px;color:#999;margin-top:8px">Click a block to select · Drag to reorder</p>
      </div>

      <!-- Right: Properties panel -->
      <div style="background:var(--white);border-left:1px solid var(--gray-1);overflow-y:auto;padding:14px" id="ed-props">
        <div style="color:var(--gray-5);font-size:13px;text-align:center;margin-top:40px">
          ← Click a block to edit its properties
        </div>
      </div>
    </div>`;
}

// Block rendering for canvas (simplified HTML preview)
function _edBlockHtml(b, idx, selected) {
  const sel = selected === idx;
  const ring = sel ? 'outline:2px solid var(--blue);outline-offset:-2px;' : '';
  const dir  = b.dir || 'ltr';
  const align= b.align || (dir==='rtl'?'right':'left');
  const ff   = b.fontFamily || (dir==='rtl'?'Noto Sans Hebrew, Arial':'Arial, sans-serif');

  const controls = `
    <div class="ed-block-ctrl" style="position:absolute;top:4px;right:4px;display:flex;gap:3px;z-index:10">
      ${idx > 0 ? `<button onclick="event.stopPropagation();_edMoveBlock(${idx},-1)" title="Move up"
        style="background:var(--navy);color:#fff;border:none;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px">▲</button>`:''}
      ${idx < window._edBlocks.length-1 ? `<button onclick="event.stopPropagation();_edMoveBlock(${idx},1)" title="Move down"
        style="background:var(--navy);color:#fff;border:none;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px">▼</button>`:''}
      <button onclick="event.stopPropagation();_edDupBlock(${idx})" title="Duplicate"
        style="background:var(--blue);color:#fff;border:none;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px">⧉</button>
      <button onclick="event.stopPropagation();_edDelBlock(${idx})" title="Delete"
        style="background:var(--red);color:#fff;border:none;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px">✕</button>
    </div>`;

  let inner = '';
  switch(b.type) {
    case 'header':
      inner = `<div style="background:${b.bg||'#1a3a6b'};padding:${b.padding||'28px 32px'};direction:${dir};text-align:${align};font-family:${ff}">
        <div style="font-size:${b.size||26}px;font-weight:${b.bold!==false?'bold':'normal'};color:${b.color||'#fff'}">${b.text||'Header text'}</div>
      </div>`; break;
    case 'text':
      inner = `<div style="padding:${b.padding||'12px 32px'};direction:${dir};text-align:${align};font-family:${ff};font-size:${b.size||15}px;color:${b.color||'#333'};line-height:${b.lineHeight||1.7}">${b.text||'Text block'}</div>`; break;
    case 'image_overlay':
      inner = `<div style="position:relative;display:inline-block;width:100%">
        ${b.url?`<img src="${b.url}" style="width:100%;max-height:${b.maxHeight||'280px'};object-fit:cover;display:block">`:
        `<div style="background:#c7d2fe;height:${b.maxHeight||'200px'};display:flex;align-items:center;justify-content:center;color:#666;font-size:13px">Upload an image</div>`}
        <div style="position:absolute;inset:0;background:${b.overlay||'rgba(0,0,0,0.45)'};
          display:flex;align-items:${b.vAlign==='top'?'flex-start':b.vAlign==='bottom'?'flex-end':'center'};
          justify-content:${b.textAlign==='left'?'flex-start':b.textAlign==='right'?'flex-end':'center'};padding:20px">
          <div style="direction:${dir};text-align:${b.textAlign||'center'};font-family:${ff};
            font-size:${b.size||28}px;font-weight:${b.bold!==false?'bold':'normal'};
            color:${b.color||'#fff'};line-height:1.3;text-shadow:0 2px 8px rgba(0,0,0,.5);max-width:${b.textWidth||'80%'}">
            ${b.text||'Text over image'}
          </div>
        </div>
      </div>`; break;
    case 'image':
      inner = `<div style="padding:${b.padding||'0'};text-align:${b.align||'center'}">
        ${b.url?`<img src="${b.url}" style="max-width:${b.maxWidth||'100%'};height:auto;display:block;${b.align==='center'?'margin:0 auto':''}">`
        :`<div style="background:#e5e7eb;height:120px;display:flex;align-items:center;justify-content:center;color:#999;font-size:13px">Click to set image URL</div>`}
      </div>`; break;
    case 'image_text':
      inner = `<div style="display:flex;align-items:center;gap:0">
        ${b.imgSide!=='right'?`<div style="width:${b.imgWidth||'40%'};flex-shrink:0">${b.url?`<img src="${b.url}" style="width:100%;height:auto">` : `<div style="background:#e5e7eb;height:100px;display:flex;align-items:center;justify-content:center;color:#999;font-size:12px">Image</div>`}</div>`:'' }
        <div style="flex:1;padding:${b.padding||'16px 24px'};direction:${dir};text-align:${align};font-family:${ff};font-size:${b.size||15}px;color:${b.color||'#333'}">${b.text||'Text alongside image'}</div>
        ${b.imgSide==='right'?`<div style="width:${b.imgWidth||'40%'};flex-shrink:0">${b.url?`<img src="${b.url}" style="width:100%;height:auto">` : `<div style="background:#e5e7eb;height:100px;display:flex;align-items:center;justify-content:center;color:#999;font-size:12px">Image</div>`}</div>`:'' }
      </div>`; break;
    case 'donation_details':
      inner = `<div style="padding:${b.padding||'0 32px'}">
        <table style="width:100%;border-collapse:collapse;font-size:${b.size||14}px">
          <tr style="background:${b.headerBg||'#f3f4f6'}"><td colspan="2" style="padding:10px 14px;font-weight:bold;color:${b.headerColor||'#1a3a6b'}">${b.title||'Donation Details'}</td></tr>
          ${[['Amount','{{amount}}'],['Date','{{date}}'],['Method','{{method}}'],['Trans ID','{{transaction_id}}']].map(([l,v],i)=>`<tr style="background:${i%2?'#f9fafb':'#fff'}"><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee;width:38%">${l}</td><td style="padding:8px 14px;font-weight:600;border-bottom:1px solid #eee">${v}</td></tr>`).join('')}
        </table>
      </div>`; break;
    case 'button':
      inner = `<div style="padding:${b.padding||'16px 32px'};text-align:${b.align||'center'}">
        <span style="display:inline-block;background:${b.bg||'#1a3a6b'};color:${b.color||'#fff'};padding:${b.btnPadding||'12px 28px'};border-radius:${b.radius||6}px;font-size:${b.size||15}px;font-weight:bold;font-family:${ff}">${b.text||'Click Here'}</span>
      </div>`; break;
    case 'columns':
      inner = `<div style="display:flex;padding:${b.padding||'8px 32px'}">
        ${(b.columns||[{text:'Column 1'},{text:'Column 2'}]).map(c=>`<div style="flex:1;padding:8px;font-size:${c.size||14}px;direction:${c.dir||dir};text-align:${c.align||(c.dir==='rtl'?'right':'left')};color:${c.color||'#333'}">${c.text||'Column text'}</div>`).join('')}
      </div>`; break;
    case 'divider':
      inner = `<div style="padding:${b.padding||'8px 32px'}"><hr style="border:none;border-top:${b.thickness||1}px solid ${b.color||'#e5e7eb'};margin:0"></div>`; break;
    case 'spacer':
      inner = `<div style="height:${b.height||24}px;background:repeating-linear-gradient(45deg,#f9fafb,#f9fafb 5px,#f0f0f0 5px,#f0f0f0 10px)"></div>`; break;
    case 'tax_footer':
      inner = `<div style="padding:${b.padding||'16px 32px'};background:${b.bg||'#f9fafb'};border-top:1px solid #e5e7eb;direction:${dir};text-align:${align};font-family:${ff};font-size:${b.size||12}px;color:${b.color||'#6b7280'}">${b.text||'Tax ID: 11-6076986 | {{org_name}}<br>No goods or services were provided.'}</div>`; break;
  }

  return `<div data-idx="${idx}" onclick="_edSelectBlock(${idx})"
    style="position:relative;cursor:pointer;${ring};border-bottom:1px solid #f0f0f0"
    title="Click to edit">
    ${controls}
    ${inner}
  </div>`;
}

function _edRenderCanvas() {
  const c = $('ed-canvas'); if(!c) return;
  if (!window._edBlocks.length) {
    c.innerHTML = `<div style="padding:40px;text-align:center;color:#aaa;font-size:13px">
      ← Add blocks from the left panel</div>`;
    return;
  }
  c.innerHTML = window._edBlocks.map((b,i) => _edBlockHtml(b, i, window._edSelected)).join('');
}

function _edSelectBlock(idx) {
  window._edSelected = idx;
  _edRenderCanvas();
  _edRenderProps();
}

function _edRenderProps() {
  const c = $('ed-props'); if(!c) return;
  const idx = window._edSelected;
  if (idx === null || idx === undefined || !window._edBlocks[idx]) {
    c.innerHTML = '<div style="color:var(--gray-5);font-size:13px;text-align:center;margin-top:40px">← Click a block to edit</div>';
    return;
  }
  const b = window._edBlocks[idx];
  const ff = ['Arial, sans-serif','Noto Sans Hebrew, Arial, sans-serif','Frank Ruhl Libre, serif','Heebo, sans-serif','Georgia, serif','Times New Roman, serif'];
  const ffLabels = ['Arial (Latin)','Noto Sans Hebrew (עברית)','Frank Ruhl Libre (עברית)','Heebo (עברית)','Georgia (Serif)','Times New Roman'];

  const field = (label, key, type='text', extra='') =>
    `<label style="font-size:12px;font-weight:500;color:var(--gray-7);margin-top:10px;display:block">${label}</label>
     <input type="${type}" value="${(b[key]||'').toString().replace(/"/g,'&quot;')}" ${extra}
       oninput="window._edBlocks[${idx}]['${key}']=this.value;_edRenderCanvas()"
       style="width:100%;padding:5px 8px;border:1.5px solid var(--gray-3);border-radius:4px;font-size:12px">`;

  const select = (label, key, options) =>
    `<label style="font-size:12px;font-weight:500;color:var(--gray-7);margin-top:10px;display:block">${label}</label>
     <select oninput="window._edBlocks[${idx}]['${key}']=this.value;_edRenderCanvas()"
       style="width:100%;padding:5px 8px;border:1.5px solid var(--gray-3);border-radius:4px;font-size:12px">
       ${options.map(([v,l])=>`<option value="${v}" ${b[key]===v?'selected':''}>${l}</option>`).join('')}
     </select>`;

  const color = (label, key, def) =>
    `<label style="font-size:12px;font-weight:500;color:var(--gray-7);margin-top:10px;display:block">${label}</label>
     <div style="display:flex;gap:6px;align-items:center">
       <input type="color" value="${b[key]||def}" oninput="window._edBlocks[${idx}]['${key}']=this.value;_edRenderCanvas()"
         style="width:36px;height:28px;padding:0;border:none;cursor:pointer;border-radius:3px">
       <input type="text" value="${b[key]||def}" oninput="window._edBlocks[${idx}]['${key}']=this.value;_edRenderCanvas()"
         style="flex:1;padding:5px 8px;border:1.5px solid var(--gray-3);border-radius:4px;font-size:12px">
     </div>`;

  const check = (label, key) =>
    `<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;font-weight:500;color:var(--gray-7);cursor:pointer">
       <input type="checkbox" ${b[key]!==false?'checked':''} onchange="window._edBlocks[${idx}]['${key}']=this.checked;_edRenderCanvas()">
       ${label}
     </label>`;

  const textarea = (label, key) =>
    `<label style="font-size:12px;font-weight:500;color:var(--gray-7);margin-top:10px;display:block">${label}</label>
     <textarea oninput="window._edBlocks[${idx}]['${key}']=this.value;_edRenderCanvas()"
       style="width:100%;padding:5px 8px;border:1.5px solid var(--gray-3);border-radius:4px;font-size:12px;min-height:70px;resize:vertical">${b[key]||''}</textarea>`;

  const fontSel = (label, key) =>
    `<label style="font-size:12px;font-weight:500;color:var(--gray-7);margin-top:10px;display:block">${label}</label>
     <select oninput="window._edBlocks[${idx}]['${key}']=this.value;_edRenderCanvas()"
       style="width:100%;padding:5px 8px;border:1.5px solid var(--gray-3);border-radius:4px;font-size:12px">
       ${ff.map((v,i)=>`<option value="${v}" ${(b[key]||ff[0])===v?'selected':''}>${ffLabels[i]}</option>`).join('')}
     </select>`;

  const dirSel = (label, key='dir') =>
    select(label, key, [['ltr','LTR (English →)'],['rtl','RTL (← עברית)']]);

  const alignSel = (label, key='align') =>
    select(label, key, [['left','Left'],['center','Center'],['right','Right']]);

  let props = `<div style="font-size:12px;font-weight:700;color:var(--navy);margin-bottom:12px;
    padding-bottom:8px;border-bottom:1px solid var(--gray-1)">
    ${b.type.replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase())} Block</div>`;

  switch (b.type) {
    case 'header':
      props += textarea('Header Text (HTML allowed)', 'text');
      props += color('Background', 'bg', '#1a3a6b');
      props += color('Text Color', 'color', '#ffffff');
      props += field('Font Size (px)', 'size', 'number');
      props += check('Bold', 'bold');
      props += dirSel('Direction');
      props += alignSel('Alignment');
      props += fontSel('Font Family', 'fontFamily');
      props += field('Padding', 'padding');
      break;
    case 'text':
      props += textarea('Text (HTML allowed)', 'text');
      props += color('Text Color', 'color', '#333333');
      props += field('Font Size (px)', 'size', 'number');
      props += field('Line Height', 'lineHeight', 'number');
      props += dirSel('Direction');
      props += alignSel('Alignment');
      props += fontSel('Font Family', 'fontFamily');
      props += field('Padding', 'padding');
      break;
    case 'image':
      props += `<div class="bg mt"><button class="btn btn-blue btn-sm" onclick="_edUploadImage(${idx})">&#8679; Upload Image</button></div>`;
      props += field('Or paste Image URL', 'url');
      props += field('Alt Text', 'alt');
      props += field('Max Width (e.g. 100% or 300px)', 'maxWidth');
      props += alignSel('Alignment');
      props += field('Padding', 'padding');
      break;
    case 'image_overlay':
      props += `<div class="bg mt"><button class="btn btn-blue btn-sm" onclick="_edUploadImage(${idx})">&#8679; Upload Image</button></div>`;
      props += field('Or paste Image URL', 'url');
      props += field('Alt Text', 'alt');
      props += field('Image Height (e.g. 280px)', 'maxHeight');
      props += textarea('Overlay Text (HTML allowed)', 'text');
      props += color('Text Color', 'color', '#ffffff');
      props += field('Font Size (px)', 'size', 'number');
      props += check('Bold', 'bold');
      props += dirSel('Text Direction');
      props += alignSel('Text Horizontal Align', 'textAlign');
      props += select('Text Vertical Position', 'vAlign', [['center','Middle'],['top','Top'],['bottom','Bottom']]);
      props += fontSel('Font Family', 'fontFamily');
      props += color('Overlay Color', 'overlay', 'rgba(0,0,0,0.45)');
      props += field('Max Text Width (e.g. 80%)', 'textWidth');
      props += field('Outer Padding', 'padding');
      break;
    case 'image_text':
      props += `<div class="bg mt"><button class="btn btn-blue btn-sm" onclick="_edUploadImage(${idx},'imgUrl')">&#8679; Upload Image</button></div>`;
      props += field('Or paste Image URL', 'url');
      props += select('Image Side', 'imgSide', [['left','Left'],['right','Right']]);
      props += field('Image Width (e.g. 40%)', 'imgWidth');
      props += textarea('Text (HTML allowed)', 'text');
      props += color('Text Color', 'color', '#333333');
      props += field('Font Size (px)', 'size', 'number');
      props += dirSel('Text Direction');
      props += fontSel('Font Family', 'fontFamily');
      props += field('Text Padding', 'padding');
      break;
    case 'donation_details':
      props += field('Section Title', 'title');
      props += color('Header Background', 'headerBg', '#f3f4f6');
      props += color('Header Text Color', 'headerColor', '#1a3a6b');
      props += field('Font Size (px)', 'size', 'number');
      props += dirSel('Direction');
      props += field('Padding', 'padding');
      break;
    case 'button':
      props += field('Button Text', 'text');
      props += field('Link URL', 'url');
      props += color('Background', 'bg', '#1a3a6b');
      props += color('Text Color', 'color', '#ffffff');
      props += field('Font Size (px)', 'size', 'number');
      props += field('Border Radius (px)', 'radius', 'number');
      props += field('Button Padding', 'btnPadding');
      props += alignSel('Alignment');
      props += fontSel('Font Family', 'fontFamily');
      break;
    case 'columns':
      props += `<p style="font-size:12px;color:var(--gray-5);margin-top:8px">Edit each column's content:</p>`;
      (b.columns||[]).forEach((col,ci) => {
        props += `<div style="border:1px solid var(--gray-1);border-radius:5px;padding:8px;margin-top:8px">
          <div style="font-size:11px;font-weight:700;color:var(--navy);margin-bottom:6px">Column ${ci+1}</div>
          <label style="font-size:12px">Text (HTML)</label>
          <textarea oninput="window._edBlocks[${idx}].columns[${ci}].text=this.value;_edRenderCanvas()"
            style="width:100%;padding:4px;border:1px solid var(--gray-3);border-radius:3px;font-size:12px;min-height:50px">${col.text||''}</textarea>
          <label style="font-size:12px;display:block;margin-top:4px">Direction</label>
          <select onchange="window._edBlocks[${idx}].columns[${ci}].dir=this.value;_edRenderCanvas()"
            style="width:100%;padding:4px;border:1px solid var(--gray-3);border-radius:3px;font-size:12px">
            <option value="ltr" ${(col.dir||'ltr')==='ltr'?'selected':''}>LTR</option>
            <option value="rtl" ${col.dir==='rtl'?'selected':''}>RTL</option>
          </select>
        </div>`;
      });
      props += `<button class="btn btn-ghost btn-sm" style="margin-top:8px;width:100%"
        onclick="window._edBlocks[${idx}].columns=window._edBlocks[${idx}].columns||[];
        window._edBlocks[${idx}].columns.push({text:'New column',dir:'ltr'});_edRenderCanvas();_edRenderProps()">
        + Add Column</button>`;
      break;
    case 'divider':
      props += color('Line Color', 'color', '#e5e7eb');
      props += field('Thickness (px)', 'thickness', 'number');
      props += field('Padding', 'padding');
      break;
    case 'spacer':
      props += field('Height (px)', 'height', 'number');
      break;
    case 'tax_footer':
      props += textarea('Footer Text (HTML allowed)', 'text');
      props += color('Background', 'bg', '#f9fafb');
      props += color('Text Color', 'color', '#6b7280');
      props += field('Font Size (px)', 'size', 'number');
      props += dirSel('Direction');
      props += fontSel('Font Family', 'fontFamily');
      props += field('Padding', 'padding');
      break;
  }

  c.innerHTML = props;
}

function _edUploadImage(idx, urlKey='url') {
  // Create a hidden file input
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/gif,image/webp';
  inp.onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 5*1024*1024) { toast('Image too large (max 5MB)','err'); return; }
    const reader = new FileReader();
    reader.onload = async ev => {
      const b64 = ev.target.result.split(',')[1];
      try {
        toast('Uploading…');
        const r = await API.post(`/api/orgs/${API.orgId}/email-templates/upload-image`, {
          image_base64: b64, mime_type: file.type, filename: file.name
        });
        // Set the URL on the block
        window._edBlocks[idx][urlKey] = r.url;
        _edRenderCanvas();
        _edRenderProps();
        toast('Image uploaded ✓');
      } catch(e2) { toast(e2.message||'Upload failed','err'); }
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}
function _edAddBlock(type) {
  const defaults = {
    header:           { type:'header', text:'Your Header Here', bg:'#1a3a6b', color:'#ffffff', size:26, bold:true, dir:'ltr', align:'center', padding:'28px 32px' },
    text:             { type:'text', text:'Your text here. Use merge tags like {{first_name}}.', size:15, color:'#333333', dir:'ltr', align:'left', lineHeight:1.7, padding:'12px 32px' },
    image:            { type:'image', url:'', alt:'', maxWidth:'100%', align:'center', padding:'0' },
    image_text:       { type:'image_text', url:'', text:'Text alongside your image.', imgSide:'left', imgWidth:'40%', size:15, color:'#333', dir:'ltr', padding:'16px 24px' },
    donation_details: { type:'donation_details', title:'Donation Details', headerBg:'#f0f4ff', headerColor:'#1a3a6b', size:14, padding:'0 32px' },
    button:           { type:'button', text:'Click Here', url:'#', bg:'#1a3a6b', color:'#ffffff', size:15, radius:6, btnPadding:'12px 28px', align:'center' },
    image_overlay:    { type:'image_overlay', url:'', text:'Your headline here', color:'#ffffff', size:28, bold:true, dir:'ltr', textAlign:'center', vAlign:'center', overlay:'rgba(0,0,0,0.45)', maxHeight:'280px', textWidth:'80%', padding:'0' },
    columns:          { type:'columns', columns:[{text:'Column 1',dir:'ltr'},{text:'עמודה 2',dir:'rtl'}], padding:'8px 32px' },
    divider:          { type:'divider', color:'#e5e7eb', thickness:1, padding:'8px 32px' },
    spacer:           { type:'spacer', height:24 },
    tax_footer:       { type:'tax_footer', text:'Tax ID: 11-6076986 | {{org_name}}<br>No goods or services were provided in exchange for this contribution.', bg:'#f9fafb', color:'#6b7280', size:12, dir:'ltr', padding:'16px 32px' },
  };
  const block = defaults[type] || { type };
  // Insert after selected, or at end
  const at = window._edSelected !== null ? window._edSelected + 1 : window._edBlocks.length;
  window._edBlocks.splice(at, 0, block);
  window._edSelected = at;
  _edRenderCanvas();
  _edRenderProps();
}
function _edMoveBlock(idx, dir) {
  const b = window._edBlocks;
  const ni = idx + dir;
  if (ni<0||ni>=b.length) return;
  [b[idx], b[ni]] = [b[ni], b[idx]];
  window._edSelected = ni;
  _edRenderCanvas();
  _edRenderProps();
}
function _edDupBlock(idx) {
  const copy = JSON.parse(JSON.stringify(window._edBlocks[idx]));
  window._edBlocks.splice(idx+1,0,copy);
  window._edSelected = idx+1;
  _edRenderCanvas();
  _edRenderProps();
}
function _edDelBlock(idx) {
  window._edBlocks.splice(idx,1);
  window._edSelected = null;
  _edRenderCanvas();
  _edRenderProps();
}
async function _edSave(returnId = false) {
  // If in HTML mode, capture raw HTML from textarea into blocks first
  if (_edHtmlMode) {
    const rawHtml = $('ed-html-raw')?.value?.replace(/&lt;/g,'<').replace(/&gt;/g,'>') || '';
    if (rawHtml.trim()) {
      window._edBlocks = [{ type: 'raw_html', html: rawHtml }];
    }
  }
  const name    = document.getElementById('ed-name')?.value?.trim();
  const subject = document.getElementById('ed-subject')?.value?.trim();
  if (!name || !subject) { toast('Name and subject required','err'); return null; }
  try {
    if (window._edId) {
      await API.put(`/api/orgs/${API.orgId}/email-templates/${window._edId}`, { name, subject, blocks: window._edBlocks });
      toast('Template saved ✓');
      if (!returnId) { Modal.close(); renderEmails($('page-emails')); }
      return window._edId;
    } else {
      const r = await API.post(`/api/orgs/${API.orgId}/email-templates`, { name, subject, blocks: window._edBlocks });
      window._edId = r.template.id;
      toast('Template created ✓');
      if (!returnId) { Modal.close(); renderEmails($('page-emails')); }
      return window._edId;
    }
  } catch(e) { toast(e.message||'Save failed','err'); return null; }
}
async function _edPreviewModal() {
  if (!window._edId) { toast('Save first, then preview','err'); return; }
  const r = await API.post(`/api/orgs/${API.orgId}/email-templates/${window._edId}/preview`, {}).catch(e=>{toast(e.message,'err');return null;});
  if (!r) return;
  window.open().document.write(r.html);
}

// Alias for confirm used elsewhere
window.confirm2 = (msg, yes) => {
  Modal.open('Confirm', `<p style="margin-bottom:14px;color:var(--gray-7)">${msg}</p>
    <div class="bg"><button class="btn btn-red btn-sm" onclick="Modal.close();(${yes.toString()})()">Confirm</button>
    <button class="btn btn-ghost btn-sm" onclick="Modal.close()">Cancel</button></div>`, {sm:true});
};


async function _saveEmailSettings() {
  const email = val('em-email').trim();
  if (!email) { toast('Enter your SMTP email address', 'err'); return; }
  const btn = document.querySelector('#em-smtp .btn-primary');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  try {
    await API.put(API.o.email(), {
      smtp_email: email || undefined,
      smtp_password: val('em-pass') || undefined,
      smtp_host: val('em-host') || 'smtp.gmail.com',
      smtp_port: parseInt(val('em-port')) || 587,
      from_name: val('em-name') || '',
      donation_emails_paused: $('em-pause')?.checked ? 1 : 0,
      brevo_api_key: val('em-brevokey') || undefined
    });
    toast('Email settings saved ✓');
    const passInput = $('em-pass'); if (passInput) passInput.value = '';
    _loadEmailStatus();
  } catch(e) {
    toast(e.message || 'Failed to save', 'err');
  } finally {
    if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
  }
}
async function _loadEmailStatus() {
  const c = $('em-status'); if (!c) return;
  try {
    const s = await API.get(`/api/orgs/${API.orgId}/email-settings/status`);
    if (s.brevo) {
      c.innerHTML = `<div class="alert alert-ok" style="font-size:12px">✓ Brevo API configured${s.paused?' (paused)':''}. Emails send via HTTPS — reliable delivery.</div>`;
    } else if (s.configured) {
      c.innerHTML = `<div class="alert alert-ok" style="font-size:12px">✓ Gmail SMTP configured${s.paused?' (paused)':''}.</div>`;
    } else if (s.has_email && !s.has_password) {
      c.innerHTML = `<div class="alert alert-warn" style="font-size:12px">⚠ Gmail address saved but no App Password set. Receipts will NOT send until you add it.</div>`;
    } else {
      c.innerHTML = `<div class="alert alert-err" style="font-size:12px">✗ Email not configured. Donation receipts are NOT sending. Add Postmark API key (recommended) or Gmail credentials above and Save.</div>`;
    }
  } catch { c.innerHTML = ''; }
}

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
function _schedEmail(){
  const now=new Date();now.setHours(now.getHours()+1);
  Modal.open('Schedule Email',`
    <label>Subject</label><input id="se-subj" style="margin-bottom:8px">
    <label>Recipients</label>
    <div style="margin-bottom:10px">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:6px">
        <input type="radio" name="se-recip" value="all" checked> All donors with email
      </label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="radio" name="se-recip" value="label"> By label:
        <select id="se-label-sel" style="margin-left:4px"><option value="">Loading...</option></select>
      </label>
    </div>
    <label>Body (HTML)</label>
    <textarea id="se-body" style="min-height:160px;font-size:12px;font-family:monospace"></textarea>
    <label style="margin-top:8px">Send At</label>
    <input type="datetime-local" id="se-at" value="${toLocalDT(now.toISOString())}">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="
        const recip=document.querySelector('input[name=se-recip]:checked')?.value;
        const label=val('se-label-sel');
        API.post(API.o.schedEmails(),{
          subject:val('se-subj'),html_body:val('se-body'),
          scheduled_for:val('se-at'),
          recipient_group:recip==='label'&&label?'label:'+label:'all_donors'
        }).then(()=>{toast('Scheduled');Modal.close();renderEmails(\$('page-emails'))}).catch(e=>toast(e.message||'Unknown error','err'))
      ">Schedule</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`,{sm:true});
  API.get(`/api/orgs/${API.orgId}/label-lists`).then(ll=>{
    const l = ll?.donor_labels||[];
    const sel=$('se-label-sel');
    if(sel) sel.innerHTML='<option value="">— All in label —</option>'+(l||[]).map(x=>`<option value="${x}">${x}</option>`).join('');
  }).catch(()=>{});
}

async function renderKvitel(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const [cfg, donors] = await Promise.all([
      API.get(`/api/orgs/${API.orgId}/kvitel/settings`).catch(()=>({})),
      API.get(API.o.donors()+'?limit=500')
    ]);
    const c = cfg || {};
    const fonts = ['Noto Sans Hebrew','Frank Ruhl Libre','Heebo','Narkisim','Times New Roman','Livvorn'];

    // Parse stored headers JSON
    let _kvHeaders = [];
    try { _kvHeaders = JSON.parse(c.header_text||'[]'); if(!Array.isArray(_kvHeaders)) _kvHeaders=[]; } catch { _kvHeaders=[]; }
    window._kvHeaders = _kvHeaders;

    // Build donor preview (grouped by neighborhood, NO donor names)
    const donorsWithKvitel = (donors.donors||[]).filter(d=>d.kvitel&&d.kvitel.trim());
    const previewGroups = {};
    donorsWithKvitel.forEach(d=>{
      const nh = d.neighborhood_name||'';
      if(!previewGroups[nh]) previewGroups[nh]=[];
      previewGroups[nh].push(d);
    });
    const previewHtml = Object.entries(previewGroups).map(([nh,ds])=>`
      ${nh?`<div style="font-size:${c.neighborhood_size||14}px;font-weight:bold;color:#1a3a6b;margin:10px 0 4px;direction:rtl;text-align:right">${nh}</div>`:''}
      ${ds.map(d=>`<div style="font-size:${c.font_size||12}px;white-space:pre-line;direction:rtl;text-align:right;margin-bottom:8px">${d.kvitel}</div>`).join('')}
    `).join('') || '<p style="color:var(--gray-5)">No donors with kvitel content</p>';

    el.innerHTML = `
      <div class="ph"><div><div class="ph-title">Kvitel Generator</div>
        <div class="ph-sub">${donorsWithKvitel.length} donors with kvitel content</div></div>
        <div class="bg">
          <button class="btn btn-outline btn-sm" onclick="API.dl('/api/orgs/${API.orgId}/kvitel/generate-pdf','kvitel.pdf','POST',{}).catch(e=>toast(e.message||'Unknown error','err'))">&#8681; Download PDF</button>
          <button class="btn btn-primary btn-sm" onclick="API.dl('/api/orgs/${API.orgId}/kvitel/generate-docx','kvitel.docx','POST',{}).catch(e=>toast(e.message||'Unknown error','err'))">&#8681; Download DOCX</button>
        </div>
      </div>
      <div class="g2">
        <div class="card">
          <div class="tabs">
            <div class="tab on" data-tc="kv-t-hdr">Headers</div>
            <div class="tab" data-tc="kv-t-body">Body</div>
            <div class="tab" data-tc="kv-t-nh">Neighborhood</div>
            <div class="tab" data-tc="kv-t-pg">Page</div>
          </div>

          <div id="kv-t-hdr" class="tc on">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <span style="font-size:12px;color:var(--gray-5)">Multiple headers allowed — each appears on every page</span>
              <button class="btn btn-blue btn-sm" onclick="_kvAddHeader()">+ Header</button>
            </div>
            <div id="kv-hdr-list"></div>
          </div>

          <div id="kv-t-body" class="tc">
            <label>Body Font</label>
            <select id="kb-font">${fonts.map(f=>`<option ${(c.font_family||'Noto Sans Hebrew')===f?'selected':''}>${f}</option>`).join('')}</select>
            <div class="r2 mt">
              <div><label>Size (pt)</label><input type="number" id="kb-sz" value="${c.font_size||12}" step="0.5" min="8" max="36"></div>
              <div><label>Line Height</label><input type="number" id="kb-lh" value="${c.line_height||1.6}" step="0.1" min="1" max="3"></div>
            </div>
          </div>

          <div id="kv-t-nh" class="tc">
            <div class="trow" style="margin-bottom:12px">
              <div>Show Hebrew Neighborhood Heading</div>
              <label class="tgl"><input type="checkbox" id="kb-nh" ${c.group_by_neighborhood!==0?'checked':''}><span class="tgl-s"></span></label>
            </div>
            <label>Neighborhood Font</label>
            <select id="knh-font">${fonts.map(f=>`<option ${(c.neighborhood_font||'Frank Ruhl Libre')===f?'selected':''}>${f}</option>`).join('')}</select>
            <div class="r2 mt">
              <div><label>Size (pt)</label><input type="number" id="knh-sz" value="${c.neighborhood_size||14}" step="0.5" min="8" max="48"></div>
              <div><label>Bold</label><br><label class="tgl" style="margin-top:6px"><input type="checkbox" id="knh-bold" ${c.neighborhood_bold!==0?'checked':''}><span class="tgl-s"></span></label></div>
            </div>
          </div>

          <div id="kv-t-pg" class="tc">
            <label>Page Size</label>
            <select id="kb-page">
              <option value="letter" ${(c.page_size||'letter')==='letter'?'selected':''}>Letter (8.5 × 11)</option>
              <option value="legal" ${c.page_size==='legal'?'selected':''}>Legal (8.5 × 14)</option>
              <option value="a4" ${c.page_size==='a4'?'selected':''}>A4</option>
            </select>
            <div class="r2 mt">
              <div><label>Columns</label><select id="kb-cols">${[1,2,3].map(n=>`<option ${(c.columns||1)==n?'selected':''}>${n}</option>`).join('')}</select></div>
              <div><label>Column Gap (in)</label><input type="number" id="kb-gap" value="${c.column_gap||0.5}" step="0.1" min="0" max="3"></div>
            </div>
            <div class="card-title mt">Margins (inches)</div>
            <div class="r4">${['top','bottom','left','right'].map(m=>`<div><label>${m.charAt(0).toUpperCase()+m.slice(1)}</label><input type="number" id="km-${m}" value="${c['margin_'+m]||1}" step="0.25" min="0" max="4"></div>`).join('')}</div>
          </div>

          <div class="bg mt">
            <button class="btn btn-primary" onclick="_saveKvitelCfg()">Save Settings</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Preview <span style="font-size:11px;color:var(--gray-5)">(RTL, no donor names)</span></div>
          <div id="kv-prev" class="kv-preview" style="font-family:${c.font_family||'Noto Sans Hebrew'};direction:rtl;text-align:right">
            ${previewHtml}
          </div>
        </div>
      </div>`;

    tabsInit('#page-kvitel');
    _kvRenderHeaders();
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message||'Error loading kvitel'}</div>`; }
}

function _kvRenderHeaders() {
  const c = document.getElementById('kv-hdr-list'); if(!c) return;
  const headers = window._kvHeaders || [];
  if (!headers.length) {
    c.innerHTML = '<p style="color:var(--gray-5);font-size:13px">No headers yet. Click "+ Header" to add one.</p>';
    return;
  }
  const fonts = ['Noto Sans Hebrew','Frank Ruhl Libre','Heebo','Narkisim','Times New Roman','Livvorn'];
  c.innerHTML = headers.map((h,i) => `
    <div style="border:1px solid var(--gray-1);border-radius:6px;padding:12px;margin-bottom:8px;background:var(--gray-05)">
      <label>Header Text</label>
      <input style="direction:rtl;font-family:Noto Sans Hebrew" value="${(h.text||'').replace(/"/g,'&quot;')}" oninput="window._kvHeaders[${i}].text=this.value">
      <div class="r2 mt">
        <div><label>Font</label><select onchange="window._kvHeaders[${i}].font=this.value">${fonts.map(f=>`<option ${(h.font||'Frank Ruhl Libre')===f?'selected':''}>${f}</option>`).join('')}</select></div>
        <div><label>Size (pt)</label><input type="number" value="${h.size||18}" min="8" max="72" oninput="window._kvHeaders[${i}].size=+this.value"></div>
      </div>
      <div class="r4 mt">
        <div><label>Bold</label><br><label class="tgl" style="margin-top:6px"><input type="checkbox" ${h.bold!==false?'checked':''} onchange="window._kvHeaders[${i}].bold=this.checked"><span class="tgl-s"></span></label></div>
        <div><label>Align</label><select onchange="window._kvHeaders[${i}].align=this.value"><option value="center" ${(h.align||'center')==='center'?'selected':''}>Center</option><option value="right" ${h.align==='right'?'selected':''}>Right</option><option value="left" ${h.align==='left'?'selected':''}>Left</option></select></div>
        <div><label>Direction</label><select onchange="window._kvHeaders[${i}].dir=this.value"><option value="rtl" ${(h.dir||'rtl')==='rtl'?'selected':''}>RTL</option><option value="ltr" ${h.dir==='ltr'?'selected':''}>LTR</option></select></div>
        <div style="display:flex;align-items:flex-end"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="window._kvHeaders.splice(${i},1);_kvRenderHeaders()">Remove</button></div>
      </div>
    </div>
  `).join('');
}
function _kvAddHeader() {
  if (!window._kvHeaders) window._kvHeaders = [];
  window._kvHeaders.push({ text:'', font:'Frank Ruhl Libre', size:18, bold:true, align:'center', dir:'rtl' });
  _kvRenderHeaders();
}
async function _saveKvitelCfg() {
  try {
    await API.put(`/api/orgs/${API.orgId}/kvitel/settings`, {
      header_text:      JSON.stringify(window._kvHeaders || []),
      font_family:      val('kb-font'),
      font_size:        parseFloat(val('kb-sz')),
      line_height:      parseFloat(val('kb-lh')),
      page_size:        val('kb-page'),
      columns:          parseInt(val('kb-cols')),
      column_gap:       parseFloat(val('kb-gap')),
      group_by_neighborhood: $('kb-nh')?.checked ? 1 : 0,
      neighborhood_font:  val('knh-font'),
      neighborhood_size:  parseFloat(val('knh-sz')),
      neighborhood_bold:  $('knh-bold')?.checked ? 1 : 0,
      margin_top:    parseFloat(val('km-top')),
      margin_bottom: parseFloat(val('km-bottom')),
      margin_left:   parseFloat(val('km-left')),
      margin_right:  parseFloat(val('km-right')),
    });
    toast('Kvitel settings saved');
  } catch(e) { toast(e.message||'Save failed','err'); }
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
    const [users, log, hoods, tzData] = await Promise.all([API.get(API.o.users()), API.get(API.o.log()), API.get(API.o.hoods()), API.get('/api/orgs/'+API.orgId+'/timezone').catch(()=>({timezone:'America/New_York'}))]);
    window._orgTz = tzData.timezone || 'America/New_York';
    
    el.innerHTML = `
      <div class="ph"><div class="ph-title">Settings</div></div>
      <div class="tabs"><div class="tab on" data-tc="st-users">Users</div><div class="tab" data-tc="st-nh">Neighborhoods</div><div class="tab" data-tc="st-labels">Labels</div><div class="tab" data-tc="st-tz">Timezone</div><div class="tab" data-tc="st-log">Login Log</div><div class="tab" data-tc="st-backup">Backup</div><div class="tab" data-tc="st-imports">Import History</div>${DRM.user?.is_super_admin?'<div class="tab" data-tc="st-all-orgs">All Orgs</div>':''}</div>
      <div id="st-users" class="tc on">
        <div class="card" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <strong>My Account</strong>
            <button class="btn btn-ghost btn-sm" onclick="_editAccountInfo()">✏ Edit</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
            <div><span style="color:var(--gray-5);font-size:11px">Organisation</span><div style="font-weight:600">${org.name}</div></div>
            <div><span style="color:var(--gray-5);font-size:11px">My Name</span><div>${DRM.user?.full_name||'—'}</div></div>
            <div><span style="color:var(--gray-5);font-size:11px">Email</span><div>${DRM.user?.email||'—'}</div></div>
            <div><span style="color:var(--gray-5);font-size:11px">Role</span><span class="pill ${DRM.user?.role==='admin'?'pill-blue':'pill-gray'}">${DRM.user?.role||'staff'}</span>${DRM.user?.is_super_admin?' <span class="pill pill-blue">Super Admin</span>':''}</div>
          </div>
          <button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="_changeMyPassword()">🔒 Change My Password</button>
        </div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Users</strong>
            <div class="bg">
              ${DRM.user?.is_super_admin?`<button class="btn btn-outline btn-sm" onclick="_inviteAcct()">+ Invite New Account</button>`:''}
              <button class="btn btn-primary btn-sm" onclick="_inviteUser()">+ Invite User</button>
            </div>
          </div>
          <div class="tw"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Login</th><th></th></tr></thead>
            <tbody>${users.map(u=>`<tr>
              <td><strong>${u.full_name}</strong></td>
              <td style="font-size:12px">${u.email}</td>
              <td><span class="pill ${u.role==='admin'?'pill-blue':'pill-gray'}">${u.role}</span></td>
              <td style="font-size:12px">${fmtDT(u.last_login)}</td>
              <td><div class="actions">
                <button class="btn btn-ghost btn-sm" onclick="_editUser('${u.id}','${(u.full_name||'').replace(/'/g,"\\'")}','${u.email}','${u.role}')">Edit</button>
                <button class="btn btn-ghost btn-sm" onclick="_resetPw('${u.id}','${(u.full_name||'').replace(/'/g,"\\'")}')">Reset PW</button>
                <button class="btn btn-icon" style="color:var(--red)" onclick="_removeUser('${u.id}','${(u.full_name||'').replace(/'/g,"\\'")}')">&#10005;</button>
              </div></td>
            </tr>`).join('')}</tbody>
          </table></div>
        </div>
      </div>
      <div id="st-nh" class="tc"><div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><strong>Neighborhoods</strong><button class="btn btn-primary btn-sm" onclick="_addHood()">+ Add</button></div>
        ${hoods.map(h=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--gray-1)"><span style="font-family:var(--font-he);font-size:15px">${h.name_he}</span><button class="btn btn-icon" style="color:var(--red)" onclick="API.del(API.o.hoods()+'/${h.id}').then(()=>{toast('Removed');renderSettings($('page-settings'))}).catch(e=>toast(e.message||'Unknown error','err'))">&#10005;</button></div>`).join('')||'<p style="color:var(--gray-5)">No neighborhoods yet</p>'}
      </div></div>
      <div id="st-labels" class="tc">
        <div class="card" id="st-labels-card">
          <div class="spinner"></div>
        </div>
      </div>
      <div id="st-tz" class="tc"><div class="card">
        <div class="card-title">Timezone Settings</div>
        <p style="font-size:13px;color:var(--gray-5);margin-bottom:14px">Set your organization's timezone for scheduled emails and recurring charges.</p>
        <label>Timezone</label>
        <select id="tz-select">
          ${['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','America/Anchorage','Pacific/Honolulu','Europe/London','Europe/Paris','Europe/Jerusalem','Asia/Jerusalem'].map(tz=>`<option value="${tz}" ${(_orgTz||'America/New_York')===tz?'selected':''}>${tz}</option>`).join('')}
        </select>
        <div class="bg mt">
          <button class="btn btn-primary" onclick="_saveTz()">Save Timezone</button>
        </div>
      </div></div>
      <div id="st-backup" class="tc">
        <div class="card" id="st-backup-card"><div class="spinner"></div></div>
      </div>
      <div id="st-imports" class="tc">
        <div class="card" id="st-imports-card"><div class="spinner"></div></div>
      </div>
      <div id="st-all-orgs" class="tc">
        <div class="card" id="st-all-orgs-card"><div class="spinner"></div></div>
      </div>
      <div id="st-log" class="tc"><div class="card">
        <div class="card-title">Login Audit Log</div>
        <div class="scroll-box"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>IP</th></tr></thead>
        <tbody>${log.slice(0,100).map(l=>`<tr><td style="font-size:12px">${fmtDT(l.created_at)}</td><td>${l.full_name}</td><td><span class="pill ${l.action==='login'?'pill-green':'pill-gray'}">${l.action}</span></td><td style="font-size:11px;color:var(--gray-5)">${l.ip||'—'}</td></tr>`).join('')}</tbody>
        </table></div>
      </div></div>`;
    tabsInit('#page-settings');
    document.querySelector('#page-settings .tab[data-tc="st-backup"]')?.addEventListener('click', _loadBackupStatus);
    document.querySelector('#page-settings .tab[data-tc="st-imports"]')?.addEventListener('click', _loadImportHistory);
    document.querySelector('#page-settings .tab[data-tc="st-all-orgs"]')?.addEventListener('click', _loadAllOrgs);
    // Check for pending access requests for org admins
    _checkAccessRequests();
    // Load label lists when Labels tab is clicked
    document.querySelector('#page-settings .tab[data-tc="st-labels"]').addEventListener('click', _loadLabelSettings);
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
function _inviteUser() {
  const pages = [
    {id:'donors',     label:'Donors',     note:'Can hide donations & adding donations'},
    {id:'donations',  label:'Donations',  note:''},
    {id:'leads',      label:'Leads',      note:''},
    {id:'verification',label:'Info Check',note:''},
    {id:'failures',   label:'Failed Charges',note:''},
    {id:'bank',       label:'Bank',       note:''},
    {id:'emails',     label:'Emails',     note:''},
    {id:'kvitel',     label:'Kvitel',     note:''},
    {id:'reports',    label:'Reports',    note:''},
    {id:'settings',   label:'Settings',   note:''},
  ];
  Modal.open('Invite User', `
    <p style="color:var(--gray-5);font-size:13px;margin-bottom:12px">They'll receive a link to create their password.</p>
    <div class="r2">
      <div><label>Email *</label><input id="iu-email" type="email" autocomplete="new-password"></div>
      <div><label>Role</label>
        <select id="iu-role">
          <option value="staff">Staff (limited)</option>
          <option value="admin">Admin (full access)</option>
        </select>
      </div>
    </div>
    <div style="margin-top:14px">
      <div style="font-size:11px;font-weight:700;color:var(--gray-5);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Page Permissions</div>
      <div style="font-size:11px;color:var(--gray-4);margin-bottom:8px">Leave all on for full access. Admins always have full access regardless.</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr>
          <th style="text-align:left;padding:4px 8px;color:var(--gray-5);font-weight:600">Page</th>
          <th style="padding:4px 8px;color:var(--gray-5);font-weight:600;text-align:center">View</th>
          <th style="padding:4px 8px;color:var(--gray-5);font-weight:600;text-align:center">Edit/Create</th>
        </tr></thead>
        <tbody>
          ${pages.map(p=>`<tr style="border-top:1px solid var(--gray-1)">
            <td style="padding:6px 8px">
              ${p.label}
              ${p.note?`<div style="font-size:10px;color:var(--gray-4)">${p.note}</div>`:''}
            </td>
            <td style="text-align:center;padding:6px 8px">
              <input type="checkbox" id="perm-view-${p.id}" checked onchange="if(!this.checked)document.getElementById('perm-edit-${p.id}').checked=false">
            </td>
            <td style="text-align:center;padding:6px 8px">
              <input type="checkbox" id="perm-edit-${p.id}" checked onchange="if(this.checked)document.getElementById('perm-view-${p.id}').checked=true">
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div id="iu-res" style="display:none;margin-top:10px"></div>
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_doInviteUser()">Send Invite</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {lg:true});
}
async function _doInviteUser() {
  try {
    const pages = ['donors','donations','leads','verification','failures','bank','emails','kvitel','reports','settings'];
    const permissions = pages.map(p => ({
      page: p,
      can_view: $('perm-view-'+p)?.checked ? 1 : 0,
      can_edit: $('perm-edit-'+p)?.checked ? 1 : 0
    }));
    const r = await API.post(`/api/orgs/${API.orgId}/users/invite`, {
      email: val('iu-email'), role: val('iu-role'), permissions
    });
    const res = $('iu-res');
    res.innerHTML = r.emailSent
      ? `<div class="alert alert-ok">Invite sent to ${val('iu-email')}</div>`
      : `<div class="alert alert-warn">Email not configured. Share this link:<br><a href="${r.setupUrl}" target="_blank" style="font-size:11px;word-break:break-all">${r.setupUrl}</a></div>`;
    res.style.display = 'block';
    renderSettings($('page-settings'));
  } catch(e) { toast(e.message||'Unknown error','err'); }
}
function _inviteAcct(){Modal.open('Invite New Account',`<p style="color:var(--gray-5);font-size:13px;margin-bottom:12px">They'll get a link to create their org and admin account.</p><label>Email *</label><input id="ia-email" type="email" autocomplete="off"><div id="ia-res" style="display:none;margin-top:10px"></div><div class="bg mt"><button class="btn btn-primary" onclick="_doInviteAcct()">Send Invite</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}
async function _doInviteAcct(){try{const r=await API.post('/auth/invite-account',{email:val('ia-email')});const res=$('ia-res');res.innerHTML=r.emailSent?`<div class="alert alert-ok">Invite sent to ${val('ia-email')}</div>`:`<div class="alert alert-warn">Email not configured. Share this link:<br><a href="${r.setupUrl}" target="_blank" style="font-size:11px;word-break:break-all">${r.setupUrl}</a></div>`;res.style.display='block';}catch(e){toast(e.message||'Unknown error','err');}}
function _resetPw(id,name){Modal.open('Reset Password',`<p style="margin-bottom:10px">New password for <strong>${name}</strong></p><label>Password</label><input id="rp-pw" type="password"><div class="bg mt"><button class="btn btn-primary" onclick="API.put('/api/orgs/${API.orgId}/users/${id}/password',{password:val('rp-pw')}).then(()=>{toast('Updated');Modal.close()}).catch(e=>toast(e.message||'Unknown error','err'))">Set</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}
function _removeUser(id,name){confirmDlg(`Remove ${name}?`,async()=>{await API.del(`/api/orgs/${API.orgId}/users/${id}`);toast('Removed');renderSettings($('page-settings'));});}
async function _loadLabelSettings() {
  const c = $('st-labels-card'); if(!c) return;
  c.innerHTML = '<div class="spinner"></div>';
  try {
    const lists = await API.get(`/api/orgs/${API.orgId}/label-lists`);
    let donorLbls    = [...(lists.donor_labels||[])];
    let donationLbls = [...(lists.donation_labels||[])];

    function renderLabelList(containerId, arr, type) {
      const el = $(containerId); if(!el) return;
      el.innerHTML = arr.length
        ? arr.map((l,i) => `<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--gray-1)">
            <span class="pill pill-blue" style="flex:1">${l}</span>
            <button class="btn btn-icon" style="color:var(--red)" onclick="window._removeLabel('${type}',${i})">&#10005;</button>
          </div>`).join('')
        : '<p style="color:var(--gray-5);font-size:13px">No labels yet</p>';
    }

    window._removeLabel = (type, idx) => {
      if(type==='donor')    { donorLbls.splice(idx,1);    renderLabelList('donor-lbl-list', donorLbls,'donor'); }
      if(type==='donation') { donationLbls.splice(idx,1); renderLabelList('donation-lbl-list', donationLbls,'donation'); }
    };
    window._addLabel = (type) => {
      const inp = $(type+'-lbl-inp');
      const v = inp?.value?.trim(); if(!v) return;
      if(type==='donor')    { if(!donorLbls.includes(v)) donorLbls.push(v);    renderLabelList('donor-lbl-list', donorLbls,'donor'); }
      if(type==='donation') { if(!donationLbls.includes(v)) donationLbls.push(v); renderLabelList('donation-lbl-list', donationLbls,'donation'); }
      inp.value = '';
    };
    window._saveLabelLists = async () => {
      await API.put(`/api/orgs/${API.orgId}/label-lists`,{donor_labels:donorLbls,donation_labels:donationLbls});
      toast('Labels saved ✓');
    };

    c.innerHTML = `
      <div class="g2">
        <div>
          <div class="card-title">Donor Labels</div>
          <p style="font-size:12px;color:var(--gray-5);margin-bottom:10px">Tags applied to donors (e.g. Major Donor, Board Member, Volunteer)</p>
          <div id="donor-lbl-list"></div>
          <div class="bg mt">
            <input id="donor-lbl-inp" placeholder="New label…" style="flex:1" autocomplete="off"
              onkeydown="if(event.key==='Enter'){event.preventDefault();window._addLabel('donor')}">
            <button class="btn btn-blue btn-sm" onclick="window._addLabel('donor')">Add</button>
          </div>
        </div>
        <div>
          <div class="card-title">Donation Labels</div>
          <p style="font-size:12px;color:var(--gray-5);margin-bottom:10px">Labels applied to individual donations (e.g. Annual Pledge, Matching Gift, Yizkor)</p>
          <div id="donation-lbl-list"></div>
          <div class="bg mt">
            <input id="donation-lbl-inp" placeholder="New label…" style="flex:1" autocomplete="off"
              onkeydown="if(event.key==='Enter'){event.preventDefault();window._addLabel('donation')}">
            <button class="btn btn-blue btn-sm" onclick="window._addLabel('donation')">Add</button>
          </div>
        </div>
      </div>
      <div class="bg mt"><button class="btn btn-primary" onclick="window._saveLabelLists()">Save Labels</button></div>`;

    renderLabelList('donor-lbl-list',    donorLbls,    'donor');
    renderLabelList('donation-lbl-list', donationLbls, 'donation');
  } catch(e) { c.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}
async function _loadBackupStatus() {
  const c = $('st-backup-card'); if(!c) return;
  c.innerHTML = '<div class="spinner"></div>';
  try {
    const s = await API.get(`/api/orgs/${API.orgId}/backup/status`);
    const fmtSize = bytes => bytes > 1024*1024 ? (bytes/1024/1024).toFixed(1)+' MB' : (bytes/1024).toFixed(1)+' KB';
    c.innerHTML = `
      <div class="card-title">Database Backup</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="stat-card">
          <div class="stat-val">${fmtSize(s.db_size)}</div>
          <div class="stat-lbl">Current DB size</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${s.backup_count}</div>
          <div class="stat-lbl">Backups stored (last 30 days)</div>
        </div>
      </div>
      ${s.latest_backup ? `<div class="alert alert-ok" style="font-size:12px;margin-bottom:12px">
        ✓ Latest backup: <strong>${s.latest_backup.date}</strong> · ${fmtSize(s.latest_backup.size)}
      </div>` : `<div class="alert alert-warn" style="font-size:12px;margin-bottom:12px">
        No backups yet. Click "Run Backup Now" to create one.
      </div>`}

      <div class="bg" style="margin-bottom:16px">
        <button class="btn btn-primary" id="backup-run-btn" onclick="_runBackupNow()">Run Backup Now</button>
        <button class="btn btn-ghost btn-sm" onclick="_loadBackupStatus()">Refresh</button>
      </div>

      ${s.backups.length ? `
        <div class="card-title" style="margin-bottom:8px">Available Backups</div>
        <div class="tw"><table>
          <thead><tr><th>Date</th><th>Size</th><th></th></tr></thead>
          <tbody>${s.backups.map(b=>`<tr>
            <td style="font-size:13px">${b.date}</td>
            <td style="font-size:12px;color:var(--gray-5)">${fmtSize(b.size)}</td>
            <td><a class="btn btn-ghost btn-sm" href="/api/orgs/${API.orgId}/backup/download/${b.name}"
              download="${b.name}">&#8681; Download</a></td>
          </tr>`).join('')}</tbody>
        </table></div>` : ''}

      <hr class="divider">
      <div style="font-size:12px;color:var(--gray-5);line-height:1.8">
        <strong style="color:var(--gray-7)">Backup schedule:</strong><br>
        • Automatic backup runs every night at 2am<br>
        • Last 30 daily backups are kept on disk at <code>/data/backups/</code><br>
        • Download any backup to keep a local copy<br>
        <strong style="color:var(--gray-7);margin-top:6px;display:block">Optional off-site backup (recommended):</strong>
        Set these environment variables in Render to also upload backups to S3/Cloudflare R2:<br>
        <code>BACKUP_S3_BUCKET</code>, <code>BACKUP_S3_KEY</code>, <code>BACKUP_S3_SECRET</code>, <code>BACKUP_S3_ENDPOINT</code>
      </div>`;
  } catch(e) { c.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

async function _runBackupNow() {
  const btn = $('backup-run-btn');
  if (btn) { btn.textContent='Backing up…'; btn.disabled=true; }
  try {
    await API.post(`/api/orgs/${API.orgId}/backup/run`, {});
    toast('Backup created ✓');
    _loadBackupStatus();
  } catch(e) {
    toast(e.message||'Backup failed','err');
    if (btn) { btn.textContent='Run Backup Now'; btn.disabled=false; }
  }
}

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
async function _saveTz(){
  try {
    await API.put('/api/orgs/'+API.orgId+'/timezone',{timezone:val('tz-select')});
    window._orgTz = val('tz-select');
    toast('Timezone saved');
  } catch(e){toast(e.message||'Error','err');}
}
function _addHood(){Modal.open('Add Neighborhood',`<label>Hebrew Name</label><input id="nh-he" dir="rtl" style="font-family:var(--font-he)" placeholder="שם השכונה"><label>English (optional)</label><input id="nh-en"><div class="bg mt"><button class="btn btn-primary" onclick="API.post(API.o.hoods(),{name_he:val('nh-he'),name_en:val('nh-en')}).then(()=>{toast('Added');Modal.close();renderSettings($('page-settings'))}).catch(e=>toast(e.message||'Unknown error','err'))">Add</button><button class="btn btn-ghost" onclick="Modal.close()">Cancel</button></div>`,{sm:true});}

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


// ── Card type detection (Fix 21) ─────────────────────────────────────────────
DonorDetail._detectCardType = function(num) {
  const n = num.replace(/\D/g,'');
  let brand = '', icon = '';
  if (/^4/.test(n))                               { brand='Visa';       icon='VISA'; }
  else if (/^5[1-5]/.test(n)||/^2[2-7]/.test(n)) { brand='Mastercard'; icon='MC'; }
  else if (/^3[47]/.test(n))                      { brand='Amex';       icon='AMEX'; }
  else if (/^6011|^65|^64[4-9]|^622/.test(n))    { brand='Discover';   icon='DISC'; }
  const iconEl = $('pm-brand-icon');
  if (iconEl) iconEl.textContent = icon;
  const brandEl = $('pm-brand');
  if (brandEl) brandEl.value = brand;
};

// ── Calc next run from now for recurring resume (Fix 9, 10) ──────────────────
function _calcNextRunFromNow(sched) {
  const tz = window._orgTz || 'America/New_York';
  const now = new Date();
  // Use start_date as anchor to keep same day-of-month/week pattern
  let anchor = sched.start_date ? new Date(sched.start_date) : new Date();
  // Advance until anchor is in the future
  while (anchor <= now) {
    switch(sched.frequency) {
      case 'weekly':    anchor.setDate(anchor.getDate()+7); break;
      case 'biweekly':  anchor.setDate(anchor.getDate()+14); break;
      case 'monthly':   anchor.setMonth(anchor.getMonth()+1); break;
      case 'quarterly': anchor.setMonth(anchor.getMonth()+3); break;
      case 'yearly':    anchor.setFullYear(anchor.getFullYear()+1); break;
      default:          anchor.setMonth(anchor.getMonth()+1);
    }
  }
  return anchor.toISOString().slice(0,10);
}

// ── Charge recurring now (Fix 9) ─────────────────────────────────────────────
DonorDetail._chargeRecurringNow = async function(did, sid, pmId, amount) {
  if (!pmId || !amount) { toast('Missing payment method or amount','err'); return; }
  try {
    const r = await API.post(`/api/orgs/${API.orgId}/payments/charge`, {
      donor_id: did, payment_method_id: pmId, amount: parseFloat(amount),
      notes: 'Manual recurring charge (due today)'
    });
    toast(`Charged ${fmt$(amount)} · Trans: ${r.transaction_id}`);
    // Update next_run
    const sched = DonorDetail.data?.recurring?.find(s=>s.id===sid);
    if (sched) {
      const nextRun = _calcNextRunFromNow({...sched, start_date: new Date().toISOString()});
      await API.put(`/api/orgs/${API.orgId}/donors/${did}/recurring/${sid}`, {next_run: nextRun});
    }
    DonorDetail.open(did);
  } catch(e) { toast(e.message||'Charge failed','err'); }
};

// ── Add expense (Fix 23) ─────────────────────────────────────────────────────
function _addExpense() {
  Modal.open('Record Expense', `
    <label>Amount ($) *</label>
    <input type="number" id="exp-amt" step="0.01" placeholder="0.00">
    <label>Category</label>
    <select id="exp-cat">
      <option>Administrative</option><option>Facilities</option><option>Programs</option>
      <option>Salaries</option><option>Supplies</option><option>Other</option>
    </select>
    <label>Description</label>
    <input id="exp-desc" placeholder="Describe the expense" autocomplete="off">
    <label>Date</label>
    <input type="date" id="exp-date" value="${new Date().toISOString().slice(0,10)}">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_saveExpense()">Save</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}
async function _saveExpense() {
  const amt = parseFloat(val('exp-amt'));
  if (!amt||amt<=0) { toast('Amount required','err'); return; }
  try {
    await API.post(`/api/orgs/${API.orgId}/expenses`, {
      amount: amt, category: val('exp-cat'),
      description: val('exp-desc'), expense_date: val('exp-date')
    });
    toast('Expense recorded');
    Modal.close();
    navigateTo('dashboard');
  } catch(e) { toast(e.message||'Error','err'); }
}

// ── Unlinked donation (Fix 24) ────────────────────────────────────────────────
let _ulSelectedDonorId = null;

function _addRecurringFromList() {
  let selectedId = null;
  Modal.open('Set Up Recurring Donation', `
    <p style="font-size:13px;color:var(--gray-5);margin-bottom:10px">Search for an existing donor, or add a new one to set up a recurring charge.</p>
    <div style="position:relative">
      <label>Search Donor</label>
      <input id="arl-search" placeholder="Name, email, phone…" autocomplete="off" oninput="_arlSearch(this.value)">
      <div id="arl-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;
        border:1.5px solid var(--blue);border-top:none;border-radius:0 0 6px 6px;z-index:100;max-height:180px;overflow-y:auto;box-shadow:var(--shadow-md)"></div>
    </div>
    <div id="arl-selected" style="display:none;margin-top:8px" class="alert alert-ok"></div>
    <div class="bg mt">
      <button class="btn btn-primary" id="arl-go-btn" onclick="_arlGoToDonor()" disabled>Continue to Donor Profile</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>
    <hr class="divider">
    <p style="font-size:12px;color:var(--gray-5);margin-bottom:6px">Or create a new donor:</p>
    <button class="btn btn-outline btn-sm w-full" onclick="_arlNewDonor()">+ New Donor</button>
  `, {sm:true});
  window._arlSelectedId = null;
}
let _arlTimeout = null;
async function _arlSearch(q) {
  clearTimeout(_arlTimeout);
  const res = $('arl-results'); if(!res) return;
  if (!q.trim()) { res.style.display='none'; return; }
  _arlTimeout = setTimeout(async () => {
    try {
      const donors = await API.get(`/api/orgs/${API.orgId}/donors/search?q=${encodeURIComponent(q)}`);
      res.innerHTML = donors.length ? donors.map(d=>`<div onclick="_arlSelect('${d.id}','${d.first_name} ${d.last_name}')"
        style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--gray-1)"
        onmouseover="this.style.background='var(--blue-pale)'" onmouseout="this.style.background=''">
        <strong>${d.first_name} ${d.last_name}</strong>${d.email?`<span style="color:var(--gray-5);font-size:12px"> · ${d.email}</span>`:''}
      </div>`).join('') : '<div style="padding:8px 12px;font-size:13px;color:var(--gray-5)">No donors found — try "+ New Donor" below</div>';
      res.style.display = 'block';
    } catch{}
  }, 300);
}
function _arlSelect(id, name) {
  window._arlSelectedId = id;
  const inp=$('arl-search'); if(inp) inp.value=name;
  const res=$('arl-results'); if(res) res.style.display='none';
  const sel=$('arl-selected'); if(sel){ sel.textContent='✓ '+name; sel.style.display='block'; }
  const btn=$('arl-go-btn'); if(btn) btn.disabled=false;
}
function _arlGoToDonor() {
  if (!window._arlSelectedId) return;
  Modal.close();
  // Navigate to donors page then open the profile and trigger recurring setup
  navigateTo('donors');
  setTimeout(() => {
    DonorDetail.open(window._arlSelectedId);
    setTimeout(() => {
      const tab = document.querySelector('#modal-body .tab[data-tc="dd-rec"]');
      if (tab) tab.click();
      toast('Add a payment method first if none exist, then set up the recurring schedule.');
    }, 400);
  }, 150);
}
function _arlNewDonor() {
  Modal.close();
  navigateTo('donors');
  setTimeout(() => {
    Donors.openAdd();
    toast('Add the donor, then open their profile to set up recurring.');
  }, 150);
}

function _addUnlinkedDonation() {
  const now = toLocalDT(new Date().toISOString());
  _ulSelectedDonorId = null;
  Modal.open('Add Donation', `
    <div class="tabs"><div class="tab on" data-tc="ul-t-linked">Link to Donor</div><div class="tab" data-tc="ul-t-anon">No Donor</div></div>
    <div id="ul-t-linked" class="tc on">
      <div style="position:relative">
        <label>Search Donor</label>
        <input id="ul-donor-search" placeholder="Name, email, phone…" autocomplete="off" oninput="_ulSearchDonor(this.value)">
        <div id="ul-donor-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;
          border:1.5px solid var(--blue);border-top:none;border-radius:0 0 6px 6px;z-index:100;max-height:180px;overflow-y:auto;box-shadow:var(--shadow-md)"></div>
      </div>
      <div id="ul-donor-selected" style="display:none;margin-top:6px" class="alert alert-ok"></div>
      <div id="ul-pm-row" style="display:none;margin-top:8px">
        <label>Payment Method</label>
        <select id="ul-pm-sel"><option value="">— Loading… —</option></select>
        <p style="font-size:11px;color:var(--gray-5);margin-top:2px">Selecting a saved card or DAF will charge it via Sola instead of recording manually.</p>
      </div>
    </div>
    <div id="ul-t-anon" class="tc">
      <label>Name / Description (for records)</label>
      <input id="ul-name" placeholder="e.g. Anonymous, Walk-in donor" autocomplete="off">
    </div>
    <div class="r2 mt">
      <div><label>Amount ($) *</label><input type="number" id="ul-amt" step="0.01" placeholder="0.00"></div>
      <div><label>Method *</label>
        <select id="ul-meth" onchange="_ulMethodChange()">
          <option value="check">Check</option><option value="cash">Cash</option>
          <option value="daf">DAF</option><option value="wire">Wire</option><option value="other">Other</option>
        </select>
      </div>
    </div>
    <div id="ul-chk"><label>Check Number</label><input id="ul-chknum" autocomplete="off"></div>
    <div class="r2">
      <div><label>Date</label><input type="datetime-local" id="ul-date" value="${now}"></div>
      <div><label>Trans ID (auto if blank)</label><input id="ul-tx" autocomplete="off"></div>
    </div>
    <label>Label</label>
    <select id="ul-label-sel"><option value="">— Select label (optional) —</option></select>
    <label style="margin-top:8px">Notes</label>
    <input id="ul-extra-notes" autocomplete="off" placeholder="Additional notes (optional)…">
    <div class="trow" style="padding:8px 0;border-top:1px solid var(--gray-1)">
      <div style="font-size:13px">Send donation receipt email</div>
      <label class="tgl"><input type="checkbox" id="ul-send-receipt" checked><span class="tgl-s"></span></label>
    </div>
    <div class="bg mt">
      <button class="btn btn-primary" id="ul-save-btn" onclick="_saveUnlinkedDonation()">Record</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
  tabsInit('#modal-body');
  document.querySelectorAll('#modal-body .tab').forEach(t=>t.addEventListener('click',()=>{
    _ulSelectedDonorId=null; const sd=$('ul-donor-selected'); if(sd)sd.style.display='none';
    const pr=$('ul-pm-row'); if(pr)pr.style.display='none';
  }));
  // Populate label dropdown (preset only)
  API.get(`/api/orgs/${API.orgId}/label-lists`).then(lists => {
    const sel = $('ul-label-sel');
    if (sel && lists.donation_labels) lists.donation_labels.forEach(l => {
      const o=document.createElement('option'); o.value=l; o.textContent=l; sel.appendChild(o);
    });
  }).catch(()=>{});
}
function _ulMethodChange() {
  const m = val('ul-meth');
  const chk = $('ul-chk'); if(chk) chk.style.display = m==='check' ? '' : 'none';
}

let _ulSearchTimeout = null;
async function _ulSearchDonor(q) {
  clearTimeout(_ulSearchTimeout);
  const res = $('ul-donor-results'); if(!res)return;
  if (!q.trim()) { res.style.display='none'; return; }
  _ulSearchTimeout = setTimeout(async () => {
    try {
      const donors = await API.get(`/api/orgs/${API.orgId}/donors/search?q=${encodeURIComponent(q)}`);
      if (!donors.length) { res.innerHTML='<div style="padding:8px 12px;font-size:13px;color:var(--gray-5)">No donors found</div>'; res.style.display='block'; return; }
      res.innerHTML = donors.map(d=>`<div onclick="_ulSelectDonor('${d.id}','${d.first_name} ${d.last_name}')" style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--gray-1)" onmouseover="this.style.background='var(--blue-pale)'" onmouseout="this.style.background=''">
        <strong>${d.first_name} ${d.last_name}</strong>${d.email?`<span style="color:var(--gray-5);font-size:12px"> · ${d.email}</span>`:''}${d.cell?`<span style="color:var(--gray-5);font-size:12px"> · ${d.cell}</span>`:''}
      </div>`).join('');
      res.style.display = 'block';
    } catch{}
  }, 300);
}
async function _ulSelectDonor(id, name) {
  _ulSelectedDonorId = id;
  const inp=$('ul-donor-search'); if(inp)inp.value=name;
  const res=$('ul-donor-results'); if(res)res.style.display='none';
  const sel=$('ul-donor-selected'); if(sel){sel.textContent='✓ '+name; sel.style.display='block';}
  // Load this donor's CC/DAF payment methods so they can be charged directly
  const pmRow = $('ul-pm-row'), pmSel = $('ul-pm-sel');
  if (!pmRow || !pmSel) return;
  try {
    const data = await API.get(API.o.donor(id));
    const pms = (data.paymentMethods||[]).filter(p =>
      (p.type==='credit_card' && p.sola_token) ||
      (p.type==='daf' && (p.other_description||'').split('|')[0]));
    if (pms.length) {
      pmSel.innerHTML = '<option value="">— Record manually (no charge) —</option>' +
        pms.map(p => p.type==='credit_card'
          ? `<option value="cc|${p.id}">${p.card_brand||'Card'} ••${p.last_four||''} ${p.label?'('+p.label+')':''}</option>`
          : `<option value="daf|${p.id}">DAF: ${p.daf_name||''} ••${((p.other_description||'').split('|')[0]).slice(-4)}</option>`
        ).join('');
      pmRow.style.display = '';
    } else {
      pmSel.innerHTML = '<option value="">No saved cards or DAF on file</option>';
      pmRow.style.display = '';
    }
  } catch{}
}

async function _saveUnlinkedDonation() {
  const amt = parseFloat(val('ul-amt'));
  if (!amt || amt <= 0) { toast('Enter an amount', 'err'); return; }

  const btn = $('ul-save-btn');
  const label = val('ul-label-sel') || null;
  const pmChoice = (_ulSelectedDonorId && val('ul-pm-sel')) || '';

  // Path 1: charge a saved CC or DAF directly
  if (pmChoice) {
    const [type, pmId] = pmChoice.split('|');
    if (btn) { btn.textContent='Charging…'; btn.disabled=true; }
    try {
      let r;
      if (type==='daf') {
        r = await API.post(`/api/orgs/${API.orgId}/payments/charge-daf`, {donor_id:_ulSelectedDonorId, payment_method_id:pmId, amount:amt, notes:val('ul-extra-notes')||null});
      } else {
        r = await API.post(`/api/orgs/${API.orgId}/payments/charge`, {donor_id:_ulSelectedDonorId, payment_method_id:pmId, amount:amt, notes:val('ul-extra-notes')||null});
      }
      if (label && r.donation?.id) await API.put(`/api/orgs/${API.orgId}/donations/${r.donation.id}/label`, {label}).catch(()=>{});
      toast(`Charged ${fmt$(amt)} · ${r.transaction_id} ✓`);
      Modal.close(); renderDonations($('page-donations'));
    } catch(e) {
      if (btn) { btn.textContent='Record'; btn.disabled=false; }
      toast(e.message || 'Charge failed', 'err');
    }
    return;
  }

  // Path 2: manual record (check/cash/wire/other/daf-manual)
  const method = val('ul-meth');
  if (!method) { toast('Select a payment method', 'err'); return; }
  if (method === 'check' && !val('ul-chknum').trim()) { toast('Check number required', 'err'); return; }

  if (btn) { btn.textContent = 'Recording…'; btn.disabled = true; }
  try {
    let r;
    if (_ulSelectedDonorId) {
      r = await API.post(`/api/orgs/${API.orgId}/donors/${_ulSelectedDonorId}/donations`, {
        amount: amt, method,
        check_number: method === 'check' ? val('ul-chknum') : undefined,
        donation_date: val('ul-date') || new Date().toISOString(),
        transaction_id: val('ul-tx') || null,
        notes: val('ul-extra-notes') || null,
        send_receipt: $('ul-send-receipt')?.checked !== false
      });
    } else {
      r = await API.post(`/api/orgs/${API.orgId}/donations/unlinked`, {
        amount: amt, method,
        check_number: method === 'check' ? val('ul-chknum') : undefined,
        donor_name: val('ul-name') || 'Anonymous',
        donation_date: val('ul-date') || new Date().toISOString(),
        transaction_id: val('ul-tx') || null,
        notes: val('ul-extra-notes') || null
      });
    }
    if (label && r.donation?.id) await API.put(`/api/orgs/${API.orgId}/donations/${r.donation.id}/label`, {label}).catch(()=>{});
    toast('Donation recorded ✓');
    Modal.close();
    renderDonations($('page-donations'));
  } catch(e) {
    if (btn) { btn.textContent = 'Record'; btn.disabled = false; }
    toast(e.message || 'Failed to record donation', 'err');
  }
}

document.addEventListener('DOMContentLoaded', init);

// ══════════════════════════════════════════════════════════════════════════════
// WhatsApp Broadcasting
// ══════════════════════════════════════════════════════════════════════════════

async function renderWhatsApp(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const [settings, groups, broadcasts] = await Promise.all([
      API.get(`/api/orgs/${API.orgId}/whatsapp/settings`).catch(()=>({})),
      API.get(`/api/orgs/${API.orgId}/whatsapp/groups`).catch(()=>[]),
      API.get(`/api/orgs/${API.orgId}/whatsapp/broadcasts`).catch(()=>[])
    ]);
    const configured = !!(settings.account_sid && settings.from_number);

    el.innerHTML = `
      <div class="ph">
        <div><div class="ph-title">WhatsApp</div>
          <div class="ph-sub">Broadcast messages to your community via WhatsApp Business</div>
        </div>
        <div class="bg">
          ${configured ? `<button class="btn btn-primary btn-sm" onclick="_waNewBroadcast()">+ New Broadcast</button>` : ''}
        </div>
      </div>

      ${!configured ? `
        <div class="alert alert-warn" style="margin-bottom:16px">
          <strong>WhatsApp not configured yet.</strong> Enter your Twilio credentials below to get started.<br>
          <span style="font-size:12px">Sign up at <strong>twilio.com</strong> → get Account SID + Auth Token → enable WhatsApp Sandbox → paste below.</span>
        </div>` : ''}

      <div class="tabs">
        <div class="tab on" data-tc="wa-broadcasts">Broadcasts</div>
        <div class="tab" data-tc="wa-groups">Contact Groups</div>
        <div class="tab" data-tc="wa-settings">Settings</div>
      </div>

      <!-- Broadcasts -->
      <div id="wa-broadcasts" class="tc on">
        ${!configured ? `<div class="card"><div class="empty">Configure WhatsApp credentials in the Settings tab first.</div></div>` :
        !broadcasts.length ? `<div class="card" style="text-align:center;padding:48px">
          <div style="font-size:48px;margin-bottom:12px">💬</div>
          <h3 style="color:var(--navy)">No broadcasts yet</h3>
          <p style="color:var(--gray-5);margin-bottom:16px">Create a contact group, then send a mass WhatsApp message.</p>
          <button class="btn btn-primary" onclick="_waNewBroadcast()">+ Create First Broadcast</button>
        </div>` : `
        <div style="display:flex;flex-direction:column;gap:10px">
          ${broadcasts.map(b => `
            <div class="card" style="padding:14px 16px">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
                <div style="flex:1">
                  <div style="font-weight:700;font-size:14px;color:var(--navy)">${b.name||'Broadcast'}</div>
                  <div style="font-size:12px;color:var(--gray-5);margin-top:2px">${fmtDT(b.created_at)} · ${b.group_name||'No group'}</div>
                  <div style="font-size:13px;color:var(--gray-7);margin-top:6px;padding:8px 10px;background:var(--gray-05);border-radius:6px;white-space:pre-wrap">${b.message.slice(0,200)}${b.message.length>200?'…':''}</div>
                </div>
                <div style="flex-shrink:0;text-align:right">
                  ${b.status==='sent'?`<span class="pill pill-green">Sent</span>`:
                    b.status==='sending'?`<span class="pill pill-amber">Sending…</span>`:
                    b.status==='scheduled'?`<span class="pill pill-blue">Scheduled</span>`:
                    `<span class="pill pill-gray">Draft</span>`}
                  <div style="font-size:11px;color:var(--gray-5);margin-top:4px">
                    ${b.status==='sent'||b.status==='sending'?`✓ ${b.sent} sent · ✗ ${b.failed} failed · ${b.total} total`:`${b.total} contacts`}
                  </div>
                </div>
              </div>
              <div class="bg mt" style="justify-content:flex-end">
                ${b.status==='sent'||b.status==='sending'?`<button class="btn btn-ghost btn-sm" onclick="_waViewLog('${b.id}','${b.name||'Broadcast'}')">📋 Message Log</button>`:''}
                ${b.status==='draft'||b.status==='scheduled'?`
                  <button class="btn btn-primary btn-sm" onclick="_waSend('${b.id}','${b.total}')">▶ Send Now</button>
                  <button class="btn btn-ghost btn-sm" onclick="_waEditBroadcast('${b.id}')">Edit</button>
                  <button class="btn btn-icon" style="color:var(--red)" onclick="_waDeleteBroadcast('${b.id}')">✕</button>
                `:''}
              </div>
            </div>`).join('')}
        </div>`}
      </div>

      <!-- Groups -->
      <div id="wa-groups" class="tc">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Contact Groups</strong>
          <button class="btn btn-primary btn-sm" onclick="_waNewGroup()">+ New Group</button>
        </div>
        ${!groups.length ? `<div class="card"><div class="empty">No groups yet. Create a group, then add contacts or import from your donor list.</div></div>` :
        `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
          ${groups.map(g => `
            <div class="card">
              <div style="display:flex;justify-content:space-between;align-items:flex-start">
                <div>
                  <div style="font-weight:700;font-size:14px;color:var(--navy)">${g.name}</div>
                  ${g.description?`<div style="font-size:12px;color:var(--gray-5)">${g.description}</div>`:''}
                  <div style="font-size:13px;margin-top:6px"><strong>${g.contact_count||0}</strong> contacts</div>
                </div>
                <button class="btn btn-icon" style="color:var(--red)" onclick="_waDeleteGroup('${g.id}','${g.name}')">✕</button>
              </div>
              <div class="bg mt">
                <button class="btn btn-blue btn-sm" onclick="_waManageContacts('${g.id}','${g.name}')">Manage Contacts</button>
                <button class="btn btn-ghost btn-sm" onclick="_waImportDonors('${g.id}','${g.name}')">Import Donors</button>
                <button class="btn btn-ghost btn-sm" onclick="_waImportList('${g.id}','${g.name}')">Import List</button>
              </div>
            </div>`).join('')}
        </div>`}
      </div>

      <!-- Settings -->
      <div id="wa-settings" class="tc">
        <div class="card">
          <div id="wa-status" style="margin-bottom:12px">
            ${configured
              ? `<div class="alert alert-ok" style="font-size:12px">✓ Twilio configured · WhatsApp number: ${settings.from_number}</div>`
              : `<div class="alert alert-warn" style="font-size:12px">⚠ Not configured yet. Fill in your Twilio credentials below.</div>`}
          </div>
          <div class="card-title" style="margin-bottom:12px">Twilio / WhatsApp Credentials</div>
          <label>Account SID</label>
          <input id="wa-sid" value="${settings.account_sid||''}" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" autocomplete="off">
          <label style="margin-top:10px">Auth Token <span style="font-size:11px;color:var(--gray-5)">(leave blank to keep existing)</span></label>
          <input id="wa-token" type="password" placeholder="Your Twilio Auth Token" autocomplete="off">
          <label style="margin-top:10px">WhatsApp From Number</label>
          <input id="wa-from" value="${settings.from_number||''}" placeholder="whatsapp:+14155238886" autocomplete="off">
          <small style="font-size:11px;color:var(--gray-5)">Format: <code>whatsapp:+1XXXXXXXXXX</code>. Use the Twilio Sandbox number during testing, or your approved number in production.</small>
          <div class="bg mt">
            <button class="btn btn-primary" onclick="_waSaveSettings()">Save</button>
            <button class="btn btn-ghost btn-sm" onclick="_waTestConnection()">Test Connection</button>
          </div>
          <hr class="divider">
          <div style="font-size:12px;color:var(--gray-5);line-height:1.8">
            <strong style="color:var(--gray-7)">Quick setup guide:</strong><br>
            1. Sign up at <strong>twilio.com</strong> (free)<br>
            2. Console → Messaging → Try it out → Send a WhatsApp message → follow the sandbox join instructions<br>
            3. Copy <strong>Account SID</strong> and <strong>Auth Token</strong> from your Twilio Console home page<br>
            4. Use <code>whatsapp:+14155238886</code> as the From Number for the sandbox<br>
            5. Contacts must send <code>join [your-sandbox-word]</code> to the sandbox number before they can receive messages<br>
            <strong style="color:var(--gray-7);margin-top:8px;display:block">For production:</strong>
            Apply for a WhatsApp Business number in Twilio → use that number as the From Number → no sandbox join required.
          </div>
        </div>
      </div>`;

    tabsInit('#page-whatsapp');
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

// ── Settings ───────────────────────────────────────────────────────────────────
async function _waSaveSettings() {
  const btn = document.querySelector('#wa-settings .btn-primary');
  if (btn) { btn.textContent='Saving…'; btn.disabled=true; }
  try {
    await API.put(`/api/orgs/${API.orgId}/whatsapp/settings`, {
      account_sid: val('wa-sid').trim(),
      auth_token:  val('wa-token') || undefined,
      from_number: val('wa-from').trim()
    });
    toast('Settings saved ✓');
    renderWhatsApp($('page-whatsapp'));
  } catch(e) { toast(e.message||'Save failed','err'); }
  finally { if(btn){btn.textContent='Save';btn.disabled=false;} }
}

async function _waTestConnection() {
  const btn = document.querySelectorAll('#wa-settings .btn-ghost')[0];
  if (btn) { btn.textContent='Testing…'; btn.disabled=true; }
  try {
    const r = await API.post(`/api/orgs/${API.orgId}/whatsapp/settings/test`, {});
    toast(`✓ Connected! Account: ${r.account_name} (${r.status})`);
  } catch(e) { toast(e.message||'Connection failed','err'); }
  finally { if(btn){btn.textContent='Test Connection';btn.disabled=false;} }
}

// ── Groups ─────────────────────────────────────────────────────────────────────
function _waNewGroup() {
  Modal.open('New Contact Group', `
    <label>Group Name *</label>
    <input id="wag-name" placeholder="e.g. Shabbat Reminders, Boro Park Members…" autocomplete="off">
    <label style="margin-top:10px">Description (optional)</label>
    <input id="wag-desc" placeholder="What is this group for?" autocomplete="off">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_waCreateGroup()">Create Group</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _waCreateGroup() {
  const name = val('wag-name').trim();
  if (!name) { toast('Group name required','err'); return; }
  try {
    await API.post(`/api/orgs/${API.orgId}/whatsapp/groups`, { name, description: val('wag-desc') });
    toast('Group created ✓'); Modal.close(); renderWhatsApp($('page-whatsapp'));
  } catch(e) { toast(e.message,'err'); }
}

async function _waDeleteGroup(id, name) {
  confirmDlg(`Delete group "${name}" and all its contacts?`, async () => {
    await API.del(`/api/orgs/${API.orgId}/whatsapp/groups/${id}`);
    toast('Deleted'); renderWhatsApp($('page-whatsapp'));
  });
}

// ── Manage contacts ────────────────────────────────────────────────────────────
async function _waManageContacts(gid, gname) {
  const contacts = await API.get(`/api/orgs/${API.orgId}/whatsapp/groups/${gid}/contacts`);
  Modal.open(`Contacts — ${gname}`, `
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="wac-name" placeholder="Name *" style="flex:1" autocomplete="off">
      <input id="wac-phone" placeholder="Phone * (e.g. 9175551234)" style="flex:1" autocomplete="off">
      <button class="btn btn-blue btn-sm" onclick="_waAddContact('${gid}')">Add</button>
    </div>
    <div id="wac-list" style="max-height:340px;overflow-y:auto">
      ${contacts.length ? `
        <table width="100%" style="font-size:13px;border-collapse:collapse">
          <thead><tr><th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--gray-1)">Name</th><th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--gray-1)">Phone</th><th></th></tr></thead>
          <tbody>${contacts.map(c=>`<tr>
            <td style="padding:6px;border-bottom:1px solid var(--gray-1)">${c.name}</td>
            <td style="padding:6px;border-bottom:1px solid var(--gray-1);font-family:monospace;font-size:12px">${c.phone}</td>
            <td style="padding:6px;border-bottom:1px solid var(--gray-1)"><button class="btn btn-icon" style="color:var(--red)" onclick="_waRemoveContact('${gid}','${c.id}')">✕</button></td>
          </tr>`).join('')}</tbody>
        </table>` : '<p style="color:var(--gray-5);font-size:13px">No contacts yet. Add one above or import.</p>'}
    </div>
    <div class="bg mt">
      <button class="btn btn-ghost btn-sm" onclick="Modal.close();renderWhatsApp($('page-whatsapp'))">Done</button>
    </div>`, {lg:true});
  window._waCurrentGid = gid;
}

async function _waAddContact(gid) {
  const name = val('wac-name').trim(), phone = val('wac-phone').trim();
  if (!name||!phone) { toast('Name and phone required','err'); return; }
  try {
    await API.post(`/api/orgs/${API.orgId}/whatsapp/groups/${gid}/contacts`, {name, phone});
    toast('Contact added ✓');
    document.getElementById('wac-name').value=''; document.getElementById('wac-phone').value='';
    _waManageContacts(gid, '');
  } catch(e) { toast(e.message,'err'); }
}

async function _waRemoveContact(gid, cid) {
  await API.del(`/api/orgs/${API.orgId}/whatsapp/groups/${gid}/contacts/${cid}`);
  toast('Removed'); _waManageContacts(gid, '');
}

// ── Import from donor list ─────────────────────────────────────────────────────
async function _waImportDonors(gid, gname) {
  const nhs = await API.get(API.o.neighborhoods()).catch(()=>[]);
  const labelLists = await API.get(`/api/orgs/${API.orgId}/label-lists`).catch(()=>({donor_labels:[]}));
  Modal.open(`Import Donors → ${gname}`, `
    <p style="font-size:13px;color:var(--gray-5);margin-bottom:12px">Import donors who have a cell or home phone number.</p>
    <div class="tabs"><div class="tab on" data-tc="imp-all">All Donors</div><div class="tab" data-tc="imp-nh">By Neighborhood</div><div class="tab" data-tc="imp-lbl">By Label</div></div>
    <div id="imp-all" class="tc on" style="padding:12px 0">
      <p style="font-size:13px">Import ALL donors with a phone number into this group.</p>
      <button class="btn btn-primary" onclick="_waDoImportDonors('${gid}',{all_donors:true})">Import All</button>
    </div>
    <div id="imp-nh" class="tc" style="padding:12px 0">
      <label>Neighborhood</label>
      <select id="imp-nh-sel">
        <option value="">— Select neighborhood —</option>
        ${nhs.map(n=>`<option value="${n.id}">${n.name_he||n.name}</option>`).join('')}
      </select>
      <button class="btn btn-primary mt" onclick="_waDoImportDonors('${gid}',{neighborhood_id:val('imp-nh-sel')})">Import</button>
    </div>
    <div id="imp-lbl" class="tc" style="padding:12px 0">
      <label>Donor Label</label>
      <select id="imp-lbl-sel">
        <option value="">— Select label —</option>
        ${(labelLists.donor_labels||[]).map(l=>`<option value="${l}">${l}</option>`).join('')}
      </select>
      <button class="btn btn-primary mt" onclick="_waDoImportDonors('${gid}',{label:val('imp-lbl-sel')})">Import</button>
    </div>`, {sm:true});
  tabsInit('#modal-body');
}

async function _waDoImportDonors(gid, params) {
  try {
    const r = await API.post(`/api/orgs/${API.orgId}/whatsapp/groups/${gid}/import-donors`, params);
    toast(`✓ Imported ${r.added} contacts (${r.skipped} skipped — no phone)`);
    Modal.close(); renderWhatsApp($('page-whatsapp'));
  } catch(e) { toast(e.message,'err'); }
}

// ── Import from pasted/uploaded list ──────────────────────────────────────────
function _waImportList(gid, gname) {
  Modal.open(`Import List → ${gname}`, `
    <p style="font-size:13px;color:var(--gray-5);margin-bottom:10px">
      Paste or type contacts — one per line, format: <code>Name, Phone</code><br>
      Or upload a CSV with columns: Name, Phone
    </p>
    <div class="tabs"><div class="tab on" data-tc="il-paste">Paste</div><div class="tab" data-tc="il-csv">Upload CSV</div></div>
    <div id="il-paste" class="tc on" style="padding:10px 0">
      <textarea id="il-text" style="width:100%;min-height:160px;font-size:12px;font-family:monospace" placeholder="Moshe Cohen, +19175551234
Yaakov Levi, 3475559876
Rivka Goldberg, +1 212 555 0101"></textarea>
      <button class="btn btn-primary mt" onclick="_waPastedImport('${gid}')">Import</button>
    </div>
    <div id="il-csv" class="tc" style="padding:10px 0">
      <label>Upload CSV file</label>
      <input type="file" id="il-file" accept=".csv,.txt" style="margin-bottom:10px">
      <button class="btn btn-primary" onclick="_waCsvImport('${gid}')">Upload & Import</button>
    </div>`, {sm:true});
  tabsInit('#modal-body');
}

async function _waPastedImport(gid) {
  const lines = (val('il-text')||'').split('\n').map(l=>l.trim()).filter(Boolean);
  const contacts = lines.map(line => {
    const parts = line.split(/,\s*/);
    return { name: parts[0]?.trim(), phone: parts[1]?.trim() };
  }).filter(c=>c.name&&c.phone);
  if (!contacts.length) { toast('No valid contacts found. Format: Name, Phone','err'); return; }
  try {
    const r = await API.post(`/api/orgs/${API.orgId}/whatsapp/groups/${gid}/import-list`, {contacts});
    toast(`✓ Imported ${r.added} · ${r.skipped} skipped`);
    Modal.close(); renderWhatsApp($('page-whatsapp'));
  } catch(e) { toast(e.message,'err'); }
}

async function _waCsvImport(gid) {
  const file = document.getElementById('il-file')?.files?.[0];
  if (!file) { toast('Select a CSV file','err'); return; }
  const text = await file.text();
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  // Skip header if it contains "name" or "phone"
  const start = lines[0]?.toLowerCase().includes('name') ? 1 : 0;
  const contacts = lines.slice(start).map(line => {
    const parts = line.split(',').map(s=>s.replace(/^"|"$/g,'').trim());
    return { name: parts[0], phone: parts[1] };
  }).filter(c=>c.name&&c.phone);
  if (!contacts.length) { toast('No valid contacts found in CSV','err'); return; }
  try {
    const r = await API.post(`/api/orgs/${API.orgId}/whatsapp/groups/${gid}/import-list`, {contacts});
    toast(`✓ Imported ${r.added} from CSV · ${r.skipped} skipped`);
    Modal.close(); renderWhatsApp($('page-whatsapp'));
  } catch(e) { toast(e.message,'err'); }
}

// ── Broadcasts ─────────────────────────────────────────────────────────────────
async function _waNewBroadcast() {
  const groups = await API.get(`/api/orgs/${API.orgId}/whatsapp/groups`).catch(()=>[]);
  if (!groups.length) {
    toast('Create a contact group first','err'); return;
  }
  Modal.open('New Broadcast', `
    <label>Name (internal)</label>
    <input id="wab-name" placeholder="e.g. Shabbat Reminder June 21" autocomplete="off">
    <label style="margin-top:10px">Send To *</label>
    <select id="wab-group">
      ${groups.map(g=>`<option value="${g.id}">${g.name} (${g.contact_count||0} contacts)</option>`).join('')}
    </select>
    <label style="margin-top:10px">Message *</label>
    <textarea id="wab-msg" style="width:100%;min-height:120px" placeholder="Type your message here…\n\nTip: Keep it short, clear and friendly. WhatsApp messages work best under 300 characters."></textarea>
    <div id="wab-chars" style="font-size:11px;color:var(--gray-5);text-align:right;margin-top:2px">0 characters</div>
    <div class="trow mt" style="padding:8px 0;border-top:1px solid var(--gray-1)">
      <div style="font-size:13px">Schedule for later</div>
      <label class="tgl"><input type="checkbox" id="wab-sched-on" onchange="document.getElementById('wab-sched-row').style.display=this.checked?'':'none'"><span class="tgl-s"></span></label>
    </div>
    <div id="wab-sched-row" style="display:none">
      <label>Send At</label>
      <input type="datetime-local" id="wab-sched-dt" value="${toLocalDT(new Date().toISOString())}">
    </div>
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_waCreateBroadcast(false)">Save as Draft</button>
      <button class="btn btn-blue" onclick="_waCreateBroadcast(true)">Send Now</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
  document.getElementById('wab-msg')?.addEventListener('input', function(){
    const c=document.getElementById('wab-chars');
    if(c)c.textContent=this.value.length+' characters';
  });
}

async function _waCreateBroadcast(sendNow) {
  const msg = val('wab-msg').trim();
  if (!msg) { toast('Message required','err'); return; }
  const gid = val('wab-group');
  if (!gid) { toast('Select a group','err'); return; }
  const schedOn = document.getElementById('wab-sched-on')?.checked;
  const schedDt = schedOn ? val('wab-sched-dt') : null;
  try {
    const r = await API.post(`/api/orgs/${API.orgId}/whatsapp/broadcasts`, {
      name: val('wab-name')||null,
      message: msg, group_id: gid,
      scheduled_at: schedDt||null
    });
    if (sendNow && !schedOn) {
      toast('Sending…');
      Modal.close();
      await _waSend(r.broadcast.id, r.broadcast.total, true);
    } else {
      toast(schedOn?'Scheduled ✓':'Draft saved ✓');
      Modal.close(); renderWhatsApp($('page-whatsapp'));
    }
  } catch(e) { toast(e.message,'err'); }
}

async function _waSend(id, total, skipConfirm) {
  if (!skipConfirm) {
    confirmDlg(`Send this broadcast to ${total} contacts now?`, async()=>{
      await _waDoSend(id);
    });
  } else {
    await _waDoSend(id);
  }
}

async function _waDoSend(id) {
  try {
    const r = await API.post(`/api/orgs/${API.orgId}/whatsapp/broadcasts/${id}/send`, {});
    toast(`✓ Sending to ${r.total} contacts… Check the message log for delivery status.`);
    setTimeout(()=>renderWhatsApp($('page-whatsapp')), 1500);
  } catch(e) { toast(e.message||'Send failed','err'); }
}

async function _waDeleteBroadcast(id) {
  confirmDlg('Delete this broadcast draft?', async()=>{
    await API.del(`/api/orgs/${API.orgId}/whatsapp/broadcasts/${id}`);
    toast('Deleted'); renderWhatsApp($('page-whatsapp'));
  });
}

// ── Message log ────────────────────────────────────────────────────────────────
async function _waViewLog(bid, bname) {
  const msgs = await API.get(`/api/orgs/${API.orgId}/whatsapp/broadcasts/${bid}/messages`);
  const sent   = msgs.filter(m=>m.status==='sent').length;
  const failed = msgs.filter(m=>m.status==='failed').length;
  Modal.open(`Message Log — ${bname}`, `
    <div class="bg" style="margin-bottom:10px;font-size:13px">
      <span class="pill pill-green">✓ ${sent} sent</span>
      <span class="pill pill-red">✗ ${failed} failed</span>
      <span style="color:var(--gray-5)">${msgs.length} total</span>
    </div>
    <div style="max-height:420px;overflow-y:auto">
      <table width="100%" style="font-size:12px;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--gray-1)">Name</th>
          <th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--gray-1)">Phone</th>
          <th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--gray-1)">Status</th>
          <th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--gray-1)">Time</th>
        </tr></thead>
        <tbody>${msgs.map(m=>`<tr>
          <td style="padding:6px 8px;border-bottom:1px solid var(--gray-1)">${m.to_name||'—'}</td>
          <td style="padding:6px 8px;border-bottom:1px solid var(--gray-1);font-family:monospace">${m.to_number}</td>
          <td style="padding:6px 8px;border-bottom:1px solid var(--gray-1)">
            ${m.status==='sent'
              ? '<span class="pill pill-green" style="font-size:10px">✓ Sent</span>'
              : `<span class="pill pill-red" style="font-size:10px" title="${m.error||''}">✗ Failed</span>`}
          </td>
          <td style="padding:6px 8px;border-bottom:1px solid var(--gray-1);color:var(--gray-5)">${fmtDT(m.sent_at)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="bg mt"><button class="btn btn-ghost" onclick="Modal.close()">Close</button></div>`, {lg:true});
}

// ══════════════════════════════════════════════════════════════════════════════
// Data Recovery Page (super admin only)
// ══════════════════════════════════════════════════════════════════════════════

async function renderRecovery(el) {
  if (!DRM.user?.is_super_admin) {
    el.innerHTML = '<div class="alert alert-err">Super admin access required.</div>';
    return;
  }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const { files, data_dir } = await API.get('/api/recovery/files');
    el.innerHTML = `
      <div class="ph">
        <div><div class="ph-title">Data Recovery</div>
          <div class="ph-sub">Restore data from a corrupted database backup</div>
        </div>
      </div>
      ${!files.length ? `
        <div class="card">
          <div class="alert alert-warn">No corrupted backup files found in <code>${data_dir}</code>.<br>
          Recovery files are named <code>drm.db.corrupted.TIMESTAMP</code>.</div>
        </div>` : `
        <div class="card">
          <div class="card-title" style="margin-bottom:12px">Found ${files.length} backup file${files.length>1?'s':''}</div>
          ${files.map(f => `
            <div style="border:1px solid var(--gray-2);border-radius:8px;padding:14px 16px;margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
                <div>
                  <div style="font-family:monospace;font-size:13px;font-weight:600;color:var(--navy)">${f.name}</div>
                  <div style="font-size:12px;color:var(--gray-5);margin-top:2px">
                    Size: ${(f.size/1024).toFixed(1)} KB · Modified: ${fmtDT(f.mtime)}
                  </div>
                </div>
                <div class="bg">
                  <button class="btn btn-ghost btn-sm" onclick="_recoveryPreview('${f.name}')">Preview Contents</button>
                  <button class="btn btn-primary btn-sm" onclick="_recoveryImport('${f.name}')">Import All Data</button>
                </div>
              </div>
              <div id="preview-${f.name.replace(/\./g,'-')}" style="margin-top:10px;display:none"></div>
            </div>`).join('')}
        </div>`}
      <div class="card" style="margin-top:12px">
        <div style="font-size:12px;color:var(--gray-5);line-height:1.8">
          <strong style="color:var(--gray-7)">How recovery works:</strong><br>
          • Preview shows how many records are in each table of the backup file<br>
          • Import copies everything into your live database — existing records are kept, duplicates skipped<br>
          • Your current account and any data you've entered since recovery will be preserved<br>
          • After import, your donors, donations, settings and all data will be restored
        </div>
      </div>`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

async function _recoveryPreview(filename) {
  const safeId = filename.replace(/\./g,'-');
  const c = $('preview-'+safeId);
  if (!c) return;
  c.style.display = 'block';
  c.innerHTML = '<div class="spinner" style="margin:8px 0"></div>';
  try {
    const r = await API.get(`/api/recovery/preview/${encodeURIComponent(filename)}`);
    const rows = Object.entries(r.counts)
      .filter(([,n]) => n > 0 && n !== 'error')
      .map(([t,n]) => `<tr><td style="padding:4px 8px;font-size:13px">${t}</td><td style="padding:4px 8px;font-weight:700;color:var(--navy)">${n}</td></tr>`)
      .join('');
    c.innerHTML = `
      <div style="background:var(--gray-05);border-radius:6px;padding:10px 12px">
        <div style="font-size:12px;font-weight:600;color:var(--gray-7);margin-bottom:6px">Records found in backup:</div>
        <table style="border-collapse:collapse">
          <tbody>${rows || '<tr><td style="color:var(--gray-5);font-size:13px">No recoverable data found</td></tr>'}</tbody>
        </table>
      </div>`;
  } catch(e) { c.innerHTML = `<div class="alert alert-err" style="font-size:12px">${e.message}</div>`; }
}

async function _recoveryImport(filename) {
  confirmDlg(
    `Import all data from "${filename}" into the live database?\n\nThis will restore your donors, donations, settings and all other data. Existing records will be kept. This cannot be undone.`,
    async () => {
      const el = $('page-recovery');
      if (el) el.innerHTML = `
        <div class="card" style="text-align:center;padding:48px">
          <div class="spinner" style="margin:0 auto 16px"></div>
          <div style="font-size:16px;font-weight:600;color:var(--navy)">Importing data…</div>
          <div style="font-size:13px;color:var(--gray-5);margin-top:8px">This may take a moment. Do not close this page.</div>
        </div>`;
      try {
        const r = await API.post(`/api/recovery/import/${encodeURIComponent(filename)}`, {});
        const summary = Object.entries(r.results)
          .filter(([,n]) => n > 0)
          .map(([t,n]) => `<tr><td style="padding:4px 8px;font-size:13px">${t}</td><td style="padding:4px 8px;font-weight:700;color:var(--green)">${n} restored</td></tr>`)
          .join('');
        if (el) el.innerHTML = `
          <div class="ph"><div><div class="ph-title">Recovery Complete ✓</div></div></div>
          <div class="card">
            <div class="alert alert-ok" style="margin-bottom:16px">
              <strong>Data successfully restored!</strong> Your donors, donations and settings are back.
            </div>
            <table style="border-collapse:collapse;margin-bottom:16px">
              <tbody>${summary}</tbody>
            </table>
            <div class="bg">
              <button class="btn btn-primary" onclick="navigateTo('donors')">Go to Donors</button>
              <button class="btn btn-ghost" onclick="navigateTo('dashboard')">Dashboard</button>
            </div>
          </div>`;
      } catch(e) {
        if (el) el.innerHTML = `<div class="alert alert-err">Import failed: ${e.message}</div>`;
      }
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Unassigned Sola Vault Cards
// ══════════════════════════════════════════════════════════════════════════════

async function _loadUnassignedCards(el) {
  const pg = el || $('page-verification');
  if (!pg) return;
  // Remove existing wrap if present
  const old = pg.querySelector('#unassigned-cards-wrap');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'unassigned-cards-wrap';
  pg.appendChild(wrap);

  try {
    const r = await API.get(`/api/orgs/${API.orgId}/payments/vault/unassigned`);
    if (!r.unassigned?.length) {
      wrap.innerHTML = `<div class="alert alert-ok" style="margin-top:16px;font-size:12px">
        ✓ Sola vault checked — ${r.total_in_vault||0} card${r.total_in_vault!==1?'s':''} in vault, all assigned to donors.
      </div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="ph" style="margin-top:24px">
        <div>
          <div class="ph-title">Unassigned Cards in Sola Vault</div>
          <div class="ph-sub">${r.unassigned.length} card${r.unassigned.length>1?'s':''} found in Sola not linked to any donor · ${r.total_assigned} of ${r.total_in_vault} vault cards assigned</div>
        </div>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="tw"><table>
          <thead><tr>
            <th>Card</th><th>Name on Card</th><th>Expires</th><th>Added</th><th></th>
          </tr></thead>
          <tbody>${r.unassigned.map(c => `<tr>
            <td><strong>${c.card_type||'CC'}</strong>${c.last_four ? ` ••••${c.last_four}` : ''}</td>
            <td style="font-size:13px">${c.name||'—'}</td>
            <td style="font-size:12px;color:var(--gray-5)">${c.exp ? c.exp.replace(/(\d{2})(\d{2})/,'$1/$2') : '—'}</td>
            <td style="font-size:11px;color:var(--gray-5)">${c.created?fmtD(c.created):'—'}</td>
            <td><button class="btn btn-blue btn-sm"
              onclick='_assignVaultCard(${JSON.stringify(c)})'>Assign to Donor</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
  } catch(e) {
    wrap.innerHTML = `<div class="alert alert-warn" style="margin-top:16px;font-size:12px">
      ⚠ Could not check Sola vault: ${e.message}
      ${e.message?.includes('not configured') ? '<br>Set your Sola API key in Settings to enable vault card detection.' : ''}
    </div>`;
  }
}

function _assignVaultCard(card) {
  window._vcCard = card;
  window._vcDonorId = null;
  Modal.open(`Assign Card ••••${card.last_four||'?'} to Donor`, `
    <p style="font-size:13px;color:var(--gray-5);margin-bottom:10px">
      Search for the donor this <strong>${card.card_type||'Card'} ••••${card.last_four||'????'}</strong> belongs to.
    </p>
    <div style="position:relative">
      <input id="vc-search" placeholder="Search name, email, phone…" oninput="_vcSearch(this.value)" autocomplete="off">
      <div id="vc-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;
        border:1.5px solid var(--blue);border-top:none;border-radius:0 0 6px 6px;z-index:100;
        max-height:200px;overflow-y:auto;box-shadow:var(--shadow-md)"></div>
    </div>
    <div id="vc-selected" style="display:none;margin-top:8px" class="alert alert-ok"></div>
    <label style="margin-top:10px">Card Label</label>
    <input id="vc-label" value="${card.card_type||'Card'} ••••${card.last_four||''}" autocomplete="off">
    <div class="bg mt">
      <button class="btn btn-primary" id="vc-assign-btn" onclick="window._vcDoAssign()" disabled>Assign Card</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});

  window._vcDoAssign = async () => {
    if (!window._vcDonorId) { toast('Select a donor first','err'); return; }
    const btn = $('vc-assign-btn');
    if(btn){btn.textContent='Assigning…';btn.disabled=true;}
    try {
      await API.post(`/api/orgs/${API.orgId}/payments/vault/assign`, {
        token:     window._vcCard.token,
        donor_id:  window._vcDonorId,
        label:     val('vc-label') || null,
        card_type: window._vcCard.card_type,
        last_four: window._vcCard.last_four
      });
      toast('Card assigned to donor ✓');
      Modal.close();
      _loadUnassignedCards(); // refresh
    } catch(e) {
      toast(e.message,'err');
      if(btn){btn.textContent='Assign Card';btn.disabled=false;}
    }
  };
}

let _vcTimer;
async function _vcSearch(q) {
  clearTimeout(_vcTimer);
  const res=$('vc-results'); if(!res)return;
  if(!q.trim()){res.style.display='none';return;}
  _vcTimer = setTimeout(async()=>{
    try {
      const donors = await API.get(`/api/orgs/${API.orgId}/donors/search?q=${encodeURIComponent(q)}`);
      res.innerHTML = donors.length
        ? donors.map(d=>`<div onclick="_vcSelectDonor('${d.id}','${d.first_name} ${d.last_name}')"
            style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--gray-1)"
            onmouseover="this.style.background='var(--blue-pale)'" onmouseout="this.style.background=''">
            <strong>${d.first_name} ${d.last_name}</strong>
            ${d.email?`<span style="color:var(--gray-5);font-size:12px"> · ${d.email}</span>`:''}
            ${d.cell?`<span style="color:var(--gray-5);font-size:12px"> · ${d.cell}</span>`:''}
          </div>`).join('')
        : '<div style="padding:8px 12px;font-size:13px;color:var(--gray-5)">No donors found</div>';
      res.style.display='block';
    } catch{}
  }, 300);
}

function _vcSelectDonor(id, name) {
  window._vcDonorId = id;
  const inp=$('vc-search'); if(inp)inp.value=name;
  const res=$('vc-results'); if(res)res.style.display='none';
  const sel=$('vc-selected'); if(sel){sel.textContent='✓ '+name;sel.style.display='block';}
  const btn=$('vc-assign-btn'); if(btn)btn.disabled=false;
}

// ── Duplicate template ────────────────────────────────────────────────────────
async function _emailDuplicate(id, name) {
  try {
    const t = await API.get(`/api/orgs/${API.orgId}/email-templates/${id}`);
    await API.post(`/api/orgs/${API.orgId}/email-templates`, {
      name:    `${t.name} (copy)`,
      subject: t.subject,
      blocks:  t.blocks,
      description: t.description || ''
    });
    toast('Template duplicated ✓');
    renderEmails($('page-emails'));
  } catch(e) { toast(e.message||'Error','err'); }
}

// ── View raw HTML of a logged email ──────────────────────────────────────────
async function _emailLogViewHtml(id) {
  const row = (window._emailLogAll||[]).find(r=>r.id===id);
  const subject = row?.subject || 'Email HTML';
  try {
    const res = await fetch(`/api/orgs/${API.orgId}/email-log/${id}/body`, {
      credentials:'include', headers:{'x-org-id':API.orgId,'Authorization':'Bearer '+localStorage.getItem('drm_token')}
    });
    const html = await res.text();
    Modal.open(`HTML — ${subject}`, `
      <textarea style="width:100%;height:520px;font-size:11px;font-family:monospace;resize:vertical;
        border:1px solid var(--gray-2);border-radius:4px;padding:10px;line-height:1.5"
        readonly>${html.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
        <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText(document.querySelector('#modal-body textarea').value.replace(/&lt;/g,'<').replace(/&gt;/g,'>'));toast('Copied ✓')">Copy HTML</button>
        <button class="btn btn-ghost btn-sm" onclick="Modal.close()">Close</button>
      </div>`, {lg:true, tall:true});
  } catch(e) { toast('Could not load HTML','err'); }
}

// ── Schedule email from builder ───────────────────────────────────────────────
function _edScheduleModal() {
  const name    = val('ed-name')?.trim();
  const subject = val('ed-subject')?.trim();
  if (!name) { toast('Enter a template name first','err'); return; }
  if (!subject) { toast('Enter a subject first','err'); return; }
  const now = new Date(); now.setHours(now.getHours()+1);
  Modal.open('Schedule This Email', `
    <div style="margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;color:var(--gray-5);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Send To</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap" id="sched-recip-pills">
        <button type="button" class="btn btn-primary btn-sm" id="pill-all" onclick="_schedSetRecip('all')">All Donors</button>
        <button type="button" class="btn btn-ghost btn-sm" id="pill-label" onclick="_schedSetRecip('label')">By Label</button>
        <button type="button" class="btn btn-ghost btn-sm" id="pill-specific" onclick="_schedSetRecip('specific')">Specific Donors</button>
      </div>
      <input type="hidden" id="sched-recip-val" value="all">
    </div>
    <div id="sched-label-wrap" style="display:none;margin-bottom:10px">
      <select id="sched-label-sel" style="width:100%;padding:8px 10px;border:1.5px solid var(--gray-3);border-radius:6px">
        <option value="">Loading labels...</option>
      </select>
    </div>
    <div id="sched-specific-wrap" style="display:none;margin-bottom:10px">
      <input id="sched-donor-search" placeholder="Search donors…" oninput="_schedDonorSearch(this.value)"
        autocomplete="new-password"
        style="padding:8px 12px;border:1.5px solid var(--gray-3);border-radius:6px;width:100%;box-sizing:border-box;margin-bottom:6px">
      <div id="sched-donor-results" style="max-height:180px;overflow-y:auto;border:1.5px solid var(--gray-2);border-radius:6px"></div>
      <div id="sched-donor-selected" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;min-height:24px"></div>
    </div>
    <label>Send At</label>
    <input type="datetime-local" id="sched-at" value="${toLocalDT(now.toISOString())}" style="padding:8px 12px;border:1.5px solid var(--gray-3);border-radius:6px;width:100%;box-sizing:border-box">
    <div class="bg mt" style="padding-top:12px;border-top:1px solid var(--gray-1)">
      <button class="btn btn-primary" id="sched-btn" onclick="_edDoSchedule()">Save & Schedule</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});

  window._schedSelectedDonors = new Map();
  // Load labels
  API.get(`/api/orgs/${API.orgId}/label-lists`).then(ll => { const l = ll?.donor_labels || [];
    const sel = $('sched-label-sel');
    if (sel) sel.innerHTML = '<option value="">— Select label —</option>' + (l||[]).map(x=>`<option value="${x}">${x}</option>`).join('');
  }).catch(()=>{});
}

function _schedSetRecip(v) {
  $('sched-recip-val').value = v;
  ['all','label','specific'].forEach(p => {
    const btn = $('pill-'+p);
    if(btn) { btn.className = v===p ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'; }
  });
  $('sched-label-wrap').style.display    = v==='label'    ? '' : 'none';
  $('sched-specific-wrap').style.display = v==='specific' ? '' : 'none';
}
function _schedRecipChange() { _schedSetRecip(document.querySelector('input[name="sched-recip"]:checked')?.value||'all'); }

let _schedDonorTimer;
function _schedDonorSearch(q) {
  clearTimeout(_schedDonorTimer);
  if (!q.trim()) { const r=$('sched-donor-results'); if(r) r.innerHTML=''; return; }
  _schedDonorTimer = setTimeout(async () => {
    try {
      const res = await API.get(`/api/orgs/${API.orgId}/donors/search?q=${encodeURIComponent(q)}`);
      const r = $('sched-donor-results'); if (!r) return;
      r.innerHTML = (res||[]).map(d => `
        <label style="display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--gray-1)">
          <input type="checkbox" value="${d.id}" data-name="${d.first_name} ${d.last_name}"
            ${window._schedSelectedDonors?.has(d.id)?'checked':''}
            onchange="_schedToggleDonor('${d.id}','${d.first_name} ${d.last_name}',this.checked)">
          <span style="font-size:13px"><strong>${d.first_name} ${d.last_name}</strong>${d.email?` <span style="color:var(--gray-5);font-size:11px">${d.email}</span>`:''}</span>
        </label>`).join('') || '<div style="padding:8px;font-size:13px;color:var(--gray-5)">No donors found</div>';
    } catch {}
  }, 300);
}

function _schedToggleDonor(id, name, checked) {
  if (!window._schedSelectedDonors) window._schedSelectedDonors = new Map();
  if (checked) window._schedSelectedDonors.set(id, name);
  else window._schedSelectedDonors.delete(id);
  const sel = $('sched-donor-selected');
  if (sel) sel.innerHTML = [...window._schedSelectedDonors.entries()].map(([id,name]) =>
    `<span class="pill pill-blue" style="font-size:11px">${name}
      <span onclick="window._schedSelectedDonors.delete('${id}');document.querySelector('#sched-donor-results input[value=\'${id}\']')?.checked && (document.querySelector('#sched-donor-results input[value=\'${id}\']').checked=false);_schedToggleDonor('${id}','${name}',false)" style="cursor:pointer;margin-left:3px">×</span>
    </span>`).join('');
}

async function _edDoSchedule() {
  const btn = $('sched-btn');
  if(btn){btn.textContent='Saving…';btn.disabled=true;}
  try {
    // First save the template
    const savedId = await _edSave(true); // returns id
    if (!savedId) { toast('Save failed','err'); if(btn){btn.textContent='Save & Schedule';btn.disabled=false;} return; }
    // Then schedule it
    const subject = val('ed-subject')?.trim();
    const scheduledAt = val('sched-at');
    // Generate HTML from blocks
    const html = _edBlocksToHtml(window._edBlocks);
    await API.post(API.o.schedEmails(), {
      subject,
      html_body: html,
      template_id: savedId,
      scheduled_for: scheduledAt,
      recipient_group: 'all_donors'
    });
    toast('Saved & scheduled ✓');
    Modal.close();
    renderEmails($('page-emails'));
  } catch(e) {
    toast(e.message||'Schedule failed','err');
    if(btn){btn.textContent='Save & Schedule';btn.disabled=false;}
  }
}

function _edBlocksToHtml(blocks) {
  // Simple HTML generation from blocks for scheduling
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    ${(blocks||[]).map(b => {
      if (b.type==='header') return `<div style="background:${b.bg||'#1a3a6b'};color:${b.color||'#fff'};padding:${b.padding||'24px 32px'};text-align:${b.align||'center'};font-size:${b.size||24}px;font-weight:700">${b.text||''}</div>`;
      if (b.type==='text') return `<div style="padding:${b.padding||'12px 32px'};font-size:${b.size||15}px;color:${b.color||'#333'};text-align:${b.align||'left'};direction:${b.dir||'ltr'}">${b.text||''}</div>`;
      if (b.type==='divider') return `<div style="padding:${b.padding||'0 32px'}"><hr style="border:none;border-top:1px solid ${b.color||'#e5e7eb'}"></div>`;
      if (b.type==='spacer') return `<div style="height:${b.height||20}px"></div>`;
      if (b.type==='button') return `<div style="text-align:center;padding:${b.padding||'16px'}"><a href="${b.url||'#'}" style="background:${b.bg||'#1a3a6b'};color:${b.color||'#fff'};padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700">${b.text||'Click Here'}</a></div>`;
      if (b.type==='tax_footer') return `<div style="background:${b.bg||'#f9fafb'};padding:${b.padding||'16px 32px'};font-size:${b.size||12}px;color:${b.color||'#6b7280'};text-align:center">${b.text||''}</div>`;
      if (b.type==='donation_details') return `<div style="padding:${b.padding||'0 32px'}"><table width="100%" style="border-collapse:collapse"><tr style="background:${b.headerBg||'#f0f4ff'}"><th colspan="2" style="padding:10px;color:${b.headerColor||'#1a3a6b'};text-align:left">${b.title||'Donation Details'}</th></tr><tr><td style="padding:8px">Amount</td><td>{{amount}}</td></tr><tr><td style="padding:8px">Date</td><td>{{date}}</td></tr><tr><td style="padding:8px">Transaction ID</td><td>{{transaction_id}}</td></tr></table></div>`;
      return '';
    }).join('')}
  </div>`;
}

// ── HTML mode toggle in email builder ─────────────────────────────────────────
let _edHtmlMode = false;
function _edToggleHtml() {
  const canvas = $('ed-canvas');
  if (!canvas) return;
  _edHtmlMode = !_edHtmlMode;
  const btn = $('ed-html-btn');
  if (_edHtmlMode) {
    if(btn) { btn.textContent='◀ Back to Builder'; btn.style.background='var(--amber)'; btn.style.color='#fff'; btn.style.border='none'; }
    const html = _edBlocksToHtml(window._edBlocks||[]);
    canvas.innerHTML = `<div style="padding:16px">
      <div style="font-size:11px;color:var(--gray-5);margin-bottom:8px;line-height:1.5">
        ✏️ Edit raw HTML below. When you click <strong>Save</strong> the HTML will be saved as-is.
      </div>
      <textarea id="ed-html-raw" style="width:100%;height:520px;font-size:12px;font-family:monospace;
        border:1.5px solid var(--gray-3);border-radius:6px;padding:12px;resize:vertical;line-height:1.6;box-sizing:border-box
      " placeholder="Paste or write HTML here...">${html.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
    </div>`;
  } else {
    if(btn) { btn.textContent='‹/› HTML'; btn.style.background=''; btn.style.color=''; btn.style.border=''; }
    // When exiting HTML mode, if there was raw HTML, keep it in blocks
    _edRenderBlocks();
  }
}

// Patch window._edSave after page load to capture HTML mode saves
document.addEventListener('DOMContentLoaded', () => {}, false);
// Instead, intercept at call time by checking _edHtmlMode inside _edSave
// (added inline in _edSave function above via the returnId block)

// ── Mass label helpers ────────────────────────────────────────────────────────
function _bulkLabelSelect(label, btn) {
  $('bulk-label-val').value = label;
  $('bulk-label-custom').value = '';
  document.querySelectorAll('#bulk-label-pills .btn').forEach(b => b.className='btn btn-ghost btn-sm');
  btn.className = 'btn btn-primary btn-sm';
}

async function _bulkLabelApplyDonors() {
  const label = val('bulk-label-custom')?.trim() || val('bulk-label-val');
  if (!label) { toast('Select or enter a label','err'); return; }
  try {
    const ids = [...(Donors.selected || new Set())];
    if (!ids.length) { toast('No donors selected','err'); return; }
    // Apply label to each selected donor
    await Promise.all(ids.map(async id => {
      const donor = await API.get(`/api/orgs/${API.orgId}/donors/${id}`);
      const labels = jsonParse(donor.labels||'[]');
      if (!labels.includes(label)) {
        labels.push(label);
        await API.put(`/api/orgs/${API.orgId}/donors/${id}`, { labels });
      }
    }));
    toast(`Label "${label}" added to ${ids.length} donor(s) ✓`);
    Modal.close();
    Donors.load();
  } catch(e) { toast(e.message||'Error','err'); }
}

async function _donBulkLabel() {
  if(!window._donSelected?.size) return;
  const labels = await API.get(`/api/orgs/${API.orgId}/label-lists`);
  const donationLabels = (labels?.donation_labels || []);
  Modal.open(`Add Label to ${window._donSelected.size} Donation(s)`, `
    <div style="margin-bottom:10px">
      <div style="font-size:12px;color:var(--gray-5);margin-bottom:8px">Select a label to add to selected donations:</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px" id="bulk-label-pills">
        ${donationLabels.map(l=>`<button type="button" class="btn btn-ghost btn-sm"
          onclick="_bulkLabelSelect('${l.replace(/'/g,"\\\\'")}',this)">${l}</button>`).join('')}
      </div>
      <input id="bulk-label-custom" placeholder="Or type a new label…" autocomplete="new-password"
        style="padding:8px 12px;border:1.5px solid var(--gray-3);border-radius:6px;width:100%;box-sizing:border-box">
      <input type="hidden" id="bulk-label-val" value="">
    </div>
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_donBulkLabelApply()">Add Label</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _donBulkLabelApply() {
  const label = val('bulk-label-custom')?.trim() || val('bulk-label-val');
  if (!label) { toast('Select or enter a label','err'); return; }
  try {
    const ids = [...(window._donSelected || new Set())];
    await Promise.all(ids.map(id => API.put(`/api/orgs/${API.orgId}/donations/${id}/label`, { label })));
    toast(`Label "${label}" added to ${ids.length} donation(s) ✓`);
    Modal.close();
    _donClearSel();
    renderDonations($('page-donations'));
  } catch(e) { toast(e.message||'Error','err'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// LEADS PAGE
// ══════════════════════════════════════════════════════════════════════════════

let _leadsData = [], _leadStaff = [], _leadCategories = [];

async function renderLeads(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    [_leadStaff, _leadCategories] = await Promise.all([
      API.get(`/api/orgs/${API.orgId}/leads/staff/list`).catch(()=>[]),
      API.get(`/api/orgs/${API.orgId}/leads/categories/list`).catch(()=>[])
    ]);
    el.innerHTML = `
      <div class="ph">
        <div><div class="ph-title">Leads</div><div class="ph-sub" id="leads-count"></div></div>
        <div class="bg">
          <button class="btn btn-ghost btn-sm" onclick="_leadCategories_manage()">⚙ Categories</button>
          <button class="btn btn-ghost btn-sm" onclick="_showScheduledFollowups()">📅 Follow-up Schedule</button>
          <button class="btn btn-ghost btn-sm" id="leads-mass-btn" style="display:none" onclick="_leadsMassAction()">⚡ Mass Action</button>
          <button class="btn btn-primary btn-sm" onclick="_leadAdd()">+ Add Lead</button>
        </div>
      </div>
      <div class="card" style="padding:12px 14px;margin-bottom:12px">
        <div class="search-bar">
          <div class="sw" style="flex:2"><input id="leads-search" placeholder="Search name, email, phone…" oninput="_leadsFilter()" autocomplete="new-password"></div>
          <select id="leads-status" onchange="_leadsFilter()">
            <option value="">All Statuses</option>
            <option value="new">New</option>
            <option value="in_progress">In Progress</option>
            <option value="converted">Converted</option>
            <option value="lost">Lost</option>
          </select>
          <select id="leads-assigned" onchange="_leadsFilter()">
            <option value="">All Assignees</option>
            ${_leadStaff.map(s=>`<option value="${s.id}">${s.full_name}</option>`).join('')}
          </select>
          <select id="leads-category" onchange="_leadsFilter()">
            <option value="">All Categories</option>
            ${_leadCategories.map(c=>`<option value="${c.name}">${c.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="leads-list"></div>`;
    await _loadLeads();
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

async function _loadLeads() {
  const q = val('leads-search')||'';
  const status = val('leads-status')||'';
  const assigned = val('leads-assigned')||'';
  const category = val('leads-category')||'';
  const p = new URLSearchParams();
  if (q) p.set('q',q);
  if (status) p.set('status',status);
  if (assigned) p.set('assigned_to',assigned);
  if (category) p.set('category',category);

  try {
    _leadsData = await API.get(`/api/orgs/${API.orgId}/leads?${p}`);
    const cnt = $('leads-count'); if(cnt) cnt.textContent = `${_leadsData.length} lead${_leadsData.length!==1?'s':''}`;
    _renderLeadsList();
  } catch(e) { const l=$('leads-list'); if(l) l.innerHTML=`<div class="alert alert-err">${e.message}</div>`; }
}

function _leadsFilter() { clearTimeout(window._leadsSearchTimer); window._leadsSearchTimer = setTimeout(_loadLeads, 300); }

const statusColors = { new:'var(--blue)', in_progress:'var(--amber)', converted:'var(--green)', lost:'var(--gray-4)' };
const statusLabels = { new:'New', in_progress:'In Progress', converted:'Converted', lost:'Lost' };

function _renderLeadsList() {
  const list = $('leads-list'); if(!list) return;
  if (!_leadsData.length) { list.innerHTML = '<div class="card"><div class="empty"><h3>No leads found</h3></div></div>'; return; }
  list.innerHTML = `<div class="card" style="padding:0;overflow:hidden"><div class="tw"><table>
    <thead><tr>
      <th style="width:28px"><input type="checkbox" id="leads-sel-all" onchange="_leadsToggleAll(this.checked)"></th>
      <th>Name</th><th>Contact</th><th>Category</th><th>Assigned To</th>
      <th>Status</th><th>Follow-ups</th><th>Next Follow-up</th><th></th>
    </tr></thead>
    <tbody>${_leadsData.map(l => {
      const name = [l.title,l.first_name,l.last_name].filter(Boolean).join(' ') || '—';
      const cat = _leadCategories.find(c=>c.name===l.category);
      const nextFu = l.next_followup ? fmtD(l.next_followup) : '—';
      const isOverdue = l.next_followup && new Date(l.next_followup) < new Date();
      return `<tr>
        <td><input type="checkbox" value="${l.id}" onchange="_leadsToggleOne('${l.id}',this.checked)"></td>
        <td><div style="font-weight:600;font-size:13px">${name}</div>
          ${l.hebrew_full_name?`<div style="font-family:var(--font-he);font-size:11px;color:var(--gray-5)">${l.hebrew_full_name}</div>`:''}
        </td>
        <td style="font-size:12px">${l.cell||l.email||'—'}</td>
        <td>${cat?`<span class="pill" style="background:${cat.color}20;color:${cat.color};font-size:10px">${cat.name}</span>`:(l.category||'—')}</td>
        <td style="font-size:12px">${l.assigned_name||'<span style="color:var(--gray-4)">Unassigned</span>'}</td>
        <td><span class="pill" style="background:${statusColors[l.status]||'var(--gray-2)'}20;color:${statusColors[l.status]||'var(--gray-5)'};font-size:11px">${statusLabels[l.status]||l.status}</span></td>
        <td style="font-size:12px;text-align:center">${l.followup_count||0}</td>
        <td style="font-size:12px;${isOverdue?'color:var(--red);font-weight:700':'color:var(--gray-5)'}">${nextFu}${isOverdue?' ⚠':''}</td>
        <td><div class="actions">
          <button class="btn btn-blue btn-sm" onclick="_leadView('${l.id}')">View</button>
          <button class="btn btn-ghost btn-sm" onclick="_leadAddFollowup('${l.id}')">Follow Up</button>
          ${l.status!=='converted'?`<button class="btn btn-green btn-sm" onclick="_leadConvert('${l.id}')">Convert</button>`:'<span class="pill pill-green" style="font-size:10px">Converted</span>'}
        </div></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div></div>`;
}

function _leadAdd() {
  Modal.open('Add Lead', _leadForm(), {lg:true});
}

async function _leadView(id) {
  try {
    const lead = await API.get(`/api/orgs/${API.orgId}/leads/${id}`);
    const cat = _leadCategories.find(c=>c.name===lead.category);
    Modal.open(`Lead: ${[lead.title,lead.first_name,lead.last_name].filter(Boolean).join(' ')||'Unnamed'}`, `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--gray-5);text-transform:uppercase;margin-bottom:6px">Contact Info</div>
          ${lead.email?`<div style="font-size:13px;margin-bottom:4px">📧 ${lead.email}</div>`:''}
          ${lead.cell?`<div style="font-size:13px;margin-bottom:4px">📱 ${lead.cell}</div>`:''}
          ${lead.home_phone?`<div style="font-size:13px;margin-bottom:4px">☎ ${lead.home_phone}</div>`:''}
          ${lead.street?`<div style="font-size:12px;color:var(--gray-5)">${[lead.street,lead.apt,lead.city,lead.state,lead.zip].filter(Boolean).join(', ')}</div>`:''}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--gray-5);text-transform:uppercase;margin-bottom:6px">Details</div>
          <div style="font-size:13px;margin-bottom:4px">Assigned: <strong>${lead.assigned_name||'Unassigned'}</strong></div>
          <div style="font-size:13px;margin-bottom:4px">Status: <span class="pill" style="background:${statusColors[lead.status]}20;color:${statusColors[lead.status]};font-size:11px">${statusLabels[lead.status]||lead.status}</span></div>
          ${cat?`<div style="font-size:13px;margin-bottom:4px">Category: <span class="pill" style="background:${cat.color}20;color:${cat.color};font-size:11px">${cat.name}</span></div>`:''}
          ${lead.notes?`<div style="font-size:12px;color:var(--gray-6);margin-top:8px">${lead.notes}</div>`:''}
        </div>
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--gray-5);text-transform:uppercase;margin-bottom:8px">Follow-up History (${lead.followups?.length||0})</div>
      <div style="max-height:200px;overflow-y:auto;border:1px solid var(--gray-2);border-radius:6px;margin-bottom:14px">
        ${lead.followups?.length ? lead.followups.map(fu=>`
          <div style="padding:10px 14px;border-bottom:1px solid var(--gray-1)">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
              <strong style="font-size:12px">${fu.done_by_name||'Unknown'}</strong>
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:11px;color:var(--gray-5)">${fmtDT(fu.created_at)}</span>
                <button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 6px"
                  onclick="event.stopPropagation();_editFollowupDate('${fu.id}','${fu.next_followup_date||''}')">✏ Date</button>
              </div>
            </div>
            <div style="font-size:13px;margin-bottom:4px">${fu.notes}</div>
            ${fu.next_followup_date?`<div style="font-size:11px;color:var(--blue)">📅 Next follow-up: ${fmtD(fu.next_followup_date)}</div>`:'<div style="font-size:11px;color:var(--gray-4)">No follow-up date set</div>'}
          </div>`).join('') : '<div style="padding:14px;text-align:center;color:var(--gray-4);font-size:13px">No follow-ups yet</div>'}
      </div>
      <div class="bg">
        <button class="btn btn-primary btn-sm" onclick="_leadEdit('${id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="Modal.close();_leadAddFollowup('${id}')">+ Follow Up</button>
        ${lead.status!=='converted'?`<button class="btn btn-green btn-sm" onclick="Modal.close();_leadConvert('${id}')">Convert to Donor</button>`:''}
        <button class="btn btn-icon" style="color:var(--red)" onclick="confirmDlg('Delete this lead?',async()=>{await API.del('/api/orgs/'+API.orgId+'/leads/${id}');toast('Deleted');Modal.close();_loadLeads();})">&#10005;</button>
      </div>`, {lg:true});
  } catch(e) { toast(e.message,'err'); }
}

function _leadForm(lead={}) {
  const existingLabels = (() => { try { return JSON.parse(lead.labels||'[]'); } catch { return []; } })();
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label>Title</label><input id="lf-title" value="${lead.title||''}" autocomplete="new-password" placeholder="Mr. Mrs. Dr."></div>
      <div><label>Hebrew Title</label><input id="lf-htitle" value="${lead.hebrew_title||''}" autocomplete="new-password"></div>
      <div><label>First Name</label><input id="lf-first" value="${lead.first_name||''}" autocomplete="new-password"></div>
      <div><label>Last Name</label><input id="lf-last" value="${lead.last_name||''}" autocomplete="new-password"></div>
      <div style="grid-column:1/-1"><label>Hebrew Full Name</label>
        <input id="lf-hname" value="${lead.hebrew_full_name||''}" autocomplete="new-password" style="direction:rtl;font-family:var(--font-he)">
      </div>
      <div><label>Email</label><input id="lf-email" type="email" value="${lead.email||''}" autocomplete="new-password"></div>
      <div><label>Cell</label><input id="lf-cell" value="${lead.cell||''}" autocomplete="new-password"></div>
      <div><label>Home Phone</label><input id="lf-home" value="${lead.home_phone||''}" autocomplete="new-password"></div>
      <div><label>Street</label><input id="lf-street" value="${lead.street||''}" autocomplete="new-password"></div>
      <div><label>Apt</label><input id="lf-apt" value="${lead.apt||''}" autocomplete="new-password"></div>
      <div><label>City</label><input id="lf-city" value="${lead.city||''}" autocomplete="new-password"></div>
      <div><label>State</label><input id="lf-state" value="${lead.state||''}" autocomplete="new-password"></div>
      <div><label>Zip</label><input id="lf-zip" value="${lead.zip||''}" autocomplete="new-password"></div>
      <div><label>Category</label>
        <select id="lf-category">
          <option value="">No category</option>
          ${_leadCategories.map(c=>`<option value="${c.name}" ${lead.category===c.name?'selected':''}>${c.name}</option>`).join('')}
        </select>
      </div>
      <div><label>Status</label>
        <select id="lf-status">
          ${['new','in_progress','lost'].map(s=>`<option value="${s}" ${(lead.status||'new')===s?'selected':''}>${statusLabels[s]||s}</option>`).join('')}
        </select>
      </div>
      <div><label>Assign To</label>
        <select id="lf-assigned">
          <option value="">Unassigned</option>
          ${_leadStaff.map(s=>`<option value="${s.id}" ${lead.assigned_to===s.id?'selected':''}>${s.full_name}</option>`).join('')}
        </select>
      </div>
    </div>
    <label style="margin-top:10px">Labels</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px" id="lf-labels-chips">
      ${existingLabels.map(l=>`<span class="pill pill-blue" style="font-size:11px">${l}
        <span onclick="this.parentElement.remove();_lfUpdateLabels()" style="cursor:pointer;margin-left:3px">×</span>
      </span>`).join('')}
    </div>
    <div style="display:flex;gap:6px">
      <input id="lf-label-input" placeholder="Add label…" autocomplete="new-password" style="flex:1"
        onkeydown="if(event.key==='Enter'){event.preventDefault();_lfAddLabel()}">
      <button class="btn btn-ghost btn-sm" onclick="_lfAddLabel()">Add</button>
    </div>
    <input type="hidden" id="lf-labels-val" value="${lead.labels||'[]'}">
    <label style="margin-top:10px">Notes</label>
    <textarea id="lf-notes" style="min-height:80px">${lead.notes||''}</textarea>
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_leadSave('${lead.id||''}')">Save Lead</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`;
}

async function _leadSave(id='') {
  const data = {
    title: val('lf-title'), first_name: val('lf-first'), last_name: val('lf-last'),
    hebrew_title: val('lf-htitle'), hebrew_full_name: val('lf-hname'),
    email: val('lf-email'), cell: val('lf-cell'), home_phone: val('lf-home'),
    street: val('lf-street'), apt: val('lf-apt'), city: val('lf-city'),
    state: val('lf-state'), zip: val('lf-zip'),
    labels: (() => { try { return JSON.parse(val('lf-labels-val')||'[]'); } catch { return []; } })(),
    category: val('lf-category'), status: val('lf-status'),
    assigned_to: val('lf-assigned')||null, notes: val('lf-notes')
  };
  try {
    if (id) await API.put(`/api/orgs/${API.orgId}/leads/${id}`, data);
    else await API.post(`/api/orgs/${API.orgId}/leads`, data);
    toast('Lead saved ✓'); Modal.close(); _loadLeads();
  } catch(e) { toast(e.message||'Error','err'); }
}

async function _leadEdit(id) {
  try {
    const lead = await API.get(`/api/orgs/${API.orgId}/leads/${id}`);
    Modal.open('Edit Lead', _leadForm(lead), {lg:true});
  } catch(e) { toast(e.message,'err'); }
}

function _leadAddFollowup(leadId) {
  Modal.open('Add Follow-Up', `
    <div style="font-size:13px;color:var(--gray-5);margin-bottom:12px">
      Your name will be auto-signed on this follow-up.
    </div>
    <label>Notes <span style="color:var(--red)">*</span></label>
    <textarea id="fu-notes" placeholder="How did the call go? What was discussed?" style="min-height:100px"></textarea>
    <label style="margin-top:10px">Next Follow-up Date</label>
    <input type="date" id="fu-date" value="${new Date(Date.now()+7*86400000).toISOString().slice(0,10)}">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_leadSaveFollowup('${leadId}')">Save Follow-up</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _leadSaveFollowup(leadId) {
  const notes = val('fu-notes')?.trim();
  if (!notes) { toast('Notes required','err'); return; }
  try {
    await API.post(`/api/orgs/${API.orgId}/leads/${leadId}/followup`, {
      notes, next_followup_date: val('fu-date')||null
    });
    toast('Follow-up saved ✓'); Modal.close(); _loadLeads();
  } catch(e) { toast(e.message||'Error','err'); }
}

async function _leadConvert(id) {
  confirmDlg('Convert this lead to a donor? They will appear in the Donors page.', async () => {
    try {
      const r = await API.post(`/api/orgs/${API.orgId}/leads/${id}/convert`, {});
      toast('Lead converted to donor ✓');
      _loadLeads();
      // Optionally navigate to the new donor
      if (r.donor_id) { navigateTo('donors'); }
    } catch(e) { toast(e.message||'Error','err'); }
  });
}

function _leadCategories_manage() {
  function refresh() {
    const body = $('cat-modal-body');
    if(body) body.innerHTML = renderCats() + '<hr class="divider">' + addCatForm();
  }
  const renderCats = () => `
    <div id="cat-list" style="margin-bottom:4px">
      ${_leadCategories.length ? _leadCategories.map(c=>`
        <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--gray-1)" id="cat-row-${c.id}">
          <input type="color" value="${c.color}" style="width:32px;height:32px;padding:2px;border-radius:4px;border:1px solid var(--gray-2);cursor:pointer;flex-shrink:0"
            onchange="document.getElementById('cat-name-${c.id}').dataset.color=this.value">
          <input id="cat-name-${c.id}" value="${c.name}" data-color="${c.color}" data-id="${c.id}"
            style="flex:1;font-size:13px;padding:6px 8px;border:1px solid var(--gray-2);border-radius:4px" autocomplete="new-password">
          <button class="btn btn-primary btn-sm" onclick="
            const inp=document.getElementById('cat-name-${c.id}');
            const col=inp.previousElementSibling.value;
            API.put('/api/orgs/'+API.orgId+'/leads/categories/${c.id}',{name:inp.value.trim(),color:col})
              .then(()=>{
                const idx=_leadCategories.findIndex(x=>x.id==='${c.id}');
                if(idx>=0){_leadCategories[idx].name=inp.value.trim();_leadCategories[idx].color=col;}
                toast('Saved');
              }).catch(e=>toast(e.message,'err'))
          ">Save</button>
          <button class="btn btn-icon" style="color:var(--red)" onclick="
            API.del('/api/orgs/'+API.orgId+'/leads/categories/${c.id}')
              .then(()=>{_leadCategories=_leadCategories.filter(x=>x.id!='${c.id}');refresh();})
              .catch(e=>toast(e.message,'err'))
          ">✕</button>
        </div>`).join('') : '<div style="font-size:13px;color:var(--gray-4);text-align:center;padding:12px">No categories yet</div>'}
    </div>`;
  const addCatForm = () => `
    <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px">
      <div style="flex:1"><label>New Category Name</label><input id="cat-name" autocomplete="new-password" placeholder="e.g. Hot Lead"></div>
      <div><label>Color</label><input type="color" id="cat-color" value="#6366f1" style="width:48px;height:38px;padding:2px;border-radius:4px;border:1px solid var(--gray-2)"></div>
      <button class="btn btn-primary" style="align-self:flex-end" onclick="
        const n=val('cat-name')?.trim(),c=val('cat-color');
        if(!n){toast('Enter a name','err');return;}
        API.post('/api/orgs/'+API.orgId+'/leads/categories/list',{name:n,color:c})
          .then(r=>{_leadCategories.push(r.category);toast('Added ✓');refresh();})
          .catch(e=>toast(e.message,'err'))
      ">+ Add</button>
    </div>`;
  Modal.open('Lead Categories', `<div id="cat-modal-body">${renderCats()}<hr class="divider">${addCatForm()}</div>`, {sm:true});
}

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════════
let _notifOpen = false;

async function _loadNotifications() {
  try {
    const notifs = await API.get(`/api/orgs/${API.orgId}/notifications`);
    const unread = notifs.filter(n=>!n.is_read).length;
    const badge = $('notif-badge'), count = $('notif-count');
    if (badge) badge.style.display = unread > 0 ? '' : 'none';
    if (count) count.textContent = unread;
    const list = $('notif-list');
    if (list) {
      list.innerHTML = notifs.length ? notifs.map(n=>`
        <div onclick="_notifClick('${n.id}','${n.link||''}')"
          style="padding:8px 10px;border-radius:6px;cursor:pointer;margin-bottom:4px;
          background:${n.is_read?'transparent':'var(--blue-pale)'};border:1px solid ${n.is_read?'transparent':'var(--blue-light)'}">
          <div style="font-size:12px;font-weight:${n.is_read?'400':'700'}">${n.title}</div>
          ${n.body?`<div style="font-size:11px;color:var(--gray-5);margin-top:2px">${n.body}</div>`:''}
          <div style="font-size:10px;color:var(--gray-4);margin-top:2px">${fmtDT(n.created_at)}</div>
        </div>`).join('')
        : '<div style="text-align:center;color:var(--gray-4);font-size:13px;padding:12px">No notifications</div>';
    }
  } catch {}
}

function _toggleNotifications() {
  _notifOpen = !_notifOpen;
  const panel = $('notif-panel');
  if (panel) panel.style.display = _notifOpen ? '' : 'none';
  if (_notifOpen) _loadNotifications();
}

async function _notifClick(id, link) {
  await API.put(`/api/orgs/${API.orgId}/notifications/${id}/read`, {}).catch(()=>{});
  if (link && link.startsWith('#')) navigateTo(link.replace('#',''));
  _loadNotifications();
  _toggleNotifications();
}

async function _markAllNotifRead() {
  await API.put(`/api/orgs/${API.orgId}/notifications/read-all`, {}).catch(()=>{});
  _loadNotifications();
}

// ══════════════════════════════════════════════════════════════════════════════
// SUPER ADMIN ORG ACCESS
// ══════════════════════════════════════════════════════════════════════════════
async function _superAdminAccessOrg(orgId, orgName) {
  Modal.open(`Request Access: ${orgName}`, `
    <div class="alert alert-info" style="margin-bottom:14px;font-size:13px">
      An access request will be sent to the org admin. They must approve it before you can view sensitive data.
      You can edit account info and sub-users without approval.
    </div>
    <label>Reason for access <span style="color:var(--red)">*</span></label>
    <input id="sa-reason" placeholder="e.g. Technical support, donor data check…" autocomplete="new-password">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_superAdminRequestAccess('${orgId}','${orgName.replace(/'/g,"\\'")}')">Send Request</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _superAdminRequestAccess(orgId, orgName) {
  const reason = val('sa-reason')?.trim();
  if (!reason) { toast('Enter a reason','err'); return; }
  try {
    await API.post('/api/auth/super-admin/request-access', { org_id: orgId, purpose: reason });
    Modal.close();
    toast(`Access request sent to ${orgName} admin. You'll be notified when approved.`);
  } catch(e) { toast(e.message||'Error','err'); }
}

async function _superAdminUseApprovedAccess(requestId, orgName) {
  try {
    const r = await API.get(`/api/auth/access-requests/${requestId}/token`);
    if (!localStorage.getItem('drm_token_original')) {
      localStorage.setItem('drm_token_original', localStorage.getItem('drm_token'));
    }
    localStorage.setItem('drm_token', r.token);
    Modal.close();
    toast(`Switching to ${orgName}…`);
    window.location.reload();
  } catch(e) { toast(e.message||'Error','err'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT HISTORY (in Settings)
// ══════════════════════════════════════════════════════════════════════════════
async function _loadImportHistory() {
  const wrap = $('st-imports-card'); if(!wrap) return;
  wrap.innerHTML = '<div class="spinner"></div>';
  try {
    const imports = await API.get(`/api/orgs/${API.orgId}/imports`);
    if (!imports.length) {
      wrap.innerHTML = '<div class="empty"><p>No imports yet. Use the Import button on the Donors page to upload an Excel file.</p></div>';
      return;
    }
    // Render each import as an expandable batch card, sorted newest first
    wrap.innerHTML = imports.map((i,idx) => `
      <div style="border:1px solid var(--gray-2);border-radius:8px;margin-bottom:10px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:${i.status==='deleted'?'var(--gray-05)':'#fff'};cursor:pointer"
          onclick="_toggleImportBatch('${i.id}')">
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <strong style="font-size:13px">${i.filename||'Upload'}</strong>
              <span class="pill" style="font-size:10px;background:${i.status==='deleted'?'#fee2e2':'#dcfce7'};color:${i.status==='deleted'?'var(--red)':'var(--green)'}">${i.status}</span>
              ${i.flagged?`<span class="pill" style="font-size:10px;background:#fef3c7;color:#b45309">${i.flagged} duplicates flagged</span>`:''}
            </div>
            <div style="font-size:11px;color:var(--gray-5);margin-top:3px">
              ${fmtDT(i.created_at)} · by ${i.imported_by_name||'Unknown'} · <strong>${i.imported}</strong> donors imported
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${DRM.user?.is_super_admin && i.status!=='deleted' ? `
              <button class="btn btn-icon" style="color:var(--red)" title="Delete this entire import batch"
                onclick="event.stopPropagation();_deleteImport('${i.id}')">🗑</button>` : ''}
            <span id="imp-arrow-${i.id}" style="color:var(--gray-4);font-size:12px;transition:transform .2s">▼</span>
          </div>
        </div>
        <div id="imp-batch-${i.id}" style="display:none;border-top:1px solid var(--gray-1)">
          <div class="spinner" style="padding:16px"></div>
        </div>
      </div>`).join('');
  } catch(e) { wrap.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

async function _toggleImportBatch(id) {
  const batch = $('imp-batch-'+id);
  const arrow = $('imp-arrow-'+id);
  if (!batch) return;
  const isOpen = batch.style.display !== 'none';
  batch.style.display = isOpen ? 'none' : '';
  if (arrow) arrow.style.transform = isOpen ? '' : 'rotate(180deg)';
  if (!isOpen && batch.querySelector('.spinner')) {
    // Load donors in this batch
    try {
      const imp = await API.get(`/api/orgs/${API.orgId}/imports/${id}`);
      batch.innerHTML = `
        <div style="padding:10px 16px;font-size:12px;color:var(--gray-5);border-bottom:1px solid var(--gray-1)">
          ${imp.items?.length||0} donors in this batch
          ${imp.items?.some(x=>x.was_flagged) ? ' · <span style="color:var(--amber)">⚠ Some flagged as duplicates</span>' : ''}
        </div>
        <div style="max-height:320px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="background:var(--gray-05)">
              <th style="padding:6px 12px;text-align:left">Name</th>
              <th style="padding:6px 12px;text-align:left">Email</th>
              <th style="padding:6px 12px;text-align:left">Cell</th>
              <th style="padding:6px 12px;text-align:left">Added</th>
              <th style="padding:6px 12px;text-align:left">Flag</th>
            </tr></thead>
            <tbody>
              ${(imp.items||[]).map(item=>`<tr style="border-bottom:1px solid var(--gray-1)">
                <td style="padding:6px 12px">${item.first_name||''} ${item.last_name||''}</td>
                <td style="padding:6px 12px;color:var(--gray-5)">${item.email||'—'}</td>
                <td style="padding:6px 12px;color:var(--gray-5)">${item.cell||'—'}</td>
                <td style="padding:6px 12px;color:var(--gray-5)">${item.donor_created?fmtD(item.donor_created):'—'}</td>
                <td style="padding:6px 12px">${item.was_flagged?`<span class="pill" style="font-size:10px;background:#fef3c7;color:#b45309">${item.flag_reasons||'duplicate'}</span>`:'—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch(e) {
      batch.innerHTML = `<div class="alert alert-err" style="margin:12px">${e.message}</div>`;
    }
  }
}

async function _viewImport(id) {
  try {
    const imp = await API.get(`/api/orgs/${API.orgId}/imports/${id}`);
    Modal.open(`Import: ${imp.filename||id}`, `
      <div style="font-size:12px;color:var(--gray-5);margin-bottom:10px">
        ${imp.imported} donors imported · ${imp.flagged||0} flagged · ${fmtDT(imp.created_at)}
      </div>
      <div class="tw" style="max-height:400px;overflow-y:auto"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Flagged</th></tr></thead>
        <tbody>${(imp.items||[]).map(item=>`<tr>
          <td style="font-size:13px">${item.first_name||''} ${item.last_name||''}</td>
          <td style="font-size:12px">${item.email||'—'}</td>
          <td>${item.was_flagged?`<span class="pill pill-amber" style="font-size:10px">${item.flag_reasons||'duplicate'}</span>`:'—'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="bg mt"><button class="btn btn-ghost" onclick="Modal.close()">Close</button></div>`, {lg:true});
  } catch(e) { toast(e.message,'err'); }
}

async function _deleteImport(id) {
  confirmDlg('Delete this import? Donors created by this import (with no donations) will be permanently deleted. Donors with donations will be kept.', async () => {
    try {
      const r = await API.del(`/api/orgs/${API.orgId}/imports/${id}`);
      toast(`Deleted ${r.deleted} donors. ${r.skipped} skipped (had donations).`);
      _loadImportHistory();
    } catch(e) { toast(e.message,'err'); }
  });
}

// ── All Orgs page (super admin) ───────────────────────────────────────────────
async function _loadAllOrgs() {
  const wrap = $('st-all-orgs-card'); if(!wrap) return;
  wrap.innerHTML = '<div class="spinner"></div>';
  try {
    const orgs = await API.get('/api/auth/orgs');
    wrap.innerHTML = `
      <div class="card-title" style="margin-bottom:12px">All Organisations (${orgs.length})</div>
      <div class="tw"><table>
        <thead><tr><th>Name</th><th>Slug</th><th>Expires</th><th>Donors</th><th></th></tr></thead>
        <tbody>${orgs.map(o=>`<tr>
          <td><strong style="font-size:13px">${o.name}</strong></td>
          <td style="font-size:11px;font-family:monospace;color:var(--gray-5)">${o.slug}</td>
          <td style="font-size:12px;color:${o.expires_at&&new Date(o.expires_at)<new Date()?'var(--red)':'var(--gray-5)'}">${o.expires_at?fmtD(o.expires_at):'No expiry'}</td>
          <td style="font-size:12px">${o.donor_count||'—'}</td>
          <td>
            <button class="btn btn-blue btn-sm" onclick="_superAdminAccessOrg('${o.id}','${o.name.replace(/'/g,"\\\\'")}')">
              Access →
            </button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  } catch(e) { wrap.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

// ── Access requests for org admins ────────────────────────────────────────────
async function _checkAccessRequests() {
  try {
    const requests = await API.get('/api/auth/access-requests');
    if (!requests.length) return;
    // Show banner at top of settings page
    const settings = $('page-settings');
    if (!settings) return;
    const existing = $('access-req-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = 'access-req-banner';
    banner.innerHTML = `
      <div class="alert alert-warn" style="margin-bottom:12px">
        <strong>⚠ ${requests.length} pending super admin access request${requests.length>1?'s':''}</strong>
        ${requests.map(r=>`
          <div style="margin-top:8px;padding:8px 10px;background:#fff;border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <div>
              <div style="font-size:13px;font-weight:600">${r.super_admin_name||'Super Admin'} wants access</div>
              <div style="font-size:12px;color:var(--gray-5)">Reason: ${r.purpose}</div>
              <div style="font-size:11px;color:var(--gray-4)">${fmtDT(r.created_at)}</div>
            </div>
            <div class="bg">
              <button class="btn btn-green btn-sm" onclick="_respondAccessRequest('${r.id}','approve')">✓ Approve</button>
              <button class="btn btn-ghost btn-sm" onclick="_respondAccessRequest('${r.id}','deny')">✕ Deny</button>
            </div>
          </div>`).join('')}
      </div>`;
    settings.insertBefore(banner, settings.firstChild);
  } catch {}
}

async function _respondAccessRequest(requestId, action) {
  try {
    await API.post(`/api/auth/access-requests/${requestId}/respond`, { action });
    toast(action === 'approve' ? 'Access approved ✓' : 'Access denied');
    _checkAccessRequests();
    _loadNotifications();
  } catch(e) { toast(e.message,'err'); }
}

// ── Lead label helpers ────────────────────────────────────────────────────────
function _lfAddLabel() {
  const inp = $('lf-label-input');
  const val2 = inp?.value?.trim();
  if (!val2) return;
  // Add chip
  const chips = $('lf-labels-chips');
  if (chips) {
    const chip = document.createElement('span');
    chip.className = 'pill pill-blue';
    chip.style.fontSize = '11px';
    chip.innerHTML = `${val2} <span onclick="this.parentElement.remove();_lfUpdateLabels()" style="cursor:pointer;margin-left:3px">×</span>`;
    chips.appendChild(chip);
  }
  inp.value = '';
  _lfUpdateLabels();
}

function _lfUpdateLabels() {
  const chips = $('lf-labels-chips');
  const valInput = $('lf-labels-val');
  if (!chips || !valInput) return;
  const labels = [...chips.querySelectorAll('.pill')].map(c => c.textContent.replace('×','').trim());
  valInput.value = JSON.stringify(labels);
}

// ── Lead selection + mass actions ─────────────────────────────────────────────
window._leadsSelected = new Set();

function _leadsToggleAll(checked) {
  window._leadsSelected.clear();
  if (checked) _leadsData.forEach(l => window._leadsSelected.add(l.id));
  document.querySelectorAll('#leads-list input[type=checkbox]').forEach(cb => cb.checked = checked);
  _leadsUpdateMassBtn();
}

function _leadsToggleOne(id, checked) {
  if (checked) window._leadsSelected.add(id);
  else window._leadsSelected.delete(id);
  _leadsUpdateMassBtn();
  const all = $('leads-sel-all');
  if (all) all.checked = window._leadsSelected.size === _leadsData.length;
}

function _leadsUpdateMassBtn() {
  const btn = $('leads-mass-btn');
  if (btn) btn.style.display = window._leadsSelected.size > 0 ? '' : 'none';
}

function _leadsMassAction() {
  const count = window._leadsSelected.size;
  if (!count) return;
  Modal.open(`Mass Action — ${count} Lead${count>1?'s':''}`, `
    <div style="display:flex;flex-direction:column;gap:8px">
      <button class="btn btn-ghost" style="text-align:left" onclick="Modal.close();_leadsMassCategory()">🏷 Set Category</button>
      <button class="btn btn-ghost" style="text-align:left" onclick="Modal.close();_leadsMassStatus()">🔄 Set Status</button>
      <button class="btn btn-ghost" style="text-align:left" onclick="Modal.close();_leadsMassAssign()">👤 Assign To</button>
      <button class="btn btn-ghost" style="text-align:left" onclick="Modal.close();_leadsMassLabel()">+ Add Label</button>
      <hr class="divider">
      <button class="btn btn-ghost" style="text-align:left;color:var(--red)" onclick="Modal.close();_leadsMassDelete()">🗑 Delete Selected</button>
    </div>`, {sm:true});
}

async function _leadsMassCategory() {
  Modal.open('Set Category', `
    <select id="mass-cat" style="width:100%;padding:8px;border:1.5px solid var(--gray-3);border-radius:6px;margin-bottom:12px">
      <option value="">No category</option>
      ${_leadCategories.map(c=>`<option value="${c.name}">${c.name}</option>`).join('')}
    </select>
    <div class="bg">
      <button class="btn btn-primary" onclick="_leadsMassUpdate({category:val('mass-cat')})">Apply</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _leadsMassStatus() {
  Modal.open('Set Status', `
    <select id="mass-status" style="width:100%;padding:8px;border:1.5px solid var(--gray-3);border-radius:6px;margin-bottom:12px">
      ${['new','in_progress','lost'].map(s=>`<option value="${s}">${statusLabels[s]||s}</option>`).join('')}
    </select>
    <div class="bg">
      <button class="btn btn-primary" onclick="_leadsMassUpdate({status:val('mass-status')})">Apply</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _leadsMassAssign() {
  Modal.open('Assign To', `
    <select id="mass-assign" style="width:100%;padding:8px;border:1.5px solid var(--gray-3);border-radius:6px;margin-bottom:12px">
      <option value="">Unassigned</option>
      ${_leadStaff.map(s=>`<option value="${s.id}">${s.full_name}</option>`).join('')}
    </select>
    <div class="bg">
      <button class="btn btn-primary" onclick="_leadsMassUpdate({assigned_to:val('mass-assign')||null})">Apply</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _leadsMassLabel() {
  Modal.open('Add Label to Selected Leads', `
    <input id="mass-label" placeholder="Label name…" autocomplete="new-password"
      style="width:100%;padding:8px;border:1.5px solid var(--gray-3);border-radius:6px;margin-bottom:12px;box-sizing:border-box">
    <div class="bg">
      <button class="btn btn-primary" onclick="_leadsMassAddLabel()">Add Label</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _leadsMassAddLabel() {
  const label = val('mass-label')?.trim();
  if (!label) { toast('Enter a label','err'); return; }
  const ids = [...window._leadsSelected];
  try {
    await Promise.all(ids.map(async id => {
      const lead = _leadsData.find(l=>l.id===id);
      const labels = (() => { try { return JSON.parse(lead?.labels||'[]'); } catch { return []; } })();
      if (!labels.includes(label)) {
        labels.push(label);
        await API.put(`/api/orgs/${API.orgId}/leads/${id}`, { labels });
      }
    }));
    toast(`Label "${label}" added to ${ids.length} lead(s) ✓`);
    Modal.close();
    _loadLeads();
  } catch(e) { toast(e.message,'err'); }
}

async function _leadsMassUpdate(data) {
  const ids = [...window._leadsSelected];
  try {
    await Promise.all(ids.map(id => API.put(`/api/orgs/${API.orgId}/leads/${id}`, data)));
    toast(`Updated ${ids.length} lead(s) ✓`);
    Modal.close();
    window._leadsSelected.clear();
    _leadsUpdateMassBtn();
    _loadLeads();
  } catch(e) { toast(e.message,'err'); }
}

async function _leadsMassDelete() {
  confirmDlg(`Delete ${window._leadsSelected.size} leads?`, async () => {
    const ids = [...window._leadsSelected];
    await Promise.all(ids.map(id => API.del(`/api/orgs/${API.orgId}/leads/${id}`).catch(()=>{})));
    toast(`${ids.length} leads deleted`);
    window._leadsSelected.clear();
    _loadLeads();
  });
}

// ── Donors mass neighborhood + autopay ───────────────────────────────────────
Object.assign(Donors, {
  async bulkNeighborhood() {
    if (!this.selected.size) return;
    const hoods = await API.get(API.o.hoods()).catch(()=>[]);
    Modal.open(`Set Neighborhood — ${this.selected.size} Donor(s)`, `
      <select id="bulk-hood-sel" style="width:100%;padding:8px 10px;border:1.5px solid var(--gray-3);border-radius:6px;margin-bottom:12px">
        <option value="">No neighborhood</option>
        ${hoods.map(h=>`<option value="${h.id}">${h.name_he}</option>`).join('')}
      </select>
      <div class="bg">
        <button class="btn btn-primary" onclick="_donorsMassPut({neighborhood_id:val('bulk-hood-sel')||null})">Apply</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`, {sm:true});
  },

  async bulkAutopay() {
    if (!this.selected.size) return;
    Modal.open(`AutoPay — ${this.selected.size} Donor(s)`, `
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-green" onclick="_donorsMassPut({autopay_enabled:1})">✓ Enable AutoPay</button>
        <button class="btn btn-ghost" onclick="_donorsMassPut({autopay_paused:1})">⏸ Pause AutoPay</button>
        <button class="btn btn-ghost" onclick="_donorsMassPut({autopay_paused:0})">▶ Resume AutoPay</button>
        <button class="btn btn-ghost" style="color:var(--red)" onclick="_donorsMassPut({autopay_enabled:0})">✕ Disable AutoPay</button>
      </div>`, {sm:true});
  }
});

async function _donorsMassPut(data) {
  const ids = [...Donors.selected];
  try {
    await Promise.all(ids.map(id => API.put(`/api/orgs/${API.orgId}/donors/${id}`, data)));
    toast(`Updated ${ids.length} donor(s) ✓`);
    Modal.close();
    Donors.selected.clear();
    Donors.updateBulk();
    Donors.load();
  } catch(e) { toast(e.message,'err'); }
}

// ── Edit follow-up date ───────────────────────────────────────────────────────
function _editFollowupDate(followupId, currentDate) {
  Modal.open('Edit Follow-up Date', `
    <label>Next Follow-up Date</label>
    <input type="date" id="fu-edit-date" value="${currentDate||''}"
      style="padding:10px 12px;border:1.5px solid var(--gray-3);border-radius:6px;width:100%;box-sizing:border-box">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_saveFollowupDate('${followupId}')">Save</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _saveFollowupDate(followupId) {
  const date = val('fu-edit-date');
  try {
    await API.put(`/api/orgs/${API.orgId}/leads/followups/${followupId}`, { next_followup_date: date||null });
    toast('Follow-up date updated ✓');
    Modal.close();
    // Reload leads list
    _loadLeads();
  } catch(e) { toast(e.message||'Error','err'); }
}

// ── Scheduled Follow-ups page ─────────────────────────────────────────────────
async function renderScheduledFollowups(el) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const followups = await API.get(`/api/orgs/${API.orgId}/leads/followups/scheduled`);
    el.innerHTML = `
      <div class="ph">
        <div><div class="ph-title">Scheduled Follow-ups</div>
          <div class="ph-sub">${followups.length} scheduled</div>
        </div>
      </div>
      ${!followups.length ? '<div class="card"><div class="empty"><h3>No scheduled follow-ups</h3><p>Add follow-ups with a date from the Leads page.</p></div></div>' : `
      <div class="card" style="padding:0;overflow:hidden"><div class="tw"><table>
        <thead><tr>
          <th>Lead</th><th>Follow-up Date</th><th>Notes</th><th>Assigned To</th><th>Fundraiser</th><th></th>
        </tr></thead>
        <tbody>${followups.map(f => {
          const isOverdue = new Date(f.next_followup_date) < new Date();
          const isToday   = f.next_followup_date === new Date().toISOString().slice(0,10);
          return `<tr style="${isOverdue?'background:#fef2f2':isToday?'background:#fefce8':''}">
            <td>
              <div style="font-weight:600;font-size:13px">${f.lead_name||'Unknown Lead'}</div>
              ${f.lead_cell?`<div style="font-size:11px;color:var(--gray-5)">${f.lead_cell}</div>`:''}
            </td>
            <td style="font-weight:600;color:${isOverdue?'var(--red)':isToday?'var(--amber)':'inherit'}">
              ${fmtD(f.next_followup_date)}
              ${isOverdue?'<span style="font-size:10px;margin-left:4px">⚠ Overdue</span>':''}
              ${isToday?'<span style="font-size:10px;margin-left:4px">📅 Today</span>':''}
            </td>
            <td style="font-size:12px;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.notes||'—'}</td>
            <td style="font-size:12px">${f.lead_assigned_name||'—'}</td>
            <td style="font-size:12px">${f.done_by_name||'—'}</td>
            <td><div class="actions">
              <button class="btn btn-blue btn-sm" onclick="_leadView('${f.lead_id}')">View Lead</button>
              <button class="btn btn-ghost btn-sm" onclick="_leadAddFollowup('${f.lead_id}')">+ Follow Up</button>
              <button class="btn btn-ghost btn-sm" onclick="_editFollowupDate('${f.id}','${f.next_followup_date||''}')">✏ Date</button>
            </div></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div></div>`}`;
  } catch(e) { el.innerHTML = `<div class="alert alert-err">${e.message}</div>`; }
}

function _showScheduledFollowups() {
  navigateTo('followups');
}

// ── Account info editing ──────────────────────────────────────────────────────
function _editAccountInfo() {
  Modal.open('Edit Account Info', `
    <label>Organisation Name</label>
    <input id="acc-org-name" value="${DRM.org?.name||''}" autocomplete="new-password">
    <hr class="divider">
    <label>My Full Name</label>
    <input id="acc-my-name" value="${DRM.user?.full_name||''}" autocomplete="new-password">
    <label>My Email</label>
    <input id="acc-my-email" type="email" value="${DRM.user?.email||''}" autocomplete="new-password">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_saveAccountInfo()">Save</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _saveAccountInfo() {
  try {
    const orgName = val('acc-org-name')?.trim();
    const myName  = val('acc-my-name')?.trim();
    const myEmail = val('acc-my-email')?.trim();
    // Update org name
    if (orgName && orgName !== DRM.org?.name) {
      await API.put(`/api/orgs/${API.orgId}/settings`, { name: orgName });
    }
    // Update my profile
    if (myName || myEmail) {
      await API.put(`/api/orgs/${API.orgId}/users/${DRM.user.id}/profile`, { full_name: myName, email: myEmail });
    }
    toast('Saved ✓');
    Modal.close();
    renderSettings($('page-settings'));
  } catch(e) { toast(e.message||'Error','err'); }
}

function _changeMyPassword() {
  Modal.open('Change My Password', `
    <label>Current Password</label>
    <input type="password" id="cp-current" autocomplete="current-password">
    <label>New Password</label>
    <input type="password" id="cp-new" autocomplete="new-password">
    <label>Confirm New Password</label>
    <input type="password" id="cp-confirm" autocomplete="new-password">
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_doChangePassword()">Change Password</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _doChangePassword() {
  const current = val('cp-current');
  const newPw   = val('cp-new');
  const confirm = val('cp-confirm');
  if (!current || !newPw) { toast('Fill in all fields','err'); return; }
  if (newPw !== confirm) { toast('Passwords do not match','err'); return; }
  if (newPw.length < 8) { toast('Password must be at least 8 characters','err'); return; }
  try {
    await API.post(`/api/orgs/${API.orgId}/users/change-password`, { current_password: current, new_password: newPw });
    toast('Password changed ✓');
    Modal.close();
  } catch(e) { toast(e.message||'Error','err'); }
}

function _editUser(id, name, email, role) {
  Modal.open(`Edit User: ${name}`, `
    <label>Full Name</label>
    <input id="eu-name" value="${name}" autocomplete="new-password">
    <label>Email</label>
    <input id="eu-email" type="email" value="${email}" autocomplete="new-password">
    <label>Role</label>
    <select id="eu-role">
      <option value="staff" ${role==='staff'?'selected':''}>Staff</option>
      <option value="admin" ${role==='admin'?'selected':''}>Admin</option>
    </select>
    <div class="bg mt">
      <button class="btn btn-primary" onclick="_saveUserEdit('${id}')">Save</button>
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
    </div>`, {sm:true});
}

async function _saveUserEdit(userId) {
  try {
    await API.put(`/api/orgs/${API.orgId}/users/${userId}/profile`, {
      full_name: val('eu-name'), email: val('eu-email'), role: val('eu-role')
    });
    toast('User updated ✓');
    Modal.close();
    renderSettings($('page-settings'));
  } catch(e) { toast(e.message||'Error','err'); }
}
