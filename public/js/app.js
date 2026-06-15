// public/js/app.js - Main application controller

let currentUser = null;
let currentOrg = null;
let currentPage = 'dashboard';
let allOrgs = [];

// Page renderers registry
const Pages = {};

async function init() {
  // Check setup
  const setupStatus = await fetch('/api/setup-status').then(r => r.json());
  if (setupStatus.needsSetup) {
    showSetup();
    return;
  }

  // Try to restore session
  try {
    const me = await API.get('/auth/me');
    currentUser = me.user;
    allOrgs = me.orgs;
    if (me.orgs.length > 0) {
      await setOrg(me.orgs[0]);
    }
    showApp();
  } catch {
    showLogin();
  }
}

function showSetup() {
  hide('login-screen'); hide('app');
  show('setup-screen');
  document.getElementById('setup-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await API.post('/auth/setup', {
        full_name: document.getElementById('setup-name').value,
        email: document.getElementById('setup-email').value,
        password: document.getElementById('setup-password').value,
        org_name: document.getElementById('setup-org').value
      });
      toast('Account created! Please sign in.', 'success');
      showLogin();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

function showLogin() {
  hide('setup-screen'); hide('app');
  show('login-screen');
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.style.display = 'none';
    try {
      const res = await API.post('/auth/login', {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value
      });
      currentUser = res.user;
      allOrgs = res.orgs;
      if (res.orgs.length > 0) {
        await setOrg(res.activeOrg || res.orgs[0]);
      }
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    }
  };
}

async function setOrg(org) {
  currentOrg = org;
  API.orgId = org.id;

  // Update org selector
  const sel = document.getElementById('org-select');
  if (sel) {
    sel.innerHTML = allOrgs.map(o => `<option value="${o.id}" ${o.id === org.id ? 'selected' : ''}>${o.name}</option>`).join('');
    sel.onchange = async () => {
      const selected = allOrgs.find(o => o.id === sel.value);
      if (selected) await setOrg(selected);
    };
  }
}

function showApp() {
  hide('login-screen'); hide('setup-screen');
  show('app');

  document.getElementById('user-name-display').textContent = currentUser.full_name;

  document.getElementById('add-org-btn').onclick = () => {
    Modal.open('New Organization', `
      <label>Organization Name</label>
      <input type="text" id="new-org-name" placeholder="My Organization">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="createOrg()">Create</button>
      </div>
    `, { small: true });
  };

  document.getElementById('logout-btn').onclick = async () => {
    try { await API.post('/auth/logout', {}); } catch {}
    showLogin();
  };

  // Nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      navigateTo(page);
    });
  });

  navigateTo('dashboard');
  loadBadges();
  setInterval(loadBadges, 60000);
}

async function createOrg() {
  const name = document.getElementById('new-org-name').value.trim();
  if (!name) return;
  try {
    const res = await API.post('/auth/orgs', { name });
    allOrgs.push(res.org);
    await setOrg(res.org);
    Modal.close();
    toast('Organization created!');
    navigateTo('dashboard');
  } catch (e) { toast(e.message, 'error'); }
}

function navigateTo(page) {
  currentPage = page;

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) {
    pageEl.classList.add('active');
    renderPage(page, pageEl);
  }
}

function renderPage(page, el) {
  const renderers = {
    dashboard: () => Pages.Dashboard?.render(el),
    donors: () => Pages.Donors?.render(el),
    donations: () => Pages.Donations?.render(el),
    verification: () => Pages.Verification?.render(el),
    failures: () => Pages.Failures?.render(el),
    bank: () => Pages.Bank?.render(el),
    emails: () => Pages.Emails?.render(el),
    kvitel: () => Pages.KvitelPage?.render(el),
    reports: () => Pages.Reports?.render(el),
    settings: () => Pages.Settings?.render(el)
  };
  renderers[page]?.();
}

async function loadBadges() {
  if (!API.orgId) return;
  try {
    const stats = await API.get(API.org.stats());

    const vb = document.getElementById('verify-badge');
    if (stats.needsVerification > 0) {
      vb.textContent = stats.needsVerification;
      vb.style.display = 'inline';
    } else vb.style.display = 'none';

    const fb = document.getElementById('fail-badge');
    if (stats.failedCharges > 0) {
      fb.textContent = stats.failedCharges;
      fb.style.display = 'inline';
    } else fb.style.display = 'none';
  } catch {}
}

function show(id) { const el = document.getElementById(id); if (el) el.style.display = ''; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

// Start
document.addEventListener('DOMContentLoaded', init);
