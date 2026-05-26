/**
 * SVG → vector PDF converter for the CLI.
 *
 * Emits a single-page PDF sized to the SVG's natural content plus a
 * small padding on every side. Mirrors the browser-side converter in
 * Tapir (`src/lib/utils/svg-to-pdf.ts`) so both runtimes produce
 * comparable output — same page sizing, same 24-pt padding, same
 * standard-PDF-font mapping for SVG text.
 *
 * Used by the `diagram` and `package` commands when the requested
 * output file has a `.pdf` extension, or when a package bundle is
 * generated (the bundle always includes `diagram.pdf` alongside
 * `diagram.svg`).
 *
 * Implementation: PDFKit + svg-to-pdfkit. Both are Deno-friendly via
 * npm: specifiers and don't need a browser DOM.
 *
 * @module modules/svg-to-pdf
 */

import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";

/**
 * Padding in PDF points added on every side of the diagram.
 *
 * 1 pt = 1/72 inch ≈ 1 px at default screen DPI. 24 pt gives the PDF
 * a comfortable margin when viewed standalone without wasting space
 * when embedded in a paper.
 *
 * @type {number}
 */
export const PDF_PADDING = 24;

/**
 * Render an SVG string to a vector PDF.
 *
 * The page is sized to the SVG's viewBox (or its width/height
 * attributes as a fallback) plus `PDF_PADDING` on each side. The SVG
 * is drawn offset by the padding on both axes. Text inside the SVG
 * is rendered as selectable PDF text (mapped to standard PDF fonts)
 * so the file remains searchable and scales losslessly for LaTeX
 * inclusion or archival.
 *
 * @param {string} svgString - The SVG markup to render.
 * @returns {Promise<Uint8Array>} The PDF bytes.
 *
 * @example
 * const pdf = await svgToPdf(svgString);
 * await Deno.writeFile("diagram.pdf", pdf);
 */
export async function svgToPdf(svgString) {
  const { width, height } = readSvgDimensions(svgString);
  const pageWidth = width + PDF_PADDING * 2;
  const pageHeight = height + PDF_PADDING * 2;

  const doc = new PDFDocument({
    size: [pageWidth, pageHeight],
    margin: 0,
    compress: true,
    info: {
      Producer: "yama-cli",
    },
  });

  // svg-to-pdfkit draws onto the current page at the given offset.
  // `assumePt: true` tells it the SVG's user units are already in
  // PDF points (1 px ≈ 1 pt for our diagrams), which avoids a
  // spurious extra scale.
  SVGtoPDF(doc, svgString, PDF_PADDING, PDF_PADDING, {
    width,
    height,
    assumePt: true,
    useCSS: false,
  });

  doc.end();

  // Collect PDF bytes as they stream out. PDFKit emits Node-style
  // Buffer chunks; Deno's `Uint8Array` handles them transparently.
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(out);
    });
    doc.on("error", reject);
  });
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Extracts the natural dimensions of an SVG from its markup.
 *
 * Prefers the viewBox (always emitted by Tapir's exporter and by the
 * yama-cli DOT-to-SVG renderer). Falls back to `width`/`height`
 * attributes, then a sensible default for empty SVGs.
 *
 * @param {string} svgString
 * @returns {{ width: number, height: number }}
 */
function readSvgDimensions(svgString) {
  const viewBoxMatch = svgString.match(
    /<svg[^>]*\sviewBox=["']([^"']+)["']/i,
  );
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const widthMatch = svgString.match(/<svg[^>]*\swidth=["']([\d.]+)/i);
  const heightMatch = svgString.match(/<svg[^>]*\sheight=["']([\d.]+)/i);
  const w = widthMatch ? parseFloat(widthMatch[1]) : NaN;
  const h = heightMatch ? parseFloat(heightMatch[1]) : NaN;
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h };
  }
  // Last resort — matches Tapir's "no descriptions" fallback SVG.
  return { width: 400, height: 300 };
}
