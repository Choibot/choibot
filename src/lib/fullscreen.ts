type FullscreenTarget = Element & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

// Safari used the prefixed method before it implemented the standard API.
// Return false when fullscreen is unavailable or the browser rejects it.
export async function requestElementFullscreen(element: Element | null): Promise<boolean> {
  if (!element) return false;
  const target = element as FullscreenTarget;
  try {
    if (target.requestFullscreen) await target.requestFullscreen();
    else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
    else return false;
    return true;
  } catch {
    return false;
  }
}
