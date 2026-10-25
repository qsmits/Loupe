import { analysisMethodLabel } from './fringe-method.js';
import { describeFormRemoval } from './fringe-form.js';
// Printable comparison uses the immutable analysis images, independent of UI zoom.
import { polarityDescription } from './fringe-orientation.js';
import { referenceMarks } from './fringe-reference.js';

export function fitReportImage(width, height, box) {
  if (!(width > 0 && height > 0)) throw new Error('Invalid report image dimensions');
  const scale = Math.min(box.w / width, box.h / height);
  const w = width * scale, h = height * scale;
  return {x:box.x + (box.w-w)/2, y:box.y + (box.h-h)/2, w, h};
}

function addImage(doc, png, box, marks = []) {
  const uri = `data:image/png;base64,${png}`;
  const info = doc.getImageProperties(uri);
  const rect = fitReportImage(info.width, info.height, box);
  doc.addImage(uri, 'PNG', rect.x, rect.y, rect.w, rect.h);
  for (const mark of marks) {
    const x = rect.x + mark.x * rect.w, y = rect.y + mark.y * rect.h;
    doc.setDrawColor(15); doc.setLineWidth(.9); doc.circle(x, y, 1.7);
    doc.setDrawColor(255, 220, 50); doc.setLineWidth(.4); doc.circle(x, y, 1.7);
    const tx = Math.min(rect.x + rect.w - 4, Math.max(rect.x + 1, x + 2));
    const ty = y < rect.y + 5 ? y + 5 : y - 2;
    doc.setFillColor(20); doc.rect(tx - .5, ty - 3, 4, 4, 'F');
    doc.setTextColor(255, 220, 50); doc.setFontSize(9); doc.text(mark.label, tx, ty);
  }
  doc.setTextColor(0);
  return rect;
}

export function createFringeReport(data, {jsPDF, sourceName = '', standard = null, details = []} = {}) {
  const form = describeFormRemoval(data);
  const doc = new jsPDF({orientation:'landscape', unit:'mm', format:'a4'});
  const margin = 10, pageW = 297, pageH = 210;
  const num = v => Number.isFinite(v) ? v.toFixed(2) : 'unavailable';
  doc.setFontSize(18); doc.text('Fringe analysis', margin, 18);
  doc.setFontSize(9);
  const source = sourceName ? doc.splitTextToSize(`Source: ${sourceName}`, 277).slice(0, 2) : [];
  doc.text(source, margin, 25);
  doc.text(`Exported: ${new Date().toLocaleString()}    Wavelength: ${data.wavelength_nm} nm`, margin, 36);
  doc.setFontSize(12);
  doc.text(`${form.metric} PV: ${num(data.pv_nm)} nm     ${form.metric} RMS: ${num(data.rms_nm)} nm     PV: ${num(data.pv_fringes)} fringes`, margin, 45);
  doc.setFontSize(9);
  const marks = referenceMarks(data);
  if (data.reference_image_b64) {
    doc.text('Interferogram - analysis crop', 10, 54);
    doc.text('Surface deviation - slope/form removed', 153, 54);
    addImage(doc, data.reference_image_b64, {x:10,y:58,w:134,h:112}, marks);
    addImage(doc, data.surface_map, {x:153,y:58,w:134,h:112}, marks);
  } else if (data.surface_map) {
    doc.text('Surface deviation - slope/form removed (aligned source unavailable)', 10, 54);
    addImage(doc, data.surface_map, {x:10,y:58,w:277,h:112});
  }
  doc.setFontSize(9);
  doc.text('Matching letters identify the same image locations. Marks do not set contact or height zero.', margin, 179);
  doc.text(polarityDescription(data), margin, 185);
  doc.setFontSize(8);
  doc.text(doc.splitTextToSize(`Full-aperture statistics; reference-flat error included. Form removal: ${data.form_model || 'zernike'}; subtracted terms: ${(data.subtracted_terms || []).join(', ') || 'none'}.`, 277), margin, 191);

  doc.addPage();
  doc.setFontSize(16); doc.text('Analysis details', margin, 18);
  let y = 28;
  doc.setFontSize(9);
  const metadata = [`Analysis method: ${analysisMethodLabel(data)}`, form.label, form.detail, ...details];
  if (data.execution_engine === 'browser') {
    metadata.push('Analysis engine: browser (experimental), using the shared Python engine in WebAssembly.');
    if (data.browser_resolution) metadata.push(`Browser analysis dimensions (rows × columns): ${data.browser_resolution.analyzed.join(' × ')}; maximum side ${data.browser_resolution.max_dimension} pixels.`);
    if (data.browser_runtime) metadata.push(`Runtime: ${data.browser_runtime.name} ${data.browser_runtime.version}`);
  }
  if (standard && !form.tiltOnly) metadata.push("Flatness limit comparison withheld: the result is not a tilt-only flatness evaluation.");
  if (standard && form.tiltOnly) metadata.push(`Selected limit: ${standard.name} (${standard.limit} nm PV). Numerical comparison: ${data.pv_nm <= standard.limit ? 'within' : 'above'} limit; no uncertainty-based conformity assessment.`);
  if (data.warnings?.length) metadata.push(...data.warnings.map(w => `Warning: ${w}`));
  for (const line of metadata) {
    const lines = doc.splitTextToSize(line, 277);
    for (const text of lines) {
      if (y > 190) { doc.addPage(); y = 18; }
      doc.text(text, margin, y); y += 4.5;
    }
    y += 2;
  }
  if (data.zernike_chart) {
    if (y + 65 > 195) { doc.addPage(); y = 18; }
    addImage(doc, data.zernike_chart, {x:10,y,w:277,h:60}); y += 67;
  }
  const header = () => {
    if (y + 14 > 195) { doc.addPage(); y = 18; }
    doc.setFontSize(11); doc.text('Zernike coefficients', margin, y); y += 6;
    doc.setFontSize(8); doc.setFont(undefined, 'bold');
    ['#', 'Term', 'Coefficient (rad)', 'Gap contribution (nm)', 'Status'].forEach((t,i) => doc.text(t, [10,20,92,133,182][i], y));
    doc.setFont(undefined, 'normal'); y += 5;
  };
  header();
  (data.coefficients || []).forEach((c, i) => {
    if (y > 192) { doc.addPage(); y = 18; header(); }
    const j = i+1;
    const values = [String(j), data.coefficient_names?.[j] || `Z${j}`, c.toFixed(6),
      (c*data.wavelength_nm/(4*Math.PI)).toFixed(3), data.subtracted_terms?.includes(j) ? 'subtracted' : 'retained'];
    values.forEach((v,k) => doc.text(v, [10,20,92,133,182][k], y)); y += 4;
  });
  const pages = doc.getNumberOfPages();
  for (let i=1; i<=pages; i++) {
    doc.setPage(i); doc.setTextColor(100); doc.setFontSize(8);
    doc.text(`Loupe | ${i} / ${pages}`, pageW-margin, pageH-5, {align:'right'});
  }
  return doc;
}
