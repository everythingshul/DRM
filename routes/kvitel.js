// routes/kvitel.js — Kvitel PDF + DOCX generation
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { all, get } = require('../db/schema');
const { requireAuth, requireOrg } = require('../middleware/auth');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');

router.use(requireAuth, requireOrg);

const PAGE_SIZES = {
  letter: [612, 792],
  legal:  [612, 1008],
  a4:     [595.28, 841.89]
};

function getDonors(orgId) {
  return all(`
    SELECT d.*, n.name_he as neighborhood_name, n.sort_order as nh_order
    FROM donors d
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    WHERE d.org_id=? AND d.kvitel_enabled=1
      AND d.kvitel IS NOT NULL AND TRIM(d.kvitel) != ''
    ORDER BY COALESCE(n.sort_order,999), n.name_he, d.last_name, d.first_name
  `, [orgId]);
}

// ── PDF ────────────────────────────────────────────────────────────────────────
router.post('/generate-pdf', async (req, res) => {
  try {
    const s = get('SELECT * FROM kvitel_settings WHERE org_id=?', [req.orgId]) || {};
    const donors = getDonors(req.orgId);
    if (!donors.length) return res.status(400).json({ error: 'No donors with kvitel content and kvitel enabled' });

    const pageSize  = PAGE_SIZES[s.page_size || 'letter'];
    const W         = pageSize[0], H = pageSize[1];
    const mT        = (s.margin_top    || 1) * 72;
    const mB        = (s.margin_bottom || 1) * 72;
    const mL        = (s.margin_left   || 1) * 72;
    const mR        = (s.margin_right  || 1) * 72;
    const numCols   = Math.max(1, parseInt(s.columns)    || 2);
    const gapPts    = (s.column_gap    || 0.5) * 72;
    const bodySize  = parseFloat(s.font_size)  || 12;
    const lineH     = bodySize * (parseFloat(s.line_height) || 1.6);
    const showNH    = s.group_by_neighborhood !== 0;

    const doc  = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    const useableW  = W - mL - mR;
    const colW      = (useableW - gapPts * (numCols - 1)) / numCols;

    // Headers — parse from JSON array stored as header_text, or use legacy single
    let headers = [];
    try { headers = JSON.parse(s.header_text || '[]'); if (!Array.isArray(headers)) headers = []; }
    catch { headers = s.header_text ? [{ text: s.header_text, size: s.header_size || 18, bold: true, align: 'center' }] : []; }

    let curPage = null;
    let col = 0;
    let y   = 0;

    function newPage() {
      curPage = doc.addPage(pageSize);
      col = 0;
      y   = H - mT;
      // Draw headers on each new page
      let hy = y;
      for (const h of headers) {
        const sz  = parseFloat(h.size) || 16;
        const f   = h.bold !== false ? bold : font;
        const txt = String(h.text || '');
        const x   = h.align === 'right' ? W - mR - txt.length * sz * 0.5
                  : h.align === 'left'  ? mL
                  : W / 2 - txt.length * sz * 0.3; // center approx
        curPage.drawText(txt, { x: Math.max(mL, x), y: hy, size: sz, font: f, color: rgb(0.1, 0.2, 0.45) });
        hy -= sz * 1.6;
      }
      y = hy - 8;
    }

    function colX(c) { return mL + c * (colW + gapPts); }

    function needSpace(needed) {
      if (y - needed < mB) {
        col++;
        if (col >= numCols) { newPage(); }
        else { y = H - mT - headers.reduce((s, h) => s + (parseFloat(h.size)||16)*1.6, 0) - 8; }
      }
    }

    newPage();

    // Group by neighborhood
    const groups = {};
    const order  = [];
    donors.forEach(d => {
      const key = d.neighborhood_name || '__none__';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(d);
    });

    for (const nhKey of order) {
      const nhName = nhKey === '__none__' ? null : nhKey;
      const nhDonors = groups[nhKey];

      // Neighborhood header
      if (showNH && nhName) {
        needSpace(lineH * 2);
        curPage.drawText(nhName, {
          x: colX(col), y, size: bodySize + 2, font: bold,
          color: rgb(0.1, 0.2, 0.45), maxWidth: colW
        });
        y -= lineH * 1.5;
      }

      for (const donor of nhDonors) {
        const lines = (donor.kvitel || '').split('\n').filter(l => l.trim());
        // NOTE: Per requirement #20, we do NOT print donor name — only neighborhood + kvitel lines
        const blockH = lines.length * lineH + 6;
        needSpace(blockH);

        // Kvitel content lines (RTL — approximated with PDF; true RTL needs custom font)
        for (const line of lines) {
          if (y - lineH < mB) { col++; if (col >= numCols) { newPage(); } else { y = H - mT - headers.reduce((s,h)=>s+(parseFloat(h.size)||16)*1.6,0)-8; } }
          // Draw text — PDF standard fonts don't do Hebrew; text will show as placeholder
          // In production, embed a Hebrew font via fontkit for proper rendering
          curPage.drawText(line.length > 60 ? line.slice(0,60)+'…' : line, {
            x: colX(col), y, size: bodySize, font,
            color: rgb(0.15, 0.15, 0.15), maxWidth: colW
          });
          y -= lineH;
        }
        y -= 6; // gap between donors
      }
      y -= lineH * 0.5; // extra gap between neighborhoods
    }

    const bytes = await doc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=kvitel.pdf');
    res.send(Buffer.from(bytes));
  } catch(e) {
    console.error('kvitel PDF:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ── DOCX ───────────────────────────────────────────────────────────────────────
router.post('/generate-docx', async (req, res) => {
  try {
    const s = get('SELECT * FROM kvitel_settings WHERE org_id=?', [req.orgId]) || {};
    const donors = getDonors(req.orgId);
    if (!donors.length) return res.status(400).json({ error: 'No donors with kvitel content and kvitel enabled' });

    const showNH   = s.group_by_neighborhood !== 0;
    const bodySize = Math.round((parseFloat(s.font_size) || 12) * 2);  // half-points
    const fontName = s.font_family || 'Times New Roman';
    const lineH    = parseFloat(s.line_height) || 1.6;
    const spacing  = { line: Math.round(lineH * 240), lineRule: 'auto' }; // 240 = single

    // Parse headers
    let headers = [];
    try { headers = JSON.parse(s.header_text || '[]'); if (!Array.isArray(headers)) headers = []; }
    catch { headers = s.header_text ? [{ text: s.header_text, size: s.header_size||18, bold:true, align:'center' }] : []; }

    const children = [];

    // Render headers
    for (const h of headers) {
      const sz  = Math.round((parseFloat(h.size)||16) * 2);
      const dir = h.dir || s.header_dir || 'rtl';
      const al  = h.align === 'right' ? AlignmentType.RIGHT
                : h.align === 'left'  ? AlignmentType.LEFT
                : AlignmentType.CENTER;
      children.push(new Paragraph({
        children: [new TextRun({ text: h.text || '', size: sz, bold: h.bold !== false, font: h.font || fontName })],
        alignment: al,
        bidirectional: dir === 'rtl',
        spacing: { after: 200 }
      }));
    }

    // Group by neighborhood
    const groups = {}, order = [];
    donors.forEach(d => {
      const key = d.neighborhood_name || '__none__';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(d);
    });

    for (const nhKey of order) {
      const nhName   = nhKey === '__none__' ? null : nhKey;
      const nhDonors = groups[nhKey];

      // Neighborhood heading
      if (showNH && nhName) {
        children.push(new Paragraph({
          children: [new TextRun({ text: nhName, bold: true, size: bodySize + 4, font: fontName, color: '1a3a6b' })],
          alignment: AlignmentType.RIGHT,
          bidirectional: true,
          spacing: { before: 200, after: 80 }
        }));
      }

      for (const donor of nhDonors) {
        // Per #20: NO donor name — only kvitel content
        const lines = (donor.kvitel || '').split('\n');
        for (const line of lines) {
          children.push(new Paragraph({
            children: [new TextRun({ text: line, size: bodySize, font: fontName })],
            alignment: AlignmentType.RIGHT,
            bidirectional: true,
            spacing
          }));
        }
        // Blank line between donors
        children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
      }
    }

    // Page size
    const pageSizes = {
      letter: { width: 12240, height: 15840 },
      legal:  { width: 12240, height: 20160 },
      a4:     { width: 11906, height: 16838 }
    };
    const ps = pageSizes[s.page_size || 'letter'];
    const marginTwips = m => Math.round((parseFloat(m)||1) * 1440);

    const docx = new Document({
      sections: [{
        properties: {
          page: {
            size: ps,
            margin: {
              top:    marginTwips(s.margin_top),
              bottom: marginTwips(s.margin_bottom),
              left:   marginTwips(s.margin_left),
              right:  marginTwips(s.margin_right)
            }
          }
        },
        children
      }]
    });

    const buf = await Packer.toBuffer(docx);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename=kvitel.docx');
    res.send(buf);
  } catch(e) {
    console.error('kvitel DOCX:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
