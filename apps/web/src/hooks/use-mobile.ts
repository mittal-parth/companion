import { useSyncExternalStore } from "react";

const mobileBreakpoint = 768;
const mobileQuery = `(max-width: ${mobileBreakpoint - 1}px)`;

/**
 * Whether the window is narrow enough for the sidebar to become a sheet.
 * The server render is the wide layout. The client corrects it after paint.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  return window.innerWidth < mobileBreakpoint;
}

function serverSnapshot(): boolean {
  return false;
}
