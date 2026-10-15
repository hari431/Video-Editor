import { AsyncLocalStorage } from 'node:async_hooks';

export const perfStorage = new AsyncLocalStorage();

export function getReqId() {
  const store = perfStorage.getStore();
  return store && store.reqId ? store.reqId : '-';
}

export function withReqId(reqId, fn) {
  return perfStorage.run({ reqId }, fn);
}
