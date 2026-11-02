import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { GitCommandError } from "@t3tools/contracts";

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: ({ cwd: resolvedCwd }) =>
                Effect.succeed({
                  kind: "git",
                  repository: { rootPath: resolvedCwd },
                } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("runs the pre-action check under the checkout lease and skips git on failure", () => {
    let gitActionRan = false;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-preflight-" });
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.execute({ operation: "test.setupRepo", cwd, args: ["init", "-b", "main"] });

      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* workflow
        .runStackedAction(
          { actionId: "preflight", cwd, action: "commit" },
          {
            beforeRun: () =>
              Effect.fail(
                new GitCommandError({
                  operation: "security-review",
                  command: "agent-review",
                  cwd,
                  detail: "Review blocked the commit.",
                }),
              ),
          },
        )
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.isFalse(gitActionRan);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: ({ cwd: resolvedCwd }) =>
                Effect.succeed({
                  kind: "git",
                  repository: { rootPath: resolvedCwd },
                } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(
            Layer.mock(GitManager.GitManager)({
              runStackedAction: () =>
                Effect.sync(() => {
                  gitActionRan = true;
                  return {} as never;
                }),
            }),
          ),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-preflight-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });
});
