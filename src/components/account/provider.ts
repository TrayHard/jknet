/** Naming the sign-in providers the same way on every screen. */

/** The provider as a player would name it. */
export function providerName(provider: string): string {
  if (provider === "jkhub") return "JKHub";
  if (provider === "discord") return "Discord";
  if (provider === "dev") return "the developer provider";
  // A provider the service grew after this build shipped. Its own name is a
  // better answer than "unknown".
  return provider;
}

/**
 * The provider as a label, where a sentence has no room.
 *
 * `providerName` reads as a sentence ("signed in with the developer
 * provider"), and a badge that pasted that in would say "the developer
 * provider linked".
 */
export function providerLabel(provider: string): string {
  return provider === "dev" ? "Developer" : providerName(provider);
}

/** The line under a name on the account card: where the account comes from. */
export function providerLine(provider: string, accountName: string): string {
  return `Signed in with ${providerName(provider)} as ${accountName}`;
}
