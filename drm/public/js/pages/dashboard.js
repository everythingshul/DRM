// public/js/pages/dashboard.js
Pages.Dashboard = {
  async render(el) {
    el.innerHTML = `<div class="spinner"></div>`;
    try {
      const stats = await API.get(API.org.stats());
      el.innerHTML = this.html(stats);
      this.renderCharts(stats);
    } catch (e) {
      el.innerHTML = `<div class="alert alert-danger">Error loading dashboard: ${e.message}</div>`;
    }
  },

  html(s) {
    const autopayActive = s.autopayStats?.active || 0;
    const autopayPaused = s.autopayStats?.paused || 0;

    return `
    <div class="page-header">
      <div>
        <div class="page-title">Dashboard</div>
        <div class="page-subtitle">Overview of your donor relationships</div>
      </div>
      <div class="btn-group">
        ${s.failedCharges > 0 ? `<a class="btn btn-danger btn-sm" onclick="navigateTo('failures')">⚠ ${s.failedCharges} Failed Charge${s.failedCharges>1?'s':''}</a>` : ''}
        ${s.needsVerification > 0 ? `<a class="btn btn-outline btn-sm" onclick="navigateTo('verification')">✅ ${s.needsVerification} Need Verification</a>` : ''}
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Donors</div>
        <div class="stat-value">${(s.totalDonors||0).toLocaleString()}</div>
        <div class="stat-sub">${s.activeDonors||0} active this period</div>
      </div>
      <div class="stat-card green">
        <div class="stat-label">Total Raised</div>
        <div class="stat-value">${fmt$(s.totalAmount)}</div>
        <div class="stat-sub">${s.totalDonations||0} donations</div>
      </div>
      <div class="stat-card orange">
        <div class="stat-label">Avg Donation</div>
        <div class="stat-value">${fmt$(s.avgDonation)}</div>
        <div class="stat-sub">per transaction</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Auto Pay</div>
        <div class="stat-value">${autopayActive}</div>
        <div class="stat-sub">${autopayPaused} paused</div>
      </div>
    </div>

    <div class="two-panel" style="margin-bottom:20px">
      <div class="card">
        <div class="card-title">Monthly Donations</div>
        <div id="chart-monthly"></div>
      </div>
      <div class="card">
        <div class="card-title">By Payment Method</div>
        <div id="chart-method"></div>
      </div>
    </div>

    <div class="two-panel">
      <div class="card">
        <div class="card-title">By Neighborhood</div>
        <div id="chart-neighborhood"></div>
      </div>
      <div class="card">
        <div class="card-title">Top Donors</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Donor</th><th>Gifts</th><th>Total</th></tr></thead>
            <tbody>
              ${(s.topDonors||[]).map(d => `
                <tr>
                  <td><strong>${d.first_name} ${d.last_name}</strong>${d.hebrew_full_name ? `<br><span class="he" style="font-size:11px">${d.hebrew_full_name}</span>` : ''}</td>
                  <td>${d.count}</td>
                  <td class="amount">${fmt$(d.total)}</td>
                </tr>`).join('') || '<tr><td colspan="3" class="empty-state" style="padding:20px">No donations yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  },

  renderCharts(s) {
    const monthEl = document.getElementById('chart-monthly');
    if (monthEl && s.byMonth?.length) {
      renderBar(monthEl, [...s.byMonth].reverse(), 'month', 'total');
    } else if (monthEl) monthEl.innerHTML = '<div class="empty-state" style="padding:20px">No data</div>';

    const methodEl = document.getElementById('chart-method');
    if (methodEl) {
      renderPie(methodEl, (s.byMethod||[]).map(m => ({ label: m.method, value: m.total })));
    }

    const nhEl = document.getElementById('chart-neighborhood');
    if (nhEl) {
      renderPie(nhEl, (s.byNeighborhood||[]).slice(0,8).map(n => ({ label: n.name_he || 'Other', value: n.total })));
    }
  }
};
