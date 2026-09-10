import { FolderSearch } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { cn } from "../lib/format";
import { hasGameFiles, useActiveGame, useGameNames } from "../lib/game";
import { useSettings } from "../lib/queries";
import { Button } from "./ui";

/**
 * The calm line a screen shows when the active game has no folder yet.
 *
 * Switching to Jedi Outcast on a machine that has only ever run Jedi Academy is
 * an ordinary thing to do, not a failure: nothing broke, the launcher simply
 * has not been told where the archives are. So this is a notice with a button
 * and not an error toast — the same reason the Clients screen says «Not set»
 * rather than refusing to draw.
 *
 * The button opens Settings, where both games have a row of their own. Sending
 * the player through the first-run steps again would ask about a client and an
 * account they already have.
 *
 * Renders nothing at all while the folder is on file, or while the settings are
 * still loading: a notice that flashes on every navigation is worse than none.
 */
export function GameFilesNotice({ className }: { className?: string }) {
  const { t } = useTranslation("home");
  const navigate = useNavigate();
  const settings = useSettings();
  const game = useActiveGame();
  const { label } = useGameNames();

  if (settings.data === undefined || hasGameFiles(settings.data, game)) {
    return null;
  }

  return (
    <section
      className={cn(
        "flex items-center gap-12 rounded-lg border border-line bg-surface p-16",
        className,
      )}
    >
      <span className="flex items-center justify-center size-36 rounded-md bg-elevated text-fg-secondary shrink-0">
        <FolderSearch size={20} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-body-md-medium text-fg">
          {t("gameFiles.title", { game: label(game) })}
        </p>
        <p className="text-body-sm text-fg-secondary pt-2">
          <Trans
            t={t}
            i18nKey="gameFiles.text"
            components={[<span className="text-mono-sm" />]}
          />
        </p>
      </div>
      <Button className="shrink-0" onClick={() => void navigate("/settings")}>
        {t("gameFiles.locate")}
      </Button>
    </section>
  );
}
