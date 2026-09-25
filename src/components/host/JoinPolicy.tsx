import { useId } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type { Friend, HostJoinPolicy } from "../../lib/ipc";
import { CheckboxBox, RadioRing } from "./Choice";
import { toggleId } from "./hostModel";

interface JoinPolicyProps {
  policy: HostJoinPolicy;
  /** Friends who join without an invite under **Friends I choose**. */
  joinUserIds: string[];
  /** Everybody the checklist offers, in the order of the panel. */
  friends: Friend[];
  onChange: (policy: HostJoinPolicy, joinUserIds: string[]) => void;
  /** Off without a JKNet Online account: nobody could be told the password. */
  disabled?: boolean;
}

const OPTIONS: HostJoinPolicy[] = ["friends", "selected", "invite"];

/**
 * **Who can join without an invite**: the JoinPolicy of the design.
 *
 * Three radios, and under **Friends I choose** the checklist of friends. The
 * same block sits in the panel before the start and while the server runs:
 * before, it fills the form; while running, every change goes to the core at
 * once and the presence of the host follows. An invite opens the server to
 * the friend it names whatever is chosen here.
 */
export function JoinPolicy({
  policy,
  joinUserIds,
  friends,
  onChange,
  disabled = false,
}: JoinPolicyProps) {
  const { t } = useTranslation("host");
  const name = useId();
  const labelId = `${name}-label`;

  return (
    <div className={cn("flex flex-col gap-8", disabled && "opacity-60")}>
      <span id={labelId} className="text-label-xs text-fg-muted">
        {t("policy.label")}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-6">
        {OPTIONS.map((option) => {
          const checked = policy === option;
          return (
            <div key={option} className="flex flex-col gap-6">
              <label
                className={cn(
                  "flex items-center gap-8 select-none",
                  disabled ? "cursor-not-allowed" : "cursor-pointer",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange(option, joinUserIds)}
                  className="peer sr-only"
                />
                <RadioRing checked={checked} />
                <span
                  className={cn(
                    "text-body-sm",
                    checked ? "text-fg" : "text-fg-secondary",
                  )}
                >
                  {t(`policy.${option}`)}
                </span>
              </label>
              {option === "selected" && checked ? (
                <div className="flex flex-col gap-4 pl-24">
                  {friends.length === 0 ? (
                    <span className="text-body-sm text-fg-muted">{t("policy.noFriends")}</span>
                  ) : (
                    friends.map((friend) => {
                      const on = joinUserIds.includes(friend.user.id);
                      return (
                        <label
                          key={friend.user.id}
                          className={cn(
                            "flex items-center gap-8 min-w-0 select-none",
                            disabled ? "cursor-not-allowed" : "cursor-pointer",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={disabled}
                            onChange={() =>
                              onChange("selected", toggleId(joinUserIds, friend.user.id))
                            }
                            className="peer sr-only"
                          />
                          <CheckboxBox checked={on} />
                          <span className="text-body-sm text-fg truncate">
                            {friend.user.displayName}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="text-body-sm text-fg-muted">{t("policy.hint")}</p>
    </div>
  );
}
