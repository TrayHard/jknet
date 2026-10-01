import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Dialog, Input, Select } from "../ui";
import { Notice } from "./bits";
import { useFailureText } from "./errors";
import { GAME_NAMES } from "./format";
import { useCommunityApi, useCommunityPlatform, type CommunitySeed } from "./platform";
import type { Game } from "./types";
import { useAction } from "./useRemote";

/** `IPv4:port`, the shape the service accepts before it checks the address is public. */
const ADDRESS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{2,5})$/;

function addressFits(value: string): boolean {
  const match = ADDRESS.exec(value.trim());
  if (match === null) return false;
  const octets = match.slice(1, 5).map(Number);
  const port = Number(match[5]);
  return octets.every((octet) => octet <= 255) && port >= 1024 && port <= 65535;
}

/**
 * **Create community**: a community starts with its first server. An
 * address the service already knows answers with its community, which opens
 * instead; a new one opens as well, and waits for its owner to prove the
 * server before it enters the catalogue.
 */
export function CreateDialog({ seed, onClose }: { seed?: CommunitySeed; onClose: () => void }) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const api = useCommunityApi();
  const failure = useFailureText();
  const action = useAction();
  const id = useId();
  const [name, setName] = useState(seed?.name ?? "");
  const [address, setAddress] = useState(seed?.address ?? "");
  const [game, setGame] = useState<Game>(seed?.game ?? platform.game ?? "ja");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    if (!platform.signedIn) {
      platform.signIn();
      return;
    }
    if (!addressFits(address)) {
      setError(t("create.invalidAddress"));
      return;
    }
    void action.run(
      async () => {
        const created = await api.create({
          name: name.trim(),
          game,
          address: address.trim(),
          ...(label.trim() !== "" ? { label: label.trim() } : {}),
        });
        onClose();
        platform.navigate({ view: "community", id: created.community.id, tab: "overview" });
      },
      (reason) => setError(failure(reason)),
    );
  };

  return (
    <Dialog
      title={t("create.title")}
      body={t("create.body")}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" wrap disabled={action.busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" wrap disabled={action.busy || name.trim() === "" || address.trim() === ""} onClick={submit}>
            {t("create.submit")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-16 pt-16"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-6">
          <label htmlFor={`${id}-name`} className="text-body-sm-medium text-fg">
            {t("create.name")}
          </label>
          <Input id={`${id}-name`} autoFocus required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="flex flex-col gap-6">
          <label htmlFor={`${id}-address`} className="text-body-sm-medium text-fg">
            {t("create.address")}
          </label>
          <Input
            id={`${id}-address`}
            required
            inputMode="decimal"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            aria-describedby={`${id}-address-hint`}
          />
          <p id={`${id}-address-hint`} className="text-body-sm text-fg-secondary">
            {t("create.addressHint")}
          </p>
        </div>
        <div className="flex flex-col gap-6">
          <span className="text-body-sm-medium text-fg">{t("create.game")}</span>
          <Select
            value={game}
            onChange={(value) => setGame(value === "jo" ? "jo" : "ja")}
            ariaLabel={t("create.game")}
            options={[
              { value: "ja", label: GAME_NAMES.ja },
              { value: "jo", label: GAME_NAMES.jo },
            ]}
          />
        </div>
        <div className="flex flex-col gap-6">
          <label htmlFor={`${id}-label`} className="text-body-sm-medium text-fg">
            {t("create.label")}
          </label>
          <Input id={`${id}-label`} maxLength={40} value={label} onChange={(event) => setLabel(event.target.value)} aria-describedby={`${id}-label-hint`} />
          <p id={`${id}-label-hint`} className="text-body-sm text-fg-secondary">
            {t("create.labelHint")}
          </p>
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
