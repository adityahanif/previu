import { initialView, type Doc, type TabState, type ViewState } from "./types";

export interface AppState {
  /** Directory whose siblings are offered for navigation. */
  folder: string | null;
  siblings: Doc[];
  index: number;
  view: ViewState;
  /** Open document tabs; the fields above mirror the active one. */
  tabs: TabState[];
  activeTabId: number | null;
  sidebarOpen: boolean;
  sidebarTab: "pages" | "files";
  loading: boolean;
  /** Human-readable message for the last failure, or null. */
  error: string | null;
}

export type ChangeReason = "document" | "view" | "siblings" | "sidebar" | "loading" | "tabs";

type Listener = (state: AppState, reason: ChangeReason) => void;

const listeners = new Set<Listener>();

let state: AppState = {
  folder: null,
  siblings: [],
  index: 0,
  view: initialView(),
  tabs: [],
  activeTabId: null,
  sidebarOpen: false,
  sidebarTab: "pages",
  loading: false,
  error: null,
};

export function getState(): AppState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setState(patch: Partial<AppState>, reason: ChangeReason): void {
  state = { ...state, ...patch };

  // The active tab is the record tabs are restored from, so anything that
  // moves the mirrored fields — navigating siblings, changing the view —
  // is written through to it.
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (
    active &&
    ("view" in patch || "siblings" in patch || "index" in patch || "folder" in patch)
  ) {
    active.view = state.view;
    active.siblings = state.siblings;
    active.index = state.index;
    active.folder = state.folder;
    const doc = state.siblings[state.index];
    if (doc) active.doc = doc;
  }

  for (const listener of [...listeners]) listener(state, reason);
}

/** The document currently on screen, if any. */
export function currentDoc(): Doc | null {
  return state.siblings[state.index] ?? null;
}
