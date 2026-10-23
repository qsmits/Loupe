/**
 * template.js — Measurement template save/load/validate module.
 *
 * Templates are client-side JSON files for saving and restoring a complete
 * inspection setup: DXF geometry, calibration, tolerances, detection settings,
 * and per-feature configuration.
 */

/**
 * Assemble a template JSON object from the given config fields.
 *
 * @param {Object} config
 * @param {string}  config.name
 * @param {string}  [config.description]
 * @param {string}  config.dxfFilename
 * @param {Array}   config.entities
 * @param {Object}  config.calibration        — { pixelsPerMm, displayUnit }
 * @param {Object}  config.tolerances         — { warn, fail }
 * @param {Object}  [config.featureTolerances]
 * @param {Object}  [config.featureSpecs]      — DXF diameter/radius DIMENSION tolerances, keyed by handle
 * @param {number|null} [config.dxfDefaultTol] — per-drawing default ± tolerance (mm)
 * @param {Object}  [config.featureModes]
 * @param {Object}  [config.featureNames]
 * @param {Object}  config.detection          — { cannyLow, cannyHigh, smoothing, subpixel }
 * @param {Object}  config.alignment          — { method, smoothing }
 * @param {Object}  [config.inspection]       — edge method, corridor, caliper recipe
 * @returns {Object} template
 */
export function assembleTemplate(config) {
  const {
    name,
    description = '',
    dxfFilename,
    entities,
    calibration,
    tolerances,
    featureTolerances = {},
    featureSpecs = {},
    dxfDefaultTol = null,
    featureModes = {},
    featureNames = {},
    detection,
    alignment,
    inspection,
  } = config;

  const now = new Date().toISOString();

  return {
    version: 1,
    name,
    description,
    createdAt: now,
    updatedAt: now,
    dxf: {
      filename: dxfFilename,
      entities,
    },
    calibration: {
      pixelsPerMm: calibration.pixelsPerMm,
      displayUnit: calibration.displayUnit,
    },
    tolerances: {
      warn: tolerances.warn,
      fail: tolerances.fail,
    },
    featureTolerances,
    featureSpecs,
    dxfDefaultTol,
    featureModes,
    featureNames,
    ...(inspection ? { inspection: structuredClone(inspection) } : {}),
    detection: {
      cannyLow: detection.cannyLow,
      cannyHigh: detection.cannyHigh,
      smoothing: detection.smoothing,
      subpixel: detection.subpixel,
    },
    alignment: {
      method: alignment.method,
      smoothing: alignment.smoothing,
    },
  };
}

/**
 * Validate a template object.
 *
 * @param {*} tmpl
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
export function validateTemplate(tmpl) {
  if (tmpl === null || typeof tmpl !== 'object' || Array.isArray(tmpl)) {
    return { valid: false, error: 'Template must be an object' };
  }

  if (tmpl.version === undefined || tmpl.version === null) {
    return { valid: false, error: 'Missing version field' };
  }

  if (typeof tmpl.version !== 'number' || tmpl.version > 1) {
    return { valid: false, error: `Unsupported template version: ${tmpl.version}` };
  }

  if (!tmpl.dxf || !Array.isArray(tmpl.dxf.entities) || tmpl.dxf.entities.length === 0) {
    return { valid: false, error: 'dxf.entities must be a non-empty array' };
  }

  if (!tmpl.calibration || typeof tmpl.calibration.pixelsPerMm !== 'number' || tmpl.calibration.pixelsPerMm <= 0) {
    return { valid: false, error: 'calibration.pixelsPerMm must be a positive number' };
  }

  if (tmpl.calibration.displayUnit !== 'mm' && tmpl.calibration.displayUnit !== 'µm') {
    return { valid: false, error: 'calibration.displayUnit must be "mm" or "µm"' };
  }

  if (!tmpl.tolerances || typeof tmpl.tolerances.warn !== 'number' || typeof tmpl.tolerances.fail !== 'number') {
    return { valid: false, error: 'tolerances.warn and tolerances.fail must be numbers' };
  }

  if (tmpl.tolerances.warn >= tmpl.tolerances.fail) {
    return { valid: false, error: 'tolerances.warn must be less than tolerances.fail' };
  }

  if (!tmpl.detection || typeof tmpl.detection.cannyLow !== 'number') {
    return { valid: false, error: 'detection settings missing or detection.cannyLow is not a number' };
  }

  if (tmpl.inspection !== undefined) {
    const opts = tmpl.inspection;
    if (!opts || !['caliper', 'contour'].includes(opts.edgeMethod) ||
        !Number.isFinite(opts.corridorPx) || opts.corridorPx <= 0 || opts.corridorPx > 200) {
      return { valid: false, error: 'Invalid inspection method or search corridor' };
    }
    const limits = { width: [0, 21], sigma: [0.3, 5], spacing: [1, 50], min_contrast: [0.001, 255] };
    for (const [key, [min, max]] of Object.entries(limits)) {
      const value = opts.caliper?.[key];
      if (!Number.isFinite(value) || value < min || value > max) {
        return { valid: false, error: `Invalid caliper ${key}` };
      }
    }
    if (!['any', 'rising', 'falling'].includes(opts.caliper.polarity) ||
        !['unique', 'first', 'strongest', 'closest'].includes(opts.caliper.selection)) {
      return { valid: false, error: 'Invalid caliper edge choice' };
    }
  }

  return { valid: true };
}

/**
 * Trigger a client-side download of the template as a `.loupe-template.json` file.
 *
 * @param {Object} tmpl — a template object (ideally already validated)
 */
export function downloadTemplate(tmpl) {
  const safeName = String(tmpl.name || 'template')
    .replace(/[^a-z0-9_\-. ]/gi, '_')
    .trim()
    .replace(/\s+/g, '_');

  const filename = `${safeName}.loupe-template.json`;
  const json = JSON.stringify(tmpl, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Revoke the object URL after a short delay to allow the download to start.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Read a File object, parse its JSON, and validate it as a template.
 *
 * @param {File} file
 * @returns {Promise<Object>} resolved template object
 * @throws {Error} if the file cannot be parsed or fails validation
 */
export async function readTemplateFile(file) {
  const text = await file.text();

  let tmpl;
  try {
    tmpl = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse template file: ${err.message}`);
  }

  const result = validateTemplate(tmpl);
  if (!result.valid) {
    throw new Error(`Invalid template: ${result.error}`);
  }

  return tmpl;
}
