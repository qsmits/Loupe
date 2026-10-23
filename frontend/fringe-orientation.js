// User observations are separate from algorithmic sign inference and height zero.
export const GAP_DIRECTIONS = {
  unknown: 'Not recorded', up:'Top', 'up-right':'Top right', right:'Right',
  'down-right':'Bottom right', down:'Bottom', 'down-left':'Bottom left', left:'Left', 'up-left':'Top left',
};
const VECTORS = {up:[0,-1],'up-right':[1,-1],right:[1,0],'down-right':[1,1],down:[0,1],'down-left':[-1,1],left:[-1,0],'up-left':[-1,-1]};
export function physicalOrientation(data) {
  const p=data?.physical_orientation || {};
  return {
    gap_direction:Object.hasOwn(GAP_DIRECTIONS,p.gap_direction) ? p.gap_direction : 'unknown',
    contact_label: data?.reference_marks?.some(m=>m.label===p.contact_label) ? p.contact_label : null,
    polarity:['red-larger-gap','red-smaller-gap'].includes(p.polarity) ? p.polarity : 'unverified',
    notes:typeof p.notes === 'string' ? p.notes.slice(0,1000) : '',
    recorded_at:typeof p.recorded_at === 'string' ? p.recorded_at : null,
  };
}
export function polarityDescription(data) {
  const {polarity}=physicalOrientation(data);
  return polarity === 'unverified' ? 'Physical polarity: unverified.'
    : `Physical polarity (user-checked): red means ${polarity === 'red-larger-gap' ? 'larger' : 'smaller'} air-gap departure.`;
}
export function orientationDescription(data) {
  const p=physicalOrientation(data);
  return [polarityDescription(data),
    `Gap-opening direction in the image: ${GAP_DIRECTIONS[p.gap_direction]}.`,
    p.contact_label ? `User-recorded contact: landmark ${p.contact_label}. No absolute gap or height-zero correction is applied.` : 'Contact point: not recorded.',
    ...(p.notes ? [`Orientation evidence: ${p.notes}`] : []),
    ...(p.recorded_at ? [`Orientation record updated: ${p.recorded_at}`] : []),
  ];
}
export function flipRecordedPolarity(data) {
  if (!data?.physical_orientation) return;
  const p=physicalOrientation(data);
  if (p.polarity !== 'unverified') p.polarity=p.polarity==='red-larger-gap'?'red-smaller-gap':'red-larger-gap';
  // Keep the physical observation time: display inversion is not a new check.
  data.physical_orientation=p;
}
export function orientationSvg(data, w, h) {
  const vector=VECTORS[physicalOrientation(data).gap_direction];
  if (!vector || w<90 || h<60) return '';
  const norm=Math.hypot(...vector), dx=vector[0]/norm, dy=vector[1]/norm;
  const x=w-35, y=30, x1=x-dx*12,y1=y-dy*12,x2=x+dx*12,y2=y+dy*12;
  return `<g stroke="#ffe15a" stroke-width="2" fill="none" style="filter:drop-shadow(0 1px 2px #000)">
    <path d="M${x1},${y1}L${x2},${y2} M${x2-dx*6-dy*4},${y2-dy*6+dx*4}L${x2},${y2}L${x2-dx*6+dy*4},${y2-dy*6-dx*4}"/>
    <text x="${x}" y="${y+25}" text-anchor="middle" fill="#ffe15a" stroke="#111" paint-order="stroke" font-size="11">gap opens</text></g>`;
}
