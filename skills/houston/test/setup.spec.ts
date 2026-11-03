import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { readSetup, setupBlock, setupIn } from "../scripts/setup.ts";
import { expect } from "./expect.ts";
import { transcript } from "./fixtures.ts";

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

describe("readSetup", () => {
  test("reads the harness, model, effort, instructions and skills of the main session", () => {
    expect(readSetup(transcript())).toEqual({
      session: "s-1",
      mode: "cloud",
      entrypoint: "remote_projects",
      harness: ["2.1.316", "2.1.317"],
      models: ["claude-opus-5-5"],
      effort: ["high"],
      instructions: [{ path: "/w/r/CLAUDE.md", sha256: short("# Rules") }],
      skills: [
        { name: "pr", digest: "bbbb" },
        { name: "tdd", digest: "aaaa" },
      ],
    });
  });

  test("hashes an instruction file's trimmed text, so it matches the file with its final newline", () => {
    const [file] = readSetup(transcript({ claudeMd: "# Rules\n" })).instructions;
    expect(file?.sha256).toBe(short("# Rules"));
  });

  test("calls a session local when its entrypoint isn't a remote one", () => {
    expect(readSetup(transcript({ entrypoint: "cli" })).mode).toBe("local");
  });

  test("keeps nothing from the session_context, which holds the user's email", () => {
    expect(JSON.stringify(readSetup(transcript()))).not.toContain("example.com");
  });

  test("reads an empty or foreign file as an unknown local setup", () => {
    expect(readSetup("").harness).toEqual([]);
    expect(readSetup("null\n42\n").mode).toBe("local");
  });
});

describe("setupBlock", () => {
  test("summarises the setup and carries it as JSON that setupIn reads back", () => {
    const setup = readSetup(transcript());
    const block = setupBlock(setup);
    expect(block).toMatch(
      /^<details><summary>Setup · Claude Code 2\.1\.316, 2\.1\.317 · claude-opus-5-5 · effort high · cloud<\/summary>/,
    );
    expect(block).toContain("Skills (2): `pr` bbbb, `tdd` aaaa");
    expect(setupIn(`Does it.\n\n${block}\n\nCloses #1`)).toEqual(setup);
  });

  test("setupIn finds nothing in a body without a block", () => {
    expect(setupIn("Does it.")).toBeNull();
  });
});
