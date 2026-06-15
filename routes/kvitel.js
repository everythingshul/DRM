// routes/kvitel.js — Kvitel PDF + DOCX generation with Hebrew font support
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { all, get } = require('../db/schema');
const { requireAuth, requireOrg } = require('../middleware/auth');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const fs   = require('fs');
const path = require('path');

router.use(requireAuth, requireOrg);

const FONTS_DIR = path.join(__dirname, '../public/fonts');
const PAGE_SIZES = {
  letter: [612, 792],
  legal:  [612, 1008],
  a4:     [595.28, 841.89]
};

// Map font family name → TTF file
function getFontPath(fontFamily) {
  const map = {
    'Noto Sans Hebrew':  'NotoSansHebrew-Regular.ttf',
    'Frank Ruhl Libre':  'FrankRuhlLibre-Regular.ttf',
    'Heebo':             'NotoSansHebrew-Regular.ttf',  // fallback
    'Narkisim':          'FrankRuhlLibre-Regular.ttf',  // closest available
    'Times New Roman':   'FrankRuhlLibre-Regular.ttf',  // Hebrew serif fallback
    'Livvorn':           'FrankRuhlLibre-Regular.ttf',
  };
  const file = map[fontFamily] || 'NotoSansHebrew-Regular.ttf';
  const full = path.join(FONTS_DIR, file);
  return fs.existsSync(full) ? full : null;
}

function getDonors(orgId) {
  return all(`
    SELECT d.*, n.name_he as neighborhood_name, n.sort_order as nh_order
    FROM donors d
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    WHERE d.org_id=? AND d.kvitel_enabled=1
      AND d.kvitel IS NOT NULL AND TRIM(d.kvitel) != ''
    ORDER BY COALESCE(n.sort_order,999), n.name_he NULLS LAST, d.last_name, d.first_name
  `, [orgId]);
}

