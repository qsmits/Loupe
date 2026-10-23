// Surface-map coordinates are CSS pixels; the untransformed image is centered.
export function clampSurfacePan(view, zoom, x, y) {
  const axis = (viewport, size, pan) => {
    const origin = (viewport - size) / 2;
    return size * zoom <= viewport
      ? (viewport - size * zoom) / 2 - origin
      : Math.max(viewport - origin - size * zoom, Math.min(-origin, pan));
  };
  return {x: axis(view.width, view.imageWidth, x), y: axis(view.height, view.imageHeight, y)};
}

export function zoomSurfaceAt(view, current, cursor, factor) {
  const zoom = Math.max(1, Math.min(10, current.zoom * factor));
  const ratio = zoom / current.zoom;
  const x = cursor.x - (view.width - view.imageWidth) / 2;
  const y = cursor.y - (view.height - view.imageHeight) / 2;
  const pan = clampSurfacePan(view, zoom,
    x - (x - current.x) * ratio, y - (y - current.y) * ratio);
  return {zoom, ...pan};
}
