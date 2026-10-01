import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { autoCompactionExtension } from "./src/extension.mjs";

export default function (pi: ExtensionAPI) {
  autoCompactionExtension(pi);
}

export { autoCompactionExtension };
