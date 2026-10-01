import { scanGraph } from '../../compiler/graph.js';

export async function routesCommand(options: { json?: boolean } = {}): Promise<void> {
  const graph = scanGraph(process.cwd());
  if (options.json) console.log(JSON.stringify(graph, null, 2));
  else for (const route of graph.routes) console.log(`${route.kind.padEnd(6)} ${route.path}\t${route.file}`);
}
