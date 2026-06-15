// public/js/pages/donations.js
Pages.Donations = {
  async render(el) {
    el.innerHTML = `<div class="page-header"><div class="page-title">All Donations</div></div><div class="spinner"></div>`;
    try {
      const donations = await API.get(`/api/orgs/${API.orgId}/reports/donations`);
      el.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">All Donations</div><div class="page-subtitle">${donations.length} records</div></div>
          <button class="btn btn-ghost btn-sm" onclick="API.downloadGet('/api/orgs/${API.orgId}/reports/donations?format=xlsx','donations-report.xlsx').catch(e=>toast(e.message,'error'))">⬇ Export XLSX</button>
        </div>
        <div class="card">
          <div class="search-bar">
            <div class="search-input-wrap" style="flex:1">
              <span class="search-icon">🔍</span>
              <input type="text" id="don-search" placeholder="Search donor or transaction ID...">
            </div>
            <select id="don-method-filter">
              <option value="">All Methods</option>
              ${[...new Set(donations.map(d=>d.method))].map(m=>`<option>${m}</option>`).join('')}
            </select>
            <select id="don-status-filter">
              <option value="">All Status</option>
              <option value="completed">Completed</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
              <option value="scheduled">Scheduled</option>
            </select>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Donor</th><th>Amount</th><th>Method</th><th>Status</th><th>Transaction ID</th><th>Notes</th></tr></thead>
              <tbody id="don-tbody">
                ${this.rows(donations)}
              </tbody>
            </table>
          </div>
        </div>`;

      let filtered = donations;
      const filter = () => {
        const s = document.getElementById('don-search')?.value?.toLowerCase() || '';
        const m = document.getElementById('don-method-filter')?.value || '';
        const st = document.getElementById('don-status-filter')?.value || '';
        filtered = donations.filter(d =>
          (!s || `${d.first_name} ${d.last_name} ${d.transaction_id}`.toLowerCase().includes(s)) &&
          (!m || d.method === m) && (!st || d.status === st));
        document.getElementById('don-tbody').innerHTML = this.rows(filtered);
      };
      document.getElementById('don-search')?.addEventListener('input', filter);
      document.getElementById('don-method-filter')?.addEventListener('change', filter);
      document.getElementById('don-status-filter')?.addEventListener('change', filter);
    } catch (e) { el.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
  },

  rows(donations) {
    if (!donations.length) return '<tr><td colspan="7"><div class="empty-state" style="padding:30px"><div class="empty-icon">💳</div><h3>No donations found</h3></div></td></tr>';
    return donations.map(d => `<tr>
      <td>${fmtDate(d.donation_date)}</td>
      <td><strong>${d.first_name} ${d.last_name}</strong><br><span style="font-size:11px;color:var(--gray-500)">${d.neighborhood||''}</span></td>
      <td class="amount">${fmt$(d.amount)}</td>
      <td>${d.method}${d.last_four ? ` ••${d.last_four}` : ''}</td>
      <td>${statusBadge(d.status)}</td>
      <td style="font-size:11px;color:var(--gray-500)">${d.transaction_id||'—'}</td>
      <td style="font-size:12px">${d.notes||''}</td>
    </tr>`).join('');
  }
};

// public/js/pages/verification.js
Pages.Verification = {
  donors: [],

  async render(el) {
    el.innerHTML = `<div class="spinner"></div>`;
    try {
      this.donors = await API.get(API.org.verification());
      this.renderPage(el);
    } catch (e) { el.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
  },

  renderPage(el) {
    const count = this.donors.length;
    el.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Info Verification</div>
          <div class="page-subtitle">${count} donor${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} info check</div>
        </div>
        ${count > 0 ? `<button class="btn btn-success" onclick="Pages.Verification.verifyAll()">✓ Verify All</button>` : ''}
      </div>

      ${count === 0 ? `
        <div class="card">
          <div class="empty-state" style="padding:60px">
            <div class="empty-icon">✅</div>
            <h3>All donors are up to date!</h3>
            <p>No info checks needed right now. Donors are flagged after 6 months without verification.</p>
          </div>
        </div>` : `
        <div class="alert alert-warning">
          <strong>Info Check Required</strong> — These donors haven't had their information verified in over 6 months.
          Review their details and click "Verify" to confirm their info is current.
        </div>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Donor</th>
                  <th>Neighborhood</th>
                  <th>Contact</th>
                  <th>Account Age</th>
                  <th>Last Verified</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${this.donors.map(d => `
                  <tr id="vrow-${d.id}">
                    <td>
                      <div class="donor-name-cell">
                        ${avatarHtml(d)}
                        <div>
                          <div class="donor-name-main">${d.title ? d.title + ' ' : ''}${d.first_name} ${d.last_name}</div>
                          ${d.hebrew_full_name ? `<div class="he" style="font-size:11px">${d.hebrew_full_name}</div>` : ''}
                        </div>
                      </div>
                    </td>
                    <td><span class="he">${d.neighborhood_name || '—'}</span></td>
                    <td>
                      ${d.cell ? `📱 ${d.cell}<br>` : ''}
                      ${d.email ? `<span style="font-size:12px;color:var(--gray-500)">${d.email}</span>` : '—'}
                    </td>
                    <td>${accountAge(d.months_old)}</td>
                    <td style="color:var(--danger)">${d.info_verified_at ? fmtDate(d.info_verified_at) : 'Never'}</td>
                    <td>
                      <div class="btn-group">
                        <button class="btn btn-blue btn-sm" onclick="Pages.DonorDetail.open('${d.id}')">View</button>
                        <button class="btn btn-success btn-sm" onclick="Pages.Verification.verify('${d.id}')">✓ Verify</button>
                      </div>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`}`;
  },

  async verify(id) {
    try {
      await API.post(`/api/orgs/${API.orgId}/donors/${id}/verify`, {});
      const row = document.getElementById(`vrow-${id}`);
      if (row) { row.style.opacity = '0'; row.style.transition = 'opacity 0.3s'; setTimeout(() => row.remove(), 300); }
      this.donors = this.donors.filter(d => d.id !== id);
      const subtitle = document.querySelector('.page-subtitle');
      if (subtitle) subtitle.textContent = `${this.donors.length} donor${this.donors.length !== 1 ? 's' : ''} need${this.donors.length === 1 ? 's' : ''} info check`;
      toast('Marked as verified ✓');
      loadBadges();
    } catch (e) { toast(e.message, 'error'); }
  },

  async verifyAll() {
    confirm(`Mark all ${this.donors.length} donors as verified?`, async () => {
      for (const d of this.donors) {
        await API.post(`/api/orgs/${API.orgId}/donors/${d.id}/verify`, {});
      }
      toast('All donors verified ✓');
      this.donors = [];
      await this.render(document.getElementById('page-verification'));
      loadBadges();
    });
  }
};

// public/js/pages/failures.js
Pages.Failures = {
  async render(el) {
    el.innerHTML = `<div class="spinner"></div>`;
    try {
      const failures = await API.get(API.org.chargeFailures());
      const unacked = failures.filter(f => !f.acknowledged);
      el.innerHTML = `
        <div class="page-header">
          <div>
            <div class="page-title">Failed Charges</div>
            <div class="page-subtitle">${failures.length} total • ${unacked.length} unacknowledged</div>
          </div>
          <div class="btn-group">
            ${unacked.length > 0 ? `<button class="btn btn-outline btn-sm" onclick="Pages.Failures.acknowledgeAll()">✓ Acknowledge All</button>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="Pages.Failures.render(document.getElementById('page-failures'))">↻ Refresh</button>
          </div>
        </div>

        ${unacked.length > 0 ? `<div class="alert alert-danger"><strong>${unacked.length} charge${unacked.length>1?'s':''} failed</strong> — Review and retry these charges. Account admins have been notified by email.</div>` : ''}

        ${failures.length === 0 ? `
          <div class="card"><div class="empty-state" style="padding:60px">
            <div class="empty-icon">✅</div><h3>No failed charges</h3><p>All charges have been processed successfully.</p>
          </div></div>` : `
          <div class="card">
            <div class="table-wrap"><table>
              <thead><tr><th>Date</th><th>Donor</th><th>Amount</th><th>Method</th><th>Reason</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                ${failures.map(f => `
                  <tr style="${f.acknowledged ? 'opacity:0.6' : ''}">
                    <td>${fmtDateTime(f.occurred_at)}</td>
                    <td>
                      <strong>${f.first_name} ${f.last_name}</strong><br>
                      ${f.email ? `<span style="font-size:11px;color:var(--gray-500)">${f.email}</span>` : ''}
                    </td>
                    <td class="amount">${fmt$(f.amount)}</td>
                    <td>${f.method_label || f.method_type || '—'}${f.last_four ? ` ••${f.last_four}` : ''}</td>
                    <td style="color:var(--danger);font-size:13px">${f.failure_reason || 'Unknown'}</td>
                    <td>${f.acknowledged ? `<span class="pill pill-green">Acknowledged</span>` : `<span class="pill pill-red">New</span>`}</td>
                    <td>
                      <div class="btn-group">
                        <button class="btn btn-blue btn-sm" onclick="Pages.DonorDetail.open('${f.donor_id}')">View Donor</button>
                        ${!f.acknowledged ? `<button class="btn btn-ghost btn-sm" onclick="Pages.Failures.acknowledge('${f.id}', this)">✓ Ack</button>` : ''}
                      </div>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table></div>
          </div>`}`;
    } catch (e) { el.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
  },

  async acknowledge(id, btn) {
    await API.post(`/api/orgs/${API.orgId}/charge-failures/${id}/acknowledge`, {});
    toast('Acknowledged');
    btn.closest('tr').style.opacity = '0.6';
    btn.remove();
    loadBadges();
  },

  async acknowledgeAll() {
    confirm('Acknowledge all failed charges?', async () => {
      await API.post(`/api/orgs/${API.orgId}/charge-failures/acknowledge-all`, {});
      toast('All acknowledged');
      await this.render(document.getElementById('page-failures'));
      loadBadges();
    });
  }
};

// public/js/pages/bank.js
Pages.Bank = {
  async render(el) {
    el.innerHTML = `<div class="spinner"></div>`;
    try {
      const txs = await API.get(`/api/orgs/${API.orgId}/bank/transactions`);
      el.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Bank Transactions</div><div class="page-subtitle">Chase Bank</div></div>
          <div class="btn-group">
            <button class="btn btn-ghost btn-sm" onclick="Pages.Bank.sync()">↻ Sync</button>
            <button class="btn btn-primary btn-sm" onclick="Pages.Bank.addConnection()">+ Connect Bank</button>
          </div>
        </div>
        <div class="card">
          <div class="search-bar">
            <div class="search-input-wrap" style="flex:1"><span class="search-icon">🔍</span>
              <input type="text" id="bank-search" placeholder="Search description or merchant...">
            </div>
            <select id="bank-dir">
              <option value="">All</option><option value="credit">Credits (In)</option><option value="debit">Debits (Out)</option>
            </select>
            <select id="bank-labeled">
              <option value="">All</option><option value="false">Unlabeled</option>
            </select>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Type</th><th>Label</th><th>Linked Donor</th><th>Actions</th></tr></thead>
            <tbody id="bank-tbody">
              ${txs.length ? txs.map(t => `<tr>
                <td>${fmtDate(t.transaction_date)}</td>
                <td>${t.description || t.merchant || '—'}</td>
                <td class="amount ${t.direction==='credit'?'positive':'negative'}">${t.direction==='debit'?'-':''}${fmt$(t.amount)}</td>
                <td>${t.direction==='credit'?'<span class="pill pill-green">Credit</span>':'<span class="pill pill-red">Debit</span>'}</td>
                <td>${t.label ? `<span class="pill pill-blue">${t.label}</span>` : '<span style="color:var(--gray-300)">—</span>'}</td>
                <td>${t.linked_donor_id ? `<a href="#" onclick="Pages.DonorDetail.open('${t.linked_donor_id}')">${t.linked_donor_id.slice(0,8)}...</a>` : '—'}</td>
                <td><button class="btn btn-ghost btn-sm" onclick="Pages.Bank.labelTx('${t.id}')">Label</button></td>
              </tr>`).join('') : '<tr><td colspan="7"><div class="empty-state" style="padding:40px"><div class="empty-icon">🏦</div><h3>No transactions</h3><p>Connect your Chase account and sync to see transactions.</p></div></td></tr>'}
            </tbody>
          </table></div>
        </div>`;
    } catch (e) { el.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
  },

  async sync() {
    try { await API.post(`/api/orgs/${API.orgId}/bank/sync`, {}); toast('Sync initiated'); }
    catch (e) { toast(e.message, 'error'); }
  },

  addConnection() {
    Modal.open('Connect Bank Account', `
      <div class="alert alert-info">Chase bank integration requires OAuth setup. Enter your Chase API credentials below.</div>
      <label>API Key</label><input id="bank-key" type="password" placeholder="Chase API Key">
      <label>API Secret</label><input id="bank-secret" type="password" placeholder="Chase API Secret">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Bank.saveConnection()">Connect</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async saveConnection() {
    try {
      await API.post(`/api/orgs/${API.orgId}/bank`, {
        api_key: document.getElementById('bank-key')?.value,
        api_secret: document.getElementById('bank-secret')?.value,
        bank_name: 'Chase'
      });
      toast('Bank connected'); Modal.close();
    } catch (e) { toast(e.message, 'error'); }
  },

  labelTx(id) {
    Modal.open('Label Transaction', `
      <label>Label</label>
      <input id="tx-label" placeholder="e.g. Donation, Office Expense...">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Bank.saveTxLabel('${id}')">Save</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async saveTxLabel(id) {
    try {
      await API.post(`/api/orgs/${API.orgId}/bank/transactions/${id}/label`, { label: document.getElementById('tx-label')?.value });
      toast('Label saved'); Modal.close();
      this.render(document.getElementById('page-bank'));
    } catch (e) { toast(e.message, 'error'); }
  }
};

// public/js/pages/emails.js
Pages.Emails = {
  async render(el) {
    el.innerHTML = `<div class="spinner"></div>`;
    try {
      const [settings, scheduled] = await Promise.all([
        API.get(API.org.emailSettings()),
        API.get(API.org.scheduledEmails())
      ]);
      el.innerHTML = `
        <div class="page-header"><div class="page-title">Email Settings</div></div>
        <div class="tabs">
          <div class="tab active" onclick="emailTab(this,'em-smtp')">SMTP Settings</div>
          <div class="tab" onclick="emailTab(this,'em-receipt')">Receipt Template</div>
          <div class="tab" onclick="emailTab(this,'em-schedule')">Scheduled Emails</div>
        </div>

        <div id="em-smtp" class="tab-content active">
          <div class="card">
            <div class="toggle-row">
              <div><div class="toggle-label">Pause all donation receipt emails</div></div>
              <label class="toggle"><input type="checkbox" id="em-pause-all" ${settings?.donation_emails_paused ? 'checked':''}><span class="toggle-slider"></span></label>
            </div>
            <hr class="section-divider">
            <div class="input-row input-row-2">
              <div><label>SMTP Email</label><input id="em-email" value="${settings?.smtp_email||''}" placeholder="you@gmail.com"></div>
              <div><label>From Name</label><input id="em-name" value="${settings?.from_name||''}" placeholder="My Synagogue"></div>
            </div>
            <div class="input-row input-row-2">
              <div><label>SMTP Host</label><input id="em-host" value="${settings?.smtp_host||'smtp.gmail.com'}"></div>
              <div><label>SMTP Port</label><input id="em-port" type="number" value="${settings?.smtp_port||587}"></div>
            </div>
            <div><label>App Password</label>
              <input id="em-pass" type="password" placeholder="Leave blank to keep current password">
              <small style="color:var(--gray-500)">For Gmail: use an App Password (Google Account → Security → App Passwords). Password is stored securely and never shown.</small>
            </div>
            <div class="btn-group" style="margin-top:16px">
              <button class="btn btn-primary" onclick="Pages.Emails.saveSmtp()">Save Settings</button>
              <button class="btn btn-ghost btn-sm" onclick="Pages.Emails.testEmail()">Send Test Email</button>
            </div>
          </div>
        </div>

        <div id="em-receipt" class="tab-content">
          <div class="card">
            <p style="color:var(--gray-500);margin-bottom:12px">Available variables: {first_name} {last_name} {title} {hebrew_name} {amount} {date} {transaction_id} {method} {last_four} {org_name}</p>
            <label>Donation Receipt Template (HTML)</label>
            <textarea id="em-receipt-tmpl" style="min-height:280px;font-family:monospace;font-size:13px">${settings?.receipt_template||''}</textarea>
            <label style="margin-top:12px">Marketing Email Template (HTML)</label>
            <textarea id="em-mkt-tmpl" style="min-height:200px;font-family:monospace;font-size:13px">${settings?.marketing_template||''}</textarea>
            <div style="margin-top:16px">
              <button class="btn btn-primary" onclick="Pages.Emails.saveTemplates()">Save Templates</button>
            </div>
          </div>
        </div>

        <div id="em-schedule" class="tab-content">
          <div class="card">
            <div style="display:flex;justify-content:space-between;margin-bottom:16px">
              <strong>Scheduled Emails</strong>
              <button class="btn btn-primary btn-sm" onclick="Pages.Emails.scheduleNew()">+ Schedule Email</button>
            </div>
            <div class="table-wrap"><table>
              <thead><tr><th>Subject</th><th>To</th><th>Scheduled</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                ${scheduled.map(e => `<tr>
                  <td>${e.subject}</td>
                  <td>${e.donor_id ? 'Donor' : 'All'}</td>
                  <td>${fmtDateTime(e.scheduled_for)}</td>
                  <td>${statusBadge(e.status)}</td>
                  <td>${e.status==='pending' ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.Emails.cancelScheduled('${e.id}')">Cancel</button>` : ''}</td>
                </tr>`).join('') || '<tr><td colspan="5"><div class="empty-state" style="padding:20px">No scheduled emails</div></td></tr>'}
              </tbody>
            </table></div>
          </div>
        </div>`;

      window.emailTab = (el, id) => {
        document.querySelectorAll('#page-emails .tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('#page-emails .tab-content').forEach(t => t.classList.remove('active'));
        el.classList.add('active'); document.getElementById(id)?.classList.add('active');
      };
    } catch (e) { el.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
  },

  async saveSmtp() {
    try {
      await API.put(API.org.emailSettings(), {
        smtp_email: document.getElementById('em-email')?.value,
        smtp_password: document.getElementById('em-pass')?.value || undefined,
        smtp_host: document.getElementById('em-host')?.value,
        smtp_port: parseInt(document.getElementById('em-port')?.value),
        from_name: document.getElementById('em-name')?.value,
        donation_emails_paused: document.getElementById('em-pause-all')?.checked ? 1 : 0
      });
      toast('Email settings saved');
    } catch (e) { toast(e.message, 'error'); }
  },

  async saveTemplates() {
    try {
      await API.put(API.org.emailSettings(), {
        receipt_template: document.getElementById('em-receipt-tmpl')?.value,
        marketing_template: document.getElementById('em-mkt-tmpl')?.value
      });
      toast('Templates saved');
    } catch (e) { toast(e.message, 'error'); }
  },

  testEmail() {
    Modal.open('Send Test Email', `
      <label>Send to</label>
      <input id="test-to" type="email" placeholder="your@email.com">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Emails.doTest()">Send</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doTest() {
    try {
      await API.post(`/api/orgs/${API.orgId}/email-settings/test`, { to: document.getElementById('test-to')?.value });
      toast('Test email sent ✓'); Modal.close();
    } catch (e) { toast(e.message, 'error'); }
  },

  scheduleNew() {
    const now = new Date(); now.setHours(now.getHours() + 1);
    Modal.open('Schedule Email', `
      <label>Subject</label>
      <input id="se-subject" placeholder="Email subject...">
      <label>Body (HTML)</label>
      <textarea id="se-body" style="min-height:160px;font-size:13px" placeholder="<p>Hello {first_name}...</p>"></textarea>
      <label>Schedule For</label>
      <input type="datetime-local" id="se-date" value="${toLocalInput(now.toISOString())}">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Emails.doSchedule()">Schedule</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doSchedule() {
    try {
      await API.post(API.org.scheduledEmails(), {
        subject: document.getElementById('se-subject')?.value,
        html_body: document.getElementById('se-body')?.value,
        scheduled_for: document.getElementById('se-date')?.value
      });
      toast('Email scheduled'); Modal.close();
      this.render(document.getElementById('page-emails'));
    } catch (e) { toast(e.message, 'error'); }
  },

  async cancelScheduled(id) {
    await API.del(`${API.org.scheduledEmails()}/${id}`);
    toast('Cancelled');
    this.render(document.getElementById('page-emails'));
  }
};

// public/js/pages/kvitel-page.js
Pages.KvitelPage = {
  async render(el) {
    el.innerHTML = `<div class="spinner"></div>`;
    try {
      const [settings, donors] = await Promise.all([
        API.get(API.org.kvitelSettings()),
        API.get(API.org.donors() + '?kvitel_enabled=1&limit=200')
      ]);
      const s = settings || {};

      el.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Kvitel Generator</div></div>
          <div class="btn-group">
            <button class="btn btn-outline" onclick="Pages.KvitelPage.generate('pdf')">⬇ Download PDF</button>
            <button class="btn btn-primary" onclick="Pages.KvitelPage.generate('docx')">⬇ Download DOCX</button>
          </div>
        </div>
        <div class="two-panel">
          <div class="card">
            <div class="card-title">Print Settings</div>
            <div class="input-row input-row-2">
              <div><label>Page Size</label>
                <select id="kv-pagesize">
                  <option value="letter" ${s.page_size==='letter'?'selected':''}>Letter (8.5×11)</option>
                  <option value="legal" ${s.page_size==='legal'?'selected':''}>Legal (8.5×14)</option>
                  <option value="a4" ${s.page_size==='a4'?'selected':''}>A4</option>
                </select>
              </div>
              <div><label>Columns</label>
                <select id="kv-cols">
                  ${[1,2,3,4].map(n=>`<option value="${n}" ${s.columns==n?'selected':''}>${n}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="input-row input-row-2">
              <div><label>Body Font</label>
                <select id="kv-font" onchange="Pages.KvitelPage.updatePreviewFont()">
                  <option value="Noto Sans Hebrew" ${s.font_family==='Noto Sans Hebrew'?'selected':''}>Noto Sans Hebrew</option>
                  <option value="Frank Ruhl Libre" ${s.font_family==='Frank Ruhl Libre'?'selected':''}>Frank Ruhl Libre</option>
                  <option value="Heebo" ${s.font_family==='Heebo'?'selected':''}>Heebo</option>
                  <option value="Narkisim" ${s.font_family==='Narkisim'?'selected':''}>Narkisim</option>
                  <option value="Times New Roman" ${s.font_family==='Times New Roman'?'selected':''}>Times New Roman</option>
                  <option value="Livvorn" ${s.font_family==='Livvorn'?'selected':''}>Livvorn (Livorna)</option>
                </select>
              </div>
              <div><label>Body Font Size (pt)</label>
                <input type="number" id="kv-fontsize" value="${s.font_size||12}" step="0.5" min="8" max="24">
              </div>
            </div>
            <div class="input-row input-row-2">
              <div><label>Column Gap (in)</label><input type="number" id="kv-gap" value="${s.column_gap||0.5}" step="0.1" min="0" max="2"></div>
              <div><label>Line Height</label><input type="number" id="kv-lh" value="${s.line_height||1.6}" step="0.1" min="1" max="3"></div>
            </div>
            <div class="input-row input-row-4" style="margin-top:4px">
              ${['top','bottom','left','right'].map(m=>`<div><label>Margin ${m} (in)</label><input type="number" id="kv-m${m}" value="${s['margin_'+m]||1}" step="0.25" min="0" max="3"></div>`).join('')}
            </div>
            <div class="toggle-row" style="margin-top:8px">
              <div class="toggle-label">Group by Neighborhood</div>
              <label class="toggle"><input type="checkbox" id="kv-bynh" ${s.group_by_neighborhood!==0?'checked':''}><span class="toggle-slider"></span></label>
            </div>

            <hr class="section-divider">
            <div class="card-title" style="margin-bottom:10px">Header</div>
            <div class="input-row input-row-2">
              <div><label>Header Text</label>
                <input id="kv-header-text" value="${(s.header_html||'').replace(/<[^>]+>/g,'')}" placeholder="Organization Name — Kvitel">
              </div>
              <div><label>Header Font</label>
                <select id="kv-hfont">
                  ${['Noto Sans Hebrew','Frank Ruhl Libre','Heebo','Narkisim','Times New Roman','Livvorn'].map(f=>`<option ${(s.header_font||'Frank Ruhl Libre')===f?'selected':''}>${f}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="input-row input-row-4" style="margin-top:4px">
              <div><label>Size (pt)</label><input type="number" id="kv-hsize" value="${s.header_size||18}" min="10" max="48"></div>
              <div><label>Bold</label><br>
                <label class="toggle" style="margin-top:6px"><input type="checkbox" id="kv-hbold" ${s.header_bold!==0?'checked':''}><span class="toggle-slider"></span></label>
              </div>
              <div><label>Alignment</label>
                <select id="kv-halign">
                  <option value="center" ${(s.header_align||'center')==='center'?'selected':''}>Center</option>
                  <option value="right" ${s.header_align==='right'?'selected':''}>Right</option>
                  <option value="left" ${s.header_align==='left'?'selected':''}>Left</option>
                </select>
              </div>
              <div><label>Direction</label>
                <select id="kv-hdir">
                  <option value="rtl" ${(s.header_dir||'rtl')==='rtl'?'selected':''}>RTL (Hebrew)</option>
                  <option value="ltr" ${s.header_dir==='ltr'?'selected':''}>LTR</option>
                </select>
              </div>
            </div>

            <div style="margin-top:14px">
              <button class="btn btn-primary" onclick="Pages.KvitelPage.saveSettings()">Save Settings</button>
            </div>
          </div>

          <div class="card">
            <div class="card-title">Preview <span style="font-size:12px;color:var(--gray-500)">(RTL, always)</span></div>
            <div class="kvitel-preview" id="kv-preview" style="font-family:${s.font_family||'Noto Sans Hebrew'}">
              ${this.buildPreview(donors.donors || [])}
            </div>
            <p style="font-size:12px;color:var(--gray-500);margin-top:8px">
              ${(donors.donors||[]).filter(d=>d.kvitel).length} donors with kvitel content
            </p>
          </div>
        </div>`;
    } catch (e) { el.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
  },

  buildPreview(donors) {
    if (!donors.length) return '<p style="color:var(--gray-500)">No donors with kvitel content</p>';
    return donors.filter(d => d.kvitel).slice(0, 20).map(d =>
      `<div style="margin-bottom:16px">
        <strong>${d.hebrew_full_name || d.first_name + ' ' + d.last_name}</strong>
        ${d.neighborhood_name ? `<span style="font-size:11px;color:var(--gray-500)"> — ${d.neighborhood_name}</span>` : ''}
        <div style="font-size:13px;white-space:pre-line;margin-top:4px">${d.kvitel}</div>
      </div>`
    ).join('<hr style="border:none;border-top:1px solid #eee;margin:8px 0">');
  },

  updatePreviewFont() {
    const font = document.getElementById('kv-font')?.value;
    const prev = document.getElementById('kv-preview');
    if (prev && font) prev.style.fontFamily = font;
  },

  async saveSettings() {
    try {
      const headerText = document.getElementById('kv-header-text')?.value || '';
      const hfont = document.getElementById('kv-hfont')?.value || 'Frank Ruhl Libre';
      const hsize = parseFloat(document.getElementById('kv-hsize')?.value || 18);
      const hbold = document.getElementById('kv-hbold')?.checked !== false;
      const halign = document.getElementById('kv-halign')?.value || 'center';
      const hdir = document.getElementById('kv-hdir')?.value || 'rtl';
      // Build header_html from settings
      const headerHtml = `<p style="font-family:${hfont};font-size:${hsize}pt;font-weight:${hbold?'bold':'normal'};text-align:${halign};direction:${hdir}">${headerText}</p>`;

      await API.put(API.org.kvitelSettings(), {
        header_html: headerHtml,
        header_font: hfont, header_size: hsize,
        header_bold: hbold ? 1 : 0, header_align: halign, header_dir: hdir,
        page_size: document.getElementById('kv-pagesize')?.value,
        columns: parseInt(document.getElementById('kv-cols')?.value),
        column_gap: parseFloat(document.getElementById('kv-gap')?.value),
        font_family: document.getElementById('kv-font')?.value,
        font_size: parseFloat(document.getElementById('kv-fontsize')?.value),
        line_height: parseFloat(document.getElementById('kv-lh')?.value),
        margin_top: parseFloat(document.getElementById('kv-mtop')?.value),
        margin_bottom: parseFloat(document.getElementById('kv-mbottom')?.value),
        margin_left: parseFloat(document.getElementById('kv-mleft')?.value),
        margin_right: parseFloat(document.getElementById('kv-mright')?.value),
        group_by_neighborhood: document.getElementById('kv-bynh')?.checked ? 1 : 0
      });
      toast('Settings saved');
    } catch (e) { toast(e.message, 'error'); }
  },

  async generate(type) {
    try {
      toast(`Generating ${type.toUpperCase()}...`);
      await API.download(`/api/orgs/${API.orgId}/kvitel/generate-${type}`, `kvitel.${type}`);
    } catch (e) { toast(e.message, 'error'); }
  }
};

// public/js/pages/reports.js
Pages.Reports = {
  async render(el) {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';

    el.innerHTML = `
      <div class="page-header"><div class="page-title">Reports</div></div>
      <div class="card" style="margin-bottom:20px">
        <div class="card-title">Donation Report</div>
        <div class="input-row input-row-4">
          <div><label>From</label><input type="date" id="rep-from" value="${monthStart}"></div>
          <div><label>To</label><input type="date" id="rep-to" value="${today}"></div>
          <div><label>Method</label>
            <select id="rep-method">
              <option value="">All Methods</option>
              ${['credit_card','daf','check','cash','wire','other'].map(m=>`<option>${m}</option>`).join('')}
            </select>
          </div>
          <div><label>Status</label>
            <select id="rep-status">
              <option value="">All</option>
              <option value="completed">Completed</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>
        <div class="btn-group" style="margin-top:16px">
          <button class="btn btn-primary" onclick="Pages.Reports.load()">Generate Report</button>
          <button class="btn btn-ghost btn-sm" onclick="Pages.Reports.downloadXlsx()">⬇ Export XLSX</button>
          <button class="btn btn-ghost btn-sm" onclick="Pages.Reports.exportDonors()">⬇ Export Donors XLSX</button>
        </div>
      </div>
      <div id="rep-results"></div>`;
  },

  getParams() {
    return new URLSearchParams({
      from: document.getElementById('rep-from')?.value || '',
      to: document.getElementById('rep-to')?.value || '',
      method: document.getElementById('rep-method')?.value || '',
      status: document.getElementById('rep-status')?.value || ''
    });
  },

  async load() {
    const res = document.getElementById('rep-results');
    res.innerHTML = '<div class="spinner"></div>';
    try {
      const rows = await API.get(`/api/orgs/${API.orgId}/reports/donations?${this.getParams()}`);
      const total = rows.reduce((s, r) => s + (r.amount || 0), 0);

      res.innerHTML = `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <strong>${rows.length} donations • Total: ${fmt$(total)}</strong>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Donor</th><th>Amount</th><th>Method</th><th>Status</th><th>Trans ID</th><th>Notes</th></tr></thead>
            <tbody>
              ${rows.map(d => `<tr>
                <td>${fmtDate(d.donation_date)}</td>
                <td><strong>${d.first_name} ${d.last_name}</strong></td>
                <td class="amount">${fmt$(d.amount)}</td>
                <td>${d.method}${d.last_four ? ` ••${d.last_four}` : ''}</td>
                <td>${statusBadge(d.status)}</td>
                <td style="font-size:11px">${d.transaction_id||'—'}</td>
                <td style="font-size:12px">${d.notes||''}</td>
              </tr>`).join('') || '<tr><td colspan="7"><div class="empty-state" style="padding:20px">No results</div></td></tr>'}
            </tbody>
          </table></div>
        </div>`;
    } catch (e) { res.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
  },

  downloadXlsx() {
    const params = this.getParams();
    params.set('format', 'xlsx');
    API.downloadGet(`/api/orgs/${API.orgId}/reports/donations?${params}`, 'donations-report.xlsx')
      .catch(e => toast(e.message, 'error'));
  },

  exportDonors() {
    API.downloadGet(`/api/orgs/${API.orgId}/reports/donors?format=xlsx`, 'donors-export.xlsx')
      .catch(e => toast(e.message, 'error'));
  }
};

// public/js/pages/settings.js
Pages.Settings = {
  async render(el) {
    el.innerHTML = `<div class="spinner"></div>`;
    try {
      const [users, loginLog, daf, sola, neighborhoods] = await Promise.all([
        API.get(API.org.users()),
        API.get(API.org.loginLog()),
        API.get(API.org.daf()),
        API.get(`/api/orgs/${API.orgId}/sola`).catch(() => null),
        API.get(API.org.neighborhoods())
      ]);

      el.innerHTML = `
        <div class="page-header"><div class="page-title">Settings</div></div>
        <div class="tabs">
          <div class="tab active" onclick="stTab(this,'st-users')">Users</div>
          <div class="tab" onclick="stTab(this,'st-nh')">Neighborhoods</div>
          <div class="tab" onclick="stTab(this,'st-daf')">DAF Accounts</div>
          <div class="tab" onclick="stTab(this,'st-sola')">Sola Payments</div>
          <div class="tab" onclick="stTab(this,'st-log')">Login Log</div>
        </div>

        <!-- USERS -->
        <div id="st-users" class="tab-content active">
          <div class="card">
            <div style="display:flex;justify-content:space-between;margin-bottom:16px;align-items:center">
              <strong>Organization Users</strong>
              <div class="btn-group">
                ${window.DRM?.user?.is_super_admin ? `<button class="btn btn-outline btn-sm" onclick="Pages.Settings.inviteAccount()">+ Invite New Account</button>` : ''}
                <button class="btn btn-primary btn-sm" onclick="Pages.Settings.addUser()">+ Invite User</button>
              </div>
            </div>
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Login</th><th>Actions</th></tr></thead>
              <tbody>
                ${users.map(u => `<tr>
                  <td><strong>${u.full_name}</strong></td>
                  <td>${u.email}</td>
                  <td><span class="pill ${u.role==='admin'?'pill-blue':'pill-gray'}">${u.role}</span></td>
                  <td>${fmtDateTime(u.last_login)}</td>
                  <td>
                    <div class="btn-group">
                      <button class="btn btn-ghost btn-sm" onclick="Pages.Settings.resetPassword('${u.id}','${u.full_name}')">Reset Password</button>
                      <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.Settings.removeUser('${u.id}','${u.full_name}')">Remove</button>
                    </div>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- NEIGHBORHOODS -->
        <div id="st-nh" class="tab-content">
          <div class="card">
            <div style="display:flex;justify-content:space-between;margin-bottom:16px">
              <strong>Neighborhoods</strong>
              <button class="btn btn-primary btn-sm" onclick="Pages.Settings.addNeighborhood()">+ Add</button>
            </div>
            <div id="nh-list">
              ${neighborhoods.map(n => `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--gray-100)">
                <span class="he" style="font-size:16px">${n.name_he}</span>
                <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.Settings.deleteNeighborhood('${n.id}')">Remove</button>
              </div>`).join('')}
            </div>
          </div>
        </div>

        <!-- DAF -->
        <div id="st-daf" class="tab-content">
          <div class="card">
            <div style="display:flex;justify-content:space-between;margin-bottom:16px">
              <strong>DAF Accounts</strong>
              <button class="btn btn-primary btn-sm" onclick="Pages.Settings.addDaf()">+ Add DAF</button>
            </div>
            <div id="daf-list">
              ${daf.map(d => `<div class="card" style="margin-bottom:10px;padding:14px">
                <div style="display:flex;justify-content:space-between">
                  <div>
                    <strong>${d.name}</strong>${d.account_number ? ` — ${d.account_number}` : ''}<br>
                    ${d.contact_name ? `<span style="font-size:12px;color:var(--gray-500)">${d.contact_name} ${d.contact_email || ''}</span>` : ''}
                  </div>
                  <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.Settings.deleteDaf('${d.id}')">Remove</button>
                </div>
              </div>`).join('') || '<p style="color:var(--gray-500)">No DAF accounts added</p>'}
            </div>
          </div>
        </div>

        <!-- SOLA -->
        <div id="st-sola" class="tab-content">
          <div class="card">
            <div class="card-title">Sola Payment Processing</div>
            <label>API Key</label>
            <input id="sola-key" type="password" placeholder="Sola API Key">
            <label>Merchant ID</label>
            <input id="sola-mid" value="${sola?.merchant_id||''}" placeholder="Merchant ID">
            <div style="margin-top:16px">
              <button class="btn btn-primary" onclick="Pages.Settings.saveSola()">Save Sola Settings</button>
            </div>
          </div>
        </div>

        <!-- LOGIN LOG -->
        <div id="st-log" class="tab-content">
          <div class="card">
            <div class="card-title">Login Audit Log</div>
            <div class="scroll-list">
              <table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>IP</th></tr></thead>
              <tbody>
                ${loginLog.slice(0, 100).map(l => `<tr>
                  <td>${fmtDateTime(l.created_at)}</td>
                  <td>${l.full_name}</td>
                  <td><span class="pill ${l.action==='login'?'pill-green':'pill-gray'}">${l.action}</span></td>
                  <td style="font-size:11px;color:var(--gray-500)">${l.ip||'—'}</td>
                </tr>`).join('')}
              </tbody></table>
            </div>
          </div>
        </div>`;

      window.stTab = (el, id) => {
        document.querySelectorAll('#page-settings .tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('#page-settings .tab-content').forEach(t => t.classList.remove('active'));
        el.classList.add('active'); document.getElementById(id)?.classList.add('active');
      };
    } catch (e) { el.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
  },

  inviteAccount() {
    Modal.open('Invite New Account', `
      <p style="color:var(--gray-500);margin-bottom:16px">
        Enter the email address of the person who will run the new organization.
        They'll receive a setup link to create their org name, admin account, and password themselves.
      </p>
      <label>Email Address *</label>
      <input id="ia-email" type="email" placeholder="rabbi@newshul.org" autocomplete="off">
      <div id="ia-result" style="display:none;margin-top:14px"></div>
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Settings.doInviteAccount()">Send Invite</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doInviteAccount() {
    const email = document.getElementById('ia-email')?.value?.trim();
    if (!email) { toast('Email required', 'error'); return; }
    try {
      const res = await API.post('/auth/invite-account', { email });
      const resultEl = document.getElementById('ia-result');
      if (res.emailSent) {
        resultEl.innerHTML = `<div class="alert alert-success">✓ Invite sent to <strong>${email}</strong>. They'll get an email with a setup link valid for 7 days.</div>`;
      } else {
        resultEl.innerHTML = `<div class="alert alert-warning">
          <strong>Email not sent</strong> — add SIGNUP_SMTP_EMAIL and SIGNUP_SMTP_PASSWORD to your Render env vars to enable invite emails.<br><br>
          In the meantime, share this link manually:<br>
          <a href="${res.setupUrl}" target="_blank" style="word-break:break-all;font-size:12px;color:var(--blue)">${res.setupUrl}</a>
        </div>`;
      }
      resultEl.style.display = 'block';
    } catch (e) { toast(e.message, 'error'); }
  },

  addUser() {
    Modal.open('Invite User', `
      <p style="color:var(--gray-500);margin-bottom:16px">Enter their email address. They'll receive a setup link to create their own password.</p>
      <label>Email Address *</label>
      <input id="nu-email" type="email" placeholder="user@example.com" autocomplete="off">
      <label>Role</label>
      <select id="nu-role">
        <option value="staff">Staff</option>
        <option value="admin">Admin</option>
      </select>
      <div id="invite-result" style="display:none;margin-top:12px"></div>
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Settings.doInvite()">Send Invite Email</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doInvite() {
    const email = document.getElementById('nu-email')?.value?.trim();
    const role = document.getElementById('nu-role')?.value;
    if (!email) { toast('Email required', 'error'); return; }
    try {
      const res = await API.post(`/api/orgs/${API.orgId}/users/invite`, { email, role });
      const resultEl = document.getElementById('invite-result');
      if (res.emailSent) {
        resultEl.innerHTML = `<div class="alert alert-success">✓ Invite sent to <strong>${email}</strong>. They'll get an email with a setup link.</div>`;
      } else {
        resultEl.innerHTML = `<div class="alert alert-warning">
          <strong>Email not sent</strong> — SIGNUP_SMTP_EMAIL not configured.<br>
          Share this setup link manually:<br>
          <a href="${res.setupUrl}" target="_blank" style="word-break:break-all;font-size:12px">${res.setupUrl}</a>
        </div>`;
      }
      resultEl.style.display = 'block';
      this.render(document.getElementById('page-settings'));
    } catch (e) { toast(e.message, 'error'); }
  },

  resetPassword(id, name) {
    Modal.open('Reset Password', `
      <p>Set new password for <strong>${name}</strong></p>
      <label>New Password</label>
      <input id="rp-pass" type="password" placeholder="New password (min 6 chars)">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Settings.doResetPw('${id}')">Set Password</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doResetPw(id) {
    try {
      await API.put(`/api/orgs/${API.orgId}/users/${id}/password`, { password: document.getElementById('rp-pass')?.value });
      toast('Password updated'); Modal.close();
    } catch (e) { toast(e.message, 'error'); }
  },

  removeUser(id, name) {
    confirm(`Remove ${name} from this organization?`, async () => {
      await API.del(`/api/orgs/${API.orgId}/users/${id}`);
      toast('User removed');
      this.render(document.getElementById('page-settings'));
    });
  },

  addNeighborhood() {
    Modal.open('Add Neighborhood', `
      <label>Hebrew Name</label>
      <input id="nh-hname" class="he" dir="rtl" placeholder="שם השכונה">
      <label>English Name (optional)</label>
      <input id="nh-ename" placeholder="Borough Park">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Settings.doAddNh()">Add</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doAddNh() {
    try {
      await API.post(API.org.neighborhoods(), {
        name_he: document.getElementById('nh-hname')?.value,
        name_en: document.getElementById('nh-ename')?.value
      });
      toast('Neighborhood added'); Modal.close();
      this.render(document.getElementById('page-settings'));
    } catch (e) { toast(e.message, 'error'); }
  },

  deleteNeighborhood(id) {
    confirm('Remove this neighborhood?', async () => {
      await API.del(`${API.org.neighborhoods()}/${id}`);
      toast('Removed');
      this.render(document.getElementById('page-settings'));
    });
  },

  addDaf() {
    Modal.open('Add DAF Account', `
      <label>DAF Name *</label><input id="daf-name" placeholder="Fidelity Charitable">
      <label>Account Number</label><input id="daf-acct" placeholder="Optional">
      <label>Contact Name</label><input id="daf-cname" placeholder="Optional">
      <label>Contact Email</label><input id="daf-email" placeholder="Optional">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.Settings.doAddDaf()">Add DAF</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doAddDaf() {
    try {
      await API.post(API.org.daf(), {
        name: document.getElementById('daf-name')?.value,
        account_number: document.getElementById('daf-acct')?.value,
        contact_name: document.getElementById('daf-cname')?.value,
        contact_email: document.getElementById('daf-email')?.value
      });
      toast('DAF account added'); Modal.close();
      this.render(document.getElementById('page-settings'));
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteDaf(id) {
    confirm('Remove this DAF account?', async () => {
      await API.del(`${API.org.daf()}/${id}`);
      toast('Removed');
      this.render(document.getElementById('page-settings'));
    });
  },

  async saveSola() {
    try {
      await API.put(`/api/orgs/${API.orgId}/sola`, {
        api_key: document.getElementById('sola-key')?.value,
        merchant_id: document.getElementById('sola-mid')?.value
      });
      toast('Sola settings saved');
    } catch (e) { toast(e.message, 'error'); }
  }
};
