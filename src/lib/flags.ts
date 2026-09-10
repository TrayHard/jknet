/**
 * Switches for features whose interface exists before their machinery does.
 *
 * A flag lives here and nowhere else. The screens that show a disabled control
 * and the code that would call the missing command read the same constant, so
 * turning a feature on is one edit rather than a hunt through the pages.
 */

/**
 * Whether JKNet can sign a player in.
 *
 * Accounts are drawn in the design — the third onboarding step and the Friends
 * screen both offer JKHub and Discord — but no command backs them yet. While
 * this is false the providers render disabled with a "Soon" badge, and playing
 * as a guest is the primary way out of onboarding.
 */
export const ACCOUNTS_ENABLED: boolean = false;
