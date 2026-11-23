/**
 * CliBrandIcons — small brand-style marks for the AI CLIs, used by the DIRS
 * launcher to start a specific CLI in a directory. These are recognizable
 * approximations of the official logos rendered as inline SVG (Anthropic
 * sunburst, OpenAI blossom-knot) in their brand colors.
 */

interface IconProps {
  size?: number;
}

/** Claude — Anthropic sunburst (coral). */
export function ClaudeIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="#D97757" strokeWidth="2.1" strokeLinecap="round">
        <line x1="12" y1="3.5" x2="12" y2="20.5" />
        <line x1="3.5" y1="12" x2="20.5" y2="12" />
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="8.7" y1="4.3" x2="15.3" y2="19.7" />
        <line x1="19.7" y1="8.7" x2="4.3" y2="15.3" />
      </g>
    </svg>
  );
}

/** Codex — OpenAI blossom knot (three interlocking loops, OpenAI green). */
export function CodexIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="#10a37f" strokeWidth="1.5" fill="none">
        <ellipse cx="12" cy="12" rx="9" ry="3.7" />
        <ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(120 12 12)" />
      </g>
    </svg>
  );
}

/** OpenCode — a plain code-bracket mark (neutral grey: not the project's logo). */
export function OpenCodeIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4" stroke="#9aa4b2" strokeWidth="1.8" />
      <path d="M10 8.5 6.5 12l3.5 3.5M14 8.5l3.5 3.5-3.5 3.5" stroke="#9aa4b2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Antigravity CLI — an upward arrow leaving an orbit (Google blue: not the product's logo). */
export function AntigravityIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <ellipse cx="12" cy="16" rx="8.5" ry="3.5" stroke="#4285f4" strokeWidth="1.6" />
      <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" stroke="#4285f4" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
