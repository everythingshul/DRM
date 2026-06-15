// public/js/api.js
// Pages registry — declared first so page files can register before app.js loads
const Pages = {};

// Global state accessible to all page files
window.DRM = {
  user: null,
  org: null,
  orgs: []
};

const API = {
  orgId: null,

  async req(method, path, data) {
    const url = path.startsWith('/api') ? path : `/api${path}`;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'x-org-id': API.orgId || '' },
      credentials: 'include'
    };
    if (data && method !== 'GET') opts.body = JSON.stringify(data);
    const res = await fetch(url, opts);
    if (res.status === 401) { window.location.href = '/'; throw new Error('Session expired'); }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) throw new Error('Unexpected response');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  },

  get:  (path)       => API.req('GET',    path),
  post: (path, data) => API.req('POST',   path, data),
  put:  (path, data) => API.req('PUT',    path, data),
  del:  (path)       => API.req('DELETE', path),

  async downloadPost(path, filename) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-org-id': API.orgId || '' },
      credentials: 'include', body: JSON.stringify({})
    });
    if (!res.ok) { const j = await res.json().catch(()=>{}); throw new Error(j?.error || 'Download failed'); }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    URL.revokeObjectURL(a.href);
  },

  async downloadGet(path, filename) {
    const res = await fetch(path, {
      headers: { 'x-org-id': API.orgId || '' }, credentials: 'include'
    });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    URL.revokeObjectURL(a.href);
  },

  org: {
    donors:           ()   => `/api/orgs/${API.orgId}/donors`,
    donor:            (id) => `/api/orgs/${API.orgId}/donors/${id}`,
    stats:            ()   => `/api/orgs/${API.orgId}/stats`,
    emailSettings:    ()   => `/api/orgs/${API.orgId}/email-settings`,
    kvitelSettings:   ()   => `/api/orgs/${API.orgId}/kvitel-settings`,
    neighborhoods:    ()   => `/api/orgs/${API.orgId}/donors/meta/neighborhoods`,
    labels:           ()   => `/api/orgs/${API.orgId}/donors/meta/labels`,
    chargeFailures:   ()   => `/api/orgs/${API.orgId}/charge-failures`,
    bankTx:           ()   => `/api/orgs/${API.orgId}/bank/transactions`,
    scheduledEmails:  ()   => `/api/orgs/${API.orgId}/scheduled-emails`,
    daf:              ()   => `/api/orgs/${API.orgId}/daf`,
    verification:     ()   => `/api/orgs/${API.orgId}/donors/needs-verification`,
    users:            ()   => `/api/orgs/${API.orgId}/users`,
    loginLog:         ()   => `/api/orgs/${API.orgId}/login-log`,
  }
};
