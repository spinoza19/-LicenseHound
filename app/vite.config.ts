import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Bradbury explorer's API does not send CORS headers, so in development we
// reach it through Vite. Everything else the app talks to (the GenLayer RPC,
// raw.githubusercontent.com, api.github.com) is CORS-open and goes direct.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/explorer": {
        target: "https://explorer-bradbury.genlayer.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/explorer/, ""),
      },
    },
  },
});
