// Tiny pub/sub so any page can ask the floating assistant (Heera) to open
// with a pre-seeded message, without lifting the assistant's message state
// into a shared store. A plain window CustomEvent is the simplest mechanism
// that fits this codebase — no new state library, no context restructuring.
const EVENT_NAME = "awip:assistant-seed-message";

export function seedAssistantMessage(text: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(EVENT_NAME, { detail: text }));
}

export function onAssistantSeedMessage(handler: (text: string) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<string>).detail);
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
