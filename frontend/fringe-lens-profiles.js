// fringe-lens-profiles.js — Fringe lens distortion profile CRUD.
//
// Profiles stored in localStorage under "loupe_fringe_lens_profiles".
// Each profile: { name: string, k1: number }
// Separate from microscope cal profiles (cal-profiles.js).

const STORAGE_KEY = "loupe_fringe_lens_profiles";

export function loadFringeLensProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const profiles = raw ? JSON.parse(raw) : [];
    return profiles.map(p => ({
      ...p,
      // Profiles written by the old implementation stored pixel-space k1.
      coefficient_space: p.coefficient_space || "pixel_v0",
    }));
  } catch { return []; }
}

/**
 * @param {string} name
 * @param {number} k1
 * @param {string} coefficientSpace  Space the caller's k1 is ACTUALLY in.
 *   Defaults to diag_normalized_v1 (every current caller applies an
 *   already-converted, dimensionless k1 before saving), but is an explicit
 *   parameter rather than a hardcoded tag so a caller can never save an
 *   unconverted value mistagged as already converted.
 */
export function saveFringeLensProfile(name, k1, coefficientSpace = "diag_normalized_v1") {
  const profiles = loadFringeLensProfiles();
  const existing = profiles.findIndex(p => p.name === name);
  const profile = { name, k1, coefficient_space: coefficientSpace };
  if (existing >= 0) profiles[existing] = profile;
  else profiles.push(profile);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

export function deleteFringeLensProfile(name) {
  const profiles = loadFringeLensProfiles().filter(p => p.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

export function renderFringeLensDropdown(activeK1) {
  const sel = document.getElementById("fringe-lens-profile");
  if (!sel) return;
  const profiles = loadFringeLensProfiles();
  const currentVal = sel.value;
  sel.innerHTML = "";

  // "None" option
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "None";
  sel.appendChild(none);

  for (const p of profiles) {
    const opt = document.createElement("option");
    opt.value = p.name;
    const legacy = p.coefficient_space === "pixel_v0" ? ", legacy" : "";
    opt.textContent = `${p.name} (k\u2081=${p.k1.toFixed(3)}${legacy})`;
    opt.dataset.k1 = p.k1;
    opt.dataset.coefficientSpace = p.coefficient_space;
    sel.appendChild(opt);
  }

  // Restore selection if it still exists
  if (currentVal && profiles.some(p => p.name === currentVal)) {
    sel.value = currentVal;
  }
  if (Number.isFinite(activeK1)) {
    const matches = p => p.coefficient_space === 'diag_normalized_v1' && Math.abs(p.k1-activeK1) < 1e-12;
    const profile = profiles.find(p => p.name === currentVal && matches(p)) || profiles.find(matches);
    if (profile) sel.value = profile.name;
    else if (activeK1 !== 0) {
      const current = document.createElement('option');
      current.value = '__current_lens_calibration__';
      current.textContent = `Unsaved calibration (k₁=${activeK1.toFixed(3)})`;
      current.disabled = true;
      sel.appendChild(current);
      sel.value = current.value;
      return true;
    } else sel.value = '';
  }
  return false;
}
