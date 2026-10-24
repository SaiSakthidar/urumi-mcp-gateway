import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the gateway runs on :8080. In the cluster, Ingress routes /api and /mcp
// to the gateway on the same host, so the browser never needs CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/mcp": "http://localhost:8080",
    },
  },
});
