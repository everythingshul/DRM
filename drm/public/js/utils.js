// public/js/utils.js

// Toast
function toast(msg, type = 'success') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', warning: '⚠' };
  t.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 3500);
}

// Modal
const Modal = {
  open(title, bodyHtml, opts = {}) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    const box = document.getElementById('modal-box');
    box.className = 'modal-box' + (opts.large ? ' modal-lg' : '') + (opts.small ? ' modal-sm' : '');
    document.getElementById('modal-overlay').style.display = 'flex';
    if (opts.onOpen) opts.onOpen();
  },
  close() {
    document.getElementById('modal-overlay').style.display = 'none';
    document.getElementById('modal-body').innerHTML = '';
  },
  setBody(html) { document.getElementById('modal-body').innerHTML = html; },
  setTitle(t) { document.getElementById('modal-title').textContent = t; }
};

document.getElementById('modal-close')?.addEventListener('click', Modal.close);
document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) Modal.close();
});

// Format currency
function fmt$(n) { return '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Format date
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return d; }
}

function fmtDateTime(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return d; }
}

// Age display
function accountAge(months) {
  if (!months && months !== 0) return '—';
  const m = parseInt(months);
  if (m < 12) return m + ' mo';
  const y = Math.floor(m / 12);
  const rm = m % 12;
  return rm > 0 ? `${y}y ${rm}m` : `${y}y`;
}

// Initials
function initials(first, last) {
  return ((first || '')[0] || '') + ((last || '')[0] || '');
}

// Donor avatar HTML
function avatarHtml(donor, size = 36) {
  return `<div class="donor-avatar" style="width:${size}px;height:${size}px;font-size:${size/2.8|0}px">${initials(donor.first_name, donor.last_name)}</div>`;
}

// Status badge
function statusBadge(status) {
  const map = { completed: '✓ Completed', pending: '⏳ Pending', failed: '✕ Failed', scheduled: '🕐 Scheduled', cancelled: 'Cancelled' };
  return `<span class="status-badge status-${status}">${map[status] || status}</span>`;
}

// Simple SVG Pie Chart
function renderPie(container, data, colors) {
  if (!data || !data.length) { container.innerHTML = '<div class="empty-state"><p>No data</p></div>'; return; }
  const total = data.reduce((s, d) => s + (d.value || d.total || 0), 0);
  if (!total) { container.innerHTML = '<div class="empty-state"><p>No data</p></div>'; return; }

  const defaultColors = ['#1a3a6b','#2d8dc4','#22a06b','#f0a500','#d63031','#9333ea','#0891b2','#16a34a'];
  const cols = colors || defaultColors;

  let svgPaths = '';
  let angle = -90;
  data.forEach((d, i) => {
    const val = d.value || d.total || 0;
    const pct = val / total;
    const sweep = pct * 360;
    if (sweep === 0) return;

    const r = 80;
    const cx = 100, cy = 100;
    const startRad = (angle * Math.PI) / 180;
    const endRad = ((angle + sweep) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);
    const large = sweep > 180 ? 1 : 0;

    svgPaths += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z"
      fill="${cols[i % cols.length]}" stroke="white" stroke-width="2" opacity="0.92"/>`;
    angle += sweep;
  });

  const legend = data.map((d, i) => {
    const val = d.value || d.total || 0;
    const pct = ((val / total) * 100).toFixed(1);
    const lbl = d.label || d.method || d.name_he || d.month || '—';
    return `<div class="pie-legend-item">
      <div class="pie-dot" style="background:${cols[i % cols.length]}"></div>
      <span>${lbl}</span><span style="color:var(--gray-500)">${pct}%</span>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap">
      <svg viewBox="0 0 200 200" width="160" height="160" style="flex-shrink:0">${svgPaths}</svg>
      <div class="pie-legend">${legend}</div>
    </div>`;
}

// Simple bar chart SVG
function renderBar(container, data, labelKey, valueKey, color = '#2d8dc4') {
  if (!data || !data.length) { container.innerHTML = '<div class="empty-state"><p>No data</p></div>'; return; }
  const max = Math.max(...data.map(d => d[valueKey] || 0));
  if (!max) { container.innerHTML = '<div class="empty-state"><p>No data</p></div>'; return; }

  const w = 520, h = 220, pad = 40, barW = Math.max(16, (w - pad * 2) / data.length - 6);
  let bars = '', xlabels = '';

  data.slice(-16).forEach((d, i) => {
    const val = d[valueKey] || 0;
    const bh = ((val / max) * (h - pad * 1.5)) || 0;
    const x = pad + i * ((w - pad * 2) / data.length) + 4;
    const y = h - pad - bh;
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="${color}" rx="3" opacity="0.85">
      <title>${d[labelKey]}: ${fmt$(val)}</title></rect>`;
    if (i % Math.ceil(data.length / 8) === 0) {
      xlabels += `<text x="${x + barW / 2}" y="${h - 6}" text-anchor="middle" font-size="9" fill="#6b7280">${(d[labelKey] || '').slice(-7)}</text>`;
    }
  });

  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-height:240px">${bars}${xlabels}</svg>`;
}

