import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import "./office-motion.css";
import "./desk-work.css";
import "./office-ambience.css";
import "./case-tray.css";
import "./operations-controls.css";
import "./connected-office.css";
import "./review-actions.css";
import "./case-inbox.css";
import "./approval-actions.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
