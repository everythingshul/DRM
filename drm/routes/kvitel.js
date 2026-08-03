// routes/kvitel.js - Generate Kvitel PDF and DOCX
const express = require('express');
const router = express.Router({ mergeParams: true });
const { all, get } = require('../db/schema');
const { requireAuth, requireOrg } = require('../middleware/auth');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');

router.use(requireAuth, requireOrg);

const PAGE_SIZES = {
  letter: [612, 792],
  legal: [612, 1008],
  a4: [595.28, 841.89]
};

// Generate PDF Kvitel
router.post('/generate-pdf', async (req, res) => {
  try {
    const settings = get('SELECT * FROM kvitel_settings WHERE org_id = ?', [req.orgId]);
    const donors = all(`
      SELECT d.*, n.name_he as neighborhood_name, n.sort_order as neighborhood_order
      FROM donors d
      LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
      WHERE d.org_id = ? AND d.kvitel_enabled = 1
        AND (d.kvitel IS NOT NULL AND TRIM(d.kvitel) != '')
      ORDER BY n.sort_order, n.name_he, d.hebrew_full_name, d.last_name
    `, [req.orgId]);

    if (!donors.length) return res.status(400).json({ error: 'No donors with kvitel content' });

    const s = settings || {};
    const pageSize = PAGE_SIZES[s.page_size || 'letter'];
    const marginTop = (s.margin_top || 1) * 72;
    const marginBottom = (s.margin_bottom || 1) * 72;
    const marginLeft = (s.margin_left || 1) * 72;
    const marginRight = (s.margin_right || 1) * 72;
    const numCols = s.columns || 2;
    const colGap = (s.column_gap || 0.5) * 72;
    const fontSize = s.font_size || 12;
    const lineHeight = fontSize * (s.line_height || 1.6);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const usableWidth = pageSize[0] - marginLeft - marginRight;
    const usableHeight = pageSize[1] - marginTop - marginBottom;
    const colWidth = (usableWidth - colGap * (numCols - 1)) / numCols;

    let currentPage = pdfDoc.addPage(pageSize);
    let col = 0;
    let y = pageSize[1] - marginTop;

    function getColX(c) {
      return marginLeft + c * (colWidth + colGap);
    }

    function drawHeader(page) {
      const headerText = s.header_html ? s.header_html.replace(/<[^>]+>/g, '') : 'Kvitel';
      page.drawText(headerText, {
        x: marginLeft,
        y: pageSize[1] - marginTop / 2 - 10,
        size: 16,
        font,
        color: rgb(0, 0, 0.4)
      });
    }

    drawHeader(currentPage);

    function needNewColumn() {
      col++;
      if (col >= numCols) {
        col = 0;
        currentPage = pdfDoc.addPage(pageSize);
        drawHeader(currentPage);
      }
      y = pageSize[1] - marginTop;
    }

    // Group by neighborhood
    const grouped = {};
    donors.forEach(d => {
      const key = d.neighborhood_name || 'ללא שכונה';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(d);
    });

    for (const [neighborhoodName, nDonors] of Object.entries(grouped)) {
      // Check if neighborhood header fits
      if (y - lineHeight * 2 < marginBottom) needNewColumn();

      // Neighborhood header
      const nhText = neighborhoodName;
      currentPage.drawText(nhText, {
        x: getColX(col),
        y,
        size: fontSize + 2,
        font,
        color: rgb(0.1, 0.1, 0.5),
        maxWidth: colWidth
      });
      y -= lineHeight * 1.5;

      for (const donor of nDonors) {
        const lines = (donor.kvitel || '').split('\n').filter(l => l.trim());
        const blockHeight = lines.length * lineHeight + lineHeight;

        if (y - blockHeight < marginBottom) needNewColumn();

        // Donor name
        const name = donor.hebrew_full_name || `${donor.first_name} ${donor.last_name}`;
        currentPage.drawText(name, {
          x: getColX(col),
          y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
          maxWidth: colWidth
        });
        y -= lineHeight;

        // Kvitel lines
        for (const line of lines) {
          if (y - lineHeight < marginBottom) needNewColumn();
          currentPage.drawText(line, {
            x: getColX(col),
            y,
            size: fontSize - 1,
            font,
            color: rgb(0.2, 0.2, 0.2),
            maxWidth: colWidth
          });
          y -= lineHeight;
        }

        y -= lineHeight * 0.5; // spacing between donors
      }

      y -= lineHeight; // extra gap between neighborhoods
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=kvitel.pdf');
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error('PDF error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Generate DOCX Kvitel
router.post('/generate-docx', async (req, res) => {
  try {
    const settings = get('SELECT * FROM kvitel_settings WHERE org_id = ?', [req.orgId]);
    const donors = all(`
      SELECT d.*, n.name_he as neighborhood_name, n.sort_order as neighborhood_order
      FROM donors d
      LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
      WHERE d.org_id = ? AND d.kvitel_enabled = 1
        AND (d.kvitel IS NOT NULL AND TRIM(d.kvitel) != '')
      ORDER BY n.sort_order, n.name_he, d.hebrew_full_name, d.last_name
    `, [req.orgId]);

    if (!donors.length) return res.status(400).json({ error: 'No donors with kvitel content' });

    const s = settings || {};
    const fontSize = (s.font_size || 12) * 2; // half-points
    const children = [];

    // Header
    const headerText = s.header_html ? s.header_html.replace(/<[^>]+>/g, '') : 'Kvitel';
    children.push(new Paragraph({
      children: [new TextRun({ text: headerText, bold: true, size: 32, color: '000066' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    }));

    // Group by neighborhood
    const grouped = {};
    donors.forEach(d => {
      const key = d.neighborhood_name || 'ללא שכונה';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(d);
    });

    for (const [nhName, nDonors] of Object.entries(grouped)) {
      // Neighborhood heading
      children.push(new Paragraph({
        children: [new TextRun({ text: nhName, bold: true, size: fontSize + 4, color: '1a1a80' })],
        alignment: AlignmentType.RIGHT,
        bidirectional: true,
        spacing: { before: 200, after: 100 }
      }));

      for (const donor of nDonors) {
        const name = donor.hebrew_full_name || `${donor.first_name} ${donor.last_name}`;
        // Donor name line
        children.push(new Paragraph({
          children: [new TextRun({ text: name, bold: true, size: fontSize })],
          alignment: AlignmentType.RIGHT,
          bidirectional: true
        }));

        // Kvitel lines
        const lines = (donor.kvitel || '').split('\n');
        for (const line of lines) {
          children.push(new Paragraph({
            children: [new TextRun({ text: line, size: fontSize - 2 })],
            alignment: AlignmentType.RIGHT,
            bidirectional: true
          }));
        }

        // Blank line between donors
        children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
      }
    }

    // Page size
    const pageSizes = {
      letter: { width: 12240, height: 15840 },
      legal: { width: 12240, height: 20160 },
      a4: { width: 11906, height: 16838 }
    };
    const ps = pageSizes[s.page_size || 'letter'];
    const marginTwips = (s.margin_top || 1) * 1440;

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: { width: ps.width, height: ps.height },
            margin: { top: marginTwips, bottom: marginTwips, left: marginTwips, right: marginTwips }
          }
        },
        children
      }]
    });

    const buf = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename=kvitel.docx');
    res.send(buf);
  } catch (e) {
    console.error('DOCX error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
