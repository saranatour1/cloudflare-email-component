import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  // VITE_CONVEX_URL lives in the repo root's .env.local, written by `convex dev`.
  envDir: "..",
});
