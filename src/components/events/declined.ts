/**
 * The events the reader answered «not going» in this window. The service
 * keeps no such answer — «not going» takes the answer back — so the control
 * would show nothing chosen right after the press; this remembers the press
 * until the window closes.
 */
const declined = new Set<string>();

export function setDeclined(eventId: string, on: boolean): void {
  if (on) declined.add(eventId);
  else declined.delete(eventId);
}

export function isDeclined(eventId: string): boolean {
  return declined.has(eventId);
}
