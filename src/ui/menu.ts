import { el } from "../dom";

export interface MenuItem {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

let open: HTMLElement | null = null;
let dismiss: ((event: Event) => void) | null = null;

export function closeMenu(): void {
  if (dismiss) {
    window.removeEventListener("pointerdown", dismiss, true);
    window.removeEventListener("keydown", dismiss, true);
    window.removeEventListener("resize", dismiss);
    dismiss = null;
  }
  open?.remove();
  open = null;
}

/**
 * Anchors a menu under `anchor`. Dismissal listens in the capture phase so a
 * click anywhere else closes the menu before that click does anything else.
 */
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu();

  const menu = el("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item.separatorBefore) menu.append(el("div", { class: "menu-separator" }));
    const entry = el(
      "button",
      {
        class: "menu-item",
        role: "menuitem",
        type: "button",
        disabled: item.disabled ? "true" : undefined,
      },
      [
        el("span", { class: "menu-check", text: item.checked ? "✓" : "" }),
        el("span", { class: "menu-label", text: item.label }),
      ],
    );
    if (!item.disabled) {
      entry.addEventListener("click", () => {
        closeMenu();
        item.onSelect();
      });
    }
    menu.append(entry);
  }

  document.body.append(menu);

  const bounds = anchor.getBoundingClientRect();
  const left = Math.min(bounds.left, window.innerWidth - menu.offsetWidth - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${bounds.bottom + 6}px`;
  open = menu;

  dismiss = (event: Event) => {
    if (event.type === "pointerdown") {
      const target = event.target;
      if (target instanceof Node && menu.contains(target)) return;
    }
    closeMenu();
  };
  window.addEventListener("pointerdown", dismiss, true);
  window.addEventListener("keydown", dismiss, true);
  window.addEventListener("resize", dismiss);
}
