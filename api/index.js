// Vercel Function: every path is rewritten here (vercel.json). The TypeScript source is compiled
// to dist/ by `npm run build` before Vercel bundles this file. Configuration comes only from the
// project's environment variables (`vercel dev` injects them locally); no .env file is read.
// A startup problem (e.g. a missing variable) is answered on every route instead of crashing.
import { createVercelEntry } from '../dist/vercel.js';

export default createVercelEntry();
