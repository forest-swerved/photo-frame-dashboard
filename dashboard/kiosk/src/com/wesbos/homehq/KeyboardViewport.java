package com.wesbos.homehq;

/** Geometry shared by the fullscreen keyboard workaround and its host regression checks. */
final class KeyboardViewport {
  private KeyboardViewport() {}

  static int contentHeight(int fullHeight, int screenTop, int visibleBottom,
      int minimumKeyboardHeight) {
    if (fullHeight <= 0) return 0;
    int available = visibleBottom - screenTop;
    // Ignore transient/empty window frames while Android is attaching or changing focus.
    if (available <= 0) return fullHeight;
    available = Math.min(available, fullHeight);
    // Status/navigation bars can briefly appear with immersive mode. They must not shrink the
    // dashboard. A keyboard hides substantially more of the window than those system bars.
    int keyboardThreshold = Math.max(minimumKeyboardHeight, fullHeight / 5);
    return fullHeight - available > keyboardThreshold ? available : fullHeight;
  }
}
