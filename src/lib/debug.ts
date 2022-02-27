import { NS } from '@ns';

export let _ns: NS;

export function init(ns: NS): void {
  _ns = ns;
}

export interface Debug {
  [category: string]: (message: string) => void;
}

export function Debug(isEnabled: (category: string) => boolean): Debug {
  const handler = (_: unknown, category: string) => (message: string) => {
    const parts = category.split('_');
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(0, i + 1).join('_');
      if (isEnabled(candidate)) {
        _ns.print(`${category}> ${message}`);
        return;
      }
    }
  };
  return new Proxy(
    {},
    {
      get: handler,
    },
  ) as Debug;
}
