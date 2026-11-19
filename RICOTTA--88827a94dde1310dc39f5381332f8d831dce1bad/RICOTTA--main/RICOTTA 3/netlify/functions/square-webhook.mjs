import legacy from "../lib/square-webhook.js";
import { productionHandler } from "../lib/legacy-handler.mjs";

export default productionHandler(legacy.handler);
