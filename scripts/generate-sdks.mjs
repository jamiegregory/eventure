import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const specs = [
  { name: "api-gateway", file: "docs/openapi/api-gateway-v1.yaml" },
  { name: "organizer-bff", file: "docs/openapi/organizer-bff-v1.yaml" },
  { name: "attendee-bff", file: "docs/openapi/attendee-bff-v1.yaml" }
];

async function run() {
  await mkdir("packages/clients", { recursive: true });

  for (const spec of specs) {
    const output = path.join("packages/clients", `${spec.name}.sdk.ts`);
    const content = `// Generated client placeholder for ${spec.file}\n` +
      `// Replace this file in CI using openapi-generator/openapi-typescript tooling.\n` +
      `export const sourceSpec = ${JSON.stringify(spec.file)};\n`;

    await writeFile(output, content, "utf8");
  }
}

run();
