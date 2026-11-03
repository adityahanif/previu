import { el, svgIcon } from "../dom";
import { isTransformed, type TabState } from "../types";

export interface TabbarActions {
  activate(id: number): void;
  close(id: number): void;
  add(): void;
  reorder(fromId: number, toId: number): void;
}

export interface TabbarView {
  tabs: TabState[];
  activeId: number | null;
}

export interface Tabbar {
  element: HTMLElement;
  update(state: TabbarView): void;
}

/**
 * The document tab strip: one tab per open file, in the order they were
 * opened. Tabs can be dragged to reorder and middle-clicked to close.
 */
export function createTabbar(actions: TabbarActions): Tabbar {
  const strip = el("div", { class: "tabbar-list", role: "tablist" });

  const add = el(
    "button",
    {
      class: "tabbar-add",
      type: "button",
      title: "Open a file in a new tab (Ctrl+O)",
      "aria-label": "Open a file in a new tab",
    },
    [svgIcon("plus", 14)],
  );
  add.addEventListener("click", () => actions.add());

  const element = el("div", { id: "tabbar", class: "tabbar", hidden: true }, [strip, add]);

  /** What is currently painted; rebuilds happen only when this changes. */
  let signature = "";

  function render(state: TabbarView): void {
    const next = state.tabs
      .map(
        (tab) =>
          `${tab.id}:${tab.doc.path}:${tab.id === state.activeId ? 1 : 0}:${
            isTransformed(tab.view) ? 1 : 0
          }`,
      )
      .join("\u0000");
    if (next === signature) return;
    signature = next;

    strip.replaceChildren(
      ...state.tabs.map((tab) => {
        const tabEl = el(
          "div",
          {
            class: `doc-tab${tab.id === state.activeId ? " is-active" : ""}`,
            role: "tab",
            "aria-selected": tab.id === state.activeId ? "true" : "false",
            title: tab.doc.path,
            draggable: "true",
          },
          [
            svgIcon(tab.doc.kind === "pdf" ? "file" : "image", 13),
            el("span", { class: "doc-tab-name", text: tab.doc.name }),
          ],
        );
        if (isTransformed(tab.view)) {
          tabEl.append(el("span", { class: "doc-tab-dot", title: "Unsaved rotation or flip" }));
        }

        const close = el("button", {
          class: "doc-tab-close",
          type: "button",
          title: "Close tab (Ctrl+W)",
          "aria-label": `Close ${tab.doc.name}`,
        });
        close.append(svgIcon("x", 11));
        close.addEventListener("click", (event) => {
          event.stopPropagation();
          actions.close(tab.id);
        });
        tabEl.append(close);

        tabEl.addEventListener("click", () => actions.activate(tab.id));
        tabEl.addEventListener("auxclick", (event) => {
          if (event.button === 1) actions.close(tab.id);
        });
        tabEl.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData("text/plain", String(tab.id));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        });
        tabEl.addEventListener("dragover", (event) => {
          event.preventDefault();
          tabEl.classList.add("is-drop-target");
        });
        tabEl.addEventListener("dragleave", () => tabEl.classList.remove("is-drop-target"));
        tabEl.addEventListener("drop", (event) => {
          event.preventDefault();
          tabEl.classList.remove("is-drop-target");
          const fromId = Number(event.dataTransfer?.getData("text/plain"));
          if (Number.isFinite(fromId) && fromId !== tab.id) actions.reorder(fromId, tab.id);
        });

        return tabEl;
      }),
    );
  }

  return {
    element,
    update(state) {
      element.hidden = state.tabs.length === 0;
      render(state);
    },
  };
}
