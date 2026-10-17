#!/usr/bin/env python3
"""Run navigation repair fakes and fullscreen keyboard viewport geometry on the host.

Requires Python 3 and a JDK on PATH. No Android device, SDK or third-party packages.
This checks settings and viewport sizes, not Android service binding, actual IME
window reports, focused-input scrolling or boot timing.
"""
from pathlib import Path
import subprocess
import tempfile


SOURCE = Path(__file__).resolve().parent / "src/com/wesbos/homehq/MainActivity.java"
KEYBOARD_SOURCE = SOURCE.with_name("KeyboardViewport.java")
text = SOURCE.read_text(encoding="utf-8")
start = text.index("  private void keepNavigationEnabled() {")
end = text.index("\n  private void openLauncher()", start)
method = text[start:end]

HARNESS = r'''
package com.wesbos.homehq;
import java.util.Objects;

class NavigationService { static boolean isConnected() { return true; } }
class Handler { void postDelayed(Runnable r, long delayMillis) {} }
class PackageManager { static final int PERMISSION_GRANTED = 0; }
class Log {
  static void i(String tag, String msg) {}
  static void w(String tag, String msg, Exception e) {}
}
class ComponentName {
  final String pkg, cls;
  ComponentName(NavigationHarness activity, Class<?> cls) {
    this(activity.getPackageName(), cls.getName());
  }
  ComponentName(String pkg, String cls) { this.pkg = pkg; this.cls = cls; }
  static ComponentName unflattenFromString(String value) {
    int slash = value.indexOf('/');
    if (slash < 0 || slash + 1 == value.length()) return null;
    String pkg = value.substring(0, slash), cls = value.substring(slash + 1);
    return new ComponentName(pkg, cls.startsWith(".") ? pkg + cls : cls);
  }
  public boolean equals(Object value) {
    if (!(value instanceof ComponentName)) return false;
    ComponentName other = (ComponentName) value;
    return pkg.equals(other.pkg) && cls.equals(other.cls);
  }
  public int hashCode() { return Objects.hash(pkg, cls); }
}
class Settings {
  static class Secure {
    static final String ENABLED_ACCESSIBILITY_SERVICES = "services";
    static final String ACCESSIBILITY_ENABLED = "master";
    static String services;
    static int master, reads, serviceWrites, masterWrites;
    static boolean refuseWrites;
    static String getString(Object resolver, String key) {
      reads++; return services;
    }
    static int getInt(Object resolver, String key, int fallback) {
      reads++; return master;
    }
    static boolean putString(Object resolver, String key, String value) {
      if (refuseWrites) throw new SecurityException("permission revoked");
      if (key.equals(ENABLED_ACCESSIBILITY_SERVICES)) {
        services = value; serviceWrites++;
      } else { master = Integer.parseInt(value); masterWrites++; }
      return true;
    }
  }
}
public class NavigationHarness {
  static final String TAG = "test";
  static final long NAV_CHECK_MS = 5000;
  static final long NAV_REBIND_MS = 1000;
  final Handler handler = new Handler();
  final Handler rebindHandler = new Handler();
  static final String OWN = "com.wesbos.homehq/com.wesbos.homehq.NavigationService";
  static final String SHORT = "com.wesbos.homehq/.NavigationService";
  static final String OTHER = "example.other/.NavigationService";
  int permission;
  int checkSelfPermission(String value) { return permission; }
  String getPackageName() { return "com.wesbos.homehq"; }
  Object getContentResolver() { return null; }

__METHOD__

  static void check(String name, String before, int master, int permission,
                    boolean refuseWrites, String after, int expectedMaster,
                    int serviceWrites, int masterWrites) {
    Settings.Secure.services = before;
    Settings.Secure.master = master;
    Settings.Secure.reads = Settings.Secure.serviceWrites = Settings.Secure.masterWrites = 0;
    Settings.Secure.refuseWrites = refuseWrites;
    NavigationHarness activity = new NavigationHarness();
    activity.permission = permission;
    activity.keepNavigationEnabled();
    if (!Objects.equals(after, Settings.Secure.services) ||
        expectedMaster != Settings.Secure.master ||
        serviceWrites != Settings.Secure.serviceWrites ||
        masterWrites != Settings.Secure.masterWrites ||
        (permission != 0 && Settings.Secure.reads != 0)) {
      throw new AssertionError(name);
    }
    System.out.println("PASS " + name);
  }
  static void viewport(String name, int fullHeight, int top, int bottom,
                       int minimumKeyboardHeight, int expected) {
    int actual = KeyboardViewport.contentHeight(fullHeight, top, bottom, minimumKeyboardHeight);
    if (actual != expected) throw new AssertionError(name + ": expected " + expected + ", got " + actual);
    System.out.println("PASS " + name);
  }
  public static void main(String[] args) {
    check("selected, master off", OWN, 0, 0, false, OWN, 1, 0, 1);
    check("short component, preserve other services", OTHER + ":" + SHORT, 0, 0,
          false, OTHER + ":" + SHORT, 1, 0, 1);
    check("selected, master already on", OWN, 1, 0, false, OWN, 1, 0, 0);
    check("absent, preserve other service", OTHER, 0, 0, false, OTHER + ":" + OWN, 1, 1, 1);
    check("absent, master already on", OTHER, 1, 0, false, OTHER + ":" + OWN, 1, 1, 0);
    check("null list", null, 0, 0, false, OWN, 1, 1, 1);
    check("empty list", "", 0, 0, false, OWN, 1, 1, 1);
    check("not granted or revoked before check", OWN, 0, -1, false, OWN, 0, 0, 0);
    check("permission lost before master write", OWN, 0, 0, true, OWN, 0, 0, 0);
    check("permission lost before list write", OTHER, 0, 0, true, OTHER, 0, 0, 0);
    // PF1007L 1280x800: opening, changing and dismissing the IME must expose the full
    // corresponding WebView viewport without accumulating the previous keyboard inset.
    viewport("frame full display", 800, 0, 800, 100, 800);
    viewport("frame keyboard opens", 800, 0, 400, 100, 400);
    viewport("keyboard suggestions change height", 800, 0, 360, 100, 360);
    viewport("keyboard closes to full display", 800, 0, 800, 100, 800);
    viewport("transient navigation bar is not keyboard", 800, 0, 752, 100, 800);
    viewport("nonzero decor origin uses screen coordinates", 800, 24, 424, 100, 400);
    viewport("Android already resized window is not resized twice", 400, 0, 400, 100, 400);
    viewport("empty focus-transition frame is ignored", 800, 0, 0, 100, 800);
    viewport("visible frame beyond window stays bounded", 800, 24, 1000, 100, 800);
    viewport("compact window keyboard still resizes", 400, 0, 250, 100, 250);
    viewport("higher density display uses supplied pixel threshold", 1600, 0, 800, 200, 800);
    viewport("unmeasured root waits for layout", 0, 0, 800, 100, 0);
  }
}
'''

with tempfile.TemporaryDirectory(prefix="homehq-navigation-") as directory:
    root = Path(directory)
    java = root / "NavigationHarness.java"
    java.write_text(HARNESS.replace("__METHOD__", method), encoding="utf-8")
    subprocess.run(["javac", "--release", "8", "-d", str(root), str(java), str(KEYBOARD_SOURCE)],
                   check=True, timeout=30)
    subprocess.run(["java", "-cp", str(root), "com.wesbos.homehq.NavigationHarness"],
                   check=True, timeout=30)
