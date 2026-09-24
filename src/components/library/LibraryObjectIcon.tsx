import {
  AudioLines, Bot, Box, Braces, Crosshair, File, Film, Flame, Image as ImageIcon, Images, Languages, LayoutDashboard, LayoutTemplate,
  Map, Mountain, Music, Presentation, Rocket, ScrollText, Settings2, Shapes, SquareStack, Sword, Table2, Type, UserRound, UsersRound,
} from "lucide-react";

const icons = {
  skin: UserRound, skins: UsersRound, hilt: Sword, sabers: Sword, weapon: Crosshair, guns: Crosshair,
  npc: Bot, npcs: Bot, vehicle: Rocket, vehicles: Rocket, music: Music, audio: AudioLines, sound: AudioLines,
  map: Map, maps: Map, singlePlayer: UserRound,
  // --- slice: pk3 contents --- the groups of the archive by the pk3 taxonomy.
  levelshot: Mountain, splash: Presentation, menuImage: Images, hudImage: LayoutDashboard, texture: SquareStack, icon: Shapes, image: ImageIcon,
  font: Type, strings: Languages, shader: Braces, effect: Flame, menu: LayoutTemplate, config: Settings2, data: Table2,
  script: ScrollText, video: Film, other: File,
};

export function LibraryObjectIcon({ kind, size = 16, className = "" }: { kind: string; size?: number; className?: string }) {
  const Icon = icons[kind as keyof typeof icons] ?? Box;
  return <Icon size={size} aria-hidden="true" className={`shrink-0 ${className}`} />;
}
