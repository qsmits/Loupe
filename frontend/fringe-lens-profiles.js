// fringe-lens-profiles.js — Fringe lens distortion profile CRUD.
//
// Profiles stored in localStorage under "loupe_fringe_lens_profiles".
// Each profile: { name: string, k1: number }
// Separate from microscope cal profiles (cal-profiles.js).

const STORAGE_KEY = "loupe_fringe_lens_profiles";

export function loadFringeLensProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveFringeLensProfile(name, k1) {
  const profiles = loadFringeLensProfiles();
  const existing = profiles.findIndex(p => p.name === name);
  if (existing >= 0) profiles[existing].k1 = k1;
  else profiles.push({ name, k1 });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

export function deleteFringeLensProfile(name) {
  const profiles = loadFringeLensProfiles().filter(p => p.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

export function renderFringeLensDropdown() {
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
    opt.textContent = `${p.name} (k\u2081=${p.k1.toFixed(3)})`;
    opt.dataset.k1 = p.k1;
    sel.appendChild(opt);
  }

  // Restore selection if it still exists
  if (currentVal && profiles.some(p => p.name === currentVal)) {
    sel.value = currentVal;
  }
}
