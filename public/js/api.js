// public/js/api.js - API client
const API = {
  orgId: null,

  async req(method, path, data, opts = {}) {
    const url = path.startsWith('/api') ? path : `/api${path}`;
    const options = {
      method,
      headers: { 'Content-Type': 'application/json', 'x-org-id': this.orgId || '' },
      credentials: 'include'
    };
    if (data && method !== 'GET') options.body = JSON.stringify(data);

    const res = await fetch(url, options);
    if (res.status === 401) { window.location.reload(); throw new Error('Unauthorized'); }

    const ct = res.headers.get('content-type') || '';
    if (opts.blob || ct.includes('application/pdf') || ct.includes('spreadsheet') || ct.includes('wordprocessing')) {
      return { ok: res.ok, blob: await res.blob(), filename: opts.filename };
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  },

  get: (path) => API.req('GET', path),
  post: (path, data) => API.req('POST', path, data),
  put: (path, data) => API.req('PUT', path, data),
  del: (path) => API.req('DELETE', path),

  async download(path, filename) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-org-id': API.orgId || '' },
      credentials: 'include',
      body: JSON.stringify({})
    });
    if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  },

  async downloadGet(path, filename) {
    const res = await fetch(path + (path.includes('?') ? '&' : '?') + '_t=' + Date.now(), {
      headers: { 'x-org-id': API.orgId || '' },
      credentials: 'include'
    });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  },

  // Org-scoped shortcuts
  org: {
    donors: () => `/api/orgs/${API.orgId}/donors`,
    donor: (id) => `/api/orgs/${API.orgId}/donors/${id}`,
    info: () => `/api/orgs/${API.orgId}/info`,
    stats: () => `/api/orgs/${API.orgId}/stats`,
    emailSettings: () => `/api/orgs/${API.orgId}/email-settings`,
    kvitelSettings: () => `/api/orgs/${API.orgId}/kvitel-settings`,
    neighborhoods: () => `/api/orgs/${API.orgId}/donors/meta/neighborhoods`,
    labels: () => `/api/orgs/${API.orgId}/donors/meta/labels`,
    chargeFailures: () => `/api/orgs/${API.orgId}/charge-failures`,
    bankTx: () => `/api/orgs/${API.orgId}/bank/transactions`,
    reports: (type) => `/api/orgs/${API.orgId}/reports/${type}`,
    users: () => `/api/orgs/${API.orgId}/users`,
    loginLog: () => `/api/orgs/${API.orgId}/login-log`,
    scheduledEmails: () => `/api/orgs/${API.orgId}/scheduled-emails`,
    daf: () => `/api/orgs/${API.orgId}/daf`,
    verification: () => `/api/orgs/${API.orgId}/donors/needs-verification`,
  }
};
