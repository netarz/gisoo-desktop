/**
 * Preact 11 sets a numeric style value as it is, so `width: 12` is dropped by the browser (only a bare
 * 0 is valid without a unit). The shell's inline styles are written with numbers, the React way; this
 * hook adds "px" to them before Preact sees the vnode. Unitless properties keep their numbers.
 */
import { options } from 'preact';

const UNITLESS = /^(flex|flexGrow|flexShrink|fontWeight|lineHeight|opacity|order|zIndex|zoom|gridRow|gridColumn|aspectRatio|animationIterationCount)$/;

const prev = options.vnode;
options.vnode = (vnode) => {
  const props = vnode.props as { style?: unknown } | null;
  const style = props?.style;
  if (style && typeof style === 'object') {
    let fixed: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
      if (typeof value !== 'number' || value === 0 || key.startsWith('--') || UNITLESS.test(key)) continue;
      fixed ??= { ...(style as Record<string, unknown>) };
      fixed[key] = `${value}px`;
    }
    if (fixed) props!.style = fixed;
  }
  prev?.(vnode);
};
