// ── Context menu ──────────────────────────────────────────────────────────
const ctxMenu = document.getElementById("context-menu");

export function showContextMenu(x, y, items) {
  ctxMenu.innerHTML = "";
  for (const item of items) {
    if (item === "---") {
      const d = document.createElement("div");
      d.className = "ctx-divider";
      ctxMenu.appendChild(d);
    } else if (item.children) {
      // Submenu
      const wrapper = document.createElement("div");
      wrapper.className = "ctx-submenu-wrapper";
      const btn = document.createElement("button");
      btn.className = "ctx-item ctx-submenu-trigger";
      btn.textContent = item.label + " ▸";
      wrapper.appendChild(btn);
      const sub = document.createElement("div");
      sub.className = "ctx-submenu";
      sub.hidden = true;
      for (const child of item.children) {
        if (child === "---") {
          const d = document.createElement("div");
          d.className = "ctx-divider";
          sub.appendChild(d);
        } else {
          const cbtn = document.createElement("button");
          cbtn.className = "ctx-item";
          cbtn.textContent = child.label;
          cbtn.addEventListener("click", () => { ctxMenu.hidden = true; child.action(); });
          sub.appendChild(cbtn);
        }
      }
      wrapper.appendChild(sub);
      wrapper.addEventListener("mouseenter", () => { sub.hidden = false; });
      wrapper.addEventListener("mouseleave", () => { sub.hidden = true; });
      ctxMenu.appendChild(wrapper);
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
