import { el, svgIcon } from "../dom";
import { isTransformed, type TabState } from "../types";

export interface TabbarActions {
  activate(id: number): void;
  close(id: number): void;
  add(): void;
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
 * The document tab strip: one tab per opened file, in the order they were
 * opened. Clicking switches, the × and a middle-click close. The strip is
 * hidden while no file is open, so the empty window looks exactly as it did
 * before tabs existed.
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
