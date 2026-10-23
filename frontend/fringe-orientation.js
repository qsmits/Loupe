// A known physical wedge can orient the recovered phase. The image alone cannot.
// Verification records user evidence; it never changes height zero or PV/RMS.
export const GAP_DIRECTIONS = {
  unknown: 'Not recorded', up:'Top', 'up-right':'Top right', right:'Right',
  'down-right':'Bottom right', down:'Bottom', 'down-left':'Bottom left', left:'Left', 'up-left':'Top left',
};
const VECTORS = {up:[0,-1],'up-right':[1,-1],right:[1,0],'down-right':[1,1],down:[0,1],'down-left':[-1,1],left:[-1,0],'up-left':[-1,-1]};
function contactMark(data, label) {
  return data?.reference_marks?.find(m => m && m.label === label && /^[A-Z]$/.test(m.label)
    && Number.isFinite(m.x) && Number.isFinite(m.y) && m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1);
}
function evidenceKey(data) {
  const p=data?.physical_orientation || {}, mark=contactMark(data,p.contact_label);
  // Inverting the display changes colors, not the physical observations.
  return JSON.stringify([p.gap_direction,mark?.label,mark?.x,mark?.y]);
}
export function physicalOrientation(data) {
  const p=data?.physical_orientation || {};
  return {
    gap_direction:Object.hasOwn(GAP_DIRECTIONS,p.gap_direction) ? p.gap_direction : 'unknown',
    contact_label: contactMark(data,p.contact_label)?.label || null,
    polarity:['red-larger-gap','red-smaller-gap'].includes(p.polarity)
      && (p.verification_method !== 'contact-gap' || p.evidence_key === evidenceKey(data)) ? p.polarity : 'unverified',
    verification_method:p.verification_method === 'contact-gap' ? 'contact-gap' : 'manual',
    evidence_key:p.evidence_key || null,
    notes:typeof p.notes === 'string' ? p.notes.slice(0,1000) : '',
    recorded_at:typeof p.recorded_at === 'string' ? p.recorded_at : null,
  };
}
export function polarityDescription(data) {
  const {polarity}=physicalOrientation(data);
  return polarity === 'unverified' ? 'Surface direction unverified — concave / convex not established.'
    : `Part deviation (user-checked): red = ${polarity === 'red-larger-gap' ? 'lower' : 'higher'}; blue = ${polarity === 'red-larger-gap' ? 'higher' : 'lower'} — after slope/form removal.`;
}
export function contactMapExplanation(data) {
  const label=physicalOrientation(data).contact_label;
  return `At a true contact${label ? ' '+label : ''}, the actual air gap is zero. This map shows deviations after the overall gap slope and selected form are removed. A contact point can therefore be any color; its color does not give the absolute gap.`;
}
export function shapeInterpretation(polarity) {
  if (!['red-larger-gap','red-smaller-gap'].includes(polarity)) return 'Until checked, either a hollow or a bump can produce this displayed shape.';
  return `For a bowl-shaped part with curvature retained: a centre ${polarity === 'red-larger-gap' ? 'redder' : 'bluer'} than its rim indicates concave (hollow); a centre ${polarity === 'red-larger-gap' ? 'bluer' : 'redder'} than its rim indicates convex (raised). Mixed shapes need local interpretation.`;
}
export function formRemovalNotice(data) {
  if (['poly2','poly3'].includes(data?.form_model) || data?.subtracted_terms?.includes(4)) {
    return 'Curvature has been removed from this result. Restore it before judging the original concave / convex shape.';
  }
  return 'Keep curvature in the result when assessing concave / convex: use Plane, or Zernike with Curvature subtraction off. Higher-order removal can change the apparent shape. Reference-flat error remains included.';
}
export function orientationGuidance(data) {
  const p=physicalOrientation(data), contact=contactMark(data,p.contact_label), vector=VECTORS[p.gap_direction];
  const blocked=(reason,action=null)=>({polarity:null,reason,action});
  if (!contact) return blocked('Add a mark at the known physical contact, then select its letter. Do not choose contact from the map colors.');
  if (!vector) return blocked(`From contact ${contact.label}, which way does the air gap open? Choose the direction observed on the physical setup, in the image coordinates.`);
  // Only original single-exposure results have a traceable phase/carrier mapping.
  // Old saved results may already have been inverted, so never assume +1.
  if (![1,-1].includes(data?.carrier_phase_sign)) return blocked('This saved result lacks the information needed to track earlier map inversions. Analyze the original image again to enable this check. Contact and direction alone cannot safely recover the missing information.', 'reanalyze');
  const fx=data.carrier?.fx_cpp, fy=data.carrier?.fy_cpp;
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || Math.hypot(fx,fy) === 0) return blocked('No usable fringe direction is available. Check the analysis before interpreting the surface.');
  const alignment=(fx*vector[0]+fy*vector[1])/(Math.hypot(fx,fy)*Math.hypot(...vector));
  if (Math.abs(alignment) < Math.SQRT1_2 - 1e-9) return blocked('The selected gap direction runs too nearly along the fringes. Check the image orientation and choose the direction across the fringes, from thinner to thicker gap.');
  if (data.warnings?.some(w=>/fold.over|sidebands run into DC/i.test(w))) return blocked('The analysis reports fringe fold-over or overlapping sidebands. Resolve that warning before using a single wedge direction to orient this map.');
  // Check that the arrow from contact enters the measured part, not empty space.
  const rows=data.grid_rows, cols=data.grid_cols, mask=data.mask_grid;
  if (rows > 1 && cols > 1 && mask?.length === rows*cols) {
    let ahead=0, total=0;
    for (let i=0;i<mask.length;i++) if (mask[i]) {
      total++;
      const dx=(i%cols)/(cols-1)-contact.x, dy=Math.floor(i/cols)/(rows-1)-contact.y;
      const w=data.surface_width || cols, h=data.surface_height || rows;
      if (dx*w*vector[0]+dy*h*vector[1] > .02*Math.max(w,h)) ahead++;
    }
    if (!total || ahead/total < .05) return blocked('The arrow from this contact points away from the measured area. Check the contact position and gap-opening direction.');
  }
  const polarity=alignment*data.carrier_phase_sign > 0 ? 'red-larger-gap' : 'red-smaller-gap';
  return {polarity,reason:`From contact ${contact.label}, gap opens toward ${GAP_DIRECTIONS[p.gap_direction].toLowerCase()}. This suggests red = ${polarity === 'red-larger-gap' ? 'lower part deviation' : 'higher part deviation'}, blue = ${polarity === 'red-larger-gap' ? 'higher part deviation' : 'lower part deviation'}, after slope/form removal.`};
}
export function confirmOrientation(data) {
  const suggestion=orientationGuidance(data);
  if (!suggestion.polarity) return false;
  data.physical_orientation={...physicalOrientation(data),polarity:suggestion.polarity,
    verification_method:'contact-gap',evidence_key:evidenceKey(data),recorded_at:new Date().toISOString()};
  return true;
}
export function clearOrientationVerification(data) {
  if (data?.physical_orientation) data.physical_orientation={...physicalOrientation(data),polarity:'unverified',evidence_key:null};
}
export function orientationDescription(data) {
  const p=physicalOrientation(data);
  return [polarityDescription(data),
    contactMapExplanation(data),
    shapeInterpretation(p.polarity),
    formRemovalNotice(data),
    ...(p.polarity !== 'unverified' ? [`Verification method: ${p.verification_method === 'contact-gap' ? 'user-confirmed contact and gap-opening direction' : 'independent physical check'}. Red = ${p.polarity === 'red-larger-gap' ? 'larger' : 'smaller'} air-gap departure. Reference flat above the part.`] : []),
    `Gap-opening direction in the image: ${GAP_DIRECTIONS[p.gap_direction]}.`,
    p.contact_label ? `User-recorded contact: landmark ${p.contact_label}. No absolute gap or height-zero correction is applied.` : 'Contact point: not recorded.',
    ...(p.notes ? [`Orientation evidence: ${p.notes}`] : []),
    ...(p.recorded_at ? [`Orientation record updated: ${p.recorded_at}`] : []),
  ];
}
export function flipRecordedPolarity(data) {
  if ([1,-1].includes(data?.carrier_phase_sign)) data.carrier_phase_sign *= -1;
  if (!data?.physical_orientation) return;
  const p=physicalOrientation(data);
  if (p.polarity !== 'unverified') p.polarity=p.polarity==='red-larger-gap'?'red-smaller-gap':'red-larger-gap';
  // Keep the physical observation time: display inversion is not a new check.
  data.physical_orientation=p;
}
export function orientationSvg(data, w, h) {
  const record=physicalOrientation(data), vector=VECTORS[record.gap_direction];
  if (!vector || w<90 || h<60) return '';
  const norm=Math.hypot(...vector), dx=vector[0]/norm, dy=vector[1]/norm;
  const contact=contactMark(data,record.contact_label);
  const x=contact ? contact.x*w : w-35, y=contact ? contact.y*h : 30;
  const x1=x+dx*(contact ? 12 : -12),y1=y+dy*(contact ? 12 : -12),x2=x+dx*(contact ? 44 : 12),y2=y+dy*(contact ? 44 : 12);
  const tx=Math.max(35,Math.min(w-35,x2)), ty=Math.max(15,Math.min(h-5,y2+20));
  return `<g stroke="#ffe15a" stroke-width="2" fill="none" style="filter:drop-shadow(0 1px 2px #000)">
    <path d="M${x1},${y1}L${x2},${y2} M${x2-dx*6-dy*4},${y2-dy*6+dx*4}L${x2},${y2}L${x2-dx*6+dy*4},${y2-dy*6-dx*4}"/>
    <text x="${tx}" y="${ty}" text-anchor="middle" fill="#ffe15a" stroke="#111" paint-order="stroke" font-size="11">gap opens</text></g>`;
}

// Recovery may carry observations across an identical aligned image, never a
// changed crop/lens correction. Physical confirmation still needs to be repeated.
export function recoverOrientationObservations(previous, next) {
  if (!previous?.reference_image_b64 || previous.reference_image_b64 !== next?.reference_image_b64
      || previous.surface_width !== next.surface_width || previous.surface_height !== next.surface_height) return false;
  next.reference_marks=(previous.reference_marks || []).filter(m=>contactMark(previous,m?.label))
    .map(({label,x,y})=>({label,x,y}));
  next.physical_orientation={...physicalOrientation(previous),polarity:'unverified',evidence_key:null};
  return true;
}
