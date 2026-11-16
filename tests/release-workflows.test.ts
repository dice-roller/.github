/**
 * Exercise the actual workflow shell steps against disposable local fixtures.
 * npm staging is never executed. Version bumps run offline with hooks disabled;
 * Git pushes target a temporary local bare repository.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  if?: string;
  "working-directory"?: string;
}
interface Workflow {
  on: { workflow_call: { inputs: Record<string, { default?: string }> } };
  jobs: Record<string, { steps: Step[] }>;
}
const root = resolve(__dirname, "..");
const load = (path: string): Workflow =>
  parse(readFileSync(join(root, path), "utf8")) as Workflow;
const publish = load(".github/workflows/npm-publish.yml");
const prepare = load(".github/workflows/prepare-release.yml");
const step = (workflow: Workflow, job: string, name: string): Step => {
  const found = workflow.jobs[job]?.steps.find((item) => item.name === name);
  if (!found) throw new Error(`Missing workflow step: ${job}/${name}`);
  return found;
};
const script = (item: Step): string => {
  if (!item.run) throw new Error("Expected a shell step");
  return item.run;
};
const success = (result: SpawnSyncReturns<string>): void => {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
};
const command = (cwd: string, ...args: string[]): string => {
  const [executable, ...rest] = args;
  if (!executable) throw new Error("Missing command");
  const result = spawnSync(executable, rest, { cwd, encoding: "utf8" });
  success(result);
  return result.stdout.trim();
};

class Fixture {
  readonly base = mkdtempSync(join(tmpdir(), "release-workflow-test-"));
  readonly path = join(this.base, "checkout");
  readonly origin = join(this.base, "origin.git");
  readonly output = join(this.base, "output");
  readonly manifest: string;

  constructor(
    readonly workspace = false,
    version = "1.2.3",
  ) {
    mkdirSync(this.path);
    this.manifest = workspace ? "packages/svg/package.json" : "package.json";
    const hooks = {
      version: 'node -e "process.exit(99)"',
      postversion: 'node -e "process.exit(99)"',
    };
    const manifest = {
      name: "fixture-root",
      version: workspace ? "9.9.9" : version,
      scripts: hooks,
      ...(workspace ? { private: true, workspaces: ["packages/*"] } : {}),
    };
    const packages: Record<string, unknown> = { "": { ...manifest } };
    if (workspace) {
      for (const [name, current] of [
        ["svg", version],
        ["terminal", "2.0.0"],
      ] as const) {
        const data = {
          name: `fixture-${name}`,
          version: current,
          scripts: hooks,
        };
        this.write(`packages/${name}/package.json`, data);
        packages[`packages/${name}`] = data;
        packages[`node_modules/fixture-${name}`] = {
          resolved: `packages/${name}`,
          link: true,
        };
      }
    }
    this.write("package.json", manifest);
    this.write("package-lock.json", {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    });
    command(this.path, "git", "init", "-q", "-b", "main");
    command(this.path, "git", "config", "user.name", "Workflow tests");
    command(
      this.path,
      "git",
      "config",
      "user.email",
      "workflow-tests@example.invalid",
    );
    command(this.path, "git", "add", ".");
    command(this.path, "git", "commit", "-qm", "Fixture");
    command(this.path, "git", "init", "-q", "--bare", this.origin);
    command(this.path, "git", "remote", "add", "origin", this.origin);
  }

  write(path: string, data: unknown): void {
    const target = join(this.path, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, JSON.stringify(data, null, 2) + "\n");
  }
  read(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(this.path, path), "utf8")) as Record<
      string,
      unknown
    >;
  }
  bytes(path: string): Buffer {
    return readFileSync(join(this.path, path));
  }
  run(item: Step, env: Record<string, string> = {}) {
    writeFileSync(this.output, "");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script(item)], {
      cwd: this.path,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: this.output,
        GITHUB_REF_NAME: "main",
        PACKAGE_DIRECTORY: this.workspace ? "packages/svg" : ".",
        TAG_PREFIX: this.workspace ? "svg-v" : "v",
        BUMP: "patch",
        PREID: "beta",
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        ...env,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(this.output, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    return { result, outputs };
  }
  close(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
}
const fixtures: Fixture[] = [];
const fixture = (workspace = false, version = "1.2.3"): Fixture => {
  const value = new Fixture(workspace, version);
  fixtures.push(value);
  return value;
};
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
const determine = () => step(publish, "publish", "Determine release");
const bump = () =>
  step(prepare, "prepare", "Validate branch, bump and package version");
const select = () => step(prepare, "tag", "Select matching package release PR");
const verify = () =>
  step(prepare, "tag", "Verify merged version and create Git tag");

describe("shared release workflows", () => {
  test("legacy defaults are unchanged", () => {
    for (const workflow of [publish, prepare])
      expect(
        workflow.on.workflow_call.inputs["package-directory"]?.default,
      ).toBe(".");
    expect(prepare.on.workflow_call.inputs["tag-prefix"]?.default).toBe("v");
    const { result, outputs } = fixture().run(determine());
    success(result);
    expect(outputs).toEqual({
      directory: ".",
      package: "fixture-root",
      version: "1.2.3",
      tag: "latest",
    });
  });

  test("publishing reads the selected workspace, not the private root", () => {
    const { result, outputs } = fixture(true).run(determine(), {
      PACKAGE_DIRECTORY: "packages/./svg/",
    });
    success(result);
    expect(outputs).toEqual({
      directory: "packages/svg",
      package: "fixture-svg",
      version: "1.2.3",
      tag: "latest",
    });
    expect(
      step(publish, "publish", "Install dependencies")["working-directory"],
    ).toBeUndefined();
    const stage = step(
      publish,
      "publish",
      "Stage package on npm for maintainer approval",
    );
    expect(stage["working-directory"]).toBe(
      "${{ steps.release.outputs.directory }}",
    );
    expect(stage.run).toContain("--workspaces=false");
  });

  test("publishing retains branch and version restrictions", () => {
    for (const [branch, version, tag] of [
      ["next", "2.0.0-beta.1", "next"],
      ["releases/v1", "1.2.3", "release-1"],
    ] as const) {
      const { result, outputs } = fixture(true, version).run(determine(), {
        GITHUB_REF_NAME: branch,
      });
      success(result);
      expect(outputs.tag).toBe(tag);
    }
    for (const [branch, version] of [
      ["main", "2.0.0-beta.1"],
      ["next", "2.0.0"],
      ["releases/v1", "2.0.0"],
      ["releases/vx", "1.0.0"],
      ["feature/example", "1.0.0"],
      ["main", "invalid"],
    ] as const) {
      expect(
        fixture(true, version).run(determine(), { GITHUB_REF_NAME: branch })
          .result.status,
      ).not.toBe(0);
    }
  });

  test("directories cannot escape the checkout or inject commands", () => {
    const value = fixture(true);
    const outside = join(value.base, "outside");
    mkdirSync(outside);
    writeFileSync(
      join(outside, "package.json"),
      '{"name":"outside","version":"1.0.0"}',
    );
    symlinkSync(outside, join(value.path, "escape"), "dir");
    unlinkSync(join(value.path, value.manifest));
    symlinkSync(
      join(outside, "package.json"),
      join(value.path, value.manifest),
    );
    for (const directory of [
      "..",
      value.path,
      "escape",
      "packages/svg",
      "missing",
      "$(touch injected)",
    ]) {
      expect(
        value.run(determine(), { PACKAGE_DIRECTORY: directory }).result.status,
      ).not.toBe(0);
    }
    expect(readdirSync(value.path)).not.toContain("injected");
  });

  test("private packages are rejected", () => {
    const value = fixture(true);
    for (const item of [determine(), bump()]) {
      const { result } = value.run(item, { PACKAGE_DIRECTORY: "." });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("selected package is private");
    }
    expect(value.read("package.json").version).toBe("9.9.9");
  });

  test("root version bumps preserve existing behaviour", () => {
    const value = fixture();
    const { result, outputs } = value.run(bump());
    success(result);
    expect(outputs.version).toBe("1.2.4");
    expect(outputs.manifest).toBe("package.json");
    expect(value.read("package-lock.json").version).toBe("1.2.4");
  });

  test("workspace bumps only update the selected manifest and shared lockfile", () => {
    const value = fixture(true);
    const rootBefore = value.bytes("package.json");
    const otherBefore = value.bytes("packages/terminal/package.json");
    const { result, outputs } = value.run(bump());
    success(result);
    expect(outputs).toMatchObject({
      manifest: "packages/svg/package.json",
      package: "fixture-svg",
      version: "1.2.4",
    });
    const packages = value.read("package-lock.json").packages as Record<
      string,
      { version?: string }
    >;
    expect(packages["packages/svg"]?.version).toBe("1.2.4");
    expect(value.bytes("package.json")).toEqual(rootBefore);
    expect(value.bytes("packages/terminal/package.json")).toEqual(otherBefore);
  });

  test("prerelease bumps and maintenance guards are preserved", () => {
    const { result, outputs } = fixture(true).run(bump(), {
      GITHUB_REF_NAME: "next",
      BUMP: "preminor",
    });
    success(result);
    expect(outputs.version).toBe("1.3.0-beta.0");
    for (const [branch, increment] of [
      ["main", "prerelease"],
      ["next", "patch"],
      ["releases/v1", "major"],
      ["feature/example", "patch"],
    ] as const) {
      const value = fixture(true);
      const before = value.bytes(value.manifest);
      expect(
        value.run(bump(), { GITHUB_REF_NAME: branch, BUMP: increment }).result
          .status,
      ).not.toBe(0);
      expect(value.bytes(value.manifest)).toEqual(before);
    }
  });

  test("tag jobs ignore other packages' release PRs", () => {
    const value = fixture(true);
    for (const [source, expected] of [
      ["release/prepare/main/svg-v1.2.4", "true"],
      ["release/prepare/main/terminal-v1.2.4", "false"],
      ["release/prepare/main/v1.2.4", "false"],
    ] as const) {
      const { result, outputs } = value.run(select(), {
        TARGET: "main",
        SOURCE: source,
      });
      success(result);
      expect(outputs.matches).toBe(expected);
    }
    for (const name of [
      "Create release app token",
      "Check out merged release commit",
      "Verify merged version and create Git tag",
    ]) {
      expect(step(prepare, "tag", name).if).toContain(
        "steps.selection.outputs.matches == 'true'",
      );
    }
  });

  test("invalid tag prefixes are rejected before changes", () => {
    const value = fixture(true);
    for (const prefix of [
      "",
      "../bad",
      "bad..prefix",
      "bad/prefix",
      "bad\noutput=true",
    ]) {
      expect(value.run(bump(), { TAG_PREFIX: prefix }).result.status).not.toBe(
        0,
      );
      expect(value.read(value.manifest).version).toBe("1.2.3");
    }
  });

  test("root and workspace tags identify merged commits and are idempotent", () => {
    for (const workspace of [false, true]) {
      const value = fixture(workspace);
      const { result, outputs } = value.run(bump());
      success(result);
      command(value.path, "git", "add", ".");
      command(value.path, "git", "commit", "-qm", "Merged release");
      const prefix = workspace ? "svg-v" : "v";
      const source = `release/prepare/main/${prefix}${outputs.version}`;
      for (let repeat = 0; repeat < 2; repeat++)
        success(value.run(verify(), { TARGET: "main", SOURCE: source }).result);
      const tag = `${prefix}${outputs.version}`;
      const head = command(value.path, "git", "rev-parse", "HEAD");
      expect(command(value.path, "git", "rev-parse", `${tag}^{}`)).toBe(head);
      expect(
        command(
          value.path,
          "git",
          "--git-dir",
          value.origin,
          "show-ref",
          "--tags",
          "-d",
        ),
      ).toContain(head);
    }
  });

  test("next and maintenance tags retain branch policy", () => {
    for (const [target, increment] of [
      ["next", "preminor"],
      ["releases/v1", "patch"],
    ] as const) {
      const value = fixture(true);
      const { result, outputs } = value.run(bump(), {
        GITHUB_REF_NAME: target,
        BUMP: increment,
      });
      success(result);
      command(value.path, "git", "add", ".");
      command(value.path, "git", "commit", "-qm", "Merged release");
      const source = `release/prepare/${target.replaceAll("/", "-")}/svg-v${outputs.version}`;
      const selected = value.run(select(), { TARGET: target, SOURCE: source });
      success(selected.result);
      expect(selected.outputs.matches).toBe("true");
      success(value.run(verify(), { TARGET: target, SOURCE: source }).result);
      expect(command(value.path, "git", "tag", "--list")).toBe(
        `svg-v${outputs.version}`,
      );
    }
  });

  test("wrong sources, unchanged versions and conflicting tags fail", () => {
    const value = fixture(true);
    expect(
      value.run(verify(), {
        TARGET: "main",
        SOURCE: "release/prepare/main/svg-v1.2.4",
      }).result.status,
    ).not.toBe(0);
    writeFileSync(join(value.path, "note.txt"), "No version change");
    command(value.path, "git", "add", ".");
    command(value.path, "git", "commit", "-qm", "Unchanged version");
    const unchanged = value.run(verify(), {
      TARGET: "main",
      SOURCE: "release/prepare/main/svg-v1.2.3",
    }).result;
    expect(unchanged.status).not.toBe(0);
    expect(unchanged.stderr).toContain("did not change");
    command(value.path, "git", "tag", "svg-v1.2.4");
    success(value.run(bump()).result);
    command(value.path, "git", "add", ".");
    command(value.path, "git", "commit", "-qm", "Release version");
    const conflict = value.run(verify(), {
      TARGET: "main",
      SOURCE: "release/prepare/main/svg-v1.2.4",
    }).result;
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain("different commit");
  });

  test("release commits stage the selected manifest and root lockfile", () => {
    const commit = step(
      prepare,
      "prepare",
      "Commit version and open release PR",
    );
    expect(commit.run).toContain('git add -- "$MANIFEST" package-lock.json');
    expect(commit.run).toContain(
      "release/prepare/${TARGET//\\//-}/${TAG_PREFIX}$VERSION",
    );
    expect(commit.env?.MANIFEST).toBe("${{ steps.release.outputs.manifest }}");
    expect(commit.run).toContain("$PACKAGE");
  });

  test("all embedded shell steps parse", () => {
    for (const workflow of [publish, prepare]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const item of job.steps) {
          if (item.run)
            success(
              spawnSync("bash", ["-n"], { input: item.run, encoding: "utf8" }),
            );
        }
      }
    }
  });
});
