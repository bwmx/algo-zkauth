import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ZkAuthProvider } from "@bwmx/algo-zkauth/react";
import { App } from "./App.tsx";
import "./styles.css";

// The service and app this page uses; the defaults match the compose local stack.
// ?app= picks another app on the same service, such as demo-slack (the service
// still checks that the app allows this origin).
const service = import.meta.env.VITE_ZKAUTH_SERVICE ?? "http://localhost:8780";
const requested = new URLSearchParams(location.search).get("app");
const app = requested && /^[a-z0-9-]{1,32}$/.test(requested) ? requested : import.meta.env.VITE_ZKAUTH_APP ?? "demo";

// A provider that needs an https redirect (Slack) returns the login window
// through the published relay (apps/oauth-relay), which forwards the code and
// state to /demo/<provider>/callback on this origin. Hand them to the service's
// callback for that provider, which exchanges the code.
const relayed = /^\/demo\/([a-z]{1,32})\/callback$/.exec(location.pathname);
if (relayed) location.replace(`${service}/v1/oauth/${relayed[1]}/callback${location.search}`);
else createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ZkAuthProvider service={service} app={app}>
      <App service={service} app={app} />
    </ZkAuthProvider>
  </StrictMode>,
);
