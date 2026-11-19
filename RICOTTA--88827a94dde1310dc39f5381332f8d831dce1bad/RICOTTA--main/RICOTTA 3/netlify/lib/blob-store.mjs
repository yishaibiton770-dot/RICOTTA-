import { getDeployStore, getStore } from "@netlify/blobs";
import store from "./store.js";

export function stateStore(context) {
  const options = { name: "ricotta-store-v1", region: "us-east-2", consistency: "strong" };
  return store.isProduction(context) ? getStore(options) : getDeployStore({ ...options, deployID: context?.deploy?.id });
}
