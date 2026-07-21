// routes/kvitel.js — Kvitel generation (PDF + DOCX), fully RTL, Hebrew fonts
'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { all, get, run } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { Document, Packer, Paragraph, TextRun, AlignmentType, SectionType } = require('docx');
const fs   = require('fs');
const path = require('path');

router.use(requireAuth, requireOrg);

// ── Font mapping ───────────────────────────────────────────────────────────────
const FONTS_DIR = path.join(__dirname, '../public/fonts');
const FONT_MAP = {
  'Noto Sans Hebrew':  'NotoSansHebrew-Regular.ttf',
  'Frank Ruhl Libre':  'FrankRuhlLibre-Regular.ttf',
  'Heebo':             'NotoSansHebrew-Regular.ttf',
  'Narkisim':          'FrankRuhlLibre-Regular.ttf',
  'Times New Roman':   'FrankRuhlLibre-Regular.ttf',
  'Livvorn':           'FrankRuhlLibre-Regular.ttf',
};
const FONT_MAP_BOLD = {
  'Frank Ruhl Libre':  'FrankRuhlLibre-Bold.ttf',
};

function fontPath(name, bold=false) {
  const map = bold ? FONT_MAP_BOLD : FONT_MAP;
  const file = map[name] || FONT_MAP[name] || 'NotoSansHebrew-Regular.ttf';
  const full = path.join(FONTS_DIR, file);
  // Fallback to Noto if file missing
  if (!fs.existsSync(full)) {
    const noto = path.join(FONTS_DIR, 'NotoSansHebrew-Regular.ttf');
    return fs.existsSync(noto) ? noto : null;
  }
  return full;
}

// ── Page size map ──────────────────────────────────────────────────────────────
const PAGE_SIZES = {
  letter: [612, 792],
  legal:  [612, 1008],
  a4:     [595.28, 841.89],
};

// ── Parse header JSON ──────────────────────────────────────────────────────────
function parseHeaders(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(h => h && h.text) : [];
  } catch { return []; }
}

// ── Get donors with kvitel, ordered by neighborhood ───────────────────────────
function getDonors(orgId) {
  return all(`
    SELECT d.id, d.kvitel, d.hebrew_full_name, d.first_name, d.last_name,
           n.name_he AS neighborhood_name, COALESCE(n.sort_order,9999) AS nh_order
    FROM donors d
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    WHERE d.org_id=? AND d.kvitel_enabled=1 AND d.removed_at IS NULL
      AND d.kvitel IS NOT NULL AND TRIM(d.kvitel) != ''
    ORDER BY COALESCE(n.sort_order,9999), n.name_he, d.last_name, d.first_name
  `, [orgId]);
}

// ── GET/PUT settings ───────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const s = get('SELECT * FROM kvitel_settings WHERE org_id=?', [req.orgId]);
  res.json(s || {});
});