function parseHeaders(headerText) {
  if (!headerText) return [];
  try {
    const arr = JSON.parse(headerText);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// ── PDF ────────────────────────────────────────────────────────────────────────
router.post('/generate-pdf', async (req, res) => {
  try {
    const s = get('SELECT * FROM kvitel_settings WHERE org_id=?', [req.orgId]) || {};
    const donors = getDonors(req.orgId);
    if (!donors.length) return res.status(400).json({ error: 'No donors with kvitel content' });

    const pageSize = PAGE_SIZES[s.page_size || 'letter'];
    const W = pageSize[0], H = pageSize[1];
    const mT = (s.margin_top    || 1) * 72;
    const mB = (s.margin_bottom || 1) * 72;
    const mL = (s.margin_left   || 1) * 72;
    const mR = (s.margin_right  || 1) * 72;
    const numCols  = Math.max(1, parseInt(s.columns) || 2);
    const gapPts   = (s.column_gap  || 0.5) * 72;
    const bodySize = parseFloat(s.font_size)    || 12;
    const lineH    = bodySize * (parseFloat(s.line_height) || 1.6);
    const showNH   = s.group_by_neighborhood !== 0;
    const headers  = parseHeaders(s.header_text);

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);

    // Embed Hebrew font
    const fontPath = getFontPath(s.font_family || 'Frank Ruhl Libre');
    let heFont, heFontBold;
    if (fontPath && fs.existsSync(fontPath)) {
      const fontBytes = fs.readFileSync(fontPath);
      heFont = await doc.embedFont(fontBytes);
      // Use same font for bold (Hebrew fonts often have no separate bold TTF)
      const boldPath = path.join(FONTS_DIR, 'FrankRuhlLibre-Bold.ttf');
      heFontBold = fs.existsSync(boldPath) ? await doc.embedFont(fs.readFileSync(boldPath)) : heFont;
    } else {
      const { StandardFonts } = require('pdf-lib');
      heFont = await doc.embedFont(StandardFonts.Helvetica);
      heFontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    }

    const useableW = W - mL - mR;
    const colW = (useableW - gapPts * (numCols - 1)) / numCols;

    let curPage = null, col = 0, y = 0;

    // Calculate header height
    const headerHeight = headers.reduce((sum, h) => sum + (parseFloat(h.size) || 16) * 1.6 + 4, 0);

    function drawHeaders(page) {
      let hy = H - mT;
      for (const h of headers) {
        const sz = parseFloat(h.size) || 16;
        const f  = h.bold !== false ? heFontBold : heFont;
        const txt = String(h.text || '');
        if (!txt.trim()) continue;
        // Center, right, or left alignment across full useable width
        let x;
        const textW = txt.length * sz * 0.55; // approximate
        if (h.align === 'right') x = W - mR - textW;
        else if (h.align === 'left') x = mL;
        else x = W / 2 - textW / 2; // center
        page.drawText(txt, { x: Math.max(mL, Math.min(x, W - mR - textW)), y: hy, size: sz, font: f, color: rgb(0.1, 0.2, 0.45) });
        hy -= sz * 1.6 + 4;
      }
    }

    function newPage() {
      curPage = doc.addPage(pageSize);
      col = 0;
      y = H - mT - headerHeight - 4;
      drawHeaders(curPage);
    }

    function colX(c) { return mL + c * (colW + gapPts); }

    function ensureSpace(needed) {
      if (!curPage) { newPage(); return; }
      if (y - needed < mB) {
        col++;
        if (col >= numCols) { newPage(); }
        else { y = H - mT - headerHeight - 4; }
      }
    }

    newPage();

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

      if (showNH && nhName) {
        ensureSpace(lineH * 2);
        curPage.drawText(nhName, {
          x: colX(col), y, size: bodySize + 2, font: heFontBold,
          color: rgb(0.1, 0.2, 0.45), maxWidth: colW
        });
        y -= lineH * 1.5;
      }

      for (const donor of nhDonors) {
        // Per requirement: NO donor name — only kvitel content
        const lines = (donor.kvitel || '').split('\n').filter(l => l.trim());
        if (!lines.length) continue;
        ensureSpace(lines.length * lineH + 4);

        for (const line of lines) {
          ensureSpace(lineH);
          // Hebrew text is drawn L→R in PDF (RTL rendering requires complex shaping)
          // The font glyphs will be correct, direction handled by bidirectionality
          curPage.drawText(line, {
            x: colX(col), y, size: bodySize, font: heFont,
            color: rgb(0.1, 0.1, 0.1), maxWidth: colW
          });
          y -= lineH;
        }
        y -= 4;
      }
      y -= lineH * 0.5;
    }

    const bytes = await doc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=kvitel.pdf');
    res.send(Buffer.from(bytes));
  } catch(e) {
    console.error('kvitel PDF error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ── DOCX ───────────────────────────────────────────────────────────────────────
router.post('/generate-docx', async (req, res) => {
  try {
    const s = get('SELECT * FROM kvitel_settings WHERE org_id=?', [req.orgId]) || {};
    const donors = getDonors(req.orgId);
    if (!donors.length) return res.status(400).json({ error: 'No donors with kvitel content' });

    const showNH   = s.group_by_neighborhood !== 0;
    const bodySize = Math.round((parseFloat(s.font_size) || 12) * 2); // half-points
    const fontName = s.font_family || 'Frank Ruhl Libre';
    const lineH    = Math.round((parseFloat(s.line_height) || 1.6) * 240);
    const headers  = parseHeaders(s.header_text);

    const children = [];

    // Render headers
    for (const h of headers) {
      if (!h.text?.trim()) continue;
      const sz  = Math.round((parseFloat(h.size) || 16) * 2);
      const al  = h.align === 'right'  ? AlignmentType.RIGHT
                : h.align === 'left'   ? AlignmentType.LEFT
                : AlignmentType.CENTER;
      children.push(new Paragraph({
        children: [new TextRun({
          text: h.text, size: sz, bold: h.bold !== false,
          font: h.font || fontName
        })],
        alignment: al,
        bidirectional: (h.dir || 'rtl') === 'rtl',
        spacing: { after: 160 }
      }));
    }

    // Separator after headers
    if (headers.length) {
      children.push(new Paragraph({ children: [new TextRun('')], spacing: { after: 80 } }));
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

      if (showNH && nhName) {
        children.push(new Paragraph({
          children: [new TextRun({ text: nhName, bold: true, size: bodySize + 4, font: fontName, color: '1a3a6b' })],
          alignment: AlignmentType.RIGHT,
          bidirectional: true,
          spacing: { before: 200, after: 60 }
        }));
      }

      for (const donor of nhDonors) {
        // NO donor name per requirement — only kvitel lines
        const lines = (donor.kvitel || '').split('\n');
        for (const line of lines) {
          children.push(new Paragraph({
            children: [new TextRun({ text: line, size: bodySize, font: fontName })],
            alignment: AlignmentType.RIGHT,
            bidirectional: true,
            spacing: { line: lineH, lineRule: 'auto', after: 0 }
          }));
        }
        // Small gap between donors
        children.push(new Paragraph({ children: [new TextRun({ text: '', size: bodySize })], spacing: { after: 60 } }));
      }
    }

    const psMap = { letter:{width:12240,height:15840}, legal:{width:12240,height:20160}, a4:{width:11906,height:16838} };
    const ps = psMap[s.page_size || 'letter'];
    const tw = m => Math.round((parseFloat(m) || 1) * 1440);

    const docx = new Document({
      sections: [{
        properties: {
          page: {
            size: ps,
            margin: { top:tw(s.margin_top), bottom:tw(s.margin_bottom), left:tw(s.margin_left), right:tw(s.margin_right) }
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
    console.error('kvitel DOCX error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
