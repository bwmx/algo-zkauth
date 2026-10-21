import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ZkAuthProvider } from "@algozkauth/sdk/react";
import { App } from "./App.tsx";
import "./styles.css";

// The service and app this page uses; the defaults match the compose local stack.
const service = import.meta.env.VITE_ZKAUTH_SERVICE ?? "http://localhost:8780";
const app = import.meta.env.VITE_ZKAUTH_APP ?? "demo";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ZkAuthProvider service={service} app={app}>
      <App service={service} app={app} />
    </ZkAuthProvider>
  </StrictMode>,
);
