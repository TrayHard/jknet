import { SessionsCard } from "../../../../src/components/account/SessionsCard.tsx";

/**
 * Settings · Devices and sessions: the launcher's card, shared as it is.
 *
 * Every launcher and browser signed in to the account, each with its icon —
 * a monitor for a launcher, a phone or a globe for the web app — its name,
 * when it was last active, and the tags "This device", "Online" (a live
 * socket) and "Push on". **Sign out** ends another device's session there;
 * **Sign out of all other devices** keeps only this one. Signing this
 * browser out stays on the account screen.
 *
 * The device that was signed out learns at once when its socket is open
 * (close code 4401) and at its next request otherwise (`401`): the web app
 * forgets the account and opens the sign-in, which says the device was
 * signed out from another one; a launcher signs out on its next request.
 */
export function SessionsScreen() {
  return (
    <div className="flex max-w-[720px] flex-col px-16 pt-24 sm:px-40 sm:pt-32" data-testid="sessions-screen">
      {/* The top bar and the settings title name the screen already. */}
      <SessionsCard heading={false} />
    </div>
  );
}
