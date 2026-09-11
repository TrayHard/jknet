import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, Check, Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useEngines } from "../lib/queries";
import { isTauri } from "../lib/runtime";
import { useAppUpdateContext } from "./AppUpdateProvider";
import { Button } from "./ui";

/** The license the launcher is released under, as GitHub renders it. */
const LICENSE_URL = "https://github.com/TrayHard/jknet/blob/main/LICENSE";

/** Opens a link in the system browser, and says nothing when it cannot. */
function openExternal(url: string) {
  if (!isTauri()) return;
  void openUrl(url).catch(() => undefined);
}

/**
 * The About card at the bottom of Settings: which build is running and
 * whether a newer one exists.
 *
 * The card shares the state of `AppUpdateProvider`, so **Check for updates**
 * and the toast in the corner never disagree about what was found. Unlike the
 * check at startup, this one shows its failure: the player pressed a button
 * and is owed an answer.
 */
export function AboutCard() {
  const { t } = useTranslation("settings");
  const update = useAppUpdateContext();

  const version = update?.currentVersion ?? null;
  const newVersion = update?.newVersion ?? null;
  const supported = update?.supported ?? false;

  return (
    <section className="rounded-lg border border-line bg-surface p-16 mb-24">
      <h2 className="text-heading-sm text-fg pb-4">{t("about.title")}</h2>
      <div className="flex items-start gap-16">
        <div className="flex-1 min-w-0">
          <p className="text-body-sm text-fg-secondary pb-8">{t("about.text")}</p>
          <p className="text-mono-sm text-fg">
            {version !== null
              ? t("about.version", { version })
              : supported
                ? t("about.version", { version: "…" })
                : t("about.versionUnknown")}
          </p>
          <UpdateLine />
          <p className="text-body-sm text-fg-muted pt-8">
            <button
              type="button"
              // A failed open is swallowed: the line is a pointer, and the card
              // already owes the player an answer about updates, not about the
              // browser.
              onClick={() => openExternal(LICENSE_URL)}
              className="cursor-pointer hover:text-fg-accent hover:underline"
            >
              {t("about.license")}
            </button>
          </p>
          <EngineIconCredits />
        </div>
        {newVersion !== null ? (
          <Button
            variant="primary"
            icon={<Download size={16} />}
            disabled={update?.busy ?? true}
            onClick={update?.install}
          >
            {t("about.install")}
          </Button>
        ) : (
          <Button
            icon={
              <RefreshCw
                size={16}
                className={update?.stage === "checking" ? "animate-spin" : undefined}
              />
            }
            disabled={!supported || (update?.busy ?? true)}
            onClick={update?.check}
          >
            {t("about.check")}
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * Who the engine icons belong to.
 *
 * Built from the registry rather than written out: a build added to
 * `src-tauri/src/engines.rs` brings its own name, its own repository link and,
 * where the project names one, the author it credits for the icon. A credit
 * list that has to be edited by hand is a credit list that goes out of date.
 */
function EngineIconCredits() {
  const { t } = useTranslation("settings");
  const engines = useEngines();
  const list = engines.data ?? [];
  if (list.length === 0) return null;

  return (
    <p className="text-body-sm text-fg-muted pt-8">
      {t("about.engineIcons")}{" "}
      {list.map((engine, index) => (
        <span key={engine.id}>
          {index > 0 ? ", " : ""}
          <button
            type="button"
            onClick={() => openExternal(engine.repoUrl)}
            className="cursor-pointer hover:text-fg-accent hover:underline"
          >
            {engine.name}
          </button>
          {engine.iconCredit !== null
            ? ` (${t("about.engineIconBy", { author: engine.iconCredit })})`
            : ""}
        </span>
      ))}
      {"."}
    </p>
  );
}

/** The one line under the version: what the last check said. */
function UpdateLine() {
  const { t } = useTranslation("update");
  const update = useAppUpdateContext();
  if (!update) return null;

  if (!update.supported) {
    return <p className="text-body-sm text-fg-muted pt-8">{t("unsupported")}</p>;
  }

  if (update.stage === "error" && update.error !== null) {
    return (
      <p className="flex items-start gap-6 text-body-sm text-fg-danger pt-8">
        <AlertTriangle size={14} className="shrink-0 mt-2" />
        <span>{update.error}</span>
      </p>
    );
  }

  if (update.newVersion !== null) {
    return (
      <p className="text-body-sm text-fg-accent pt-8">
        {t("available", { version: update.newVersion })}
      </p>
    );
  }

  if (update.stage === "checking") {
    return <p className="text-body-sm text-fg-muted pt-8">{t("checking")}</p>;
  }

  // Before the first answer comes back the card says nothing. "You are up to
  // date" is a claim, and no check has been made yet that could support it.
  if (update.checkedAt === null) return null;

  return (
    <p className="flex items-center gap-6 text-body-sm text-fg-muted pt-8">
      <Check size={14} className="text-fg-success shrink-0" />
      <span>{t("upToDate")}</span>
    </p>
  );
}
