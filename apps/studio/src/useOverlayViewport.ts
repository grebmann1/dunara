import { useLayoutEffect, useState, type CSSProperties } from 'react';

/** Mobile keyboards can resize the visual viewport without changing CSS viewport units. */
export function useOverlayViewport(active: boolean) {
  const [viewport, setViewport] = useState<{ style?: CSSProperties; short: boolean }>({ short: false });
  useLayoutEffect(() => {
    if (!active) { setViewport({ short: false }); return; }
    const visual = window.visualViewport;
    const measure = () => {
      // Leave pinch zoom to the browser rather than resizing the panel around it.
      if (visual && Math.abs(visual.scale - 1) > .01) { setViewport({ short: innerHeight < 600 }); return; }
      const inset = innerWidth <= 480 ? 0 : 8;
      const height = visual?.height ?? innerHeight;
      if (innerWidth > 760 && height >= 600 && height >= innerHeight - 1) { setViewport({ short: false }); return; }
      setViewport({ short: height < 600, style: { top: (visual?.offsetTop ?? 0) + inset, bottom: 'auto', height: Math.max(0, height - inset * 2) } });
    };
    measure();
    visual?.addEventListener('resize', measure);
    visual?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      visual?.removeEventListener('resize', measure);
      visual?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [active]);
  return viewport;
}
