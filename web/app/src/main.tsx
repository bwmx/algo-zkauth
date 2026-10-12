import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DemoController } from "./controller";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App controller={new DemoController()} />);
