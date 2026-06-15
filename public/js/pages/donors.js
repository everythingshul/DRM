// public/js/pages/donors.js
Pages.Donors = {
  donors: [], total: 0, page: 1, perPage: 25,
  search: '', neighborhood: '', label: '', autopay: '',
  sortBy: 'last_name', sortDir: 'asc',
  selected: new Set(),
  neighborhoods: [], labels: [],

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
        <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.importXlsx()">${Icon.upload()} Import</button>
        <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.exportXlsx()">${Icon.download()} Export</button>
        <button class="btn btn-primary btn-sm" onclick="Pages.Donors.openAdd()">${Icon.plus()} Add Donor</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px;padding:14px 16px">
      <div class="search-bar">
        <div class="search-wrap" style="flex:2">
          <span class="search-icon-svg">${Icon.search()}</span>
          <input type="text" id="donor-search" placeholder="Search name, email, phone, Hebrew name…" autocomplete="off" autocorrect="off" spellcheck="false">
        </div>
        <select id="donor-neighborhood">
          <option value="">All Neighborhoods</option>
        </select>
        <select id="donor-label-filter">
          <option value="">All Labels</option>
        </select>
        <select id="donor-autopay-filter">
          <option value="">All AutoPay</option>
          <option value="1">AutoPay On</option>
          <option value="0">AutoPay Off</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.pauseAll()">Pause All AutoPay</button>
          <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.resumeAll()">Resume All AutoPay</button>
        </div>
        <div class="per-page-wrap">
          Show <select id="donor-per-page">
            <option value="25" selected>25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select> per page
        </div>
      </div>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <div id="bulk-bar" class="bulk-bar">
        <span id="bulk-count">0 selected</span>
        <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.bulkEmail()">Send Email</button>
        <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.bulkExport()">Export Selected</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.Donors.bulkDelete()">Delete</button>
        <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.clearSelection()">Clear</button>
      </div>
      <div class="table-wrap">
        <table class="compact">
          <thead>
            <tr>
              <th style="width:32px"><input type="checkbox" class="row-check" id="select-all" onchange="Pages.Donors.toggleAll(this.checked)"></th>
              <th class="sortable" onclick="Pages.Donors.sort('last_name')">Name</th>
              <th>Hebrew</th>
              <th>Contact</th>
              <th class="sortable" onclick="Pages.Donors.sort('neighborhood_name')">Neighborhood</th>
              <th class="sortable" onclick="Pages.Donors.sort('months_old')">Age</th>
              <th class="sortable" onclick="Pages.Donors.sort('total_amount')">Total</th>
              <th>AutoPay</th>
              <th style="width:100px"></th>
            </tr>
          </thead>
          <tbody id="donors-tbody">
            <tr><td colspan="9"><div class="spinner"></div></td></tr>
          </tbody>
        </table>
      </div>
      <div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--gray-100)">
        <div id="donors-pagination"></div>
        <div id="donors-page-info" style="font-size:12px;color:var(--gray-500)"></div>
      </div>
    </div>`;
  },

  async loadMeta() {
    try {
      [this.neighborhoods, this.labels] = await Promise.all([
        API.get(API.org.neighborhoods()),
        API.get(API.org.labels())
      ]);
      const nhSel = document.getElementById('donor-neighborhood');
      if (nhSel) nhSel.innerHTML = '<option value="">All Neighborhoods</option>' +
        this.neighborhoods.map(n=>`<option value="${n.id}">${n.name_he}</option>`).join('');
      const lSel = document.getElementById('donor-label-filter');
      if (lSel) lSel.innerHTML = '<option value="">All Labels</option>' +
        this.labels.map(l=>`<option value="${l}">${l}</option>`).join('');
    } catch {}
  },

  async load() {
    const params = new URLSearchParams({
      page: this.page, limit: this.perPage,
      ...(this.search && {search: this.search}),
      ...(this.neighborhood && {neighborhood: this.neighborhood}),
      ...(this.label && {label: this.label}),
      ...(this.autopay !== '' && {autopay: this.autopay})
    });
    try {
      const res = await API.get(API.org.donors() + '?' + params);
      this.donors = res.donors || [];
      this.total = res.total || 0;
      this.renderTable();
      const c = document.getElementById('donors-count');
      if (c) c.textContent = `${this.total.toLocaleString()} donor${this.total!==1?'s':''}`;
      const info = document.getElementById('donors-page-info');
      const start = (this.page-1)*this.perPage+1;
      const end = Math.min(this.page*this.perPage, this.total);
      if (info && this.total > 0) info.textContent = `Showing ${start}–${end} of ${this.total}`;
    } catch (e) {
      const tb = document.getElementById('donors-tbody');
      if (tb) tb.innerHTML = `<tr><td colspan="9"><div class="alert alert-danger" style="margin:12px">${e.message}</div></td></tr>`;
    }
  },

  renderTable() {
    const tbody = document.getElementById('donors-tbody');
    if (!tbody) return;
    if (!this.donors.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state" style="padding:40px">${Icon.donors()}<h3 style="margin-top:10px">No donors found</h3></div></td></tr>`;
      return;
    }

    // Sort client-side
    const sorted = [...this.donors].sort((a,b) => {
      const av = a[this.sortBy] ?? '', bv = b[this.sortBy] ?? '';
      const r = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return this.sortDir === 'asc' ? r : -r;
    });

    tbody.innerHTML = sorted.map(d => {
      const labels = (() => { try { return JSON.parse(d.labels||'[]'); } catch { return []; } })();
      const apBadge = d.autopay_enabled
        ? (d.autopay_paused
          ? '<span class="status-badge status-paused" style="font-size:11px">Paused</span>'
          : '<span class="status-badge status-active" style="font-size:11px">On</span>')
        : '<span style="color:var(--gray-300);font-size:11px">Off</span>';

      return `<tr>
        <td><input type="checkbox" class="row-check donor-check" value="${d.id}" onchange="Pages.Donors.toggleOne('${d.id}',this.checked)" ${this.selected.has(d.id)?'checked':''}></td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            ${avatarHtml(d, 28)}
            <div>
              <div style="font-weight:600;font-size:13px">${d.title?d.title+' ':''}${d.first_name} ${d.last_name}</div>
              ${labels.length ? `<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:2px">${labels.map(l=>`<span class="pill pill-blue" style="font-size:10px;padding:1px 6px">${l}</span>`).join('')}</div>` : ''}
              ${d.needs_verification ? '<span style="font-size:10px;color:var(--warning);font-weight:600">⚠ Verify</span>' : ''}
            </div>
          </div>
        </td>
        <td><span style="font-family:var(--font-he);direction:rtl;font-size:12px">${d.hebrew_full_name||'—'}</span></td>
        <td style="font-size:12px">
          ${d.cell?`<div>${d.cell}</div>`:''}
          ${d.email?`<div style="color:var(--gray-500)">${d.email}</div>`:''}
        </td>
        <td><span style="font-family:var(--font-he);font-size:12px">${d.neighborhood_name||'—'}</span></td>
        <td style="font-size:12px;white-space:nowrap">${accountAge(d.months_old)}</td>
        <td style="font-weight:600;font-size:13px">${fmt$(d.total_amount)}</td>
        <td>${apBadge}</td>
        <td>
          <div style="display:flex;gap:4px">
            <button class="btn btn-blue btn-sm" onclick="Pages.DonorDetail.open('${d.id}')" title="View">${Icon.eye()}</button>
            <button class="btn btn-ghost btn-sm" onclick="Pages.Donors.openEdit('${d.id}')" title="Edit">${Icon.edit()}</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.Donors.deleteDonor('${d.id}','${d.first_name} ${d.last_name}')" title="Delete">${Icon.trash()}</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    // Pagination
    const pages = Math.ceil(this.total / this.perPage);
    const pagEl = document.getElementById('donors-pagination');
    if (pagEl) pagEl.innerHTML = paginationHtml(this.page, pages, 'Pages.Donors.goPage');

    // Update sort indicators
    document.querySelectorAll('#page-donors th.sortable').forEach(th => {
      th.classList.remove('sort-asc','sort-desc');
      if (th.onclick?.toString().includes(`'${this.sortBy}'`)) {
        th.classList.add(this.sortDir==='asc'?'sort-asc':'sort-desc');
      }
    });

    this.updateBulkBar();
  },

  sort(col) {
    if (this.sortBy === col) this.sortDir = this.sortDir==='asc'?'desc':'asc';
    else { this.sortBy = col; this.sortDir = 'asc'; }
    this.renderTable();
  },

  bindEvents(el) {
    let timer;
    const searchEl = document.getElementById('donor-search');
    if (searchEl) {
      searchEl.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(()=>{ this.search=searchEl.value; this.page=1; this.load(); }, 320);
      };
    }
    document.getElementById('donor-neighborhood')?.addEventListener('change', e => { this.neighborhood=e.target.value; this.page=1; this.load(); });
    document.getElementById('donor-label-filter')?.addEventListener('change', e => { this.label=e.target.value; this.page=1; this.load(); });
    document.getElementById('donor-autopay-filter')?.addEventListener('change', e => { this.autopay=e.target.value; this.page=1; this.load(); });
    document.getElementById('donor-per-page')?.addEventListener('change', e => { this.perPage=parseInt(e.target.value); this.page=1; this.load(); });
  },

  goPage(p) { Pages.Donors.page=p; Pages.Donors.load(); },

  toggleAll(checked) {
    document.querySelectorAll('.donor-check').forEach(cb => {
      cb.checked = checked;
      if (checked) this.selected.add(cb.value);
      else this.selected.delete(cb.value);
    });
    this.updateBulkBar();
  },
  toggleOne(id, checked) {
    if (checked) this.selected.add(id); else this.selected.delete(id);
    this.updateBulkBar();
  },
  clearSelection() { this.selected.clear(); document.getElementById('select-all').checked=false; document.querySelectorAll('.donor-check').forEach(c=>c.checked=false); this.updateBulkBar(); },
  updateBulkBar() {
    const bar = document.getElementById('bulk-bar');
    const cnt = document.getElementById('bulk-count');
    if (bar) bar.className = 'bulk-bar' + (this.selected.size>0?' visible':'');
    if (cnt) cnt.textContent = `${this.selected.size} selected`;
  },

  bulkDelete() {
    if (!this.selected.size) return;
    confirm(`Delete ${this.selected.size} donor(s)? This cannot be undone.`, async () => {
      for (const id of this.selected) await API.del(API.org.donor(id)).catch(()=>{});
      this.selected.clear(); toast(`Deleted ${this.selected.size} donors`); this.load();
    });
  },
  bulkExport() { toast('Exporting selected…'); this.exportXlsx(); },
  bulkEmail() { toast('Coming soon — use scheduled emails for bulk sends', 'warning'); },

  openAdd() { this.openForm(null); },
  async openEdit(id) { const d = await API.get(API.org.donor(id)); this.openForm(d.donor); },

  openForm(donor) {
    const isEdit = !!donor;
    Modal.open(isEdit?'Edit Donor':'Add Donor', '<div class="spinner"></div>', { large: true, onOpen: async () => {
      const hoods = await API.get(API.org.neighborhoods()).catch(()=>[]);
      const labels = (() => { try { return JSON.parse(donor?.labels||'[]'); } catch { return []; } })();

      Modal.setBody(`
        <div class="tabs">
          <div class="tab active" onclick="dTab(this,'dt-basic')">Basic</div>
          <div class="tab" onclick="dTab(this,'dt-contact')">Contact</div>
          <div class="tab" onclick="dTab(this,'dt-extra')">Labels & Kvitel</div>
        </div>
        <div id="dt-basic" class="tab-content active">
          <div class="input-row input-row-4">
            <div><label>Title</label><input id="d-title" value="${donor?.title||''}" placeholder="Mr./Mrs./Rabbi" autocomplete="honorific-prefix"></div>
            <div style="grid-column:span 2"><label>First Name *</label><input id="d-first" value="${donor?.first_name||''}" autocomplete="given-name"></div>
            <div><label>Last Name *</label><input id="d-last" value="${donor?.last_name||''}" autocomplete="family-name"></div>
          </div>
          <div class="input-row input-row-2">
            <div><label>Hebrew Title</label><input id="d-htitle" dir="rtl" style="font-family:var(--font-he)" value="${donor?.hebrew_title||''}" placeholder="הרב / מר" autocomplete="off"></div>
            <div><label>Hebrew Full Name</label><input id="d-hname" dir="rtl" style="font-family:var(--font-he)" value="${donor?.hebrew_full_name||''}" placeholder="ישראל בן אברהם" autocomplete="off"></div>
          </div>
          <div class="input-row input-row-2">
            <div>
              <label>Neighborhood</label>
              <div style="display:flex;gap:6px">
                <select id="d-nh" style="flex:1">
                  <option value="">— None —</option>
                  ${hoods.map(h=>`<option value="${h.id}" ${h.id===donor?.neighborhood_id?'selected':''}>${h.name_he}</option>`).join('')}
                </select>
                <button type="button" class="btn btn-ghost btn-sm" onclick="Pages.Donors.addNeighborhood()">+</button>
              </div>
            </div>
            <div><label>Account Age (created)</label><input type="date" id="d-created" value="${donor?.created_at?donor.created_at.slice(0,10):new Date().toISOString().slice(0,10)}" ${isEdit?'readonly':''}></div>
          </div>
        </div>
        <div id="dt-contact" class="tab-content">
          <div class="input-row input-row-2">
            <div><label>Cell</label><input id="d-cell" type="tel" value="${donor?.cell||''}" autocomplete="tel"></div>
            <div><label>Home Phone</label><input id="d-home" type="tel" value="${donor?.home_phone||''}" autocomplete="tel-home"></div>
          </div>
          <label>Email</label><input id="d-email" type="email" value="${donor?.email||''}" autocomplete="email">
          <hr class="section-divider">
          <label>Street</label><input id="d-street" value="${donor?.street||''}" autocomplete="street-address">
          <div class="input-row input-row-4">
            <div><label>Apt</label><input id="d-apt" value="${donor?.apt||''}"></div>
            <div style="grid-column:span 2"><label>City</label><input id="d-city" value="${donor?.city||''}" autocomplete="address-level2"></div>
            <div><label>State</label><input id="d-state" value="${donor?.state||''}" maxlength="2" autocomplete="address-level1"></div>
          </div>
          <div style="max-width:140px"><label>ZIP</label><input id="d-zip" value="${donor?.zip||''}" autocomplete="postal-code"></div>
        </div>
        <div id="dt-extra" class="tab-content">
          <label>Labels</label>
          <div id="labels-widget"></div>
          <hr class="section-divider">
          <label>Kvitel <span style="font-size:12px;color:var(--gray-500)">(Hebrew, RTL)</span></label>
          <textarea id="d-kvitel" dir="rtl" style="font-family:var(--font-he);min-height:120px;font-size:15px;line-height:1.8">${donor?.kvitel||''}</textarea>
          <div class="toggle-row" style="margin-top:10px">
            <div class="toggle-label">Include in Kvitel generation</div>
            <label class="toggle"><input type="checkbox" id="d-kvon" ${donor?.kvitel_enabled!==0?'checked':''}><span class="toggle-slider"></span></label>
          </div>
        </div>
        <hr class="section-divider" style="margin-top:16px">
        <div class="btn-group">
          <button class="btn btn-primary" onclick="Pages.Donors.save('${donor?.id||''}')">${isEdit?'Save Changes':'Add Donor'}</button>
          <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        </div>
      `);

      window.__labelsWidget = labelsInput('labels-widget', labels);
      window.dTab = (el, id) => {
        document.querySelectorAll('#modal-body .tab').forEach(t=>t.classList.remove('active'));
        document.querySelectorAll('#modal-body .tab-content').forEach(t=>t.classList.remove('active'));
        el.classList.add('active'); document.getElementById(id)?.classList.add('active');
      };
    }});
  },

  async addNeighborhood() {
    const name = prompt('Hebrew neighborhood name:');
    if (!name) return;
    try {
      const r = await API.post(API.org.neighborhoods(), { name_he: name });
      toast('Neighborhood added');
      const sel = document.getElementById('d-nh');
      if (sel) sel.innerHTML += `<option value="${r.neighborhood.id}" selected>${r.neighborhood.name_he}</option>`;
      this.neighborhoods.push(r.neighborhood);
    } catch(e) { toast(e.message,'error'); }
  },

  async save(id) {
    const data = {
      title: document.getElementById('d-title')?.value,
      first_name: document.getElementById('d-first')?.value,
      last_name: document.getElementById('d-last')?.value,
      hebrew_title: document.getElementById('d-htitle')?.value,
      hebrew_full_name: document.getElementById('d-hname')?.value,
      neighborhood_id: document.getElementById('d-nh')?.value || null,
      cell: document.getElementById('d-cell')?.value,
      home_phone: document.getElementById('d-home')?.value,
      email: document.getElementById('d-email')?.value,
      street: document.getElementById('d-street')?.value,
      apt: document.getElementById('d-apt')?.value,
      city: document.getElementById('d-city')?.value,
      state: document.getElementById('d-state')?.value,
      zip: document.getElementById('d-zip')?.value,
      kvitel: document.getElementById('d-kvitel')?.value,
      kvitel_enabled: document.getElementById('d-kvon')?.checked ? 1 : 0,
      labels: window.__labelsWidget?.getLabels() || []
    };
    if (!data.first_name || !data.last_name) { toast('First and last name required','error'); return; }
    try {
      if (id) await API.put(API.org.donor(id), data);
      else await API.post(API.org.donors(), data);
      toast(id?'Donor saved':'Donor added');
      Modal.close();
      this.load(); this.loadMeta();
    } catch(e) { toast(e.message,'error'); }
  },

  deleteDonor(id, name) {
    confirm(`Delete "${name}"? All donations and history will be removed.`, async () => {
      await API.del(API.org.donor(id)); toast('Deleted'); this.load();
    });
  },

  async pauseAll() {
    confirm('Pause AutoPay for all donors?', async () => {
      await API.post(`/api/orgs/${API.orgId}/donors/autopay/pause-all`, {});
      toast('All AutoPay paused'); this.load();
    });
  },

  async resumeAll() {
    await API.post(`/api/orgs/${API.orgId}/donors/autopay/resume-all`, {});
    toast('All AutoPay resumed'); this.load();
  },

  importXlsx() {
    Modal.open('Import Donors', `
      <p style="color:var(--gray-500);margin-bottom:12px">Excel file with columns: First Name, Last Name, Hebrew Name, Email, Cell, Street, City, State, Zip</p>
      <input type="file" id="import-file" accept=".xlsx,.xls">
      <div style="margin-top:14px">
        <button class="btn btn-primary" onclick="Pages.Donors.doImport()">Import</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doImport() {
    const file = document.getElementById('import-file')?.files[0];
    if (!file) { toast('Select a file','error'); return; }
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await fetch(`/api/orgs/${API.orgId}/import/donors`, {
        method:'POST', body:fd, credentials:'include', headers:{'x-org-id':API.orgId}
      }).then(r=>r.json());
      toast(`Imported ${r.imported} donors${r.errors?.length?` (${r.errors.length} errors)`:''}`);
      Modal.close(); this.load();
    } catch(e) { toast(e.message,'error'); }
  },

  exportXlsx() {
    API.downloadGet(`/api/orgs/${API.orgId}/reports/donors?format=xlsx`, 'donors.xlsx').catch(e=>toast(e.message,'error'));
  }
};