router.put('/settings', requireOrgAdmin, (req, res) => {
  const {
    header_text, font_family, font_size, line_height, page_size,
    margin_top, margin_bottom, margin_left, margin_right,
    group_by_neighborhood, neighborhood_font, neighborhood_size, neighborhood_bold,
    columns, column_gap
  } = req.body;

  const ex = get('SELECT id FROM kvitel_settings WHERE org_id=?', [req.orgId]);
  if (ex) {
    run(`UPDATE kvitel_settings SET
         header_text=?, font_family=?, font_size=?, line_height=?, page_size=?,
         margin_top=?, margin_bottom=?, margin_left=?, margin_right=?,
         group_by_neighborhood=?, neighborhood_font=?, neighborhood_size=?, neighborhood_bold=?,
         columns=?, column_gap=?, updated_at=CURRENT_TIMESTAMP
         WHERE org_id=?`,
      [header_text, font_family||'Noto Sans Hebrew', parseFloat(font_size)||12,
       parseFloat(line_height)||1.6, page_size||'letter',
       parseFloat(margin_top)||1, parseFloat(margin_bottom)||1,
       parseFloat(margin_left)||1, parseFloat(margin_right)||1,
       group_by_neighborhood!==false?1:0,
       neighborhood_font||'Frank Ruhl Libre', parseFloat(neighborhood_size)||14,
       neighborhood_bold!==false?1:0,
       parseInt(columns)||1, parseFloat(column_gap)||0.5,
       req.orgId]);
  } else {
    const { v4: uuidv4 } = require('uuid');
    run(`INSERT INTO kvitel_settings
         (id,org_id,header_text,font_family,font_size,line_height,page_size,
          margin_top,margin_bottom,margin_left,margin_right,
          group_by_neighborhood,neighborhood_font,neighborhood_size,neighborhood_bold,
          columns,column_gap)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), req.orgId, header_text, font_family||'Noto Sans Hebrew',
       parseFloat(font_size)||12, parseFloat(line_height)||1.6, page_size||'letter',
       parseFloat(margin_top)||1, parseFloat(margin_bottom)||1,
       parseFloat(margin_left)||1, parseFloat(margin_right)||1,
       group_by_neighborhood!==false?1:0,
       neighborhood_font||'Frank Ruhl Libre', parseFloat(neighborhood_size)||14,
       neighborhood_bold!==false?1:0,
       parseInt(columns)||1, parseFloat(column_gap)||0.5]);
  }
  res.json({ success: true });
});

// ── PDF ────────────────────────────────────────────────────────────────────────
router.post('/generate-pdf', async (req, res) => {
  try {
    const cfg = get('SELECT * FROM kvitel_settings WHERE org_id=?', [req.orgId]) || {};
    const donors = getDonors(req.orgId);
    if (!donors.length) return res.status(400).json({ error: 'No donors with kvitel content and kvitel enabled' });

    const [W, H] = PAGE_SIZES[cfg.page_size || 'letter'];
    const mT = (cfg.margin_top    || 1) * 72;
    const mB = (cfg.margin_bottom || 1) * 72;
    const mL = (cfg.margin_left   || 1) * 72;
    const mR = (cfg.margin_right  || 1) * 72;
    const cols   = Math.max(1, parseInt(cfg.columns) || 1);
    const gap    = (cfg.column_gap || 0.5) * 72;
    const bodyPt = parseFloat(cfg.font_size) || 12;
    const lineH  = bodyPt * (parseFloat(cfg.line_height) || 1.6);
    const nhPt   = parseFloat(cfg.neighborhood_size) || 14;
    const showNH = cfg.group_by_neighborhood !== 0;
    const headers = parseHeaders(cfg.header_text);

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);

    // Embed body font
    const bodyFontPath = fontPath(cfg.font_family || 'Noto Sans Hebrew');
    const bodyFontBytes = bodyFontPath ? fs.readFileSync(bodyFontPath) : null;
    const bodyFont = bodyFontBytes ? await doc.embedFont(bodyFontBytes) : null;

    // Embed neighborhood font (may differ)
    const nhFontName = cfg.neighborhood_font || 'Frank Ruhl Libre';
    const nhFontPath = fontPath(nhFontName, cfg.neighborhood_bold !== 0);
    const nhFontBytes = nhFontPath ? fs.readFileSync(nhFontPath) : bodyFontBytes;
    const nhFont = nhFontBytes ? await doc.embedFont(nhFontBytes) : bodyFont;

    // Embed header fonts (each header can have its own font)
    const headerFontCache = {};
    async function getHdrFont(name, bold) {
      const key = (name||'Frank Ruhl Libre') + (bold?'_bold':'');
      if (headerFontCache[key]) return headerFontCache[key];
      const p = fontPath(name || 'Frank Ruhl Libre', bold);
      const bytes = p ? fs.readFileSync(p) : nhFontBytes;
      headerFontCache[key] = bytes ? await doc.embedFont(bytes) : nhFont;
      return headerFontCache[key];
    }

    if (!bodyFont) return res.status(500).json({ error: 'Hebrew font files not found. Ensure fonts are in public/fonts/' });

    const colW = (W - mL - mR - gap * (cols - 1)) / cols;

    // Track position
    let page = null, col = 0, y = 0;
    const headerHeightCache = {};

    function drawPageHeaders(pg) {
      let hy = H - mT;
      for (const h of headers) {
        const sz = parseFloat(h.size) || 16;
        // Header spans full page width (not column width)
        const txt = String(h.text || '');
        if (!txt.trim()) continue;
        // Draw at center/right/left across full useable width
        const maxW = W - mL - mR;
        // Because PDF doesn't do true RTL, we position from right for RTL text
        let x = mL;
        if (h.align === 'right' || (h.dir||'rtl')==='rtl') x = mL; // will draw maxWidth RTL
        pg.drawText(txt, {
          x, y: hy,
          size: sz,
          font: headerFontCache[`${h.font||'Frank Ruhl Libre'}${h.bold!==false?'_bold':''}`] || nhFont,
          color: rgb(0.08, 0.18, 0.40),
          maxWidth: maxW
        });
        hy -= sz * 1.7;
      }
      return H - mT - hy; // total header height used
    }

    // Pre-load header fonts
    for (const h of headers) {
      await getHdrFont(h.font, h.bold !== false);
    }

    // Measure total header height
    const hdrHeight = headers.reduce((s, h) => s + (parseFloat(h.size)||16)*1.7, 0);

    function colX(c) { return mL + c * (colW + gap); }

    function newPage() {
      page = doc.addPage([W, H]);
      col = 0;
      y = H - mT - hdrHeight - 4;
      drawPageHeaders(page);
    }

    function ensureSpace(needed) {
      if (!page) { newPage(); return; }
      if (y - needed < mB) {
        col++;
        if (col >= cols) { newPage(); }
        else { y = H - mT - hdrHeight - 4; }
      }
    }

    newPage();

    // Group donors by neighborhood
    const groups = new Map();
    for (const d of donors) {
      const nh = d.neighborhood_name || '';
      if (!groups.has(nh)) groups.set(nh, []);
      groups.get(nh).push(d);
    }

    for (const [nhName, nhDonors] of groups) {
      // Draw neighborhood heading
      if (showNH && nhName) {
        ensureSpace(nhPt * 2.2 + 4);
        page.drawText(nhName, {
          x: colX(col), y,
          size: nhPt,
          font: nhFont,
          color: rgb(0.08, 0.18, 0.40),
          maxWidth: colW
        });
        y -= nhPt * 1.7 + 4;
      }

      for (const donor of nhDonors) {
        // NO donor name — only kvitel content (requirement #19)
        const lines = (donor.kvitel || '').split('\n').filter(l => l.trim());
        if (!lines.length) continue;

        const blockH = lines.length * lineH + 6;
        ensureSpace(blockH);

        for (const line of lines) {
          ensureSpace(lineH);
          page.drawText(line.trim(), {
            x: colX(col), y,
            size: bodyPt,
            font: bodyFont,
            color: rgb(0.1, 0.1, 0.1),
            maxWidth: colW
          });
          y -= lineH;
        }
        y -= 5; // gap between donors
      }
      y -= nhPt * 0.6; // gap between neighborhoods
    }

    const bytes = await doc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=kvitel.pdf');
    res.send(Buffer.from(bytes));
  } catch(e) {
    console.error('Kvitel PDF error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DOCX — fully RTL ──────────────────────────────────────────────────────────
router.post('/generate-docx', async (req, res) => {
  try {
    const cfg = get('SELECT * FROM kvitel_settings WHERE org_id=?', [req.orgId]) || {};
    const donors = getDonors(req.orgId);
    if (!donors.length) return res.status(400).json({ error: 'No donors with kvitel content and kvitel enabled' });

    const showNH   = cfg.group_by_neighborhood !== 0;
    const bodyFont = cfg.font_family || 'Noto Sans Hebrew';
    const bodyPt   = Math.round((parseFloat(cfg.font_size)||12) * 2); // half-points
    const lineH    = Math.round((parseFloat(cfg.line_height)||1.6) * 240); // 240 = single
    const nhFont   = cfg.neighborhood_font || 'Frank Ruhl Libre';
    const nhPt     = Math.round((parseFloat(cfg.neighborhood_size)||14) * 2);
    const nhBold   = cfg.neighborhood_bold !== 0;
    const headers  = parseHeaders(cfg.header_text);

    const psMap = {
      letter: { width: 12240, height: 15840 },
      legal:  { width: 12240, height: 20160 },
      a4:     { width: 11906, height: 16838 }
    };
    const ps = psMap[cfg.page_size||'letter'];
    const tw = m => Math.round((parseFloat(m)||1) * 1440);

    const children = [];

    // ── Headers ──────────────────────────────────────────────────────────────
    for (const h of headers) {
      if (!h.text?.trim()) continue;
      const hPt = Math.round((parseFloat(h.size)||16)*2);
      const al  = h.align==='right'  ? AlignmentType.RIGHT
                : h.align==='left'   ? AlignmentType.LEFT
                : AlignmentType.CENTER;
      children.push(new Paragraph({
        bidirectional: true,
        alignment: al,
        spacing: { after: 100 },
        children: [new TextRun({
          text: h.text,
          size: hPt,
          bold: h.bold !== false,
          font: h.font || 'Frank Ruhl Libre',
          color: '1a3a6b'
        })]
      }));
    }
    // Blank line after headers
    if (headers.length) {
      children.push(new Paragraph({ bidirectional:true, children:[new TextRun({text:''})] }));
    }

    // ── Donors grouped by neighborhood ────────────────────────────────────────
    const groups = new Map();
    for (const d of donors) {
      const nh = d.neighborhood_name || '';
      if (!groups.has(nh)) groups.set(nh, []);
      groups.get(nh).push(d);
    }

    for (const [nhName, nhDonors] of groups) {
      if (showNH && nhName) {
        children.push(new Paragraph({
          bidirectional: true,
          alignment: AlignmentType.RIGHT,
          spacing: { before: 160, after: 60 },
          children: [new TextRun({
            text: nhName,
            size: nhPt,
            bold: nhBold,
            font: nhFont,
            color: '1a3a6b'
          })]
        }));
      }

      for (const donor of nhDonors) {
        // NO donor name — only kvitel lines (#19)
        const lines = (donor.kvitel || '').split('\n');
        for (const line of lines) {
          children.push(new Paragraph({
            bidirectional: true,           // RTL paragraph
            alignment: AlignmentType.RIGHT, // right-align
            spacing: { line: lineH, lineRule: 'auto', after: 0 },
            children: [new TextRun({
              text: line,
              size: bodyPt,
              font: bodyFont
            })]
          }));
        }
        // Small separator between donors
        children.push(new Paragraph({
          bidirectional: true,
          children: [new TextRun({ text: '', size: bodyPt })],
          spacing: { after: 60 }
        }));
      }
    }

    const docx = new Document({
      sections: [{
        properties: {
          type: SectionType.CONTINUOUS,
          page: {
            size: ps,
            margin: { top:tw(cfg.margin_top), bottom:tw(cfg.margin_bottom), left:tw(cfg.margin_left), right:tw(cfg.margin_right) }
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
    console.error('Kvitel DOCX error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
