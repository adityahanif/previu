import { el, svgIcon } from "../dom";

export interface FindBarHandlers {
  /** Called once typing settles, not on every keystroke. */
  search(query: string): void;
  step(delta: 1 | -1): void;
  close(): void;
}

export interface FindBar {
  element: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  value(): string;
  /** Match position such as "3 of 12", "No matches", or empty for a blank field. */
  setCount(label: string): void;
}

/** How long typing settles before the document is searched. */
const DEBOUNCE = 160;

/**
 * The find field, floating over the stage. It owns only its own controls: what a
 * query means and where a match is belong to the PDF layer.
 */
export function createFindBar(handlers: FindBarHandlers): FindBar {
  const input = el("input", {
    id: "find-input",
    class: "findbar-input",
    type: "text",
    placeholder: "Find in PDF",
    "aria-label": "Find in document",
    autocomplete: "off",
    spellcheck: "false",
  });

  const count = el("span", { id: "find-count", class: "findbar-count", "aria-live": "polite" });

  const previous = el("button", {
    class: "findbar-button",
    type: "button",
    title: "Previous match (Shift+Enter)",
    "aria-label": "Previous match",
    onclick: () => handlers.step(-1),
  });
  previous.append(svgIcon("chevron-up", 15));

  const next = el("button", {
    class: "findbar-button",
    type: "button",
    title: "Next match (Enter)",
    "aria-label": "Next match",
    onclick: () => handlers.step(1),
  });
  next.append(svgIcon("chevron-down", 15));

  const dismiss = el("button", {
    class: "findbar-button",
    type: "button",
    title: "Close (Esc)",
    "aria-label": "Close find",
    onclick: () => handlers.close(),
  });
  dismiss.append(svgIcon("x", 15));

  let timer = 0;

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    const query = input.value;
    timer = window.setTimeout(() => handlers.search(query), DEBOUNCE);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      // Enter is also how a query is committed, so a slow typist never steps
      // through results from an older query.
      window.clearTimeout(timer);
      handlers.step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      handlers.close();
    }
  });

  const element = el("div", { id: "find", class: "findbar", hidden: "" }, [
    input,
    count,
    previous,
    next,
    dismiss,
  ]);

  const setCount = (label: string): void => {
    count.textContent = label;
    const empty = label === "";
    previous.disabled = empty;
    next.disabled = empty;
  };
  setCount("");

  return {
    element,
    open() {
      element.hidden = false;
      input.focus();
      // Selecting the old query lets typing replace it, the way browsers do.
      input.select();
    },
    close() {
      element.hidden = true;
      input.value = "";
      window.clearTimeout(timer);
      setCount("");
    },
    isOpen() {
      return !element.hidden;
    },
    value() {
      return input.value;
    },
    setCount,
  };
}
