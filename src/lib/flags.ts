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
 * True since the account slice landed: the third onboarding step and the
 * Account card of the Settings screen both run a real sign-in against the
 * JKNet hub. What is still missing is on the hub's side rather than here —
 * JKHub and Discord have issued no OAuth client, so those two providers answer
 * `provider_error` until they do, and the launcher says so where the player
 * pressed the button.
 *
 * Nothing reads this constant any more. It stays as the switch the Friends
 * screen will want when it separates "no account" from "no friends yet".
 */
export const ACCOUNTS_ENABLED: boolean = true;
