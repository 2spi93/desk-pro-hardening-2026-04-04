// Worker source kept in TS-named file per project convention.
// Runtime worker used by browser is indicatorWorker.js in the same folder.

declare function importScripts(...urls: string[]): void;
importScripts("/workers/indicatorWorker.js");

export {};
