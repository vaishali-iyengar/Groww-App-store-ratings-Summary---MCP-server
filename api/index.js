// Vercel Function: every path is rewritten here (vercel.json). The TypeScript source is compiled
// to dist/ by `npm run build` before Vercel bundles this file. Configuration comes only from the
// project's environment variables (`vercel dev` injects them locally); no .env file is read.
import { createVercelHandler } from '../dist/vercel.js';

export default createVercelHandler();
