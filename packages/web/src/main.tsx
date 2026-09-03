import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AdOverlay } from "./AdOverlay";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <AdOverlay />
  </StrictMode>,
);
