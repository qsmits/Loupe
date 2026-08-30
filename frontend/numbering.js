// frontend/numbering.js — the single numbering authority. Sidebar rows and
// canvas labels both consume this map so "[3]" means the same thing
// everywhere.
//
// Ported verbatim from renderSidebar's partition semantics (sidebar.js's
// `renderSidebar`, ~lines 171-297) so parity holds by construction:
//   - `skip` (overlay types) is filtered out entirely, same as the sidebar's
//     `visible` list.
//   - DETECTION_TYPES are filtered out entirely — the sidebar renders them in
//     a separate "Detections" section with a "⚬" glyph, never a number, and
//     they never advance the sidebar's `i` counter.
//   - 'origin' never receives a number — the sidebar's group-members loop
//     `continue`s past it without incrementing `i`, and the ungrouped loop
//     renders it as a dedicated "⊙" row, also without incrementing `i`.
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

const OVERLAY_SKIP_TYPES = new Set(['edges-overlay', 'preprocessed-overlay', 'dxf-overlay']);

export function annotationNumbers(annotations = [], measurementGroups = {}) {
  // Same universe as the sidebar's `measurements` list: overlays and
  // detections dropped outright; 'origin' dropped too (it never gets a
  // number whether grouped or ungrouped, so excluding it up front doesn't
  // change any other annotation's resulting number).
  const eligible = annotations.filter(a =>
    !OVERLAY_SKIP_TYPES.has(a.type) && !DETECTION_TYPES.has(a.type) && a.type !== 'origin');

  // Groups in first-appearance order over `eligible`.
  const groupOrder = [];
  const seenGroups = new Set();
  for (const ann of eligible) {
    const g = measurementGroups[ann.id];
    if (g == null || seenGroups.has(g)) continue;
    seenGroups.add(g);
    groupOrder.push(g);
  }

  // Grouped members, group-by-group, each group's members in original order.
  const grouped = [];
  for (const g of groupOrder) {
    for (const ann of eligible) {
      if (measurementGroups[ann.id] === g) grouped.push(ann);
    }
  }

  // Ungrouped: no group AND sidebar's isMeasurement purpose filter.
  const ungrouped = eligible.filter(a =>
    measurementGroups[a.id] == null && (!a.purpose || a.purpose === 'measurement'));

  const map = new Map();
  let n = 1;
  for (const ann of [...grouped, ...ungrouped]) map.set(ann.id, n++);
  return map;
}
