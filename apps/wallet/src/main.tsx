import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ZkAuthProvider } from "@bwmx/algo-zkauth/react";
import { App } from "./App.tsx";
import "./styles.css";

// The wallet is an app of the service like any other ("wallet" in apps.json),
// registered for this page's origin; dApps reach it through connectWallet().
const service = import.meta.env.VITE_ZKAUTH_SERVICE ?? "http://localhost:8780";
const app = import.meta.env.VITE_ZKAUTH_APP ?? "wallet";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ZkAuthProvider service={service} app={app}>
      <App />
    </ZkAuthProvider>
  </StrictMode>,
);
