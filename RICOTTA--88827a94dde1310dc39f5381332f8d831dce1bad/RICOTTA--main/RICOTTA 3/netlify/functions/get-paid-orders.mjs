import legacy from "../lib/get-paid-orders.js";
import { productionHandler } from "../lib/legacy-handler.mjs";

export default productionHandler(legacy.handler);
