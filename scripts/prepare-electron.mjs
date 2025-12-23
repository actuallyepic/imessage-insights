import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standaloneDir = path.join(root, ".next", "standalone");
const staticDir = path.join(root, ".next", "static");
const publicDir = path.join(root, "public");
const outDir = path.join(root, "electron", "next");

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(standaloneDir))) {
    throw new Error("Missing .next/standalone. Run `next build` first.");
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  await fs.cp(standaloneDir, outDir, { recursive: true });

  if (await exists(staticDir)) {
    await fs.cp(staticDir, path.join(outDir, ".next", "static"), { recursive: true });
  }

  if (await exists(publicDir)) {
    await fs.cp(publicDir, path.join(outDir, "public"), { recursive: true });
  }

  console.log("Prepared Electron Next bundle at", outDir);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
