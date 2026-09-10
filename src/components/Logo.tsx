interface LogoProps {
  size?: number;
  className?: string;
}

/**
 * The JKNet glyph: a hexagon around a saber hilt. Placeholder until the final
 * mark exists — the design file still lists it as unfinished.
 */
export function Logo({ size = 20, className }: LogoProps) {
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
