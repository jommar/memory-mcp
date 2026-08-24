import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (base.endsWith('.js')) {
      const tsPath = base.slice(0, -3) + '.ts';
      if (existsSync(tsPath)) return { url: pathToFileURL(tsPath).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
