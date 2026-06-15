// public/js/pages/donor-detail.js
Pages.DonorDetail = {
  data: null,
  donorId: null,

  async open(id) {
    this.donorId = id;
    Modal.open('Loading…', '<div class="spinner"></div>', { large: true });
    try {
      this.data = await API.get(API.org.donor(id));
      const recurring = await API.get(`/api/orgs/${API.orgId}/donors/${id}/recurring`).catch(()=>[]);
      this.data.recurring = recurring;
      this.render();
    } catch (e) {
      Modal.setBody(`<div class="alert alert-danger">${e.message}</div>`);
    }
  },

  render() {
    const { donor, paymentMethods, donations, recurring } = this.data;
    const labels = (() => { try { return JSON.parse(donor.labels||'[]'); } catch { return []; } })();

    Modal.setTitle('');
    Modal.setBody(`
      <div class="donor-detail-header">
        <div class="donor-detail-avatar">${initials(donor.first_name, donor.last_name)}</div>
        <div class="donor-detail-name" style="flex:1">
          <h2>${donor.title?donor.title+' ':''}${donor.first_name} ${donor.last_name}</h2>
          ${donor.hebrew_full_name?`<div style="font-family:var(--font-he);direction:rtl">${donor.hebrew_title||''} ${donor.hebrew_full_name}</div>`:''}
          <div class="meta">${accountAge(donor.months_old)} member &nbsp;·&nbsp; ${donor.email||''} ${donor.cell?'· '+donor.cell:''} ${donor.neighborhood_name?'· '+donor.neighborhood_name:''}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
            ${labels.map(l=>`<span class="pill pill-blue" style="font-size:10px">${l}</span>`).join('')}
            ${donor.needs_verification?'<span class="pill pill-orange" style="font-size:10px">⚠ Needs Verification</span>':''}
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:24px;font-weight:700">${fmt$(donor.total_amount)}</div>
          <div style="opacity:0.75;font-size:12px">${donor.total_donations||0} donations</div>
          <div class="btn-group" style="margin-top:8px;justify-content:flex-end">
            <button class="btn btn-blue btn-sm" onclick="Pages.Donors.openEdit('${donor.id}')">${Icon.edit()} Edit</button>
            ${donor.needs_verification?`<button class="btn btn-success btn-sm" onclick="Pages.DonorDetail.verify('${donor.id}')">${Icon.check()} Verify</button>`:''}
          </div>
        </div>
      </div>

      <div class="tabs" style="margin-top:0;border-radius:0">
        <div class="tab active" onclick="ddTab(this,'dd-overview')">Overview</div>
        <div class="tab" onclick="ddTab(this,'dd-payment')">Cards</div>
        <div class="tab" onclick="ddTab(this,'dd-donations')">Donations</div>
        <div class="tab" onclick="ddTab(this,'dd-recurring')">Recurring</div>
        <div class="tab" onclick="ddTab(this,'dd-kvitel')">Kvitel</div>
        <div class="tab" onclick="ddTab(this,'dd-notes')">Notes</div>
      </div>

      <!-- OVERVIEW -->
      <div id="dd-overview" class="tab-content active" style="padding:18px">
        <div class="two-panel">
          <div>
            <div class="card-title">Contact</div>
            ${donor.cell?`<p style="font-size:13px">Cell: ${donor.cell}</p>`:''}
            ${donor.home_phone?`<p style="font-size:13px">Home: ${donor.home_phone}</p>`:''}
            ${donor.email?`<p style="font-size:13px">Email: ${donor.email}</p>`:''}
            <hr class="section-divider">
            <div class="card-title">Address</div>
            <p style="font-size:13px">${[donor.street,donor.apt,donor.city,donor.state,donor.zip].filter(Boolean).join(', ')||'—'}</p>
          </div>
          <div>
            <div class="card-title">Stats</div>
            <p style="font-size:13px">Last donation: ${fmtDate(donor.last_donation_date)}</p>
            <p style="font-size:13px">Member since: ${fmtDate(donor.created_at)}</p>
            <hr class="section-divider">
            <div class="card-title">Email Preferences</div>
            <div class="toggle-row">
              <div class="toggle-label" style="font-size:13px">Donation receipts</div>
              <label class="toggle"><input type="checkbox" ${!donor.donation_emails_paused?'checked':''} onchange="Pages.DonorDetail.pref('${donor.id}','donation_emails_paused',!this.checked)"><span class="toggle-slider"></span></label>
            </div>
            <div class="toggle-row">
              <div class="toggle-label" style="font-size:13px">Marketing emails</div>
              <label class="toggle"><input type="checkbox" ${!donor.marketing_emails_paused?'checked':''} onchange="Pages.DonorDetail.pref('${donor.id}','marketing_emails_paused',!this.checked)"><span class="toggle-slider"></span></label>
            </div>
          </div>
        </div>
      </div>

      <!-- PAYMENT METHODS (CARDS) -->
      <div id="dd-payment" class="tab-content" style="padding:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Payment Methods</strong>
          <button class="btn btn-blue btn-sm" onclick="Pages.DonorDetail.addCard('${donor.id}')">${Icon.plus()} Add Card</button>
        </div>
        <div id="pm-list">
          ${paymentMethods.length ? paymentMethods.map(pm => this.pmCard(pm, donor.id)).join('') :
            '<p style="color:var(--gray-500);padding:20px 0">No payment methods yet</p>'}
        </div>
      </div>

      <!-- DONATIONS -->
      <div id="dd-donations" class="tab-content" style="padding:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Donation History</strong>
          <div class="btn-group">
            <button class="btn btn-ghost btn-sm" onclick="Pages.DonorDetail.manualDonation('${donor.id}')">${Icon.plus()} Manual</button>
            <button class="btn btn-blue btn-sm" onclick="Pages.DonorDetail.chargeNow('${donor.id}')">${Icon.card()} Charge Card</button>
          </div>
        </div>
        <div class="scroll-list">
          <table>
            <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Trans ID</th><th>Status</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              ${donations.map(d => this.donationRow(d, donor.id)).join('') ||
                '<tr><td colspan="7"><div class="empty-state" style="padding:20px">No donations yet</div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <!-- RECURRING -->
      <div id="dd-recurring" class="tab-content" style="padding:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Recurring Charge Schedules</strong>
          <button class="btn btn-primary btn-sm" onclick="Pages.DonorDetail.addRecurring('${donor.id}')">${Icon.plus()} Add Schedule</button>
        </div>
        <div id="recurring-list">
          ${recurring.length ? recurring.map(s => this.recurringCard(s, donor.id)).join('') :
            '<div class="alert alert-info">No recurring schedules set up. Use "Add Schedule" to set up automatic weekly, biweekly, or monthly charges.</div>'}
        </div>
      </div>

      <!-- KVITEL -->
      <div id="dd-kvitel" class="tab-content" style="padding:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong>Kvitel</strong>
          <label class="toggle" title="Include in Kvitel generation">
            <input type="checkbox" id="kv-on" ${donor.kvitel_enabled!==0?'checked':''} onchange="Pages.DonorDetail.pref('${donor.id}','kvitel_enabled',this.checked?1:0)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <textarea id="kv-text" dir="rtl" style="font-family:var(--font-he);min-height:180px;font-size:15px;line-height:1.8;width:100%">${donor.kvitel||''}</textarea>
        <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="Pages.DonorDetail.saveKvitel('${donor.id}')">Save Kvitel</button>
      </div>

      <!-- NOTES -->
      <div id="dd-notes" class="tab-content" style="padding:18px">
        <div style="margin-bottom:14px">
          <textarea id="new-note" placeholder="Add a note…" style="min-height:70px;width:100%"></textarea>
          <button class="btn btn-primary btn-sm" style="margin-top:6px" onclick="Pages.DonorDetail.addNote('${donor.id}')">Add Note</button>
        </div>
        <div id="notes-list">
          ${this.notesList(donor)}
        </div>
      </div>
    `);

    window.ddTab = (el, id) => {
      document.querySelectorAll('#modal-body .tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('#modal-body .tab-content').forEach(t=>t.classList.remove('active'));
      el.classList.add('active'); document.getElementById(id)?.classList.add('active');
    };
  },

  pmCard(pm, donorId) {
    const brandClass = (pm.card_brand||'').toLowerCase().replace(/\s/g,'');
    const brandLabel = pm.card_brand || (pm.type==='credit_card'?'Card':'');
    return `<div class="sched-item">
      <div>
        <div class="sched-main" style="display:flex;align-items:center;gap:8px">
          ${pm.type==='credit_card' ? `
            <span class="card-brand ${brandClass}">${brandLabel}</span>
            ${pm.last_four?`<span style="font-size:13px">•••• ${pm.last_four}</span>`:''}
          ` : `<span>${fmtMethod(pm.type)}</span>${pm.daf_name?`<span style="color:var(--gray-500);font-size:12px">${pm.daf_name}</span>`:''}${pm.other_description?`<span style="color:var(--gray-500);font-size:12px">${pm.other_description}</span>`:''}` }
          ${pm.label?`<span style="font-size:12px;color:var(--gray-500)">${pm.label}</span>`:''}
          ${pm.is_default?'<span class="pill pill-green" style="font-size:10px">Default</span>':''}
          ${pm.sola_token?'<span class="pill pill-blue" style="font-size:10px">Tokenized</span>':''}
        </div>
      </div>
      <div class="btn-group">
        ${pm.type==='credit_card'&&pm.sola_token?`<button class="btn btn-ghost btn-sm" onclick="Pages.DonorDetail.chargeCard('${donorId}','${pm.id}')">${Icon.card()} Charge</button>`:''}
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.DonorDetail.deletePM('${donorId}','${pm.id}')">${Icon.trash()}</button>
      </div>
    </div>`;
  },

  donationRow(d, donorId) {
    const donNotes = (() => { try { return JSON.parse(d.donation_notes||'[]'); } catch { return []; } })();
    return `<tr>
      <td style="white-space:nowrap;font-size:12px">${fmtDate(d.donation_date)}</td>
      <td style="font-weight:600">${fmt$(d.amount)}${d.refund_amount>0?`<br><span style="font-size:11px;color:var(--danger)">-${fmt$(d.refund_amount)} refunded</span>`:''}</td>
      <td style="font-size:12px">${fmtMethod(d.method)}${d.last_four?` ••${d.last_four}`:''}</td>
      <td style="font-size:11px;color:var(--gray-500);max-width:120px;word-break:break-all">${d.transaction_id||'—'}</td>
      <td>${statusBadge(d.status)}</td>
      <td style="font-size:12px;max-width:140px">
        ${d.notes||''}
        ${donNotes.map(n=>`<div class="don-note">${fmtDate(n.at)}: ${n.text}</div>`).join('')}
      </td>
      <td>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" title="Add note" onclick="Pages.DonorDetail.addDonationNote('${donorId}','${d.id}')">${Icon.note()}</button>
          ${d.status==='completed'||d.status==='partial_refund'?`<button class="btn btn-ghost btn-sm" title="Refund" onclick="Pages.DonorDetail.refundDonation('${donorId}','${d.id}','${d.amount}','${d.transaction_id||''}')">${Icon.refund()}</button>`:''}
        </div>
      </td>
    </tr>`;
  },

  recurringCard(s, donorId) {
    const pmLabel = s.pm_label || (s.pm_type==='credit_card' ? `${s.card_brand||'Card'} ••${s.last_four||''}` : fmtMethod(s.pm_type));
    const limitText = s.occurrences_limit ? `${s.occurrences_count||0}/${s.occurrences_limit} charges` : 'Unlimited';
    return `<div class="sched-item">
      <div>
        <div class="sched-main">${fmt$(s.amount)} / ${fmtFrequency(s.frequency)}</div>
        <div class="sched-sub">${pmLabel} &nbsp;·&nbsp; Next: ${fmtDate(s.next_run)} &nbsp;·&nbsp; ${limitText}</div>
        ${s.last_failure?`<div style="font-size:11px;color:var(--danger);margin-top:3px">Last error: ${s.last_failure}</div>`:''}
      </div>
      <div class="btn-group">
        ${s.status==='active'?`<button class="btn btn-ghost btn-sm" onclick="Pages.DonorDetail.toggleRecurring('${donorId}','${s.id}','paused')">Pause</button>`:
          `<button class="btn btn-ghost btn-sm" onclick="Pages.DonorDetail.toggleRecurring('${donorId}','${s.id}','active')">Resume</button>`}
        <button class="btn btn-ghost btn-sm" onclick="Pages.DonorDetail.editRecurring('${donorId}','${s.id}','${s.amount}','${s.frequency}','${s.next_run||''}')">${Icon.edit()}</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="Pages.DonorDetail.deleteRecurring('${donorId}','${s.id}')">${Icon.trash()}</button>
      </div>
    </div>`;
  },

  notesList(donor) {
    const notes = (() => { try { return JSON.parse(donor.notes||'[]'); } catch { return []; } })();
    if (!notes.length) return '<p style="color:var(--gray-500)">No notes yet</p>';
    return notes.slice().reverse().map(n=>`
      <div class="note-item">
        <div class="note-meta">${fmtDateTime(n.at)}${n.by?' · '+n.by:''}</div>
        <div class="note-text">${n.text}</div>
      </div>`).join('');
  },

  async verify(id) {
    await API.post(`/api/orgs/${API.orgId}/donors/${id}/verify`, {});
    toast('Verified ✓'); this.open(id); loadBadges();
  },
  async pref(id, field, value) {
    await API.put(API.org.donor(id), { [field]: value });
  },
  async saveKvitel(id) {
    const kvitel = document.getElementById('kv-text')?.value||'';
    const enabled = document.getElementById('kv-on')?.checked?1:0;
    await API.put(API.org.donor(id), { kvitel, kvitel_enabled: enabled });
    toast('Kvitel saved');
  },
  async addNote(id) {
    const text = document.getElementById('new-note')?.value?.trim();
    if (!text) return;
    const notes = (() => { try { return JSON.parse(this.data.donor.notes||'[]'); } catch { return []; } })();
    notes.push({ text, at: new Date().toISOString(), by: window.DRM.user?.full_name||'' });
    await API.put(API.org.donor(id), { notes });
    toast('Note added'); this.open(id);
  },

  addCard(donorId) {
    Modal.open('Add Payment Method', `
      <label>Type</label>
      <select id="pm-type" onchange="Pages.DonorDetail.pmTypeChange()">
        <option value="credit_card">Credit Card (Sola)</option>
        <option value="daf">DAF</option>
        <option value="check">Check</option>
        <option value="other">Other</option>
      </select>
      <div id="cc-fields">
        <div class="alert alert-info" style="margin-top:10px;font-size:12px">Card is tokenized via Sola — raw card number is never stored.</div>
        <div class="input-row input-row-2">
          <div><label>Card Number</label><input id="pm-num" placeholder="Card number" maxlength="19" autocomplete="cc-number"></div>
          <div><label>Expiry (MMYY)</label><input id="pm-exp" placeholder="0128" maxlength="4" autocomplete="cc-exp"></div>
        </div>
        <div class="input-row input-row-2">
          <div><label>CVV</label><input id="pm-cvv" placeholder="123" maxlength="4" type="password" autocomplete="cc-csc"></div>
          <div><label>ZIP</label><input id="pm-zip" placeholder="11201" maxlength="5"></div>
        </div>
        <div><label>Card Brand</label>
          <select id="pm-brand">
            <option value="">— Select —</option>
            <option>Visa</option><option>Mastercard</option><option>Amex</option><option>Discover</option>
          </select>
        </div>
      </div>
      <div id="daf-fields" style="display:none">
        <label>DAF Name</label><input id="pm-dafname" placeholder="Fidelity Charitable, Schwab…">
      </div>
      <div id="other-fields" style="display:none">
        <label>Description</label><input id="pm-other" placeholder="Check, Cash, Wire…">
      </div>
      <label>Nickname (optional)</label>
      <input id="pm-label" placeholder="e.g. My Chase Visa" autocomplete="off">
      <div class="toggle-row" style="margin-top:10px">
        <div class="toggle-label">Set as default</div>
        <label class="toggle"><input type="checkbox" id="pm-default" checked><span class="toggle-slider"></span></label>
      </div>
      <div style="margin-top:14px">
        <button class="btn btn-primary" id="pm-save-btn" onclick="Pages.DonorDetail.saveCard('${donorId}')">Save & Tokenize</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });

    window.Pages.DonorDetail.pmTypeChange = () => {
      const t = document.getElementById('pm-type')?.value;
      document.getElementById('cc-fields').style.display = t==='credit_card'?'':'none';
      document.getElementById('daf-fields').style.display = t==='daf'?'':'none';
      document.getElementById('other-fields').style.display = (t==='check'||t==='other')?'':'none';
      const btn = document.getElementById('pm-save-btn');
      if (btn) btn.textContent = t==='credit_card'?'Save & Tokenize':'Add Method';
    };
  },

  async saveCard(donorId) {
    const type = document.getElementById('pm-type')?.value;
    const label = document.getElementById('pm-label')?.value;
    const isDefault = document.getElementById('pm-default')?.checked ? 1 : 0;
    const btn = document.getElementById('pm-save-btn');
    try {
      if (type === 'credit_card') {
        const num = document.getElementById('pm-num')?.value.replace(/\s/g,'');
        const exp = document.getElementById('pm-exp')?.value.replace(/\D/g,'');
        const cvv = document.getElementById('pm-cvv')?.value;
        const brand = document.getElementById('pm-brand')?.value;
        if (!num||!exp) { toast('Card number and expiry required','error'); return; }
        if (btn) { btn.textContent='Tokenizing…'; btn.disabled=true; }
        // First save card with card_brand manually set so last_four shows up
        const r = await API.post(`/api/orgs/${API.orgId}/payments/save-card`, {
          donor_id: donorId, card_num: num, exp, cvv: cvv||'', label: label||''
        });
        // Update brand if selected
        if (brand && r.paymentMethod?.id) {
          await API.put(`/api/orgs/${API.orgId}/donors/${donorId}/payment-methods/${r.paymentMethod.id}`, { card_brand: brand }).catch(()=>{});
        }
        toast(`Card ••${r.paymentMethod?.last_four||'??'} saved and tokenized`);
      } else {
        await API.post(`/api/orgs/${API.orgId}/donors/${donorId}/payment-methods`, {
          type, label: label||null,
          daf_name: document.getElementById('pm-dafname')?.value||null,
          other_description: document.getElementById('pm-other')?.value||null,
          is_default: isDefault
        });
        toast('Payment method added');
      }
      Modal.close(); this.open(donorId);
    } catch(e) {
      if (btn) { btn.textContent='Save & Tokenize'; btn.disabled=false; }
      toast(e.message,'error');
    }
  },

  async deletePM(donorId, pmId) {
    confirm('Remove this payment method?', async () => {
      await API.del(`/api/orgs/${API.orgId}/donors/${donorId}/payment-methods/${pmId}`);
      toast('Removed'); this.open(donorId);
    });
  },

  chargeNow(donorId) {
    const pms = this.data.paymentMethods.filter(p=>p.type==='credit_card'&&p.sola_token);
    if (!pms.length) { toast('No tokenized credit cards on file. Add a card first.','error'); return; }
    Modal.open('Charge Card', `
      <label>Payment Method</label>
      <select id="cn-pm">
        ${pms.map(p=>`<option value="${p.id}">${p.card_brand||'Card'} ••${p.last_four||'??'} ${p.label?'('+p.label+')':''}</option>`).join('')}
      </select>
      <label>Amount ($)</label>
      <input type="number" id="cn-amount" step="0.01" placeholder="0.00">
      <label>Notes (optional)</label>
      <input id="cn-notes" placeholder="Optional" autocomplete="off">
      <div style="margin-top:14px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.doCharge('${donorId}')">Charge Now</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  chargeCard(donorId, pmId) {
    Modal.open('Charge Card', `
      <label>Amount ($)</label>
      <input type="number" id="cc-amount" step="0.01" placeholder="0.00">
      <label>Notes (optional)</label>
      <input id="cc-notes" placeholder="Optional" autocomplete="off">
      <div style="margin-top:14px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.doChargeSpecific('${donorId}','${pmId}')">Charge Now</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doCharge(donorId) {
    const pmId = document.getElementById('cn-pm')?.value;
    const amount = parseFloat(document.getElementById('cn-amount')?.value);
    if (!amount||amount<=0) { toast('Enter a valid amount','error'); return; }
    try {
      const r = await API.post(`/api/orgs/${API.orgId}/payments/charge`, {
        donor_id: donorId, payment_method_id: pmId, amount,
        notes: document.getElementById('cn-notes')?.value
      });
      toast(`Charged ${fmt$(amount)} — Trans ID: ${r.transaction_id}`);
      Modal.close(); this.open(donorId);
    } catch(e) { toast(e.message,'error'); }
  },

  async doChargeSpecific(donorId, pmId) {
    const amount = parseFloat(document.getElementById('cc-amount')?.value);
    if (!amount||amount<=0) { toast('Enter a valid amount','error'); return; }
    try {
      const r = await API.post(`/api/orgs/${API.orgId}/payments/charge`, {
        donor_id: donorId, payment_method_id: pmId, amount,
        notes: document.getElementById('cc-notes')?.value
      });
      toast(`Charged ${fmt$(amount)} — Trans ID: ${r.transaction_id}`);
      Modal.close(); this.open(donorId);
    } catch(e) { toast(e.message,'error'); }
  },

  manualDonation(donorId) {
    const now = new Date().toISOString().slice(0,16);
    const allPms = this.data.paymentMethods || [];
    Modal.open('Add Manual Donation', `
      <div class="input-row input-row-2">
        <div><label>Amount ($) *</label><input type="number" id="md-amount" step="0.01" placeholder="0.00"></div>
        <div><label>Method *</label>
          <select id="md-method">
            <option value="check">Check</option>
            <option value="cash">Cash</option>
            <option value="daf">DAF</option>
            <option value="wire">Wire</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div class="input-row input-row-2">
        <div><label>Date *</label><input type="datetime-local" id="md-date" value="${now}"></div>
        <div><label>Transaction ID</label><input id="md-txid" placeholder="Check #, ref, etc." autocomplete="off"></div>
      </div>
      <label>Notes</label><input id="md-notes" placeholder="Optional" autocomplete="off">
      <div style="margin-top:14px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.saveManual('${donorId}')">Record Donation</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async saveManual(donorId) {
    const amount = parseFloat(document.getElementById('md-amount')?.value);
    if (!amount||amount<=0) { toast('Amount required','error'); return; }
    try {
      await API.post(`/api/orgs/${API.orgId}/donors/${donorId}/donations`, {
        amount, method: document.getElementById('md-method')?.value,
        donation_date: document.getElementById('md-date')?.value || new Date().toISOString(),
        transaction_id: document.getElementById('md-txid')?.value||null,
        notes: document.getElementById('md-notes')?.value||null,
        status: 'completed'
      });
      toast('Donation recorded'); Modal.close(); this.open(donorId);
    } catch(e) { toast(e.message,'error'); }
  },

  addDonationNote(donorId, donId) {
    Modal.open('Add Note to Donation', `
      <textarea id="dn-text" placeholder="Enter note…" style="min-height:80px;width:100%"></textarea>
      <div style="margin-top:12px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.saveDonationNote('${donorId}','${donId}')">Add Note</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async saveDonationNote(donorId, donId) {
    const text = document.getElementById('dn-text')?.value?.trim();
    if (!text) return;
    try {
      await API.post(`/api/orgs/${API.orgId}/donors/${donorId}/donations/${donId}/notes`, { text });
      toast('Note added'); Modal.close(); this.open(donorId);
    } catch(e) { toast(e.message,'error'); }
  },

  refundDonation(donorId, donId, amount, txId) {
    Modal.open('Refund Donation', `
      <p style="color:var(--gray-500);font-size:13px;margin-bottom:12px">Original amount: ${fmt$(amount)}</p>
      <label>Refund Amount ($)</label>
      <input type="number" id="rf-amount" step="0.01" max="${amount}" value="${amount}" placeholder="0.00">
      <label>Reason</label>
      <input id="rf-reason" placeholder="Reason for refund" autocomplete="off">
      ${txId?`<div class="alert alert-info" style="margin-top:10px;font-size:12px">Sola Ref: ${txId} — CC refunds go through Sola automatically.</div>`:''}
      <div style="margin-top:14px">
        <button class="btn btn-danger" onclick="Pages.DonorDetail.doRefund('${donorId}','${donId}','${txId}')">Process Refund</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async doRefund(donorId, donId, txId) {
    const amount = parseFloat(document.getElementById('rf-amount')?.value);
    const notes = document.getElementById('rf-reason')?.value;
    if (!amount||amount<=0) { toast('Enter refund amount','error'); return; }
    try {
      const r = await API.post(`/api/orgs/${API.orgId}/donors/${donorId}/donations/${donId}/refund`, {
        amount, notes, ref_num: txId||undefined
      });
      toast(`Refund of ${fmt$(amount)} processed`);
      Modal.close(); this.open(donorId);
    } catch(e) { toast(e.message,'error'); }
  },

  addRecurring(donorId) {
    const pms = this.data.paymentMethods || [];
    if (!pms.length) { toast('Add a payment method first','error'); return; }
    Modal.open('Add Recurring Schedule', `
      <label>Payment Method</label>
      <select id="rec-pm">
        ${pms.map(p=>`<option value="${p.id}">${fmtMethod(p.type)} ${p.last_four?'••'+p.last_four:''} ${p.label?'('+p.label+')':''}</option>`).join('')}
      </select>
      <div class="input-row input-row-2">
        <div><label>Amount ($)</label><input type="number" id="rec-amount" step="0.01" placeholder="0.00"></div>
        <div><label>Frequency</label>
          <select id="rec-freq">
            <option value="weekly">Weekly</option>
            <option value="biweekly">Bi-Weekly</option>
            <option value="monthly" selected>Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
            <option value="once">One-Time (scheduled)</option>
          </select>
        </div>
      </div>
      <div class="input-row input-row-2">
        <div><label>Start Date</label><input type="date" id="rec-start" value="${new Date().toISOString().slice(0,10)}"></div>
        <div><label>End Date (optional)</label><input type="date" id="rec-end" placeholder="Leave blank for unlimited"></div>
      </div>
      <label>Number of Charges (blank = unlimited)</label>
      <input type="number" id="rec-limit" placeholder="e.g. 12 for one year of monthly" min="1">
      <label>Notes (optional)</label>
      <input id="rec-notes" placeholder="e.g. Pledge 2025" autocomplete="off">
      <div style="margin-top:14px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.saveRecurring('${donorId}')">Save Schedule</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async saveRecurring(donorId) {
    const amount = parseFloat(document.getElementById('rec-amount')?.value);
    if (!amount||amount<=0) { toast('Amount required','error'); return; }
    try {
      await API.post(`/api/orgs/${API.orgId}/donors/${donorId}/recurring`, {
        payment_method_id: document.getElementById('rec-pm')?.value,
        amount, frequency: document.getElementById('rec-freq')?.value,
        start_date: document.getElementById('rec-start')?.value,
        end_date: document.getElementById('rec-end')?.value||null,
        occurrences_limit: document.getElementById('rec-limit')?.value ? parseInt(document.getElementById('rec-limit').value) : null,
        notes: document.getElementById('rec-notes')?.value||null
      });
      toast('Schedule created'); Modal.close(); this.open(donorId);
    } catch(e) { toast(e.message,'error'); }
  },

  async toggleRecurring(donorId, schedId, status) {
    await API.put(`/api/orgs/${API.orgId}/donors/${donorId}/recurring/${schedId}`, { status });
    toast(status==='paused'?'Paused':'Resumed'); this.open(donorId);
  },

  editRecurring(donorId, schedId, amount, freq, nextRun) {
    Modal.open('Edit Schedule', `
      <label>Amount ($)</label>
      <input type="number" id="er-amount" value="${amount}" step="0.01">
      <label>Frequency</label>
      <select id="er-freq">
        ${['weekly','biweekly','monthly','quarterly','yearly','once'].map(f=>`<option value="${f}" ${f===freq?'selected':''}>${fmtFrequency(f)}</option>`).join('')}
      </select>
      <label>Next Run Date</label>
      <input type="date" id="er-next" value="${nextRun?nextRun.slice(0,10):''}">
      <div style="margin-top:14px">
        <button class="btn btn-primary" onclick="Pages.DonorDetail.saveEditRecurring('${donorId}','${schedId}')">Save</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `, { small: true });
  },

  async saveEditRecurring(donorId, schedId) {
    await API.put(`/api/orgs/${API.orgId}/donors/${donorId}/recurring/${schedId}`, {
      amount: parseFloat(document.getElementById('er-amount')?.value),
      frequency: document.getElementById('er-freq')?.value,
      next_run: document.getElementById('er-next')?.value
    });
    toast('Schedule updated'); Modal.close(); this.open(donorId);
  },

  async deleteRecurring(donorId, schedId) {
    confirm('Cancel this recurring schedule?', async () => {
      await API.del(`/api/orgs/${API.orgId}/donors/${donorId}/recurring/${schedId}`);
      toast('Schedule cancelled'); this.open(donorId);
    });
  }
};
