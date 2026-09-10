import { cn } from "../lib/format";

interface LogoProps {
  size?: number;
  className?: string;
}

/**
 * The JKNet mark: a saber inside a ring of four players.
 *
 * The mark is a raster, so it carries its own dark background and ignores the
 * text colour of whatever renders it. The rounded corner turns the square tile
 * into an app-icon shape instead of a stray rectangle on the near-black title
 * bar. Two files back the component: the 128 px one is enough up to a 64 px
 * box, above that the 256 px one keeps the saber sharp on a HiDPI display.
 */
export function Logo({ size = 20, className }: LogoProps) {
  const source = size > 64 ? "/brand/jknet-logo-256.png" : "/brand/jknet-logo-128.png";

  return (
    <img
      src={source}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={cn("select-none rounded-[22%]", className)}
    />
  );
}

/**
 * The previous geometric mark: a hexagon around a saber hilt.
 *
 * It stood in for the logo until the real one arrived and is kept in the tree
 * for now. Nothing renders it.
 */
export function LogoGlyph({ size = 20, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M16 4 L27 10.25 V22.75 L16 29 L5 22.75 V10.25 Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M16 10 V21"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.75"
      />
    </svg>
  );
}
