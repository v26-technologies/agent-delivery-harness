/** Producer-only bundling. Consumers run these files without npm or source paths. */
import { build } from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The one load an adopter's import scanner cannot bound from its specifier: the CLI loading the adopter's own
 * `harness.config.ts`, once in each CLI bundle. An adopter bounds it by naming that config. */
const CONFIG_LOADER = /^pathToFileURL\d*\(configPath\d*\)\.href$/;
const BOUNDED_COMPUTED_IMPORTS: Record<string, number> = { "cli-api": 1, cli: 1, kernel: 0, policy: 0 };

/**
 * Each load in `text` an import scanner cannot bound from the source alone, as written: an `import()`,
 * `require()` or `__require()` whose specifier is anything but one quoted string with nothing after it, a call
 * through `createRequire(...)`'s result or a `.require` member, and code built at run time (`eval`, `Function`).
 * Scanners such as Athena's accept the same literal form, so a runtime this passes cannot read to them as opaque.
 * It does not follow an alias of `require` or the text of a script a bundle hands to a child process.
 */
export function computedImports(text: string): string[] {
  const source = ts.createSourceFile("bundle.mjs", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const found: string[] = [];
  const named = (node: ts.Node, names: RegExp) => ts.isIdentifier(node) && names.test(node.text);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || named(callee, /^(?:__)?require$/) ||
          ts.isPropertyAccessExpression(callee) && callee.name.text === "require") {
        const [specifier, ...rest] = node.arguments;
        if (!specifier || !ts.isStringLiteral(specifier) || rest.length) found.push(node.arguments.map(arg => arg.getText(source)).join(", "));
      } else if (ts.isCallExpression(callee) && named(callee.expression, /^createRequire\d*$/)) found.push(node.getText(source));
      else if (named(callee, /^(?:eval|Function)$/)) found.push(node.getText(source));
    } else if (ts.isNewExpression(node) && named(node.expression, /^Function$/)) found.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Refuses a runtime whose bundles load anything a scanner cannot bound, other than each CLI's one config loader. */
export async function refuseComputedImports(out: string): Promise<void> {
  for (const [name, loaders] of Object.entries(BOUNDED_COMPUTED_IMPORTS)) {
    const computed = computedImports(await readFile(path.join(out, `${name}.mjs`), "utf8"));
    const unbounded = computed.filter(specifier => !CONFIG_LOADER.test(specifier));
    if (unbounded.length) throw new Error(`product.computed_import: ${name}.mjs loads ${unbounded.join(", ")} through a computed specifier; spell it as a literal`);
    if (computed.length !== loaders) throw new Error(`product.computed_import: ${name}.mjs has ${computed.length} config loaders, expected ${loaders}`);
  }
}

export async function buildProductRuntime(root: string, workflowManifest: string, out: string): Promise<void> {
  const workflow = JSON.parse(await readFile(workflowManifest, "utf8")) as { contentSha256?: string; schemaVersion?: string };
  if (workflow.schemaVersion !== "agent-skills-release/1" || !/^[a-f0-9]{64}$/.test(workflow.contentSha256 ?? "")) {
    throw new Error("product.workflow_manifest: expected a verified workflow release manifest");
  }
  await mkdir(out, { recursive: true });
  for (const [name, source] of Object.entries({ "cli-api": "packages/cli/src/index.ts", cli: "packages/cli/src/main.ts", kernel: "packages/kernel/src/index.ts", policy: "scripts/recompile-policy-snapshot.ts" })) {
    await build({ absWorkingDir: root, entryPoints: [source], outfile: path.join(out, `${name}.mjs`), bundle: true, platform: "node", format: "esm", target: "node22.6", legalComments: "inline", external: ["bun:ffi"], plugins: [{ name: "installed-kernel", setup(builder) {
      builder.onResolve({ filter: /^@agent-delivery-harness\/kernel$/ }, () => ({ path: "./kernel.mjs", external: true }));
    } }] });
  }
  await refuseComputedImports(out);
  // Keep declarations in the same generation as the actual implementation.
  // The CLI API imports this generation's kernel types, never an adopter's
  // independently installed (and potentially older) npm package.
  for (const [name, source] of Object.entries({ kernel: "packages/kernel/src/index.ts", "cli-api": "packages/cli/src/index.ts" })) {
    const declarations = await rollup({ input: path.join(root, source), external: ["@agent-delivery-harness/kernel"], plugins: [dts({ tsconfig: path.join(root, "tsconfig.base.json") })] });
    try { await declarations.write({ file: path.join(out, `${name}.d.mts`), format: "es", paths: { "@agent-delivery-harness/kernel": "./kernel.mjs" } }); }
    finally { await declarations.close(); }
  }
  await writeFile(path.join(out, "bootstrap.mjs"), 'import { register } from "node:module";\nregister(new URL("./loader.mjs", import.meta.url));\n');
  await writeFile(path.join(out, "loader.mjs"), 'export async function resolve(specifier, context, nextResolve) {\n  if (specifier === "@agent-delivery-harness/kernel") return { url: new URL("./kernel.mjs", import.meta.url).href, shortCircuit: true };\n  return nextResolve(specifier, context);\n}\n');
  for (const name of ["LICENSE", "NOTICE"]) await writeFile(path.join(out, name), await readFile(path.join(root, name)));
  const names = ["LICENSE", "NOTICE", "bootstrap.mjs", "cli-api.d.mts", "cli-api.mjs", "cli.mjs", "kernel.d.mts", "kernel.mjs", "loader.mjs", "policy.mjs"].sort();
  const files = await Promise.all(names.map(async (name) => ({ path: name, sha256: createHash("sha256").update(await readFile(path.join(out, name))).digest("hex") })));
  const pkg = JSON.parse(await readFile(path.join(root, "packages/kernel/package.json"), "utf8")) as { version: string };
  await writeFile(path.join(out, "runtime.json"), JSON.stringify({ schemaVersion: "delivery-runtime/1", runtimeVersion: pkg.version, nodeMinimum: "22.6.0", workflowContentSha256: workflow.contentSha256, files }, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, out] = process.argv.slice(2);
  if (!manifest || !out || process.argv.length !== 4) throw new Error("usage: build-product-runtime <verified-workflow-manifest> <output-directory>");
  await buildProductRuntime(process.cwd(), manifest, out);
}
