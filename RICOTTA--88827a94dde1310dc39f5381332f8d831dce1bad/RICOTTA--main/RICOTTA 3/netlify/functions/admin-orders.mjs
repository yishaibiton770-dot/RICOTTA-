import legacy from "../lib/admin-orders.js";
import { productionHandler } from "../lib/legacy-handler.mjs";

export default productionHandler(legacy.handler);
