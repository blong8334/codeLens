import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** `CODELENS_GRAPH=path/to/graph.json npm run dev` serves that file at /codelens.graph.json. */
function serveGraph(): Plugin {
  const file = process.env.CODELENS_GRAPH;
  return {
    name: 'codelens-graph',
    configureServer(server) {
      if (!file) return;
      server.middlewares.use('/codelens.graph.json', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(await readFile(resolve(process.env.INIT_CWD ?? process.cwd(), file)));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveGraph()],
});
