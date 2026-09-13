import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { KEY_ROWS, SYSTEM_KEYS, NAV_KEYS, NUMPAD_KEYS, MOUSE_KEYS, browserGameKey, type GameKey } from "../lib/gameKeys";
import type { EffectiveBind } from "../lib/quakeConfig";
import { Button, Badge } from "./ui";
import "./BindKeyboard.css";

export function BindKeyboard({ value, bindings, onChange }: {
  value: string;
  bindings: EffectiveBind[];
  onChange: (key: string) => void;
}) {
  const { t } = useTranslation("common");
  const [recording, setRecording] = useState(false);
  const bound = new Map(bindings.map(b => [b.key, b]));
  const draw = (key: GameKey, index: number, style?: CSSProperties) => {
    const binding = bound.get(key.token);
    const description = key.reserved ? t("configStudio.reserved") : binding ? `${binding.command} · ${binding.source}` : t("configStudio.free");
    return <button key={`${key.token}-${index}`} type="button" disabled={key.reserved}
      data-game-key={key.token} data-binding={binding?.kind ?? "free"}
      aria-pressed={value === key.token} aria-label={`${key.label}: ${description}`} title={description}
      style={{ "--key-width": key.width ?? 1, ...style } as CSSProperties}
      className="bind-key" onClick={() => onChange(key.token)}>
      <span className="bind-key-label">{key.label}</span>
      {binding && <span className="bind-key-mark" aria-hidden="true" />}
    </button>;
  };
  return <div className="flex flex-col gap-12" onKeyDownCapture={e => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code === "Escape") { setRecording(false); return; }
    const key = browserGameKey(e.code);
    if (key) { onChange(key); setRecording(false); }
  }}>
    <div className="flex items-center flex-wrap gap-8">
      <Badge tone="accent">{t("configStudio.occupied", { count: bindings.length })}</Badge>
      <span className="text-body-xs text-fg-muted">{t("configStudio.keyboardHint")}</span>
      <Button className="ml-auto" size="sm" variant={recording ? "primary" : "secondary"}
        onClick={() => setRecording(v => !v)}>{t(recording ? "configStudio.pressKey" : "configStudio.recordKey")}</Button>
    </div>
    <div className="bind-keyboard-scroll" tabIndex={0} role="region" aria-label={t("configStudio.keyboard")}>
      <div className="bind-keyboard">
        <div className="bind-keyboard-main">
          <div className="bind-function-row">{KEY_ROWS[0].map((key, i) => draw(key, i, { gridColumn: i === 0 ? "1 / span 4" : `${9 + (i - 1) * 4 + Math.floor((i - 1) / 4) * 2} / span 4` }))}</div>
          {KEY_ROWS.slice(1).map((row, i) => <div className="bind-key-row" key={i}>{row.map((key, j) => draw(key, j))}</div>)}
        </div>
        <div className="bind-keyboard-navigation">
          <div className="bind-system-row">{SYSTEM_KEYS.map((key, i) => draw(key, i))}</div>
          <div className="bind-navigation-grid">{NAV_KEYS.slice(0, 6).map((key, i) => draw(key, i))}</div>
          <div className="bind-arrow-grid">{NAV_KEYS.slice(6).map((key, i) => draw(key, i, { gridColumn: [1, 2, 2, 3][i], gridRow: i === 1 ? 1 : 2 }))}</div>
        </div>
        <div className="bind-numpad">
          <div className="bind-numpad-title" aria-hidden="true">{t("configStudio.numpad")}</div>
          <div className="bind-numpad-grid">{NUMPAD_KEYS.map((key, i) => draw(key, i,
            key.token === "KP_PLUS" ? { gridColumn: 4, gridRow: "2 / span 2" } :
            key.token === "KP_ENTER" ? { gridColumn: 4, gridRow: "4 / span 2" } :
            key.token === "KP_INS" ? { gridColumn: "1 / span 2" } : undefined))}</div>
        </div>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-16 text-body-xs text-fg-secondary">
      {(["inherited", "edited", "layer", "free"] as const).map(kind => <span className="bind-legend" key={kind}><i data-kind={kind} />{t(`configStudio.key_${kind}`)}</span>)}
      <span className="ml-auto text-fg-muted">{t("configStudio.sharedModifiers")}</span>
    </div>
    <div className="bind-mouse-row"><span className="text-body-sm text-fg-secondary">{t("configStudio.mouse")}</span>{MOUSE_KEYS.map((key, i) => draw(key, i))}</div>
  </div>;
}
