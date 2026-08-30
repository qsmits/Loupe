// frontend/numbering.js — the single numbering authority. Sidebar rows and
// canvas labels both consume this map so "[3]" means the same thing
// everywhere.
//
// Ported verbatim from renderSidebar's partition semantics (sidebar.js's
// `renderSidebar`, ~lines 171-297) so parity holds by construction:
//   - `OVERLAY_SKIP_TYPES` is filtered out entirely, same as the sidebar's
//     `visible` list — exported so sidebar.js shares this exact Set instead
//     of keeping its own copy (two literals WILL drift).
//   - DETECTION_TYPES are filtered out entirely — the sidebar renders them in
//     a separate "Detections" section with a "⚬" glyph, never a number, and
//     they never advance the sidebar's `i` counter.
//   - 'origin' never receives a number — the sidebar's group-members loop
//     `continue`s past it without incrementing `i`, and the ungrouped loop
//     renders it as a dedicated "⊙" row, also without incrementing `i`.
//     BUT origin is NOT dropped before group first-appearance order is
//     computed: the sidebar's `groupMap` is built by iterating over
//     `measurements`, which still contains origin (only skip is overlay
//     types + DETECTION_TYPES, not origin). If a user groups the origin
//     annotation ("Group selected…" applies to any selected ids, and origin
//     is hit-testable/selectable) and it happens to be that group's
//     first-appearing member, the sidebar's groupMap registers that group at
//     THAT position — so numbering.js must compute group order over the
//     same origin-inclusive set, and only exclude origin when collecting the
//     members that actually receive a number.
//   - Grouped members are collected with NO purpose filter (the sidebar's
//     group-building loop pushes every member regardless of `ann.purpose`).
//   - The purpose filter (`!ann.purpose || ann.purpose === 'measurement'`)
//     applies ONLY when placing an annotation into the ungrouped list — the
//     sidebar's exact `isMeasurement` check.
//   - Groups are visited in first-appearance order over the annotations
//     array (JS Map insertion order), and each group's members keep their
//     relative order from the annotations array — same as the sidebar's
//     single linear pass.
import { DETECTION_TYPES } from './state.js';

export const OVERLAY_SKIP_TYPES = new Set(['edges-overlay', 'preprocessed-overlay', 'dxf-overlay']);

export function annotationNumbers(annotations = [], measurementGroups = {}) {
  // Mirrors the sidebar's `measurements` list exactly: overlay types and
  // detections dropped, 'origin' KEPT (see header note above — its presence
  // here can change which group is discovered first).
  const measurements = annotations.filter(a =>
    !OVERLAY_SKIP_TYPES.has(a.type) && !DETECTION_TYPES.has(a.type));

  // Groups in first-appearance order over `measurements` (origin included,
  // exactly like the sidebar's groupMap build pass).
  const groupOrder = [];
  const seenGroups = new Set();
  for (const ann of measurements) {
    const g = measurementGroups[ann.id];
    if (g == null || seenGroups.has(g)) continue;
    seenGroups.add(g);
    groupOrder.push(g);
  }

  // Grouped members that actually receive a number: same membership test,
  // but origin excluded here — it never gets a number even when grouped
  // (the sidebar's per-row loop `continue`s past it without incrementing
  // its counter).
  const grouped = [];
  for (const g of groupOrder) {
    for (const ann of measurements) {
      if (ann.type !== 'origin' && measurementGroups[ann.id] === g) grouped.push(ann);
    }
  }

  // Ungrouped: no group, not origin, AND sidebar's isMeasurement purpose filter.
  const ungrouped = measurements.filter(a =>
    a.type !== 'origin' && measurementGroups[a.id] == null &&
    (!a.purpose || a.purpose === 'measurement'));

  const map = new Map();
  let n = 1;
  for (const ann of [...grouped, ...ungrouped]) map.set(ann.id, n++);
  return map;
}
