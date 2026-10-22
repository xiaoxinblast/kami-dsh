import { AsyncLocalStorage } from "node:async_hooks";

const calls = new AsyncLocalStorage();
let runtime = {};

export function configureRuntime(options) {
  runtime = { ...options };
}

export function runtimeOptions() {
  return { ...runtime, ...calls.getStore() };
}

export function withRuntimeCall(options, callback) {
  return calls.run({ ...calls.getStore(), ...options }, callback);
}
