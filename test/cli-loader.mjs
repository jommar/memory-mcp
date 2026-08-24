import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

register('./cli-loader-hooks.mjs', import.meta.url);
