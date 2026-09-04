export const POPUNDER_SRC =
  "https://pl31181777.profitableratecpmnetwork.com/8f/5e/21/8f5e216465dae91bae1b29cdc9be0493.js";

export const BANNER_SRC =
  "https://pl31181840.profitableratecpmnetwork.com/4b7610120382ddb30f7aadbd0b8e2a42/invoke.js";

export function loadExternalScript(src: string, id: string, attrs: Record<string, string> = {}) {
  if (document.getElementById(id)) return;
  const s = document.createElement("script");
  s.id = id;
  s.src = src;
  s.async = true;
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  document.body.appendChild(s);
}

export function reloadExternalScript(src: string, id: string, attrs: Record<string, string> = {}) {
  document.getElementById(id)?.remove();
  const s = document.createElement("script");
  s.id = id;
  s.src = src;
  s.async = true;
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  document.body.appendChild(s);
}

const POPUNDER_ID = "popunder-js";

let popunderInjected = false;
let originalOpen: typeof window.open | null = null;
let overlayObserver: MutationObserver | null = null;

const blockedOpen = (() => null) as unknown as typeof window.open;

export function ensurePopunder() {
  stopSuppressingPopunder();
  if (popunderInjected || document.getElementById(POPUNDER_ID)) return;
  popunderInjected = true;
  const s = document.createElement("script");
  s.id = POPUNDER_ID;
  s.src = POPUNDER_SRC;
  s.async = true;
  document.body.appendChild(s);
}

export function suppressPopunder() {
  if (window.open !== blockedOpen) {
    if (!originalOpen) originalOpen = window.open;
    window.open = blockedOpen;
  }
  stripPopunderOverlays();
  if (!overlayObserver) {
    overlayObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n instanceof HTMLElement) {
            if (isPopunderOverlay(n)) {
              n.remove();
            } else {
              n.querySelectorAll("*").forEach((el) => {
                if (isPopunderOverlay(el as HTMLElement)) (el as HTMLElement).remove();
              });
            }
          }
        });
      }
    });
    overlayObserver.observe(document.body, { childList: true, subtree: true });
  }
}

export function stopSuppressingPopunder() {
  if (originalOpen) {
    window.open = originalOpen;
    originalOpen = null;
  }
  overlayObserver?.disconnect();
  overlayObserver = null;
}

function isPopunderOverlay(el: HTMLElement): boolean {
  const hay = `${el.id} ${typeof el.className === "string" ? el.className : ""}`;
  if (/popunder|pl_general|transplayer/i.test(hay)) return true;
  const z = Number.parseInt(el.style?.zIndex ?? "", 10);
  if (
    el.style?.position === "fixed" &&
    Number.isFinite(z) &&
    z >= 1000 &&
    (el.style.backgroundImage.includes("data:image/gif") ||
      el.style.backgroundImage.includes("base64"))
  ) {
    return true;
  }
  return false;
}

function stripPopunderOverlays() {
  document.body.querySelectorAll("*").forEach((el) => {
    if (isPopunderOverlay(el as HTMLElement)) (el as HTMLElement).remove();
  });
}
