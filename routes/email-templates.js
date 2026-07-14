// routes/email-templates.js — Email template CRUD + HTML render + test send
'use strict';
const express    = require('express');
const router     = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');
const nodemailer = require('nodemailer');
const mailer    = require('../utils/mailer');

router.use(requireAuth, requireOrg);

// ── Merge tags → HTML ─────────────────────────────────────────────────────────
function interpolate(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || '');
}

// ── Build HTML email from blocks array ────────────────────────────────────────
function renderBlocks(blocks, vars = {}) {
  const rows = blocks.map(b => {
    const dir  = b.dir || 'ltr';
    const align= b.align || (dir === 'rtl' ? 'right' : 'left');
    const ff   = b.fontFamily || (dir === 'rtl' ? "'Noto Sans Hebrew', Arial, sans-serif" : "Arial, sans-serif");
    const base = `direction:${dir};text-align:${align};font-family:${ff}`;

    switch (b.type) {
      case 'header': return `
        <tr><td style="background:${b.bg||'#1a3a6b'};padding:${b.padding||'28px 32px'}">
          <div style="${base};font-size:${b.size||28}px;font-weight:${b.bold!==false?'bold':'normal'};
            color:${b.color||'#ffffff'};line-height:1.3">
            ${interpolate(b.text||'', vars)}
          </div>
        </td></tr>`;

      case 'image_overlay': {
        const oAlign = b.textAlign || 'center';
        const oVAlign= b.vAlign || 'center';
        const vPad   = oVAlign==='top' ? '16px 16px auto' : oVAlign==='bottom' ? 'auto 16px 16px' : 'auto';
        return `
          <tr><td style="padding:${b.padding||'0'};position:relative">
            <div style="position:relative;display:inline-block;width:100%">
              ${b.url ? `<img src="${b.url}" alt="${b.alt||''}"
                style="width:100%;max-height:${b.maxHeight||'400px'};object-fit:cover;display:block">` :
                `<div style="background:#c7d2fe;height:${b.maxHeight||'200px'};display:flex;align-items:center;justify-content:center;color:#666;font-size:13px">Image placeholder</div>`}
              <div style="position:absolute;inset:0;background:${b.overlay||'rgba(0,0,0,0.45)'};
                display:flex;align-items:${oVAlign==='top'?'flex-start':oVAlign==='bottom'?'flex-end':'center'};
                justify-content:${oAlign==='left'?'flex-start':oAlign==='right'?'flex-end':'center'};
                padding:20px">
                <div style="direction:${dir};text-align:${oAlign};font-family:${ff};
                  font-size:${b.size||28}px;font-weight:${b.bold!==false?'bold':'normal'};
                  color:${b.color||'#ffffff'};line-height:1.3;
                  text-shadow:0 2px 8px rgba(0,0,0,0.5);max-width:${b.textWidth||'80%'}">
                  ${interpolate(b.text||'Text over image', vars)}
                </div>
              </div>
            </div>
          </td></tr>`;
      }

      case 'image': return `
        <tr><td style="padding:${b.padding||'0'};text-align:${b.align||'center'}">
          ${b.url ? `<img src="${b.url}" alt="${b.alt||''}"
            style="max-width:${b.maxWidth||'100%'};height:auto;display:block;
            ${b.align==='center'?'margin:0 auto':''}">` : ''}
        </td></tr>`;

      case 'image_text': {
        const imgSide = b.imgSide || 'left';
        const imgCell = `<td style="width:${b.imgWidth||'40%'};vertical-align:middle;padding:8px">
          ${b.url?`<img src="${b.url}" style="width:100%;height:auto;border-radius:${b.radius||'0'}px">` : '<div style="background:#eee;height:120px"></div>'}
        </td>`;
        const txtCell = `<td style="vertical-align:middle;padding:${b.padding||'16px 24px'}">
          <div style="${base};font-size:${b.size||15}px;color:${b.color||'#333333'}">
            ${interpolate(b.text||'', vars)}
          </div>
        </td>`;
        return `<tr><td style="padding:0">
          <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            ${imgSide==='left' ? imgCell+txtCell : txtCell+imgCell}
          </tr></table>
        </td></tr>`;
      }

      case 'text': return `
        <tr><td style="padding:${b.padding||'12px 32px'}">
          <div style="${base};font-size:${b.size||15}px;color:${b.color||'#333333'};
            line-height:${b.lineHeight||1.7}">
            ${interpolate(b.text||'', vars)}
          </div>
        </td></tr>`;

      case 'donation_details': return `
        <tr><td style="padding:${b.padding||'8px 32px'}">
          <table width="100%" cellpadding="0" cellspacing="0" border="0"
            style="border-collapse:collapse;${base}">
            <tr style="background:${b.headerBg||'#f3f4f6'}">
              <td colspan="2" style="padding:10px 14px;font-weight:bold;
                font-size:${b.size||14}px;color:${b.headerColor||'#1a3a6b'}">
                ${interpolate(b.title||'Donation Details', vars)}
              </td>
            </tr>
            ${[
              ['Amount', '{{amount}}'],
              ['Date', '{{date}}'],
              ['Method', '{{method}}'],
              ['Transaction ID', '{{transaction_id}}']
            ].map(([label,tag],i) => `
              <tr style="background:${i%2===0?'#ffffff':'#f9fafb'}">
                <td style="padding:9px 14px;color:#666;font-size:${b.size||14}px;border-bottom:1px solid #eee;width:38%">${label}</td>
                <td style="padding:9px 14px;font-weight:600;font-size:${b.size||14}px;border-bottom:1px solid #eee">${interpolate(tag, vars)}</td>
              </tr>`).join('')}
          </table>
        </td></tr>`;

      case 'button': return `
        <tr><td style="padding:${b.padding||'16px 32px'};text-align:${b.align||'center'}">
          <a href="${interpolate(b.url||'#', vars)}"
            style="display:inline-block;background:${b.bg||'#1a3a6b'};
            color:${b.color||'#ffffff'};padding:${b.btnPadding||'12px 28px'};
            border-radius:${b.radius||'6'}px;font-size:${b.size||15}px;
            font-weight:bold;text-decoration:none;font-family:${ff}">
            ${interpolate(b.text||'Click Here', vars)}
          </a>
        </td></tr>`;

      case 'divider': return `
        <tr><td style="padding:${b.padding||'8px 32px'}">
          <hr style="border:none;border-top:${b.thickness||1}px solid ${b.color||'#e5e7eb'};margin:0">
        </td></tr>`;

      case 'spacer': return `
        <tr><td style="height:${b.height||24}px;font-size:1px;line-height:1px">&nbsp;</td></tr>`;

      case 'tax_footer': return `
        <tr><td style="padding:${b.padding||'16px 32px'};background:${b.bg||'#f9fafb'};
          border-top:1px solid #e5e7eb">
          <div style="${base};font-size:${b.size||12}px;color:${b.color||'#6b7280'};line-height:1.6">
            ${interpolate(b.text||
              'Tax ID: 11-6076986 | {{org_name}}<br>No goods or services were provided in exchange for this contribution.', vars)}
          </div>
        </td></tr>`;

      case 'columns': {
        const cols = b.columns || [];
        return `<tr><td style="padding:${b.padding||'8px 32px'}">
          <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            ${cols.map(c => {
              const cd = c.dir || dir;
              const ca = c.align || (cd==='rtl'?'right':'left');
              const cf = c.fontFamily || ff;
              return `<td style="width:${Math.floor(100/cols.length)}%;padding:${c.padding||'8px'};
                vertical-align:top;direction:${cd};text-align:${ca};font-family:${cf};
                font-size:${c.size||14}px;color:${c.color||'#333'}">
                ${interpolate(c.text||'', vars)}
              </td>`;
            }).join('')}
          </tr></table>
        </td></tr>`;
      }

      default: return '';
    }
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Hebrew:wght@400;700&family=Frank+Ruhl+Libre:wght@400;700&family=Heebo:wght@400;700&display=swap" rel="stylesheet">
</head><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0"
  style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);max-width:600px;width:100%">
${rows}
<tr><td style="padding:20px 32px 24px;text-align:center;background:#f9fafb;border-top:1px solid #e5e7eb">
  <div style="font-size:10px;color:#9ca3af;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:8px">Powered By</div>
  <a href="https://everythingshul.com" target="_blank" style="text-decoration:none">
    <img src="https://drm.everythingshul.com/img/logo.png" alt="EverythingShul"
      style="height:28px;width:auto;display:block;margin:0 auto;opacity:0.75"
      onerror="this.style.display='none'">
  </a>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Image upload ─────────────────────────────────────────────────────────────
router.post('/upload-image', requireOrgAdmin, async (req, res) => {
  try {
    const { image_base64, mime_type, filename } = req.body;
    if (!image_base64) return res.status(400).json({ error: 'No image data' });
    const fs   = require('fs');
    const path = require('path');
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
    const dir  = path.join(DATA_DIR, 'email-images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext  = (mime_type||'image/png').includes('jpeg')||String(filename||'').endsWith('.jpg') ? 'jpg' : 'png';
    const name = `img-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(image_base64, 'base64'));
    res.json({ success: true, url: `/email-images/${name}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CRUD ───────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json(all('SELECT * FROM email_templates WHERE org_id=? ORDER BY created_at DESC', [req.orgId]));
});

router.get('/:id', (req, res) => {
  const t = get('SELECT * FROM email_templates WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
});

router.post('/', requireOrgAdmin, (req, res) => {
  const { name, description, subject, blocks } = req.body;
  if (!name || !subject) return res.status(400).json({ error: 'name and subject required' });
  const id = uuidv4();
  run('INSERT INTO email_templates (id,org_id,name,description,subject,blocks) VALUES (?,?,?,?,?,?)',
    [id, req.orgId, name, description||'', subject, JSON.stringify(blocks||[])]);
  res.json({ success: true, template: get('SELECT * FROM email_templates WHERE id=?', [id]) });
});

router.put('/:id', requireOrgAdmin, (req, res) => {
  const { name, description, subject, blocks } = req.body;
  const ex = get('SELECT id FROM email_templates WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!ex) return res.status(404).json({ error: 'Template not found' });
  run('UPDATE email_templates SET name=?,description=?,subject=?,blocks=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
    [name, description||'', subject, JSON.stringify(blocks||[]), req.params.id]);
  res.json({ success: true });
});

router.delete('/:id', requireOrgAdmin, (req, res) => {
  run('DELETE FROM email_templates WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  res.json({ success: true });
});

// ── Set as default receipt template ───────────────────────────────────────────
router.post('/:id/set-default-receipt', requireOrgAdmin, (req, res) => {
  run('UPDATE email_templates SET is_default_receipt=0 WHERE org_id=?', [req.orgId]);
  run('UPDATE email_templates SET is_default_receipt=1 WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  res.json({ success: true });
});

router.post('/clear-default-receipt', requireOrgAdmin, (req, res) => {
  run('UPDATE email_templates SET is_default_receipt=0 WHERE org_id=?', [req.orgId]);
  res.json({ success: true });
});

// ── Preview: render blocks with sample data ───────────────────────────────────
router.post('/:id/preview', (req, res) => {
  const t = get('SELECT * FROM email_templates WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const org = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
  const blocks = (() => { try { return JSON.parse(t.blocks||'[]'); } catch { return []; } })();
  const sampleVars = req.body.vars || {
    first_name: 'Moshe', last_name: 'Goldberg', title: 'R\'', hebrew_name: 'משה גולדברג',
    amount: '$360.00', date: new Date().toLocaleDateString(),
    transaction_id: 'ES123456789', method: 'Credit Card',
    last_four: '4242', org_name: org?.name || 'Your Organization'
  };
  res.json({ html: renderBlocks(blocks, sampleVars) });
});

// ── Render with real donor/donation data (used by scheduler) ──────────────────
router.post('/render-for-donor', (req, res) => {
  const { template_id, donor_id, donation_id } = req.body;
  const t = get('SELECT * FROM email_templates WHERE id=? AND org_id=?', [template_id, req.orgId]);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const donor    = get('SELECT * FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
  const donation = get('SELECT * FROM donations WHERE id=?', [donation_id]);
  const org      = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
  if (!donor || !donation) return res.status(404).json({ error: 'Donor or donation not found' });
  const pm = donation.payment_method_id ? get('SELECT * FROM payment_methods WHERE id=?', [donation.payment_method_id]) : null;
  const blocks = (() => { try { return JSON.parse(t.blocks||'[]'); } catch { return []; } })();
  const vars = {
    first_name: donor.first_name, last_name: donor.last_name,
    title: donor.title||'', hebrew_name: donor.hebrew_full_name||'',
    amount: `$${parseFloat(donation.amount).toFixed(2)}`,
    date: new Date(donation.donation_date).toLocaleDateString(),
    transaction_id: donation.transaction_id||'N/A',
    method: (donation.method||'').replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase()),
    last_four: pm?.last_four||'', org_name: org?.name||''
  };
  res.json({ html: renderBlocks(blocks, vars), subject: t.subject });
});

// ── Test send ─────────────────────────────────────────────────────────────────
router.post('/:id/test-send', requireOrgAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Recipient email required' });

    const t = get('SELECT * FROM email_templates WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
    if (!t) return res.status(404).json({ error: 'Template not found' });

    const settings = get('SELECT * FROM email_settings WHERE org_id=?', [req.orgId]);
    if (!settings?.smtp_email) return res.status(400).json({ error: 'SMTP not configured. Set up email in Settings first.' });

    const org    = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
    const blocks = (() => { try { return JSON.parse(t.blocks||'[]'); } catch { return []; } })();
    const html   = renderBlocks(blocks, {
      first_name: 'Test', last_name: 'Recipient', title: '',
      hebrew_name: 'שם בעברית', amount: '$360.00',
      date: new Date().toLocaleDateString(), transaction_id: 'ES000000001',
      method: 'Credit Card', last_four: '4242', org_name: org?.name||''
    });

    const transporter = nodemailer.createTransport({
      host: settings.smtp_host || 'smtp.gmail.com',
      port: settings.smtp_port || 587,
      secure: false,
      auth: { user: settings.smtp_email, pass: settings.smtp_password }
    });

    await mailer.sendMail({
      settings, orgId: req.orgId,
      to, from: mailer.fromAddr(settings, org?.name),
      subject: '[TEST] ' + t.subject, html,
      type: 'test'
    });

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, renderBlocks };
