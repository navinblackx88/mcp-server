// Evaluates railway.ts locally (no Railway account needed) and prints what it would create.
// `railway config plan` is still the real check; this catches mistakes before you get there.
import { createRailwayContext, RAILWAY_GRAPH_VERSION, validateGraph } from 'railway/iac';

const { default: program } = await import('./railway.ts');
const ctx = createRailwayContext({ command: 'plan', environment: 'production', environmentName: 'production', projectName: 'mcp-file-reader' });
const def = await program(ctx, (name, d) => ({ name, ...d }));

const show = (v) => (typeof v === 'string' ? v : v?.type === 'literal' ? v.value : v?.type === 'reference' ? `→ ${v.resource}.${v.output}  (Railway reference)` : v?.type === 'preserve' ? '(preserved secret)' : JSON.stringify(v));
console.log(`Project: ${def.name}`);
for (const r of def.resources) {
  console.log(`\n[${r.type}] ${r.name}${r.address ? `  (${r.address})` : ''}`);
  const cfg = r;
  if (r.type === 'service') console.log(`  source: ${cfg.source ? JSON.stringify(cfg.source) : cfg.kind === 'empty' ? 'none (deploy with `railway up --service ' + r.name + '`)' : cfg.kind}`);
  if (cfg.source === undefined && cfg.repo) console.log(`  repo: ${cfg.repo} (${cfg.branch ?? 'default branch'})`);
  if (cfg.build) console.log(`  build: ${JSON.stringify(cfg.build)}`);
  if (cfg.deploy) console.log(`  deploy: ${JSON.stringify(cfg.deploy)}`);
  for (const [name, a] of Object.entries(cfg.volumeAttachments ?? {})) console.log(`  volume: ${name} mounted at ${a.mountPath}`);
  for (const [k, v] of Object.entries(cfg.variables ?? {})) console.log(`  ${k} = ${show(v)}`);
}
const problems = validateGraph({ version: RAILWAY_GRAPH_VERSION, project: { name: def.name }, environments: [{ name: 'production' }], resources: def.resources, edges: [] });
console.log(problems.length ? `\nValidation problems:\n- ${problems.join('\n- ')}` : '\nvalidateGraph: no problems');
