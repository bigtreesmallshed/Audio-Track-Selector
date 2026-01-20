import type { Api } from "../../main/src/preload";

declare global {
  interface Window {
    api: Api;
  }
}

export {};
