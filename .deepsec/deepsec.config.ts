import { type DeepsecPlugin, defineConfig } from "@anolilab/deepsec/config";
import { archiveExtractionUntrusted } from "./matchers/archive-extraction-untrusted.js";

const deepsecPlugin: DeepsecPlugin = {
  name: "deepsec-internal",
  matchers: [archiveExtractionUntrusted],
};

export default defineConfig({
  projects: [
    { id: "deepsec", root: ".." },
    // <deepsec:projects-insert-above>
  ],
  plugins: [deepsecPlugin],
});
