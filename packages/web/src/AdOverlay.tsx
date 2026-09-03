import { useEffect, useState } from "react";

// How long the page stays ad-free after the current ad is closed.
const AD_INTERVAL_MS = 10 * 60 * 1000;

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

// Interstitial ad shown on every page load/refresh and again every 10 minutes
// while the page stays open. Closing it reveals the app underneath. The ad
// unit is a Google AdSense responsive block; when the script is blocked
// (adblockers, offline LAN use) the box stays empty and the close button
// still works, so the app is never unreachable.
export function AdOverlay() {
  const [visible, setVisible] = useState(true);

  // Schedule the next showing 10 minutes after the current one is closed.
  useEffect(() => {
    if (visible) return;
    const timer = window.setTimeout(() => setVisible(true), AD_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  // Every showing renders a fresh <ins> element; AdSense fills it on push.
  // If the script never loaded this is a harmless no-op array push.
  useEffect(() => {
    if (!visible) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // ad script blocked or failed to load; close button still works
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="ad-overlay" role="dialog" aria-modal="true" aria-label="Advertisement">
      <div className="ad-card">
        <div className="ad-head">
          <span className="ad-label">Advertisement</span>
          <button className="ad-close" onClick={() => setVisible(false)} aria-label="Close ad">
            ✕
          </button>
        </div>
        <ins
          className="adsbygoogle"
          style={{ display: "block" }}
          data-ad-client="ca-pub-2467417149555465"
          data-ad-slot="1365730124"
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      </div>
    </div>
  );
}
