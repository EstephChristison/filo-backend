// ═══════════════════════════════════════════════════════════════════
// FILO — PDF Generation Engine
// Generates: Submittal Documents, Customer Estimates, Internal BOMs
// Uses: Puppeteer (submittal PDFs) + PDFKit (estimate PDFs)
// All client-facing documents are WHITE-LABELED (no FILO branding)
// ═══════════════════════════════════════════════════════════════════

import puppeteer from 'puppeteer';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ─── Configuration ───────────────────────────────────────────────

const PDF_CONFIG = {
  tempDir: process.env.PDF_TEMP_DIR || '/tmp/filo-pdfs',
  chromiumPath: process.env.CHROMIUM_PATH || null, // auto-detect
  defaultFont: 'Helvetica',
  brandFont: 'Helvetica-Bold',
};

// Ensure temp directory exists
if (!fs.existsSync(PDF_CONFIG.tempDir)) {
  fs.mkdirSync(PDF_CONFIG.tempDir, { recursive: true });
}

// ═══════════════════════════════════════════════════════════════════
// SUBMITTAL PDF GENERATOR (Puppeteer — HTML → PDF)
// ═══════════════════════════════════════════════════════════════════

export class SubmittalPDFGenerator {
  constructor(db, s3) {
    this.db = db;
    this.s3 = s3;
  }

