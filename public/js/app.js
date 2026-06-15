// public/js/app.js - Main application controller

let currentUser = null;
let currentOrg = null;
let currentPage = 'dashboard';
let allOrgs = [];

async function init() {
  // Check for new account invite token
  const urlParams = new URLSearchParams(window.location.search);
  const inviteToken = urlParams.get('token');
  if (window.location.pathname === '/new-account' && inviteToken) {
    showNewAccount(inviteToken);
    return;
  }

  // Check for user setup token (existing user invite)
  if (window.location.pathname === '/complete-setup' && inviteToken) {
    showCompleteSetup(inviteToken);
    return;
  }

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

function showNewAccount(token) {
  hide('login-screen'); hide('app');
  const screen = document.getElementById('setup-screen');
  screen.style.display = 'flex';
  screen.querySelector('h1').textContent = 'Create Your Account';
  screen.querySelector('.subtitle').textContent = 'Set up your organization on DRM.';
  const form = document.getElementById('setup-form');
  form.innerHTML = `
    <label>Your Full Name</label>
    <input type="text" id="na-name" placeholder="Your full name" required autocomplete="name">
    <label>Organization Name</label>
    <input type="text" id="na-org" placeholder="Beth Israel Congregation" required>
    <label>Password</label>
    <input type="password" id="na-password" placeholder="Choose a password (min 6 chars)" required autocomplete="new-password">
    <label>Confirm Password</label>
    <input type="password" id="na-password2" placeholder="Confirm password" required autocomplete="new-password">
    <button type="submit" class="btn btn-primary btn-full" style="margin-top:20px">Create My Account</button>
  `;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('setup-error');
    errEl.style.display = 'none';
    const p1 = document.getElementById('na-password').value;
    const p2 = document.getElementById('na-password2').value;
    if (p1 !== p2) { errEl.textContent = 'Passwords do not match'; errEl.style.display = 'block'; return; }
    try {
      await API.post('/auth/new-account', {
        token,
        full_name: document.getElementById('na-name').value,
        org_name: document.getElementById('na-org').value,
        password: p1
      });
      window.history.replaceState({}, '', '/');
      toast('Account created! Please sign in.', 'success');
      showLogin();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    }
  };
}

function showCompleteSetup(token) {
  hide('login-screen'); hide('app');
  const screen = document.getElementById('setup-screen');
  screen.style.display = 'flex';
  screen.querySelector('h1').textContent = 'Set Up Your Account';
  screen.querySelector('.subtitle').textContent = 'You\'ve been invited to DRM. Create your account below.';
  const form = document.getElementById('setup-form');
  form.innerHTML = `
    <label>Full Name</label>
    <input type="text" id="setup-name" placeholder="Your full name" required>
    <label>Password</label>
    <input type="password" id="setup-password" placeholder="Choose a password (min 6 chars)" required>
    <label>Confirm Password</label>
    <input type="password" id="setup-password2" placeholder="Confirm password" required>
    <button type="submit" class="btn btn-primary btn-full" style="margin-top:20px">Create Account</button>
  `;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('setup-error');
    const p1 = document.getElementById('setup-password').value;
    const p2 = document.getElementById('setup-password2').value;
    if (p1 !== p2) { errEl.textContent = 'Passwords do not match'; errEl.style.display = 'block'; return; }
    try {
      await API.post('/auth/complete-setup', {
        token,
        full_name: document.getElementById('setup-name').value,
        password: p1
      });
      // Clear token from URL and go to login
      window.history.replaceState({}, '', '/');
      toast('Account created! Please sign in.');
      showLogin();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    }
  };
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

  // Sidebar collapse/expand
  const sidebar = document.getElementById('sidebar');
  const mainContent = document.getElementById('main-content');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const collapsed = localStorage.getItem('sidebar-collapsed') === '1';
  if (collapsed) {
    sidebar.classList.add('sidebar-collapsed');
    mainContent.style.marginLeft = 'var(--sidebar-collapsed-w)';
  }
  toggleBtn.onclick = () => {
    const isCollapsed = sidebar.classList.toggle('sidebar-collapsed');
    mainContent.style.marginLeft = isCollapsed ? 'var(--sidebar-collapsed-w)' : 'var(--sidebar-w)';
    localStorage.setItem('sidebar-collapsed', isCollapsed ? '1' : '0');
  };

  // Add tooltips to nav items for collapsed mode
  document.querySelectorAll('.nav-item').forEach(item => {
    const label = item.querySelector('.nav-label');
    if (label) item.setAttribute('data-tooltip', label.textContent.trim());
  });

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
