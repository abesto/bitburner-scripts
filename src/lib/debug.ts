import { NS } from '@ns';

export interface Debug {
  [category: string]: (message: string) => void;
  withCategoryPrefix: (prefix: string) => Debug;
}

export function Debug(ns: NS, isEnabled: (category: string) => boolean, categoryPrefix: string | null = null): Debug {
  const handler = (_: unknown, category: string) => {
    if (category === 'withCategoryPrefix') {
      return (prefix: string) => {
        const finalPrefix = categoryPrefix ? categoryPrefix + '_' + prefix : prefix;
        return Debug(ns, isEnabled, finalPrefix);
      };
    }
    const finalCategory = (categoryPrefix ? categoryPrefix + '_' : '') + category;
    return (message: string) => {
      const parts = finalCategory.split('_');
      for (let i = 0; i < parts.length; i++) {
        const candidate = parts.slice(0, i + 1).join('_');
        if (isEnabled(candidate)) {
          ns.print(`${finalCategory}> ${message}`);
          return;
        }
      }
    };
  };
  return new Proxy(
    {},
    {
      get: handler,
    },
  ) as Debug;
}
