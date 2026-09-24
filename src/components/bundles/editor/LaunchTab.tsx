import { useTranslation } from "react-i18next";

import type { DraftComponent, Engine } from "../../../lib/ipc";
import type { DraftActions } from "../../../lib/queries";
import { Input } from "../../ui";
import { ModeChecks } from "./ComponentsSection";
import { LIMITS } from "./draftModel";
import { Field, useCommitField } from "./fields";

/** What a mod folder may be called: one path segment, as the client field allows. */
const FS_GAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * --- slice: bundles ---
 *
 * **Launch** of a component: the mod folder, the arguments and the modes.
 *
 * The same three things the client window edits for a client, committed on
 * blur through `draft_update_component`. The modes are the ones of the engine
 * in the registry, and at least one stays ticked: a component with no mode
 * would make a client nothing can start.
 */
export function LaunchTab({
  component,
  engine,
  actions,
}: {
  component: DraftComponent;
  engine: Engine | undefined;
  actions: DraftActions;
}) {
  const { t } = useTranslation("bundles");
  const patch = (changes: Parameters<typeof actions.updateComponent.mutate>[0]["patch"]) =>
    actions.updateComponent.mutate({ componentId: component.id, patch: changes });

  const fsGame = useCommitField(
    component.fsGame ?? "",
    (value) => patch({ fsGame: value.trim() === "" ? null : value.trim() }),
    (value) => (value.trim() !== "" && !FS_GAME.test(value.trim()) ? t("editor.launch.invalidFsGame") : null),
  );
  const launchArgs = useCommitField(
    component.launchArgs,
    (value) => patch({ launchArgs: value.trim() }),
    (value) => ([...value].length > LIMITS.launchArgs ? t("editor.launch.invalidArgs") : null),
  );
  const engineModes = engine?.modes ?? component.modes;

  return (
    <div className="flex flex-col gap-12">
      <Field label={t("editor.launch.fsGame")} hint={t("editor.launch.fsGameHint")} problem={fsGame.problem} htmlFor="component-fs-game">
        <Input
          id="component-fs-game"
          value={fsGame.value}
          placeholder={engine?.defaultFsGame ?? "base"}
          invalid={fsGame.problem !== null}
          onChange={(event) => fsGame.onChange(event.target.value)}
          onBlur={fsGame.onBlur}
          className="max-w-[360px]"
        />
      </Field>
      <Field label={t("editor.launch.args")} hint={t("editor.launch.argsHint")} problem={launchArgs.problem} htmlFor="component-launch-args">
        <Input
          id="component-launch-args"
          value={launchArgs.value}
          placeholder={t("editor.launch.argsPlaceholder")}
          invalid={launchArgs.problem !== null}
          onChange={(event) => launchArgs.onChange(event.target.value)}
          onBlur={launchArgs.onBlur}
          className="font-mono"
        />
      </Field>
      <Field
        label={t("editor.components.modes")}
        hint={t("editor.launch.modesHint")}
        problem={component.modes.length === 0 ? t("editor.components.noModes") : null}
      >
        <ModeChecks
          engineModes={engineModes}
          modes={component.modes}
          disabled={actions.updateComponent.isPending}
          onChange={(modes) => {
            if (modes.length === 0) return;
            patch({ modes });
          }}
        />
      </Field>
    </div>
  );
}
