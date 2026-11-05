import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../convex/_generated/api";
import { App } from "./App";
import "./index.css";

// shadcn's theme switches on a .dark class, so follow the system setting.
const dark = matchMedia("(prefers-color-scheme: dark)");
const followTheme = () =>
  document.documentElement.classList.toggle("dark", dark.matches);
followTheme();
dark.addEventListener("change", followTheme);

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexAuthProvider
      client={convex}
      api={{
        refreshSession: api.auth.refreshSession,
        signOut: api.auth.signOut,
      }}
    >
      <App />
    </ConvexAuthProvider>
  </StrictMode>,
);
