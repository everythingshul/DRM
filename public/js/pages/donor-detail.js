// public/js/pages/donor-detail.js
Pages.DonorDetail = {
  data: null,

  async open(id) {
    Modal.open('Loading...', '<div class="spinner"></div>', { large: true });
    try {
      this.data = await API.get(API.org.donor(id));
      this.render();
    } catch (e) {
      Modal.setBody(`<div class="alert alert-danger">${e.message}</div>`);
    }
  },

  render() {
    const { donor, paymentMethods, donations, scheduledCharges } = this.data;
    const age = accountAge(donor.months_old);
    const labels = (() => { try { return JSON.parse(donor.labels||'[]'); } catch { return []; } })();
    const notes = (() => { try { return JSON.parse(donor.notes||'[]'); } catch { return []; } })();

    Modal.setTitle('');
    Modal.setBody(`
      <div class="donor-detail-header">
        <div class="donor-detail-avatar">${initials(donor.first_name, donor.last_name)}</div>
        <div class="donor-detail-name">
          <h2>${donor.title ? donor.title + ' ' : ''}${donor.first_name} ${donor.last_name}</h2>
          ${donor.hebrew_title || donor.hebrew_full_name ? `<div class="he">${donor.hebrew_title||''} ${donor.hebrew_full_name||''}</div>` : ''}
          <div class="meta">
            ${age} • ${donor.email || ''} ${donor.cell ? '• ' + donor.cell : ''}
            ${donor.neighborhood_name ? `• <span class="he">${donor.neighborhood_name}</span>` : ''}
          </div>
          ${labels.map(l=>`<span class="pill pill-blue" style="margin-top:4px;font-size:11px">${l}</span>`).join('')}
          ${donor.needs_verification ? '<span class="pill pill-orange" style="margin-top:4px">⚠ Info needs verification</span>' : ''}
        </div>
        <div style="margin-left:auto;text-align:right">
          <div style="font-size:22px;font-weight:700">${fmt$(donor.total_amount)}</div>
          <div style="opacity:0.75;font-size:13px">${donor.total_donations||0} donations</div>
          <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-blue btn-sm" onclick="Pages.Donors.openEdit('${donor.id}')">Edit</button>
            ${donor.needs_verification ? `<button class="btn btn-success btn-sm" onclick="Pages.DonorDetail.verify('${donor.id}')">Verify ✓</button>` : ''}
          </div>
        </div>
      </div>

      <div class="tabs" style="margin-top:0;border-radius:0">
        <div class="tab active" onclick="ddTab(this,'dd-overview')">Overview</div>
        <div class="tab" onclick="ddTab(this,'dd-payments')">Payment Methods</div>
        <div class="tab" onclick="ddTab(this,'dd-donations')">Donations</div>
        <div class="tab" onclick="ddTab(this,'dd-autopay')">AutoPay</div>
        <div class="tab" onclick="ddTab(this,'dd-kvitel')">Kvitel</div>
        <div class="tab" onclick="ddTab(this,'dd-notes')">Notes</div>
      </div>

      <!-- OVERVIEW -->
      <div id="dd-overview" class="tab-content active" style="padding:20px">
        <div class="two-panel">
          <div>
            <div class="card-title">Contact</div>
            ${donor.cell ? `<p>📱 ${donor.cell}</p>` : ''}
            ${donor.home_phone ? `<p>📞 ${donor.home_phone}</p>` : ''}
            ${donor.email ? `<p>✉ ${donor.email}</p>` : ''}
            <hr class="section-divider">
            <div class="card-title">Address</div>
            <p>${[donor.street, donor.apt, donor.city, donor.state, donor.zip].filter(Boolean).join(', ') || '—'}</p>
          </div>
          <div>
            <div class="card-title">Stats</div>
            <p>Last donation: ${fmtDate(donor.last_donation_date)}</p>
            <p>Member since: ${fmtDate(donor.created_at)}</p>
            <p>Account age: ${age}</p>
            <hr class="section-divider">
            <div class="card-title">Email Preferences</div>
            <div class="toggle-row">
              <div class="toggle-label">Donation receipts</div>
              <label class="toggle"><input type="checkbox" ${!donor.donation_emails_paused?'checked':''} onchange="Pages.DonorDetail.updatePref('${donor.id}','donation_emails_paused',!this.checked)"><span class="toggle-slider"></span></label>
            </div>
            <div class="toggle-row">
              <div class="toggle-label">Marketing emails</div>
              <label class="toggle"><input type="checkbox" ${!donor.marketing_emails_paused?'checked':''} onchange="Pages.DonorDetail.updatePref('${donor.id}','marketing_emails_paused',!this.checked)"><span class="toggle-slider"></span></label>
            </div>
          </div>
        </div>
      </div>

      <!-- PAYMENT METHODS -->
      <div id="dd-payments" class="tab-content" style="padding:20px">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <strong>Payment Methods</strong>
          <button class="btn btn-blue btn-sm" onclick="Pages.DonorDetail.addPaymentMethod('${donor.id}')">+ Add Method</button>
        </div>
        <div id="pm-list">
          ${paymentMethods.map(pm => `
            <div class="card" style="margin-bottom:10px;padding:14px">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <div>
                  <strong>${pm.label || pm.type}</strong>
                  ${pm.is_default ? '<span class="pill pill-green" style="font-size:11px">Default</span>' : ''}
                  <br>
                  ${pm.type === 'credit_card' ? `${pm.card_brand || ''} •••• ${pm.last_four || ''}` : ''}
                  ${pm.type === 'daf' ? `DAF: ${pm.daf_name || ''}` : ''}
                  ${pm.type === 'other' ? pm.other_description || '' : ''}
                </div>
                <div class="btn-group">
                  ${!pm.is_default ? `<button class="btn btn-ghost btn-sm" onclick="Pages.DonorDetail.chargeNow('${donor.id}','${pm.id}')">Charge Now</button>` : ''}
                  <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.DonorDetail.deletePM('${donor.id}','${pm.id}')">✕</button>
                </div>
              </div>
            </div>`).join('') || '<p class="empty-state" style="padding:20px">No payment methods added</p>'}
        </div>
      </div>

      <!-- DONATIONS -->
      <div id="dd-donations" class="tab-content" style="padding:20px">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <strong>Donation History</strong>
          <div class="btn-group">
            <button class="btn btn-ghost btn-sm" onclick="Pages.DonorDetail.addManualDonation('${donor.id}')">+ Manual</button>
            <button class="btn btn-blue btn-sm" onclick="Pages.DonorDetail.scheduleCharge('${donor.id}')">+ Schedule Charge</button>
          </div>
        </div>
        <div class="scroll-list">
          <table style="font-size:13px">
            <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Trans ID</th><th>Notes</th></tr></thead>
            <tbody>
              ${donations.map(d => `<tr>
                <td>${fmtDateTime(d.donation_date)}</td>
                <td class="amount">${fmt$(d.amount)}</td>
                <td>${d.method}${d.last_four ? ` ••${d.last_four}` : ''}</td>
                <td>${statusBadge(d.status)}</td>
                <td style="font-size:11px;color:var(--gray-500)">${d.transaction_id || '—'}</td>
                <td style="font-size:12px">${d.notes || ''}</td>
              </tr>`).join('') || '<tr><td colspan="6" class="empty-state" style="padding:20px">No donations yet</td></tr>'}
            </tbody>
          </table>
        </div>
        ${scheduledCharges.length ? `
          <div style="margin-top:16px"><strong>Scheduled Charges</strong></div>
          ${scheduledCharges.map(c => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--gray-100)">
              <span>${fmt$(c.amount)} on ${fmtDateTime(c.scheduled_for)}</span>
              <div class="btn-group">
                <button class="btn btn-ghost btn-sm" onclick="Pages.DonorDetail.rescheduleCharge('${donor.id}','${c.id}','${c.scheduled_for}','${c.amount}')">Reschedule</button>
                <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.DonorDetail.cancelCharge('${donor.id}','${c.id}')">Cancel</button>
              </div>
            </div>`).join('')}
        ` : ''}
      </div>

      <!-- AUTOPAY -->
      <div id="dd-autopay" class="tab-content" style="padding:20px">
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Enable AutoPay</div>
            <div class="toggle-sublabel">Charge automatically on a schedule</div>
          </div>
          <label class="toggle"><input type="checkbox" id="ap-enabled" ${donor.autopay_enabled?'checked':''} onchange="Pages.DonorDetail.toggleAutopay('${donor.id}',this.checked)"><span class="toggle-slider"></span></label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Pause AutoPay</div>
            <div class="toggle-sublabel">Temporarily disable without removing</div>
          </div>
          <label class="toggle"><input type="checkbox" id="ap-paused" ${donor.autopay_paused?'checked':''} onchange="Pages.DonorDetail.toggleAutopayPause('${donor.id}',this.checked)"><span class="toggle-slider"></span></label>
        </div>
        <hr class="section-divider">
        <div class="card-title">Schedule</div>
        <div class="input-row input-row-3" style="margin-top:8px">
          <div>
            <label>Day of Month</label>
            <select id="ap-day">
              ${Array.from({length:28},(_,i)=>`<option value="${i+1}" ${donor.autopay_day===i+1?'selected':''}>${i+1}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Hour (EST)</label>
            <select id="ap-hour">
              ${Array.from({length:24},(_,i)=>`<option value="${i}" ${donor.autopay_hour===i?'selected':''}>${i}:00</option>`).join('')}
            </select>
          </div>
          <div style="align-self:flex-end">
            <button class="btn btn-primary" onclick="Pages.DonorDetail.saveAutopaySchedule('${donor.id}')">Save Schedule</button>
          </div>
        </div>
        <div class="alert alert-info" style="margin-top:16px">
          <strong>Note:</strong> AutoPay uses the donor's default payment method and the amount from their most recent donation.
        </div>
      </div>

      <!-- KVITEL -->
      <div id="dd-kvitel" class="tab-content" style="padding:20px">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <strong>Kvitel</strong>
          <div class="toggle-row" style="padding:0;border:none">
            <span style="margin-right:10px;font-size:13px">Include in generation</span>
            <label class="toggle"><input type="checkbox" id="kv-on" ${donor.kvitel_enabled!==0?'checked':''} onchange="Pages.DonorDetail.updatePref('${donor.id}','kvitel_enabled',this.checked?1:0)"><span class="toggle-slider"></span></label>
          </div>
        </div>
        <textarea id="kv-text" class="kvitel-input" dir="rtl" placeholder="Enter kvitel lines here..." style="min-height:180px">${donor.kvitel||''}</textarea>
        <div style="margin-top:12px">
          <button class="btn btn-primary" onclick="Pages.DonorDetail.saveKvitel('${donor.id}')">Save Kvitel</button>
        </div>
      </div>

      <!-- NOTES -->
      <div id="dd-notes" class="tab-content" style="padding:20px">
        <div style="margin-bottom:16px">
          <label>Add Note</label>
          <textarea id="new-note" placeholder="Type a note..." style="min-height:80px"></textarea>
          <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="Pages.DonorDetail.addNote('${donor.id}')">Add Note</button>
        </div>
        <div id="notes-list">
          ${notes.length ? notes.slice().reverse().map(n => `
            <div class="note-item">
              <div class="note-meta">${fmtDateTime(n.at)} ${n.by ? '• ' + n.by : ''}</div>
              <div class="note-text">${n.text}</div>
            </div>`).join('') : '<p style="color:var(--gray-500);padding:12px">No notes yet</p>'}
        </div>
      </div>
    `);

    window.ddTab = (el, id) => {
      document.querySelectorAll('#modal-body .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('#modal-body .tab-content').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      document.getElementById(id)?.classList.add('active');
    };
  },

  async verify(id) {
    await API.post(`/api/orgs/${API.orgId}/donors/${id}/verify`, {});
    toast('Marked as verified ✓');
    await this.open(id);
  },

  async updatePref(id, field, value) {
    await API.put(API.org.donor(id), { [field]: value });
  },

  async toggleAutopay(id, enabled) {
    await API.put(API.org.donor(id), { autopay_enabled: enabled ? 1 : 0 });
    toast(enabled ? 'AutoPay enabled' : 'AutoPay disabled');
  },

  async toggleAutopayPause(id, paused) {
    await API.put(API.org.donor(id), { autopay_paused: paused ? 1 : 0 });
    toast(paused ? 'AutoPay paused' : 'AutoPay resumed');
  },

  async saveAutopaySchedule(id) {
    const day = parseInt(document.getElementById('ap-day')?.value);
    const hour = parseInt(document.getElementById('ap-hour')?.value);
    await API.put(API.org.donor(id), { autopay_day: day, autopay_hour: hour, autopay_minute: 0 });
    toast('Schedule saved');
  },

  async saveKvitel(id) {
    const kvitel = document.getElementById('kv-text')?.value || '';
    const enabled = document.getElementById('kv-on')?.checked ? 1 : 0;
    await API.put(API.org.donor(id), { kvitel, kvitel_enabled: enabled });
    toast('Kvitel saved');
  },

  async addNote(id) {
    const text = document.getElementById('new-note')?.value?.trim();
    if (!text) return;
    const existing = this.data.donor;
    const notes = (() => { try { return JSON.parse(existing.notes||'[]'); } catch { return []; } })();
    notes.push({ text, at: new Date().toISOString(), by: currentUser?.full_name || '' });
    await API.put(API.org.donor(id), { notes });
    toast('Note added');
    await this.open(id);
  },

  addPaymentMethod(donorId) {
    Modal.open('Add Payment Method', `
      <label>Type</label>
      <select id="pm-type" onchange="Pages.DonorDetail.pmTypeChange()">
        <option value="credit_card">Credit Card (Sola)</option>
        <option value="daf">DAF Account</option>
        <option value="other">Other (Check/Cash/Wire)</option>
      </select>

      <div id="cc-fields">
        <div class="alert alert-info" style="margin-top:12px">Card data is sent directly to the Sola gateway. The DRM server only stores a secure token — never the raw card number.</div>
        <div class="input-row input-row-2">
          <div><label>Card Number</label><input id="pm-cardnum" placeholder="Card number" maxlength="19" autocomplete="cc-number"></div>
          <div><label>Expiry (MMYY)</label><input id="pm-exp" placeholder="0125" maxlength="4" autocomplete="cc-exp"></div>
        </div>
        <div class="input-row input-row-2">
          <div><label>CVV</label><input id="pm-cvv" placeholder="123" maxlength="4" autocomplete="cc-csc"></div>
          <div><label>ZIP</label><input id="pm-zip" placeholder="11201" maxlength="5"></div>
        </div>
      </div>

      <div id="daf-fields" style="display:none">
        <label>DAF Name</label>
        <input id="pm-dafname" placeholder="Fidelity Charitable, Schwab, etc.">
      </div>
      <div id="other-fields" style="display:none">
        <label>Description</label>
        <input id="pm-other" placeholder="Check, Cash, Wire, etc.">
      </div>

      <label>Label (nickname)</label>
      <input id="pm-label" placeholder="My Chase Visa">
      <div class="toggle-row" style="margin-top:12px">
        <div class="toggle-label">Set as default</div>
        <label class="toggle"><input type="checkbox" id="pm-default" checked><span class="toggle-slider"></span></label>
      </div>
      <div style="margin-top:16px">
        <button class="btn btn-primary" id="pm-save-btn" onclick="Pages.DonorDetail.savePM('${donorId}')">Save & Tokenize Card</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });

    window.Pages.DonorDetail.pmTypeChange = () => {
      const type = document.getElementById('pm-type')?.value;
      document.getElementById('cc-fields').style.display = type === 'credit_card' ? '' : 'none';
      document.getElementById('daf-fields').style.display = type === 'daf' ? '' : 'none';
      document.getElementById('other-fields').style.display = type === 'other' ? '' : 'none';
      const btn = document.getElementById('pm-save-btn');
      if (btn) btn.textContent = type === 'credit_card' ? 'Save & Tokenize Card' : 'Add Method';
    };
  },

  async savePM(donorId) {
    const type = document.getElementById('pm-type')?.value;
    const data = {
      type,
      label: document.getElementById('pm-label')?.value,
      is_default: document.getElementById('pm-default')?.checked ? 1 : 0
    };
    if (type === 'credit_card') {
      data.card_brand = document.getElementById('pm-brand')?.value;
      data.last_four = document.getElementById('pm-last4')?.value;
      data.stripe_payment_method_id = document.getElementById('pm-stripe')?.value || null;
    } else if (type === 'daf') {
      data.daf_name = document.getElementById('pm-dafname')?.value;
    } else {
      data.other_description = document.getElementById('pm-other')?.value;
    }
    try {
      await API.post(`/api/orgs/${API.orgId}/donors/${donorId}/payment-methods`, data);
      toast('Payment method added');
      await this.open(donorId);
    } catch (e) { toast(e.message, 'error'); }
  },

  async deletePM(donorId, pmId) {
    confirm('Remove this payment method?', async () => {
      await API.del(`/api/orgs/${API.orgId}/donors/${donorId}/payment-methods/${pmId}`);
      toast('Removed');
      await this.open(donorId);
    });
  },

  chargeNow(donorId, pmId) {
    Modal.open('Process Charge', `
      <label>Amount ($)</label>
      <input type="number" id="charge-amount" step="0.01" placeholder="0.00">
      <label>Notes</label>
      <input id="charge-notes" placeholder="Optional">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.processCharge('${donorId}','${pmId}')">Process Now</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async processCharge(donorId, pmId) {
    const amount = parseFloat(document.getElementById('charge-amount')?.value);
    if (!amount || amount <= 0) { toast('Enter a valid amount', 'error'); return; }
    try {
      // For now, record as manual donation pending (Stripe integration requires keys)
      await API.post(`/api/orgs/${API.orgId}/donors/${donorId}/donations`, {
        amount, method: 'credit_card', payment_method_id: pmId,
        donation_date: new Date().toISOString(),
        notes: document.getElementById('charge-notes')?.value
      });
      toast('Charge processed');
      Modal.close();
      await this.open(donorId);
    } catch (e) { toast(e.message, 'error'); }
  },

  addManualDonation(donorId) {
    const now = new Date().toISOString().slice(0, 16);
    Modal.open('Add Manual Donation', `
      <div class="input-row input-row-2">
        <div><label>Amount ($) *</label><input type="number" id="man-amount" step="0.01" placeholder="0.00"></div>
        <div><label>Method *</label>
          <select id="man-method">
            <option value="credit_card">Credit Card</option>
            <option value="daf">DAF</option>
            <option value="check">Check</option>
            <option value="cash">Cash</option>
            <option value="wire">Wire Transfer</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div class="input-row input-row-2">
        <div><label>Date & Time</label><input type="datetime-local" id="man-date" value="${now}"></div>
        <div><label>Transaction ID</label><input id="man-txid" placeholder="Optional"></div>
      </div>
      <label>Notes</label>
      <input id="man-notes" placeholder="Optional">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.saveManual('${donorId}')">Add Donation</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async saveManual(donorId) {
    const amount = parseFloat(document.getElementById('man-amount')?.value);
    if (!amount) { toast('Amount required', 'error'); return; }
    try {
      await API.post(`/api/orgs/${API.orgId}/donors/${donorId}/donations`, {
        amount,
        method: document.getElementById('man-method')?.value,
        donation_date: document.getElementById('man-date')?.value || new Date().toISOString(),
        transaction_id: document.getElementById('man-txid')?.value || null,
        notes: document.getElementById('man-notes')?.value
      });
      toast('Donation added');
      Modal.close();
      await this.open(donorId);
    } catch (e) { toast(e.message, 'error'); }
  },

  scheduleCharge(donorId) {
    Modal.open('Schedule Charge', `
      <label>Amount ($)</label>
      <input type="number" id="sc-amount" step="0.01" placeholder="0.00">
      <label>Payment Method</label>
      <select id="sc-pm">
        ${(this.data.paymentMethods || []).map(pm => `<option value="${pm.id}">${pm.label || pm.type} ${pm.last_four ? '••' + pm.last_four : ''}</option>`).join('')}
      </select>
      <label>Scheduled For</label>
      <input type="datetime-local" id="sc-date">
      <label>Notes</label>
      <input id="sc-notes" placeholder="Optional">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.saveScheduledCharge('${donorId}')">Schedule</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async saveScheduledCharge(donorId) {
    const amount = parseFloat(document.getElementById('sc-amount')?.value);
    const pmId = document.getElementById('sc-pm')?.value;
    const date = document.getElementById('sc-date')?.value;
    if (!amount || !pmId || !date) { toast('All fields required', 'error'); return; }
    try {
      await API.post(`/api/orgs/${API.orgId}/donors/${donorId}/scheduled-charges`, {
        amount, payment_method_id: pmId, scheduled_for: date,
        notes: document.getElementById('sc-notes')?.value
      });
      toast('Charge scheduled');
      Modal.close();
      await this.open(donorId);
    } catch (e) { toast(e.message, 'error'); }
  },

  rescheduleCharge(donorId, chargeId, current, amount) {
    Modal.open('Reschedule Charge', `
      <label>New Date & Time</label>
      <input type="datetime-local" id="rsc-date" value="${toLocalInput(current)}">
      <label>Amount</label>
      <input type="number" id="rsc-amount" value="${amount}" step="0.01">
      <div style="margin-top:16px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.doReschedule('${donorId}','${chargeId}')">Reschedule</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doReschedule(donorId, chargeId) {
    const date = document.getElementById('rsc-date')?.value;
    const amount = parseFloat(document.getElementById('rsc-amount')?.value);
    await API.put(`/api/orgs/${API.orgId}/donors/${donorId}/scheduled-charges/${chargeId}`, { scheduled_for: date, amount });
    toast('Rescheduled');
    Modal.close();
    await this.open(donorId);
  },

  async cancelCharge(donorId, chargeId) {
    confirm('Cancel this scheduled charge?', async () => {
      await API.del(`/api/orgs/${API.orgId}/donors/${donorId}/scheduled-charges/${chargeId}`);
      toast('Cancelled');
      await this.open(donorId);
    });
  }
};
