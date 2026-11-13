import { build } from "vite-plus";
import { expect, it } from "vite-plus/test";

it("emits notification audio as files that desktop's content security policy can fetch", async () => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      rolldownOptions: {
        input: `${import.meta.dirname}/notificationSounds.ts`,
        preserveEntrySignatures: "strict",
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) =>
    "output" in bundle ? bundle.output : [],
  );
  const script = outputs.find((output) => output.type === "chunk");
  expect(script?.code.includes("data:audio/")).toBe(false);
  expect(
    outputs.filter((output) => output.type === "asset" && output.fileName.endsWith(".mp3")),
  ).toHaveLength(16);
});
