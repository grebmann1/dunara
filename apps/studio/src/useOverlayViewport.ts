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
      const height = visual?.height ?? innerHeight;
      const visualTop = visual?.offsetTop ?? 0;
      const keyboard = !!(visual && height < innerHeight - 1);
      const studioTop = keyboard ? 0 : Math.max(0, document.querySelector('.studio')?.getBoundingClientRect().top ?? 0);
      setViewport({ short: height < 600, style: { top: visualTop + studioTop, bottom: 'auto', height: Math.max(0, height - studioTop) } });
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
