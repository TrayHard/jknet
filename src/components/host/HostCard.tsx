import { LoaderCircle, Square, Swords } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import { useHostSession, useStopHost } from "../../lib/queries";
import { Button } from "../ui";
import { StopServerDialog } from "./HostDialogs";
import { currentStep, hostView, humanCount, isHostLive, secondsSince } from "./hostModel";
import { useNow } from "./useNow";

/**
 * The HostCard of the design: **Play with friends** on the Home screen,
 * between the hero and the server blocks.
 *
 * Idle, it is the way in: **Host a game** opens the screen. While a server
 * starts it names the current step, and while it runs it says what runs and
 * offers **Open** and **Stop**, so a player who came back to Home does not
 * forget the server behind the game they are about to start.
 */
export function HostCard({ className }: { className?: string }) {
  const { t } = useTranslation("host");
  const navigate = useNavigate();
  const format = useFormat();
  const session = useHostSession().data ?? null;
  const stop = useStopHost();
  const [confirming, setConfirming] = useState(false);

  const view = hostView(session);
  const live = isHostLive(session);
  const now = useNow(1000, live);
  const open = () => void navigate("/host");

  if (!live) {
    return (
      <section
        className={cn(
          "flex items-center gap-16 rounded-lg border border-line-accent bg-accent-subtle p-16",
          className,
        )}
      >
        <Glyph tone="accent">
          <Swords size={20} />
        </Glyph>
        <Text title={t("home.idle.title")} text={t("home.idle.text")} />
        <Button icon={<Swords size={16} />} onClick={open} className="shrink-0">
          {t("home.idle.action")}
        </Button>
      </section>
    );
  }

  const shell = cn(
    "flex items-center gap-16 rounded-lg border border-line bg-surface p-16",
    className,
  );

  if (view === "starting") {
    const step = currentStep(session);
    const stepText =
      step === "server"
        ? t("starting.steps.server")
        : step === "map"
          ? t("starting.steps.map", { map: session.settings.map })
          : step === "relay"
            ? t("starting.steps.relay")
            : t("starting.steps.ready");
    return (
      <section className={shell}>
        <Glyph tone="accent">
          <LoaderCircle size={20} className="animate-spin" />
        </Glyph>
        <Text title={t("home.starting.title")} text={stepText} />
        <Button onClick={open} className="shrink-0">
          {t("home.open")}
        </Button>
      </section>
    );
  }

  const humans = humanCount(session.players);
  const stopping = stop.isPending || session.status === "stopping";
  const ran = secondsSince(session.readyAt ?? session.startedAt, now) ?? 0;

  return (
    <section className={shell}>
      <Glyph tone="success">
        <Swords size={20} />
      </Glyph>
      <Text
        title={t("home.running.title")}
        text={t("home.running.text", {
          map: session.settings.map,
          players: humans,
          max: session.settings.maxPlayers,
          duration: format.elapsed(ran),
        })}
      />
      <div className="flex items-center gap-8 shrink-0">
        <Button onClick={open}>{t("home.open")}</Button>
        <Button
          icon={<Square size={16} />}
          disabled={stopping}
          onClick={() => {
            if (humans > 0) setConfirming(true);
            else stop.mutate();
          }}
        >
          {stopping ? t("starting.stopping") : t("home.stop")}
        </Button>
      </div>
      {confirming ? (
        <StopServerDialog
          players={humans}
          stopping={stop.isPending}
          onClose={() => setConfirming(false)}
          onStop={() => stop.mutate(undefined, { onSettled: () => setConfirming(false) })}
        />
      ) : null}
    </section>
  );
}

/** The 40 px square with the icon of the card's state. */
function Glyph({ tone, children }: { tone: "accent" | "success"; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex items-center justify-center size-40 shrink-0 rounded-md",
        tone === "success" ? "bg-success-subtle text-fg-success" : "bg-accent-subtle text-fg-accent",
      )}
    >
      {children}
    </span>
  );
}

/** The title and the line under it. */
function Text({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex-1 min-w-0 flex flex-col gap-2">
      <h2 className="text-heading-sm text-fg">{title}</h2>
      <p className="text-body-sm text-fg-secondary truncate" title={text}>
        {text}
      </p>
    </div>
  );
}
