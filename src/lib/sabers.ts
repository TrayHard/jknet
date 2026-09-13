// --- slice: skins and hilts ---
/**
 * The three shapes a lightsaber takes, and the profile values each one writes.
 *
 * The engine has no cvar for «what shape am I carrying». It has four values —
 * `saber1`, `saber2`, `color1`, `color2` — and the shape falls out of them,
 * which is exactly what the game's own menu does with its `ui_saber_type`:
 * `UI_UpdateSaberType` (`codemp/ui/ui_main.c:5343-5353` of OpenJK `1a6a6434`)
 * blanks `ui_saber2` for **single** and **staff** and leaves it alone for
 * **dual**, and `UI_UpdateSaberCvars` (`ui_main.c:5246-5260`) then copies the
 * four cvars out. The type itself is never stored: `UI_GetSaberCvars`
 * (`ui_main.c:5418-5429`) reads `saber1`, `saber2`, `color1` and `color2`
 * back and the line that would have restored `ui_saber_type` is commented out
 * (`ui_main.c:5420`).
 *
 * A player profile does the same and for the same reason — a stored shape
 * could disagree with the values under it, and then two fields would describe
 * one thing.
 *
 * ## Which colour paints which blade
 *
 * `CG_AddSaberBlade` picks the colour by the **hilt** number and never by the
 * blade number: `scolor = client->icolor1` for `saberNum == 0` and
 * `client->icolor2` for the second hilt (`codemp/cgame/cg_players.c:6130-6140`).
 * A staff is one hilt with `numBlades == 2`, so both of its blades take
 * `color1` and `color2` paints nothing at all. Two single hilts are two hilts,
 * so each takes a colour of its own. The game's own menu preview agrees
 * (`codemp/ui/ui_saber.c:356-365`).
 */
import { NO_SECOND_HILT, type SaberHilt } from "./ipc";

/**
 * The shape the player picks: one hilt, one double-bladed hilt, or two hilts.
 *
 * The words are the launcher's. The engine's own three are `single`, `staff`
 * and `dual` (`codemp/ui/ui_main.c:5279`, `:5286`, `:5348-5349`); **Duals** is
 * plural here because the control names what the player is holding and two
 * sabers are two of them.
 */
export type SaberMode = "single" | "staff" | "duals";

/** The three, in the order the control draws them. */
export const SABER_MODES: readonly SaberMode[] = ["single", "staff", "duals"];

export const DEFAULT_SINGLE_HILT = "Kyle";
export const DEFAULT_STAFF_HILT = "dual_1";

export function isVisibleHilt(id: string | null): id is string {
  return !!id && !/^(?:none|invisible)$/i.test(id);
}

/** The four profile fields the hilt control owns. */
export interface SaberValues {
  saber1: string | null;
  saber2: string | null;
  color1: number | null;
  color2: number | null;
}

/**
 * The `saberType` of a hilt this client offers, or `null` when the list has
 * never heard of it.
 *
 * `null` covers three cases that behave the same: no hilt at all, the value
 * `none` that means an empty second hand, and a hilt a mod once provided and
 * no longer does. None of the three says anything about a shape.
 */
export function hiltTypeOf(hilts: SaberHilt[], id: string | null): string | null {
  if (id === null || id === NO_SECOND_HILT) return null;
  return hilts.find((hilt) => hilt.id === id)?.saberType ?? null;
}

/**
 * Which shape a set of values reads as.
 *
 * A real hilt in the second hand is two hilts, whatever the first one is. With
 * the second hand empty, the shape is the shape of the first hilt. Everything
 * else — no hilt yet, a hilt the client no longer carries — reads as
 * **Single**, which is the shape a player who has picked nothing is in.
 */
export function saberModeOf(values: SaberValues, hilts: SaberHilt[]): SaberMode {
  if (isVisibleHilt(values.saber2)) return "duals";
  if (hiltTypeOf(hilts, values.saber1) === "staff" || /^dual_[1-5]$/i.test(values.saber1 ?? "")) return "staff";
  return "single";
}

/**
 * The hilts one mode offers.
 *
 * **Staff** is the double-bladed hilts, `SABER_STAFF` — in the retail archives
 * those are the five named `dual_1` … `dual_5`, where «dual» means two blades
 * and not two hilts. Both other modes offer the one-bladed `SABER_SINGLE`,
 * because **Duals** is two hilts of one blade each.
 *
 * The dozen other shapes of `saberType_t` (`codemp/game/bg_public.h:1501-1516`)
 * are story weapons — a dagger, a lance, a trident — and `notInMP` keeps every
 * retail one of them out of the list before this filter ever sees it. A mod
 * that ships such a shape is offered under **Single**: it is one hilt in one
 * hand, which is what that mode is.
 */
export function hiltsForMode(mode: SaberMode, hilts: SaberHilt[]): SaberHilt[] {
  return hilts.filter((hilt) => isVisibleHilt(hilt.id) && !/^invisible$/i.test(hilt.name)
    && (hilt.saberType === "staff") === (mode === "staff"));
}

/**
 * Whether this mode paints a second blade colour.
 *
 * Only two hilts do. A staff has two blades and one hilt, and the engine
 * colours by hilt.
 */
export function hasSecondBlade(mode: SaberMode): boolean {
  return mode === "duals";
}

/** Resolve every active hand and colour, including old unset profiles. */
export function saberValuesFor(mode: SaberMode, values: SaberValues, hilts: SaberHilt[]): SaberValues {
  const available = hiltsForMode(mode, hilts);
  const preferred = mode === "staff" ? DEFAULT_STAFF_HILT : DEFAULT_SINGLE_HILT;
  const fallback = available.find(h => h.id.toLowerCase() === preferred.toLowerCase())?.id
    ?? available[0]?.id ?? preferred;
  const kept = (id: string | null) => {
    if (!isVisibleHilt(id)) return fallback;
    const match = available.find(h => h.id.toLowerCase() === id.toLowerCase());
    if (match) return match.id;
    // A known wrong shape is replaced even while the catalog is loading.
    const staff = hiltTypeOf(hilts, id) === "staff" || /^dual_[1-5]$/i.test(id);
    if (staff !== (mode === "staff") || hilts.length) return fallback;
    return id;
  };
  const color = (n: number | null) => n !== null && Number.isInteger(n) && n >= 0 && n <= 5 ? n : 4;
  return {
    saber1: kept(values.saber1),
    saber2: mode === "duals" ? kept(values.saber2) : NO_SECOND_HILT,
    color1: color(values.color1),
    color2: mode === "duals" ? color(values.color2) : null,
  };
}
