/**
 * Config templates built on `vstr`. They live apart from `configScript.ts` so
 * the unit tests can load them without the JSON catalog that file imports.
 * Default binds they overwrite (JA `jampconfig.cfg`): F5 `force_heal`, F7
 * `force_absorb`, F8 `force_distract`; the menu gives 1–5 back their
 * `weapon N` binds when it closes.
 */
export const CHAIN_TEMPLATES = {
  cycle:
    '// Two-state toggle with vstr\nset view_on "set cg_drawGun 1; set view_toggle vstr view_off"\nset view_off "set cg_drawGun 0; set view_toggle vstr view_on"\nset view_toggle "vstr view_off"\nbind F7 "vstr view_toggle"\n',
  cycle3:
    '// Three-state cycle with vstr: each F8 press picks the next crosshair size\nset crosshair_1 "set cg_crosshairSize 16; echo ^3Crosshair 16; set crosshair_cycle vstr crosshair_2"\nset crosshair_2 "set cg_crosshairSize 24; echo ^3Crosshair 24; set crosshair_cycle vstr crosshair_3"\nset crosshair_3 "set cg_crosshairSize 32; echo ^3Crosshair 32; set crosshair_cycle vstr crosshair_1"\nset crosshair_cycle "vstr crosshair_1"\nbind F8 "vstr crosshair_cycle"\n',
  menu:
    '// Menu with vstr: F5 opens it, 1-3 use a force power, 4 opens taunts, 5 or F5 closes it\nset menu_open "echo ^3Menu: 1 heal 2 protect 3 absorb 4 taunts 5 close; bind 1 vstr menu_heal; bind 2 vstr menu_protect; bind 3 vstr menu_absorb; bind 4 vstr menu_taunts; bind 5 vstr menu_close; bind F5 vstr menu_close"\nset menu_close "bind 1 weapon 1; bind 2 weapon 2; bind 3 weapon 3; bind 4 weapon 4; bind 5 weapon 5; bind F5 vstr menu_open"\nset menu_heal "force_heal; vstr menu_close"\nset menu_protect "force_protect; vstr menu_close"\nset menu_absorb "force_absorb; vstr menu_close"\nset menu_taunts "echo ^3Taunts: 1 bow 2 meditate 3 flourish 4 back; bind 1 vstr taunt_bow; bind 2 vstr taunt_meditate; bind 3 vstr taunt_flourish; bind 4 vstr menu_open"\nset taunt_bow "bow; vstr menu_close"\nset taunt_meditate "meditate; vstr menu_close"\nset taunt_flourish "flourish; vstr menu_close"\nbind F5 "vstr menu_open"\n',
} as const;