// Confirm dialog
function confirm(msg, onYes) {
  Modal.open('Confirm', `
    <p style="margin-bottom:20px">${msg}</p>
    <div class="btn-group">
      <button class="btn btn-danger" id="confirm-yes">Yes, proceed</button>
      <button class="btn btn-ghost" id="confirm-no">Cancel</button>
    </div>
  `, { small: true });
  document.getElementById('confirm-yes').onclick = () => { Modal.close(); onYes(); };
  document.getElementById('confirm-no').onclick = Modal.close;
}

// Pagination helper
function paginate(items, page, perPage) {
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), total: items.length, pages: Math.ceil(items.length / perPage) };
}

function paginationHtml(page, pages, onPage) {
  if (pages <= 1) return '';
  let html = '<div class="pagination">';
  if (page > 1) html += `<button class="btn btn-ghost btn-sm" onclick="${onPage}(${page-1})">‹</button>`;
  for (let i = Math.max(1,page-2); i <= Math.min(pages, page+2); i++) {
    html += `<button class="btn btn-sm ${i===page?'btn-primary':'btn-ghost'}" onclick="${onPage}(${i})">${i}</button>`;
  }
  if (page < pages) html += `<button class="btn btn-ghost btn-sm" onclick="${onPage}(${page+1})">›</button>`;
  html += '</div>';
  return html;
}

// Labels input widget
function labelsInput(containerId, initial = []) {
  const c = document.getElementById(containerId);
  let labels = [...initial];

  function render() {
    c.innerHTML = `
      <div class="labels-wrap" id="${containerId}-tags">
        ${labels.map((l, i) => `<span class="pill pill-blue">${l} <span style="cursor:pointer" onclick="window.__removeLabelAt_${containerId}(${i})">×</span></span>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input type="text" id="${containerId}-input" placeholder="Add label..." style="flex:1">
        <button type="button" class="btn btn-ghost btn-sm" onclick="window.__addLabel_${containerId}()">Add</button>
      </div>`;
  }

  window[`__addLabel_${containerId}`] = () => {
    const v = document.getElementById(`${containerId}-input`).value.trim();
    if (v && !labels.includes(v)) { labels.push(v); render(); }
  };

  window[`__removeLabelAt_${containerId}`] = (i) => {
    labels.splice(i, 1); render();
  };

  render();
  return { getLabels: () => labels, setLabels: (l) => { labels = [...l]; render(); } };
}

// Neighborhood dropdown with add
async function neighborhoodSelect(selectId, selectedId) {
  const hoods = await API.get(API.org.neighborhoods());
  const sel = document.getElementById(selectId);
  sel.innerHTML = `<option value="">— No neighborhood —</option>` +
    hoods.map(h => `<option value="${h.id}" ${h.id === selectedId ? 'selected' : ''}>${h.name_he}</option>`).join('');
}

// Date/time local input value
function toLocalInput(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ''; }
}
