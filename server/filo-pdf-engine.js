// ═══════════════════════════════════════════════════════════════════
// FILO — PDF Generation Engine
// Generates: Submittal Documents (PDFKit only, no Puppeteer)
// All client-facing documents are WHITE-LABELED (no FILO branding)
// ═══════════════════════════════════════════════════════════════════

import PDFDocument from 'pdfkit';
import sharp from 'sharp';

// ─── Image Fetch Helper ─────────────────────────────────────────

function validateImageUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid protocol');
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname.startsWith('127.') || hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') || hostname.startsWith('169.254.') || hostname === '0.0.0.0' ||
        hostname.startsWith('172.') && parseInt(hostname.split('.')[1]) >= 16 && parseInt(hostname.split('.')[1]) <= 31) {
      throw new Error('Internal URLs are not allowed');
    }
  } catch (e) { if (e.message !== 'Invalid protocol' && e.message !== 'Internal URLs are not allowed') return; throw e; }
}

async function fetchImageBuffer(url, maxWidth = 800, maxHeight = 800) {
  if (!url) return null;
  try {
    let buffer;
    if (url.startsWith('data:')) {
      const b64 = url.replace(/^data:image\/[^;]+;base64,/, '');
      buffer = Buffer.from(b64, 'base64');
    } else {
      validateImageUrl(url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) return null;
      buffer = Buffer.from(await resp.arrayBuffer());
    }
    // Normalize to PNG via sharp, resize if needed
    return await sharp(buffer)
      .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (err) {
    console.warn('[pdf-engine] Image fetch failed:', url?.substring(0, 60), err.message);
    return null;
  }
}

// ─── Color Helpers ──────────────────────────────────────────────

function hexToRGB(hex) {
  const h = (hex || '#1a3a2a').replace('#', '');
  return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
}

// ═══════════════════════════════════════════════════════════════════
// SUBMITTAL PDF GENERATOR
// ═══════════════════════════════════════════════════════════════════

export class SubmittalPDFGenerator {
  constructor(db, supaStorage) {
    this.db = db;
    this.supaStorage = supaStorage;
  }

  async generate(submittalId, companyId, options = {}) {
    console.log(`[pdf-engine] Generating submittal PDF for ${submittalId}`);

    // ─── 1. Load all data ─────────────────────────────────────────
    const submittal = await this.db.getOne('SELECT * FROM submittals WHERE id = $1', [submittalId]);
    if (!submittal) throw new Error('Submittal not found');
    if (submittal.company_id !== companyId) throw new Error('Unauthorized');

    const project = await this.db.getOne(
      `SELECT p.*, c.first_name, c.last_name, c.email as client_email, c.phone as client_phone,
              c.address, c.city, c.state, c.zip
       FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
      [submittal.project_id]
    );

    const company = await this.db.getOne('SELECT * FROM companies WHERE id = $1', [companyId]);

    const plantProfiles = await this.db.getMany(
      `SELECT * FROM submittal_plant_profiles WHERE submittal_id = $1 ORDER BY sort_order, plant_name`,
      [submittalId]
    );

    // Get design render URL — prefer the one passed in (from frontend state), fall back to project row
    const renderUrl = options.designRenderUrl || project?.render_url || project?.design_render_url || null;

    // ─── 2. Pre-fetch images ──────────────────────────────────────
    const logoBuffer = await fetchImageBuffer(company?.logo_url, 300, 120);
    const renderBuffer = await fetchImageBuffer(renderUrl, 1200, 900);

    const plantImageBuffers = {};
    for (const pp of plantProfiles) {
      if (pp.image_url) {
        plantImageBuffers[pp.id] = await fetchImageBuffer(pp.image_url, 250, 250);
      }
    }

    // ─── 3. Build PDF ─────────────────────────────────────────────
    const primaryColor = hexToRGB(company?.submittal_primary_color || '#1a3a2a');
    const accentColor = hexToRGB(company?.submittal_accent_color || '#2d6a4f');

    const clientName = project?.first_name && project?.last_name
      ? `${project.first_name} ${project.last_name}`
      : project?.project_name || 'Valued Client';

    const clientAddress = [project?.address, project?.city, project?.state, project?.zip]
      .filter(Boolean).join(', ') || '';

    const companyName = company?.name || 'Landscape Company';
    const tagline = company?.tagline || '';
    const credentials = company?.credentials || '';
    const phone = company?.phone || '';
    const email = company?.email || '';
    const website = company?.website || '';
    const contactLine = [phone, email, website].filter(Boolean).join(' | ');

    const doc = new PDFDocument({
      size: 'letter',
      margins: { top: 50, bottom: 60, left: 55, right: 55 },
      bufferPages: true,
      info: {
        Title: `Landscape Submittal - ${clientName}`,
        Author: companyName,
        Creator: 'FILO Design Software',
      },
    });

    // Collect PDF as buffer
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));

    const pdfReady = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    // ─── PAGE 1: Cover ────────────────────────────────────────────
    this.buildCoverPage(doc, {
      logoBuffer, companyName, tagline, credentials,
      clientName, clientAddress, contactLine, phone, email, website,
      primaryColor, accentColor,
    });

    // ─── PAGE 2: Design Narrative ─────────────────────────────────
    doc.addPage();
    this.addHeader(doc, companyName, tagline, primaryColor, logoBuffer);
    this.buildNarrativePage(doc, submittal.scope_narrative || '', primaryColor);
    this.addFooter(doc, contactLine, 2);

    // ─── PAGE 3: Design Rendering ─────────────────────────────────
    doc.addPage();
    this.addHeader(doc, companyName, tagline, primaryColor, logoBuffer);
    this.buildRenderingPage(doc, renderBuffer, primaryColor);
    this.addFooter(doc, contactLine, 3);

    // ─── PAGES 4+: Plant Selections ───────────────────────────────
    let pageNum = 4;
    doc.addPage();
    this.addHeader(doc, companyName, tagline, primaryColor, logoBuffer);

    doc.fontSize(22).font('Helvetica-Bold').fillColor(primaryColor);
    doc.text('Plant Selections', 55, doc.y);
    doc.moveDown(0.3);
    doc.moveTo(55, doc.y).lineTo(557, doc.y).strokeColor(accentColor).lineWidth(1.5).stroke();
    doc.moveDown(0.8);

    for (let i = 0; i < plantProfiles.length; i++) {
      const pp = plantProfiles[i];
      const imgBuf = plantImageBuffers[pp.id] || null;

      // Check if we need a new page (need ~200pt for a plant card)
      if (doc.y > 560) {
        this.addFooter(doc, contactLine, pageNum);
        pageNum++;
        doc.addPage();
        this.addHeader(doc, companyName, tagline, primaryColor, logoBuffer);
        doc.fontSize(22).font('Helvetica-Bold').fillColor(primaryColor);
        doc.text('Plant Selections', 55, doc.y);
        doc.moveDown(0.3);
        doc.moveTo(55, doc.y).lineTo(557, doc.y).strokeColor(accentColor).lineWidth(1.5).stroke();
        doc.moveDown(0.8);
      }

      this.buildPlantCard(doc, pp, imgBuf, primaryColor, accentColor);
    }
    this.addFooter(doc, contactLine, pageNum);
    pageNum++;

    // ─── LAST PAGE: Thank You ─────────────────────────────────────
    doc.addPage();
    this.buildThankYouPage(doc, {
      companyName, tagline, credentials, phone, email, website,
      primaryColor, accentColor, contactLine, logoBuffer,
    });

    doc.end();

    // ─── 4. Upload to Supabase ────────────────────────────────────
    const pdfBuffer = await pdfReady;
    console.log(`[pdf-engine] PDF generated: ${Math.round(pdfBuffer.length / 1024)} KB, uploading...`);

    const storageKey = `${companyId}/submittals/${submittalId}.pdf`;
    const uploadResult = await this.supaStorage.upload(storageKey, pdfBuffer, 'application/pdf');
    const pdfUrl = this.supaStorage.getPublicUrl(storageKey);

    // Update submittal record
    await this.db.query(
      'UPDATE submittals SET pdf_url = $1, updated_at = NOW() WHERE id = $2',
      [pdfUrl, submittalId]
    );

    console.log(`[pdf-engine] Submittal PDF uploaded: ${pdfUrl}`);
    return { success: true, pdfUrl };
  }

  // ─── Cover Page ───────────────────────────────────────────────

  buildCoverPage(doc, opts) {
    const { logoBuffer, companyName, tagline, credentials, clientName, clientAddress,
            contactLine, phone, email, website, primaryColor, accentColor } = opts;

    const pageW = 612;
    const centerX = pageW / 2;

    // Company logo or name
    let y = 160;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, centerX - 100, y, { width: 200, align: 'center' });
        y += 100;
      } catch (e) {
        doc.fontSize(36).font('Helvetica-Bold').fillColor(primaryColor);
        doc.text(companyName, 55, y, { align: 'center', width: pageW - 110 });
        y = doc.y + 8;
      }
    } else {
      doc.fontSize(36).font('Helvetica-Bold').fillColor(primaryColor);
      doc.text(companyName, 55, y, { align: 'center', width: pageW - 110 });
      y = doc.y + 8;
    }

    // Tagline
    if (tagline) {
      doc.fontSize(14).font('Helvetica').fillColor([120, 120, 120]);
      doc.text(tagline, 55, y, { align: 'center', width: pageW - 110 });
      y = doc.y + 24;
    } else {
      y += 16;
    }

    // Decorative rule
    doc.moveTo(centerX - 60, y).lineTo(centerX + 60, y)
      .strokeColor(accentColor).lineWidth(2).stroke();
    y += 32;

    // Title
    doc.fontSize(26).font('Helvetica-Bold').fillColor(primaryColor);
    doc.text('Landscape Submittal Package', 55, y, { align: 'center', width: pageW - 110 });
    y = doc.y + 28;

    // Prepared for
    doc.fontSize(14).font('Helvetica').fillColor([120, 120, 120]);
    doc.text('Prepared for', 55, y, { align: 'center', width: pageW - 110 });
    y = doc.y + 6;

    doc.fontSize(20).font('Helvetica-Bold').fillColor(primaryColor);
    doc.text(clientName, 55, y, { align: 'center', width: pageW - 110 });
    y = doc.y + 6;

    if (clientAddress) {
      doc.fontSize(13).font('Helvetica').fillColor([100, 100, 100]);
      doc.text(clientAddress, 55, y, { align: 'center', width: pageW - 110 });
      y = doc.y + 6;
    }

    // Date
    y += 12;
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.fontSize(13).font('Helvetica').fillColor([120, 120, 120]);
    doc.text(dateStr, 55, y, { align: 'center', width: pageW - 110 });

    // Bottom section — credentials + contact
    if (credentials) {
      doc.fontSize(10).font('Helvetica').fillColor([130, 130, 130]);
      doc.text(credentials, 55, 680, { align: 'center', width: pageW - 110 });
    }

    doc.fontSize(10).font('Helvetica').fillColor([130, 130, 130]);
    doc.text(contactLine, 55, 700, { align: 'center', width: pageW - 110 });
  }

  // ─── Header (pages 2+) ───────────────────────────────────────

  addHeader(doc, companyName, tagline, primaryColor, logoBuffer) {
    const saved = doc.y;

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 55, 30, { height: 28 });
      } catch (e) {
        doc.fontSize(14).font('Helvetica-Bold').fillColor(primaryColor);
        doc.text(companyName, 55, 34);
      }
    } else {
      doc.fontSize(14).font('Helvetica-Bold').fillColor(primaryColor);
      doc.text(companyName, 55, 34);
    }

    if (tagline) {
      doc.fontSize(9).font('Helvetica').fillColor([140, 140, 140]);
      doc.text(tagline, 300, 38, { align: 'right', width: 257 });
    }

    doc.moveTo(55, 62).lineTo(557, 62).strokeColor([200, 200, 200]).lineWidth(0.5).stroke();
    doc.y = 78;
  }

  // ─── Footer ───────────────────────────────────────────────────

  addFooter(doc, contactLine, pageNum) {
    doc.moveTo(55, 728).lineTo(557, 728).strokeColor([200, 200, 200]).lineWidth(0.5).stroke();
    doc.fontSize(8).font('Helvetica').fillColor([150, 150, 150]);
    doc.text(contactLine, 55, 734, { width: 420 });
    doc.text(`Page ${pageNum}`, 480, 734, { align: 'right', width: 77 });
  }

  // ─── Design Narrative Page ────────────────────────────────────

  buildNarrativePage(doc, narrative, primaryColor) {
    doc.fontSize(22).font('Helvetica-Bold').fillColor(primaryColor);
    doc.text('Front Yard Design', 55, doc.y);
    doc.moveDown(0.3);
    doc.moveTo(55, doc.y).lineTo(557, doc.y).strokeColor(primaryColor).lineWidth(1.5).stroke();
    doc.moveDown(0.8);

    if (narrative) {
      doc.fontSize(11).font('Helvetica').fillColor([50, 50, 50]);
      const paragraphs = narrative.split(/\n\n+/);
      for (const para of paragraphs) {
        if (doc.y > 690) break; // leave room for footer
        doc.text(para.trim(), 55, doc.y, {
          width: 502,
          lineGap: 4,
          paragraphGap: 2,
        });
        doc.moveDown(0.6);
      }
    } else {
      doc.fontSize(12).font('Helvetica').fillColor([150, 150, 150]);
      doc.text('Design narrative will be generated when the AI design is complete.', 55, doc.y, { width: 502 });
    }
  }

  // ─── Design Rendering Page ────────────────────────────────────

  buildRenderingPage(doc, renderBuffer, primaryColor) {
    doc.fontSize(22).font('Helvetica-Bold').fillColor(primaryColor);
    doc.text('Front Yard Design Rendering', 55, doc.y);
    doc.moveDown(0.3);
    doc.moveTo(55, doc.y).lineTo(557, doc.y).strokeColor(primaryColor).lineWidth(1.5).stroke();
    doc.moveDown(0.8);

    if (renderBuffer) {
      try {
        const imgY = doc.y;
        const availWidth = 502;
        const availHeight = 640 - imgY;
        doc.image(renderBuffer, 55, imgY, {
          fit: [availWidth, availHeight],
          align: 'center',
          valign: 'center',
        });
      } catch (e) {
        console.warn('[pdf-engine] Failed to embed render image:', e.message);
        doc.fontSize(13).font('Helvetica').fillColor([150, 150, 150]);
        doc.text('Design rendering image could not be loaded.', 55, doc.y, { width: 502, align: 'center' });
      }
    } else {
      doc.fontSize(13).font('Helvetica').fillColor([150, 150, 150]);
      doc.text('Design rendering not yet generated. Complete Step 6 to create the visual design.', 55, doc.y + 100, { width: 502, align: 'center' });
    }
  }

  // ─── Plant Card ───────────────────────────────────────────────

  buildPlantCard(doc, plant, imgBuffer, primaryColor, accentColor) {
    const startY = doc.y;
    const textX = imgBuffer ? 195 : 55;
    const textWidth = imgBuffer ? 362 : 502;

    // Plant image on the left
    if (imgBuffer) {
      try {
        doc.image(imgBuffer, 55, startY, { width: 120, height: 120 });
      } catch (e) {
        // Placeholder box
        doc.rect(55, startY, 120, 120).fillColor([240, 240, 240]).fill();
        doc.fontSize(30).fillColor([180, 180, 180]);
        doc.text('🌿', 90, startY + 42);
      }
    }

    // Plant name + container size
    const nameText = plant.plant_name || plant.common_name || 'Unknown Plant';
    const sizeText = plant.container_size ? ` ${plant.container_size}` : '';
    doc.fontSize(15).font('Helvetica-Bold').fillColor(primaryColor);
    doc.text(`${nameText}${sizeText}`, textX, startY, { width: textWidth });

    // Quantity
    const qty = plant.quantity || 1;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(accentColor);
    doc.text(`Qty: ${qty}`, textX, doc.y + 2, { width: textWidth });

    // Description
    const desc = plant.description || plant.poetic_desc || '';
    if (desc) {
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor([80, 80, 80]);
      doc.text(desc, textX, doc.y, { width: textWidth, lineGap: 2 });
    }

    // Ensure we move past the image height
    const endY = Math.max(doc.y + 12, startY + (imgBuffer ? 132 : 20));
    doc.y = endY;

    // Separator line
    doc.moveTo(55, doc.y).lineTo(557, doc.y).strokeColor([230, 230, 230]).lineWidth(0.5).stroke();
    doc.y += 16;
  }

  // ─── Thank You Page ───────────────────────────────────────────

  buildThankYouPage(doc, opts) {
    const { companyName, tagline, credentials, phone, email, website,
            primaryColor, accentColor, contactLine, logoBuffer } = opts;

    const pageW = 612;

    // Centered content
    let y = 240;

    doc.fontSize(42).font('Helvetica-Bold').fillColor(primaryColor);
    doc.text('Thank You', 55, y, { align: 'center', width: pageW - 110 });
    y = doc.y + 16;

    doc.fontSize(15).font('Helvetica').fillColor([100, 100, 100]);
    doc.text('We look forward to transforming your outdoor space.', 55, y, { align: 'center', width: pageW - 110 });
    y = doc.y + 32;

    // Decorative rule
    const cx = pageW / 2;
    doc.moveTo(cx - 40, y).lineTo(cx + 40, y).strokeColor(accentColor).lineWidth(2).stroke();
    y += 28;

    doc.fontSize(16).font('Helvetica-Bold').fillColor(primaryColor);
    doc.text(companyName, 55, y, { align: 'center', width: pageW - 110 });
    y = doc.y + 6;

    if (phone) {
      doc.fontSize(12).font('Helvetica').fillColor([100, 100, 100]);
      doc.text(phone, 55, y, { align: 'center', width: pageW - 110 });
      y = doc.y + 3;
    }
    if (email) {
      doc.fontSize(12).font('Helvetica').fillColor([100, 100, 100]);
      doc.text(email, 55, y, { align: 'center', width: pageW - 110 });
      y = doc.y + 3;
    }
    if (website) {
      doc.fontSize(12).font('Helvetica').fillColor([100, 100, 100]);
      doc.text(website, 55, y, { align: 'center', width: pageW - 110 });
      y = doc.y + 3;
    }

    if (credentials) {
      y = doc.y + 16;
      doc.fontSize(10).font('Helvetica').fillColor([140, 140, 140]);
      doc.text(credentials, 55, y, { align: 'center', width: pageW - 110 });
    }

    // Footer
    this.addFooter(doc, contactLine, '');
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

export function createPDFEngine(db, supaStorage) {
  return {
    submittal: new SubmittalPDFGenerator(db, supaStorage),
  };
}

export default { SubmittalPDFGenerator, createPDFEngine };
