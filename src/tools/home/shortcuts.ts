// Pure mapping from a keyboard event to a Home-screen shortcut action.
// "browse" opens the file picker; any other non-null value is a route to navigate to.

export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  target: EventTarget | null;
}

export type HomeShortcutAction = "browse" | "/merge" | "/images-to-pdf";

export function matchHomeShortcut(e: ShortcutEvent): HomeShortcutAction | null {
  const t = e.target as (HTMLElement | null);
  const inField =
    !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable === true);
  if (inField) return null;
  if (!(e.metaKey || e.ctrlKey)) return null;

  switch (e.key.toLowerCase()) {
    case "o":
      return "browse";
    case "m":
      return "/merge";
    case "i":
      return "/images-to-pdf";
    default:
      return null;
  }
}