  async generate(submittalId) {
    // Load all data
    const submittal = await this.db.getOne('SELECT * FROM submittals WHERE id = $1', [submittalId]);
    const project = await this.db.getOne(
      `SELECT p.*, c.display_name as client_name, c.address_line1 as client_address,
              c.city as client_city, c.state as client_state, c.zip as client_zip
       FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
      [submittal.project_id]
    );
    const company = await this.db.getOne('SELECT * FROM companies WHERE id = $1', [submittal.company_id]);
    const plantProfiles = await this.db.getMany(
      'SELECT * FROM submittal_plant_profiles WHERE submittal_id = $1 ORDER BY sort_order', [submittalId]
    );

    // Get before/after photos
    const areas = await this.db.getMany('SELECT * FROM property_areas WHERE project_id = $1', [project.id]);
    const photos = [];
    const renderings = [];
    for (const area of areas) {
      const areaPhotos = await this.db.getMany(
        'SELECT f.cdn_url, f.original_name FROM photos p JOIN files f ON f.id = p.file_id WHERE p.property_area_id = $1 LIMIT 1',
        [area.id]
      );
      if (areaPhotos.length) photos.push(areaPhotos[0]);

      const design = await this.db.getOne(
        'SELECT rendering_url FROM designs WHERE property_area_id = $1 AND is_current = true', [area.id]
      );
      if (design?.rendering_url) renderings.push({ url: design.rendering_url, area: area.area_type });
    }

    // Build HTML
    const html = this.buildSubmittalHTML({
      company,
      project,
      submittal,
      plantProfiles,
      photos,
      renderings,
    });

    // Render to PDF via Puppeteer
    const pdfPath = path.join(PDF_CONFIG.tempDir, `submittal-${submittalId}-${uuidv4()}.pdf`);

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: PDF_CONFIG.chromiumPath || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.pdf({
        path: pdfPath,
        format: 'Letter',
        printBackground: true,
        margin: { top: '0.5in', bottom: '0.75in', left: '0.6in', right: '0.6in' },
        displayHeaderFooter: true,
        footerTemplate: `<div style="width:100%;text-align:center;font-size:9px;color:#999;font-family:Helvetica,sans-serif;">
          <span class="pageNumber"></span> of <span class="totalPages"></span>
        </div>`,
        headerTemplate: '<div></div>',
      });

      await browser.close();
      browser = null;

      // Upload to S3
      const s3Key = `${company.id}/submittals/${submittalId}.pdf`;
      const pdfBuffer = fs.readFileSync(pdfPath);

      await this.s3.upload({
        Bucket: process.env.S3_BUCKET,
        Key: s3Key,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
      }).promise();

      const cdnUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

      // Save file record
      const file = await this.db.getOne(
        `INSERT INTO files (company_id, file_type, original_name, s3_key, s3_bucket, cdn_url, mime_type, file_size)
         VALUES ($1, 'submittal_pdf', $2, $3, $4, $5, 'application/pdf', $6) RETURNING *`,
        [company.id, `Submittal_${project.project_number}.pdf`, s3Key, process.env.S3_BUCKET, cdnUrl, pdfBuffer.length]
      );

      // Update submittal record
      await this.db.query(
        'UPDATE submittals SET pdf_file_id = $1, pdf_url = $2 WHERE id = $3',
        [file.id, cdnUrl, submittalId]
      );

      // Cleanup temp file
      fs.unlinkSync(pdfPath);

      return { success: true, pdfUrl: cdnUrl, fileId: file.id, size: pdfBuffer.length };
    } catch (err) {
      if (browser) await browser.close();
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      console.error('[PDF:submittal] Generation failed:', err);
      return { success: false, error: err.message };
    }
  }

  buildSubmittalHTML({ company, project, submittal, plantProfiles, photos, renderings }) {
    const logoHtml = company.logo_url
      ? `<img src="${company.logo_url}" alt="${company.name}" style="max-height:80px;max-width:300px;">`
      : `<div style="font-family:'Georgia',serif;font-size:28px;font-weight:bold;color:#1a3a2a;">${company.name}</div>`;

    const plantCards = plantProfiles.map(p => `
      <div class="plant-card">
        ${p.image_url ? `<img src="${p.image_url}" alt="${p.plant_name}" class="plant-img">` : '<div class="plant-img-placeholder"></div>'}
        <div class="plant-info">
          <h3>${p.plant_name}</h3>
          <p class="poetic">${p.poetic_desc || ''}</p>
          <div class="plant-details">
            ${p.bloom_info ? `<span>Bloom: ${p.bloom_info}</span>` : ''}
            ${p.sun_info ? `<span>Sun: ${p.sun_info.replace(/_/g, ' ')}</span>` : ''}
            ${p.water_info ? `<span>Water: ${p.water_info}</span>` : ''}
          </div>
        </div>
      </div>
    `).join('');

    const beforeAfterHtml = photos.map((photo, i) => `
      <div class="before-after">
        <div class="ba-panel">
          <h4>Before</h4>
          <img src="${photo.cdn_url}" alt="Before">
        </div>
        ${renderings[i] ? `<div class="ba-panel">
          <h4>After</h4>
          <img src="${renderings[i].url}" alt="After">
        </div>` : ''}
      </div>
    `).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: letter; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333; line-height: 1.6; }

  /* Cover Page */
  .cover { height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; background: linear-gradient(180deg, #f8fdf9 0%, #eef7f0 100%); page-break-after: always; padding: 60px; }
  .cover .logo { margin-bottom: 60px; }
  .cover h1 { font-family: Georgia, serif; font-size: 36px; color: #1a3a2a; margin-bottom: 12px; }
  .cover .subtitle { font-size: 18px; color: #666; margin-bottom: 40px; }
  .cover .meta { font-size: 14px; color: #888; }
  .cover .meta div { margin-bottom: 4px; }
  .cover .divider { width: 80px; height: 2px; background: #2d6a4f; margin: 30px auto; }

  /* Section Pages */
  .section { page-break-before: always; padding: 40px 0; }
  .section:first-of-type { page-break-before: avoid; }
  h2 { font-family: Georgia, serif; font-size: 24px; color: #1a3a2a; margin-bottom: 20px; padding-bottom: 8px; border-bottom: 2px solid #2d6a4f; }
  p { font-size: 13px; margin-bottom: 12px; }

  /* Scope Narrative */
  .narrative { font-size: 14px; line-height: 1.8; color: #444; text-align: justify; }

  /* Plant Profiles */
  .plant-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .plant-card { display: flex; gap: 14px; padding: 14px; border: 1px solid #e0e8e2; border-radius: 8px; background: #fcfefb; }
  .plant-img { width: 100px; height: 100px; object-fit: cover; border-radius: 6px; flex-shrink: 0; }
  .plant-img-placeholder { width: 100px; height: 100px; background: #e8f0ea; border-radius: 6px; flex-shrink: 0; }
  .plant-info h3 { font-size: 14px; color: #1a3a2a; margin-bottom: 4px; }
  .plant-info .poetic { font-style: italic; font-size: 12px; color: #666; margin-bottom: 6px; }
  .plant-details { display: flex; flex-wrap: wrap; gap: 6px; }
  .plant-details span { font-size: 10px; background: #e8f0ea; color: #2d6a4f; padding: 2px 8px; border-radius: 10px; }

  /* Before/After */
  .before-after { display: flex; gap: 16px; margin-bottom: 20px; }
  .ba-panel { flex: 1; }
  .ba-panel h4 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 8px; }
  .ba-panel img { width: 100%; border-radius: 6px; border: 1px solid #ddd; }

  /* Closing */
  .closing { text-align: center; padding: 40px 20px; }
  .closing .company-name { font-family: Georgia, serif; font-size: 20px; color: #1a3a2a; margin-bottom: 8px; }
  .closing .contact { font-size: 13px; color: #666; }
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="cover">
  <div class="logo">${logoHtml}</div>
  <h1>${submittal.cover_title || 'Landscape Design Proposal'}</h1>
  <div class="subtitle">Prepared for ${project.client_name}</div>
  <div class="divider"></div>
  <div class="meta">
    <div>${project.client_address || ''}${project.client_city ? `, ${project.client_city}, ${project.client_state} ${project.client_zip}` : ''}</div>
    <div>${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
    <div>Project ${project.project_number}</div>
  </div>
</div>

<!-- SCOPE OF WORK -->
<div class="section">
  <h2>Scope of Work</h2>
  <div class="narrative">${(submittal.scope_narrative || '').split('\n').map(p => `<p>${p}</p>`).join('')}</div>
</div>

<!-- PLANT PROFILES -->
${plantProfiles.length > 0 ? `
<div class="section">
  <h2>Plant Selections</h2>
  <div class="plant-grid">${plantCards}</div>
</div>
` : ''}

<!-- BEFORE & AFTER -->
${photos.length > 0 ? `
<div class="section">
  <h2>Design Visualization</h2>
  ${beforeAfterHtml}
</div>
` : ''}

<!-- CLOSING PAGE -->
<div class="section closing">
  <div class="divider" style="margin:0 auto 30px;"></div>
  <div class="company-name">${company.name}</div>
  <div class="contact">
    ${company.phone ? `<div>${company.phone}</div>` : ''}
    ${company.email ? `<div>${company.email}</div>` : ''}
    ${company.website ? `<div>${company.website}</div>` : ''}
    ${company.address_line1 ? `<div>${company.address_line1}, ${company.city}, ${company.state} ${company.zip}</div>` : ''}
  </div>
  ${company.license_number ? `<div style="margin-top:20px;font-size:11px;color:#999;">License #${company.license_number}</div>` : ''}
  ${submittal.closing_notes ? `<div style="margin-top:30px;font-size:13px;color:#555;">${submittal.closing_notes}</div>` : ''}
  ${company.warranty_terms ? `<div style="margin-top:20px;font-size:11px;color:#888;text-align:left;"><strong>Warranty:</strong> ${company.warranty_terms}</div>` : ''}
  ${company.default_terms ? `<div style="margin-top:12px;font-size:11px;color:#888;text-align:left;"><strong>Terms:</strong> ${company.default_terms}</div>` : ''}
</div>

</body>
</html>`;
  }
}

// ═══════════════════════════════════════════════════════════════════
// ESTIMATE PDF GENERATOR (PDFKit — faster, no browser needed)
// ═══════════════════════════════════════════════════════════════════

export class EstimatePDFGenerator {
  constructor(db, s3) {
    this.db = db;
    this.s3 = s3;
  }

  async generate(estimateId, type = 'customer') {
    const estimate = await this.db.getOne('SELECT * FROM estimates WHERE id = $1', [estimateId]);
    const project = await this.db.getOne(
      `SELECT p.*, c.display_name as client_name, c.email as client_email,
              c.phone as client_phone, c.address_line1, c.city, c.state, c.zip
       FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
      [estimate.project_id]
    );
    const company = await this.db.getOne('SELECT * FROM companies WHERE id = $1', [estimate.company_id]);
    const lineItems = await this.db.getMany(
      'SELECT * FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order', [estimateId]
    );

    const isInternal = type === 'bom';
    const pdfPath = path.join(PDF_CONFIG.tempDir, `${type}-${estimateId}-${uuidv4()}.pdf`);

    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'LETTER',
          margins: { top: 50, bottom: 70, left: 50, right: 50 },
          info: {
            Title: isInternal ? `BOM - ${project.project_number}` : `Estimate - ${project.project_number}`,
            Author: company.name,
          },
        });

        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);

        const pageWidth = 512; // 612 - 50 - 50
        const green = '#1a3a2a';
        const lightGreen = '#2d6a4f';

        // ─── Header ──────────────────────────────────────────────
        doc.fontSize(20).font('Helvetica-Bold').fillColor(green).text(company.name, 50, 50);
        doc.fontSize(9).font('Helvetica').fillColor('#666');
        if (company.phone) doc.text(company.phone, { continued: company.email ? true : false });
        if (company.email) doc.text(`  |  ${company.email}`);
        if (company.address_line1) doc.text(`${company.address_line1}, ${company.city}, ${company.state} ${company.zip}`);
        if (company.license_number) doc.text(`License #${company.license_number}`);

        doc.moveTo(50, doc.y + 10).lineTo(562, doc.y + 10).strokeColor(lightGreen).lineWidth(1.5).stroke();
        doc.moveDown(1.5);

        // ─── Title ───────────────────────────────────────────────
        doc.fontSize(16).font('Helvetica-Bold').fillColor(green)
          .text(isInternal ? 'Bill of Materials (Internal)' : 'Landscape Estimate');
        doc.moveDown(0.3);

        doc.fontSize(10).font('Helvetica').fillColor('#333');
        doc.text(`Project: ${project.project_number}`, { continued: true });
        doc.text(`    Date: ${new Date().toLocaleDateString('en-US')}`, { align: 'right' });
        doc.moveDown(0.5);

        // Client info
        doc.fontSize(10).font('Helvetica-Bold').text('Prepared For:');
        doc.font('Helvetica').text(project.client_name);
        if (project.address_line1) doc.text(`${project.address_line1}, ${project.city}, ${project.state} ${project.zip}`);
        if (project.client_phone) doc.text(project.client_phone);
        if (project.client_email) doc.text(project.client_email);
        doc.moveDown(1);

        // ─── Line Items Table ────────────────────────────────────
        const colWidths = isInternal
          ? { desc: 200, qty: 50, unit: 50, cost: 70, markup: 60, price: 82 }
          : { desc: 260, qty: 60, unit: 60, price: 70, total: 62 };

        // Table header
        const tableTop = doc.y;
        doc.rect(50, tableTop, pageWidth, 22).fill(lightGreen);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('white');

        if (isInternal) {
          doc.text('Description', 54, tableTop + 6, { width: colWidths.desc });
          doc.text('Qty', 54 + colWidths.desc, tableTop + 6, { width: colWidths.qty, align: 'center' });
          doc.text('Unit', 54 + colWidths.desc + colWidths.qty, tableTop + 6, { width: colWidths.unit, align: 'center' });
          doc.text('Cost', 54 + colWidths.desc + colWidths.qty + colWidths.unit, tableTop + 6, { width: colWidths.cost, align: 'right' });
          doc.text('Markup', 54 + colWidths.desc + colWidths.qty + colWidths.unit + colWidths.cost, tableTop + 6, { width: colWidths.markup, align: 'right' });
          doc.text('Total', 54 + colWidths.desc + colWidths.qty + colWidths.unit + colWidths.cost + colWidths.markup, tableTop + 6, { width: colWidths.price, align: 'right' });
        } else {
          doc.text('Description', 54, tableTop + 6, { width: colWidths.desc });
          doc.text('Qty', 54 + colWidths.desc, tableTop + 6, { width: colWidths.qty, align: 'center' });
          doc.text('Unit', 54 + colWidths.desc + colWidths.qty, tableTop + 6, { width: colWidths.unit, align: 'center' });
          doc.text('Price', 54 + colWidths.desc + colWidths.qty + colWidths.unit, tableTop + 6, { width: colWidths.price, align: 'right' });
          doc.text('Total', 54 + colWidths.desc + colWidths.qty + colWidths.unit + colWidths.price, tableTop + 6, { width: colWidths.total, align: 'right' });
        }

        let y = tableTop + 26;
        const fmt = (n) => `$${parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        // Group line items by category
        const categories = {};
        for (const li of lineItems) {
          if (!li.is_visible && !isInternal) continue;
          const cat = li.category || 'other';
          if (!categories[cat]) categories[cat] = [];
          categories[cat].push(li);
        }

        const categoryLabels = {
          plant_material: 'Plant Material', labor: 'Labor', soil_amendment: 'Soil Amendments',
          mulch: 'Mulch', edging: 'Edging & Borders', irrigation: 'Irrigation',
          lighting: 'Landscape Lighting', hardscape: 'Hardscape', delivery: 'Delivery',
          removal_disposal: 'Removal & Disposal', warranty: 'Warranty', tax: 'Tax', other: 'Other',
        };

        for (const [cat, items] of Object.entries(categories)) {
          // Check for page break
          if (y > 680) {
            doc.addPage();
            y = 50;
          }

          // Category header
          doc.rect(50, y, pageWidth, 18).fill('#f0f5f1');
          doc.fontSize(9).font('Helvetica-Bold').fillColor(lightGreen)
            .text(categoryLabels[cat] || cat, 54, y + 4);
          y += 22;

          for (const li of items) {
            if (y > 700) {
              doc.addPage();
              y = 50;
            }

            const isEven = items.indexOf(li) % 2 === 0;
            if (isEven) doc.rect(50, y - 2, pageWidth, 16).fill('#fafcfa');

            doc.fontSize(9).font('Helvetica').fillColor('#333');
            doc.text(li.description, 54, y, { width: isInternal ? colWidths.desc : colWidths.desc });
            doc.text(String(parseFloat(li.quantity)), 54 + (isInternal ? colWidths.desc : colWidths.desc), y, { width: 50, align: 'center' });
            doc.text(li.unit || 'ea', 54 + (isInternal ? colWidths.desc + colWidths.qty : colWidths.desc + colWidths.qty), y, { width: 50, align: 'center' });

            if (isInternal) {
              const costBefore = parseFloat(li.unit_price) / (1 + (parseFloat(estimate.material_markup) || 35) / 100);
              doc.text(fmt(costBefore), 54 + colWidths.desc + colWidths.qty + colWidths.unit, y, { width: colWidths.cost, align: 'right' });
              doc.text(`${estimate.material_markup || 35}%`, 54 + colWidths.desc + colWidths.qty + colWidths.unit + colWidths.cost, y, { width: colWidths.markup, align: 'right' });
              doc.text(fmt(li.total_price), 54 + colWidths.desc + colWidths.qty + colWidths.unit + colWidths.cost + colWidths.markup, y, { width: colWidths.price, align: 'right' });
            } else {
              doc.text(fmt(li.unit_price), 54 + colWidths.desc + colWidths.qty + colWidths.unit, y, { width: colWidths.price, align: 'right' });
              doc.text(fmt(li.total_price), 54 + colWidths.desc + colWidths.qty + colWidths.unit + colWidths.price, y, { width: colWidths.total, align: 'right' });
            }

            y += 16;
          }
          y += 6;
        }

        // ─── Totals ──────────────────────────────────────────────
        y += 8;
        doc.moveTo(350, y).lineTo(562, y).strokeColor('#ccc').lineWidth(0.5).stroke();
        y += 8;

        doc.fontSize(10).font('Helvetica').fillColor('#333');
        doc.text('Subtotal:', 350, y, { width: 130, align: 'right' });
        doc.font('Helvetica-Bold').text(fmt(estimate.subtotal), 485, y, { width: 77, align: 'right' });
        y += 18;

        if (estimate.tax_enabled && parseFloat(estimate.tax_amount) > 0) {
          doc.font('Helvetica').text(`Tax (${(parseFloat(estimate.tax_rate) * 100).toFixed(2)}%):`, 350, y, { width: 130, align: 'right' });
          doc.font('Helvetica-Bold').text(fmt(estimate.tax_amount), 485, y, { width: 77, align: 'right' });
          y += 18;
        }

        doc.moveTo(350, y).lineTo(562, y).strokeColor(lightGreen).lineWidth(2).stroke();
        y += 8;
        doc.fontSize(14).font('Helvetica-Bold').fillColor(green);
        doc.text('Total:', 350, y, { width: 130, align: 'right' });
        doc.text(fmt(estimate.total), 485, y, { width: 77, align: 'right' });
        y += 30;

        // ─── Terms ───────────────────────────────────────────────
        if (!isInternal && (estimate.terms || estimate.warranty)) {
          if (y > 600) { doc.addPage(); y = 50; }
          doc.fontSize(8).font('Helvetica').fillColor('#888');
          if (estimate.terms) {
            doc.font('Helvetica-Bold').text('Terms & Conditions:', 50, y);
            y += 12;
            doc.font('Helvetica').text(estimate.terms, 50, y, { width: pageWidth });
            y = doc.y + 12;
          }
          if (estimate.warranty) {
            doc.font('Helvetica-Bold').text('Warranty:', 50, y);
            y += 12;
            doc.font('Helvetica').text(estimate.warranty, 50, y, { width: pageWidth });
            y = doc.y + 12;
          }
        }

        // ─── Signature Line (Customer Estimate Only) ─────────────
        if (!isInternal) {
          if (y > 620) { doc.addPage(); y = 50; }
          y += 30;
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Acceptance', 50, y);
          y += 20;
          doc.fontSize(9).font('Helvetica').fillColor('#555')
            .text('By signing below, I authorize the work described in this estimate.', 50, y);
          y += 30;

          doc.moveTo(50, y).lineTo(300, y).strokeColor('#333').lineWidth(0.5).stroke();
          doc.text('Signature', 50, y + 4, { width: 250 });

          doc.moveTo(330, y).lineTo(500, y).strokeColor('#333').lineWidth(0.5).stroke();
          doc.text('Date', 330, y + 4, { width: 170 });

          y += 30;
          doc.moveTo(50, y).lineTo(300, y).strokeColor('#333').lineWidth(0.5).stroke();
          doc.text('Printed Name', 50, y + 4, { width: 250 });
        }

        doc.end();

        stream.on('finish', async () => {
          try {
            const pdfBuffer = fs.readFileSync(pdfPath);
            const fileType = isInternal ? 'estimate_pdf' : 'estimate_pdf';
            const fileName = isInternal
              ? `BOM_${project.project_number}.pdf`
              : `Estimate_${project.project_number}.pdf`;
            const s3Key = `${company.id}/estimates/${estimateId}-${type}.pdf`;

            await this.s3.upload({
              Bucket: process.env.S3_BUCKET,
              Key: s3Key,
              Body: pdfBuffer,
              ContentType: 'application/pdf',
            }).promise();

            const cdnUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

            const file = await this.db.getOne(
              `INSERT INTO files (company_id, file_type, original_name, s3_key, s3_bucket, cdn_url, mime_type, file_size)
               VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', $7) RETURNING *`,
              [company.id, fileType, fileName, s3Key, process.env.S3_BUCKET, cdnUrl, pdfBuffer.length]
            );

            const updateField = isInternal ? 'bom_pdf_file_id' : 'pdf_file_id';
            await this.db.query(`UPDATE estimates SET ${updateField} = $1 WHERE id = $2`, [file.id, estimateId]);

            fs.unlinkSync(pdfPath);
            resolve({ success: true, pdfUrl: cdnUrl, fileId: file.id, type });
          } catch (uploadErr) {
            if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
            reject(uploadErr);
          }
        });

        stream.on('error', (err) => {
          if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
          reject(err);
        });
      } catch (err) {
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
        reject(err);
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function mountPDFRoutes(app, db, s3, authenticate, crmManager) {
  const submittalPDF = new SubmittalPDFGenerator(db, s3);
  const estimatePDF = new EstimatePDFGenerator(db, s3);

  // Generate submittal PDF (returns download URL)
  app.post('/api/submittals/:id/pdf', authenticate, async (req, res) => {
    try {
      const result = await submittalPDF.generate(req.params.id);
      if (result.success) {
        res.json(result);
      } else {
        res.status(500).json(result);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Generate + push submittal PDF to CRM in one step
  app.post('/api/submittals/:id/pdf-and-push', authenticate, async (req, res) => {
    try {
      // Generate PDF
      const pdfResult = await submittalPDF.generate(req.params.id);
      if (!pdfResult.success) return res.status(500).json(pdfResult);

      // Push to CRM if connected
      let crmResult = null;
      if (crmManager) {
        const submittal = await db.getOne('SELECT * FROM submittals WHERE id = $1', [req.params.id]);
        const project = await db.getOne('SELECT * FROM projects WHERE id = $1', [submittal.project_id]);
        crmResult = await crmManager.syncDocument(
          req.user.companyId,
          pdfResult.pdfUrl,
          `Submittal_${project.project_number}.pdf`,
          project.client_id
        );
      }

      res.json({ pdf: pdfResult, crm: crmResult });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Generate estimate PDFs (both customer and BOM)
  app.post('/api/estimates/:id/pdf', authenticate, async (req, res) => {
    try {
      const { type } = req.body; // 'customer' or 'bom'
      const result = await estimatePDF.generate(req.params.id, type || 'customer');
      if (result.success) {
        res.json(result);
      } else {
        res.status(500).json(result);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Generate both estimate PDFs at once
  app.post('/api/estimates/:id/pdf/all', authenticate, async (req, res) => {
    try {
      const [customer, bom] = await Promise.all([
        estimatePDF.generate(req.params.id, 'customer'),
        estimatePDF.generate(req.params.id, 'bom'),
      ]);
      res.json({ customer, bom });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Direct download route — generates a presigned S3 URL for immediate download
  app.get('/api/files/:fileId/download', authenticate, async (req, res) => {
    try {
      const file = await db.getOne(
        'SELECT * FROM files WHERE id = $1 AND company_id = $2',
        [req.params.fileId, req.user.companyId]
      );
      if (!file) return res.status(404).json({ error: 'File not found' });

      const presignedUrl = s3.getSignedUrl('getObject', {
        Bucket: file.s3_bucket,
        Key: file.s3_key,
        Expires: 300, // 5 minutes
        ResponseContentDisposition: `attachment; filename="${file.original_name}"`,
      });

      res.json({ downloadUrl: presignedUrl, fileName: file.original_name, expiresIn: 300 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk export — download all project documents as individual download links
  app.get('/api/projects/:projectId/export', authenticate, async (req, res) => {
    try {
      const projectId = req.params.projectId;

      // Get all related files
      const submittals = await db.getMany(
        'SELECT s.id, s.pdf_url, f.s3_key, f.s3_bucket, f.original_name FROM submittals s LEFT JOIN files f ON f.id = s.pdf_file_id WHERE s.project_id = $1 AND s.is_current = true',
        [projectId]
      );
      const estimates = await db.getMany(
        'SELECT e.id, f.s3_key, f.s3_bucket, f.original_name, bf.s3_key as bom_key, bf.s3_bucket as bom_bucket, bf.original_name as bom_name FROM estimates e LEFT JOIN files f ON f.id = e.pdf_file_id LEFT JOIN files bf ON bf.id = e.bom_pdf_file_id WHERE e.project_id = $1 AND e.is_current = true',
        [projectId]
      );
      const designs = await db.getMany(
        'SELECT d.rendering_url FROM designs d WHERE d.project_id = $1 AND d.is_current = true AND d.rendering_url IS NOT NULL',
        [projectId]
      );
      const photos = await db.getMany(
        `SELECT f.cdn_url, f.original_name FROM photos p JOIN files f ON f.id = p.file_id
         JOIN property_areas pa ON pa.id = p.property_area_id WHERE pa.project_id = $1`,
        [projectId]
      );

      // Generate presigned download URLs for each file
      const downloads = [];

      for (const s of submittals) {
        if (s.s3_key) {
          downloads.push({
            type: 'submittal',
            fileName: s.original_name || 'Submittal.pdf',
            url: s3.getSignedUrl('getObject', { Bucket: s.s3_bucket, Key: s.s3_key, Expires: 3600 }),
          });
        }
      }

      for (const e of estimates) {
        if (e.s3_key) {
          downloads.push({
            type: 'estimate',
            fileName: e.original_name || 'Estimate.pdf',
            url: s3.getSignedUrl('getObject', { Bucket: e.s3_bucket, Key: e.s3_key, Expires: 3600 }),
          });
        }
        if (e.bom_key) {
          downloads.push({
            type: 'bom',
            fileName: e.bom_name || 'BOM.pdf',
            url: s3.getSignedUrl('getObject', { Bucket: e.bom_bucket, Key: e.bom_key, Expires: 3600 }),
          });
        }
      }

      for (const d of designs) {
        downloads.push({ type: 'rendering', fileName: 'Design_Rendering.png', url: d.rendering_url });
      }

      for (const p of photos) {
        downloads.push({ type: 'photo', fileName: p.original_name, url: p.cdn_url });
      }

      res.json({ projectId, fileCount: downloads.length, downloads });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
