// src/components/BrandMark.tsx — the brand mark (lib/brandMark): the pixel-art bot on the inverted
// tile. Decorative: it stands beside the product name. The sprite is a 12 × 12 grid, so the
// sizes are 24 and 36 px only (2 or 3 whole screen pixels per cell). Do not scale it with CSS.
import { MARK_GRID, markPath } from "../lib/brandMark";

const PATH = markPath();

export function BrandMark({ size = 24 }: { size?: 24 | 36 }) {
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${MARK_GRID} ${MARK_GRID}`} shapeRendering="crispEdges" aria-hidden focusable="false"
      style={{ flex: "none", display: "block", borderRadius: "25%", background: "var(--inv)" }}
    >
      <path fill="var(--inv-ink)" d={PATH} />
    </svg>
  );
}
