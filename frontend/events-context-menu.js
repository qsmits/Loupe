// ── Context menu ──────────────────────────────────────────────────────────
const ctxMenu = document.getElementById("context-menu");

export function showContextMenu(x, y, items) {
  ctxMenu.innerHTML = "";
  for (const item of items) {
    if (item === "---") {
      const d = document.createElement("div");
      d.className = "ctx-divider";
      ctxMenu.appendChild(d);
    } else {
      const btn = document.createElement("button");
      btn.className = "ctx-item";
      btn.textContent = item.label;
      btn.addEventListener("click", () => { ctxMenu.hidden = true; item.action(); });
      ctxMenu.appendChild(btn);
    }
  }
  // Position, keeping on screen
  ctxMenu.hidden = false;
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 5) + "px";
  ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 5) + "px";
}

export function hideContextMenu() { ctxMenu.hidden = true; }

document.addEventListener("click", hideContextMenu);
