export const BANNER_SRC =
  "https://pl31181840.profitableratecpmnetwork.com/4b7610120382ddb30f7aadbd0b8e2a42/invoke.js";

export function reloadExternalScript(src: string, id: string, attrs: Record<string, string> = {}) {
  document.getElementById(id)?.remove();
  const s = document.createElement("script");
  s.id = id;
  s.src = src;
  s.async = true;
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  document.body.appendChild(s);
}
