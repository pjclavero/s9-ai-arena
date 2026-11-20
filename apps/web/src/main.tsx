import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { installRouteFocus } from "./ui/route-focus.js";

// UX-E · foco al contenido tras navegar y enlace «Saltar al contenido».
installRouteFocus();

createRoot(document.getElementById("root")!).render(<App />);
