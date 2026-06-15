// public/js/pages/donors.js
Pages.Donors = {
  search: '', neighborhood: '', label: '', page: 1,
  donors: [], total: 0, neighborhoods: [], labels: [],

  async render(el) {
    el.innerHTML = this.shell();
    await this.loadMeta();
    await this.load();
    this.bindEvents(el);
  },

  shell() {
    return `
    <div class="page-header">
      <div>
        <div class="page-title">Donors</div>
        <div class="page-subtitle" id="donors-count"></div>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.importXlsx()">⬆ Import XLSX</button>
        <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.exportXlsx()">⬇ Export XLSX</button>
        <button class="btn btn-primary" onclick="Pages.Donors.openAdd()">+ Add Donor</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="search-bar">
        <div class="search-input-wrap" style="flex:2">
          <span class="search-icon">🔍</span>
          <input type="text" id="donor-search" placeholder="Search name, email, phone, Hebrew name..." value="">
        </div>
        <select id="donor-neighborhood" style="flex:1;max-width:200px">
          <option value="">All Neighborhoods</option>
        </select>
        <select id="donor-label-filter" style="flex:1;max-width:160px">
          <option value="">All Labels</option>
        </select>
        <select id="donor-autopay-filter" style="max-width:140px">
          <option value="">All AutoPay</option>
          <option value="1">AutoPay On</option>
          <option value="0">AutoPay Off</option>
        </select>
      </div>
      <div class="btn-group" style="margin-top:4px">
        <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.pauseAll()">⏸ Pause All AutoPay</button>
        <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.resumeAll()">▶ Resume All AutoPay</button>
      </div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Donor</th>
              <th>Hebrew Name</th>
              <th>Contact</th>
              <th>Neighborhood</th>
              <th>Account Age</th>
              <th>Total Donated</th>
              <th>AutoPay</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="donors-tbody">
            <tr><td colspan="8"><div class="spinner"></div></td></tr>
          </tbody>
        </table>
      </div>
      <div id="donors-pagination"></div>
    </div>`;
  },

  async loadMeta() {
    try {
      this.neighborhoods = await API.get(API.org.neighborhoods());
      this.labels = await API.get(API.org.labels());
      const nhSel = document.getElementById('donor-neighborhood');
      if (nhSel) {
        nhSel.innerHTML = '<option value="">All Neighborhoods</option>' +
          this.neighborhoods.map(n => `<option value="${n.id}">${n.name_he}</option>`).join('');
      }
      const lSel = document.getElementById('donor-label-filter');
      if (lSel) {
        lSel.innerHTML = '<option value="">All Labels</option>' +
          this.labels.map(l => `<option value="${l}">${l}</option>`).join('');
      }
    } catch {}
  },

  async load() {
    const params = new URLSearchParams({ page: this.page, limit: 50 });
    if (this.search) params.set('search', this.search);
    if (this.neighborhood) params.set('neighborhood', this.neighborhood);
    if (this.label) params.set('label', this.label);
    if (this.autopay !== undefined && this.autopay !== '') params.set('autopay', this.autopay);

    try {
      const res = await API.get(API.org.donors() + '?' + params);
      this.donors = res.donors || [];
      this.total = res.total || 0;
      this.renderTable();
      const countEl = document.getElementById('donors-count');
      if (countEl) countEl.textContent = `${this.total} donor${this.total !== 1 ? 's' : ''}`;
    } catch (e) {
      const tbody = document.getElementById('donors-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="8"><div class="alert alert-danger">${e.message}</div></td></tr>`;
    }
  },

  renderTable() {
    const tbody = document.getElementById('donors-tbody');
    if (!tbody) return;

    if (!this.donors.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">👥</div><h3>No donors found</h3><p>Add your first donor to get started.</p></div></td></tr>`;
      return;
    }

    tbody.innerHTML = this.donors.map(d => {
      const labels = (() => { try { return JSON.parse(d.labels||'[]'); } catch { return []; } })();
      const autopayStatus = d.autopay_enabled
        ? (d.autopay_paused ? '<span class="pill pill-orange">Paused</span>' : '<span class="pill pill-green">On</span>')
        : '<span class="pill pill-gray">Off</span>';

      return `<tr>
        <td>
          <div class="donor-name-cell">
            ${avatarHtml(d)}
            <div>
              <div class="donor-name-main">${d.title ? d.title + ' ' : ''}${d.first_name} ${d.last_name}</div>
              ${labels.length ? `<div class="labels-wrap" style="margin-top:3px">${labels.map(l=>`<span class="pill pill-blue" style="font-size:10px">${l}</span>`).join('')}</div>` : ''}
              ${d.needs_verification ? '<span class="pill pill-orange" style="font-size:10px">⚠ Needs Verification</span>' : ''}
            </div>
          </div>
        </td>
        <td><span class="he">${d.hebrew_full_name || '—'}</span></td>
        <td>
          ${d.cell ? `📱 ${d.cell}<br>` : ''}
          ${d.email ? `<span style="font-size:12px;color:var(--gray-500)">${d.email}</span>` : ''}
        </td>
        <td><span class="he">${d.neighborhood_name || '—'}</span></td>
        <td>${accountAge(d.months_old)}</td>
        <td class="amount">${fmt$(d.total_amount)}</td>
        <td>${autopayStatus}</td>
        <td>
          <div class="td-actions">
            <button class="btn btn-blue btn-sm" onclick="Pages.DonorDetail.open('${d.id}')">View</button>
            <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.openEdit('${d.id}')">Edit</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.Donors.deleteDonor('${d.id}','${d.first_name} ${d.last_name}')">✕</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    // Pagination
    const pages = Math.ceil(this.total / 50);
    const pagEl = document.getElementById('donors-pagination');
    if (pagEl && pages > 1) {
      pagEl.innerHTML = paginationHtml(this.page, pages, 'Pages.Donors.goPage');
    }
  },

  bindEvents(el) {
    let searchTimer;
    const searchEl = document.getElementById('donor-search');
    if (searchEl) searchEl.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this.search = searchEl.value;
        this.page = 1;
        this.load();
      }, 300);
    };

    const nhEl = document.getElementById('donor-neighborhood');
    if (nhEl) nhEl.onchange = () => { this.neighborhood = nhEl.value; this.page = 1; this.load(); };

    const lEl = document.getElementById('donor-label-filter');
    if (lEl) lEl.onchange = () => { this.label = lEl.value; this.page = 1; this.load(); };

    const apEl = document.getElementById('donor-autopay-filter');
    if (apEl) apEl.onchange = () => { this.autopay = apEl.value; this.page = 1; this.load(); };
  },

  goPage(p) { Pages.Donors.page = p; Pages.Donors.load(); },

  openAdd() {
    this.openForm(null);
  },

  async openEdit(id) {
    const data = await API.get(API.org.donor(id));
    this.openForm(data.donor);
  },

  openForm(donor) {
    const isEdit = !!donor;
    Modal.open(isEdit ? 'Edit Donor' : 'Add Donor', '<div class="spinner"></div>', { large: true, onOpen: async () => {
      const hoods = await API.get(API.org.neighborhoods());
      const labels = (() => { try { return JSON.parse(donor?.labels || '[]'); } catch { return []; } })();

      Modal.setBody(`
        <div class="tabs">
          <div class="tab active" onclick="switchTab(this,'tab-basic')">Basic Info</div>
          <div class="tab" onclick="switchTab(this,'tab-contact')">Contact</div>
          <div class="tab" onclick="switchTab(this,'tab-notes')">Notes & Labels</div>
        </div>

        <div id="tab-basic" class="tab-content active">
          <div class="input-row input-row-4">
            <div><label>Title</label><input id="d-title" value="${donor?.title||''}" placeholder="Mr./Mrs./Rabbi..."></div>
            <div style="grid-column:span 2"><label>First Name *</label><input id="d-first" value="${donor?.first_name||''}" required></div>
            <div><label>Last Name *</label><input id="d-last" value="${donor?.last_name||''}" required></div>
          </div>
          <div class="input-row input-row-2">
            <div><label>Hebrew Title</label><input id="d-htitle" class="he" dir="rtl" value="${donor?.hebrew_title||''}" placeholder="הרב / מר / גברת"></div>
            <div><label>Hebrew Full Name</label><input id="d-hname" class="he" dir="rtl" value="${donor?.hebrew_full_name||''}" placeholder="ישראל בן אברהם"></div>
          </div>
          <div class="input-row input-row-2">
            <div>
              <label>Neighborhood</label>
              <div style="display:flex;gap:8px">
                <select id="d-neighborhood" style="flex:1">
                  <option value="">— None —</option>
                  ${hoods.map(h => `<option value="${h.id}" ${h.id === donor?.neighborhood_id ? 'selected' : ''}>${h.name_he}</option>`).join('')}
                </select>
                <button type="button" class="btn btn-ghost btn-sm" onclick="Pages.Donors.addNeighborhood()">+</button>
              </div>
            </div>
            <div>
              <label>Account Created</label>
              <input type="date" id="d-created" value="${donor?.created_at ? donor.created_at.slice(0,10) : new Date().toISOString().slice(0,10)}" ${isEdit?'readonly':''}>
            </div>
          </div>
        </div>

        <div id="tab-contact" class="tab-content">
          <div class="input-row input-row-2">
            <div><label>Cell Phone</label><input id="d-cell" type="tel" value="${donor?.cell||''}" placeholder="+1 (555) 000-0000"></div>
            <div><label>Home Phone</label><input id="d-home" type="tel" value="${donor?.home_phone||''}" placeholder="+1 (555) 000-0000"></div>
          </div>
          <div><label>Email</label><input id="d-email" type="email" value="${donor?.email||''}" placeholder="donor@email.com"></div>
          <hr class="section-divider">
          <div><label>Street Address</label>
            <input id="d-street" value="${donor?.street||''}" placeholder="123 Main St" autocomplete="street-address">
          </div>
          <div class="input-row input-row-4">
            <div><label>Apt/Unit</label><input id="d-apt" value="${donor?.apt||''}" placeholder="Apt 4B"></div>
            <div style="grid-column:span 2"><label>City</label><input id="d-city" value="${donor?.city||''}" placeholder="Brooklyn"></div>
            <div><label>State</label><input id="d-state" value="${donor?.state||''}" placeholder="NY" maxlength="2"></div>
          </div>
          <div style="max-width:150px"><label>ZIP</label><input id="d-zip" value="${donor?.zip||''}" placeholder="11201"></div>
        </div>

        <div id="tab-notes" class="tab-content">
          <label>Labels</label>
          <div id="labels-widget"></div>
          <hr class="section-divider">
          <label>Kvitel (Hebrew, RTL)</label>
          <textarea id="d-kvitel" class="kvitel-input" dir="rtl" placeholder="Enter kvitel content...">${donor?.kvitel||''}</textarea>
          <div class="toggle-row" style="margin-top:12px">
            <div><div class="toggle-label">Include in Kvitel generation</div></div>
            <label class="toggle"><input type="checkbox" id="d-kvitel-on" ${donor?.kvitel_enabled !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
          </div>
        </div>

        <hr class="section-divider">
        <div class="btn-group">
          <button class="btn btn-primary" onclick="Pages.Donors.saveDonor('${donor?.id||''}')">
            ${isEdit ? 'Save Changes' : 'Add Donor'}
          </button>
          <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        </div>
      `);

      // Init labels widget
      window.__labelsWidget = labelsInput('labels-widget', labels);

      // Tab switching
      window.switchTab = (el, id) => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        document.getElementById(id)?.classList.add('active');
      };
    }});
  },

  async addNeighborhood() {
    const name = prompt('Hebrew neighborhood name:');
    if (!name) return;
    try {
      const res = await API.post(API.org.neighborhoods(), { name_he: name });
      toast('Neighborhood added');
      this.neighborhoods.push(res.neighborhood);
      const sel = document.getElementById('d-neighborhood');
      if (sel) sel.innerHTML += `<option value="${res.neighborhood.id}">${res.neighborhood.name_he}</option>`;
    } catch (e) { toast(e.message, 'error'); }
  },

  async saveDonor(id) {
    const data = {
      title: document.getElementById('d-title')?.value,
      first_name: document.getElementById('d-first')?.value,
      last_name: document.getElementById('d-last')?.value,
      hebrew_title: document.getElementById('d-htitle')?.value,
      hebrew_full_name: document.getElementById('d-hname')?.value,
      cell: document.getElementById('d-cell')?.value,
      home_phone: document.getElementById('d-home')?.value,
      email: document.getElementById('d-email')?.value,
      neighborhood_id: document.getElementById('d-neighborhood')?.value || null,
      street: document.getElementById('d-street')?.value,
      apt: document.getElementById('d-apt')?.value,
      city: document.getElementById('d-city')?.value,
      state: document.getElementById('d-state')?.value,
      zip: document.getElementById('d-zip')?.value,
      kvitel: document.getElementById('d-kvitel')?.value,
      kvitel_enabled: document.getElementById('d-kvitel-on')?.checked ? 1 : 0,
      labels: window.__labelsWidget?.getLabels() || []
    };

    if (!data.first_name || !data.last_name) { toast('First and last name required', 'error'); return; }

    try {
      if (id) {
        await API.put(API.org.donor(id), data);
        toast('Donor updated!');
      } else {
        await API.post(API.org.donors(), data);
        toast('Donor added!');
      }
      Modal.close();
      this.page = 1;
      await this.load();
      await this.loadMeta();
    } catch (e) { toast(e.message, 'error'); }
  },

  deleteDonor(id, name) {
    confirm(`Delete donor "${name}"? This cannot be undone.`, async () => {
      try {
        await API.del(API.org.donor(id));
        toast('Donor deleted');
        this.load();
      } catch (e) { toast(e.message, 'error'); }
    });
  },

  async pauseAll() {
    confirm('Pause AutoPay for ALL donors?', async () => {
      await API.post(`/api/orgs/${API.orgId}/donors/autopay/pause-all`, {});
      toast('All AutoPay paused');
      this.load();
    });
  },

  async resumeAll() {
    await API.post(`/api/orgs/${API.orgId}/donors/autopay/resume-all`, {});
    toast('All AutoPay resumed');
    this.load();
  },

  importXlsx() {
    Modal.open('Import Donors (XLSX)', `
      <p style="margin-bottom:12px">Upload an Excel file with columns: First Name, Last Name, Hebrew Name, Email, Cell, Street, City, State, Zip</p>
      <input type="file" id="import-file" accept=".xlsx,.xls">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Donors.doImport()">Import</button>
      </div>
    `, { small: true });
  },

  async doImport() {
    const file = document.getElementById('import-file')?.files[0];
    if (!file) { toast('Select a file', 'error'); return; }
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`/api/orgs/${API.orgId}/import/donors`, {
        method: 'POST', body: formData, credentials: 'include',
        headers: { 'x-org-id': API.orgId }
      }).then(r => r.json());
      toast(`Imported ${res.imported} donors${res.errors?.length ? ` (${res.errors.length} errors)` : ''}`);
      Modal.close();
      this.load();
    } catch (e) { toast(e.message, 'error'); }
  },

  exportXlsx() {
    API.downloadGet(`/api/orgs/${API.orgId}/reports/donors?format=xlsx`, 'donors-export.xlsx')
      .catch(e => toast(e.message, 'error'));
  }
};
