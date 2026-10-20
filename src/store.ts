import { initialView, type Doc, type ViewState } from "./types";

export interface AppState {
  /** Directory whose siblings are offered for navigation. */
  folder: string | null;
  siblings: Doc[];
  index: number;
  view: ViewState;
  sidebarOpen: boolean;
  sidebarTab: "pages" | "files";
  loading: boolean;
  /** Human-readable message for the last failure, or null. */
  error: string | null;
}

export type ChangeReason = "document" | "view" | "siblings" | "sidebar" | "loading";

type Listener = (state: AppState, reason: ChangeReason) => void;

const listeners = new Set<Listener>();

let state: AppState = {
  folder: null,
  siblings: [],
  index: 0,
  view: initialView(),
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
  for (const listener of [...listeners]) listener(state, reason);
}

/** The document currently on screen, if any. */
export function currentDoc(): Doc | null {
  return state.siblings[state.index] ?? null;
}
