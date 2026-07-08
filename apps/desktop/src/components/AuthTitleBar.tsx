import { TrayMenu } from "./TrayMenu";

/**
 * AuthTitleBar — the custom (Overlay) window title bar for the auth / onboarding
 * surfaces: the app name centered and the tray menu pinned to the right. The
 * native macOS traffic lights overlay the left. "BiBoTracking" is the brand and
 * stays verbatim in every locale.
 *
 * Intentionally NOT a drag region on these screens — the welcome / sign-in /
 * onboarding window can't be dragged around (BRI-22).
 */
export function AuthTitleBar() {
  return (
    <div className="welcome-titlebar">
      <span className="welcome-titlebar-title">BiBoTracking</span>
      <TrayMenu />
    </div>
  );
}
