import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { RootErrorBoundary } from "@/shared/ui";
import { initGlobalErrorHandlers } from "@/shared/utils/globalErrorHandlers";
import { initTelemetry } from "@/shared/telemetry";
import { initBackgroundStorageAnalytics } from "@/shared/utils/cacheManager";
import { initApiEndpointProbe, initializeAuthSession } from "@/shared/api";

const rootElement = document.getElementById("root");

void initializeAuthSession().then(() => {
  // Initialize auth-dependent services only after native storage has hydrated.
  initGlobalErrorHandlers();
  initTelemetry();
  initBackgroundStorageAnalytics();
  initApiEndpointProbe();

  if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </React.StrictMode>,
    );
  }
});

