import { AudioLines, Bot, Box, Crosshair, Map, Music, Rocket, Sword, UserRound, UsersRound } from "lucide-react";

const icons = {
  skin: UserRound, skins: UsersRound, hilt: Sword, sabers: Sword, weapon: Crosshair, guns: Crosshair,
  npc: Bot, npcs: Bot, vehicle: Rocket, vehicles: Rocket, music: Music, audio: AudioLines, sound: AudioLines,
  map: Map, maps: Map, singlePlayer: UserRound,
};

export function LibraryObjectIcon({ kind, size = 16, className = "" }: { kind: string; size?: number; className?: string }) {
  const Icon = icons[kind as keyof typeof icons] ?? Box;
  return <Icon size={size} aria-hidden="true" className={`shrink-0 ${className}`} />;
}
