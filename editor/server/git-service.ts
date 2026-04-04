import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import { PublishTransactionInfo } from "../shared/types";
import { HttpError } from "./errors";

interface PendingPublishTransaction {
  transactionId: string;
  commitSha: string;
  baseSha: string;
  branchName: string;
  upstreamBranch: string | null;
  pushAvailable: boolean;
  commitMessage: string;
  affectedPaths: string[];
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitService {
  private readonly transactions = new Map<string, PendingPublishTransaction>();
  private readonly workingRoot: string;

  constructor(private readonly repoRoot: string) {
    this.workingRoot = path.join(repoRoot, ".blog-editor", "git");
  }

  async createPublishTransaction(paths: string[], commitMessage: string): Promise<PublishTransactionInfo> {
    const affectedPaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));

    if (affectedPaths.length === 0) {
      throw new HttpError(400, "No publishable files were selected.");
    }

    const transactionId = randomUUID();
    const tempIndexPath = path.join(this.workingRoot, `${transactionId}.index`);

    await fs.mkdir(this.workingRoot, { recursive: true });
    await fs.writeFile(tempIndexPath, "");

    try {
      const branchName = await this.getCurrentBranch();
      const baseSha = await this.runGit(["rev-parse", "HEAD"]);
      const upstreamBranch = await this.getUpstreamBranch();

      await this.runGit(["read-tree", "HEAD"], {
        GIT_INDEX_FILE: tempIndexPath,
      });

      for (const affectedPath of affectedPaths) {
        const addResult = await this.runGitDetailed(["add", "-A", "--", affectedPath], {
          GIT_INDEX_FILE: tempIndexPath,
        });

        if (addResult.exitCode !== 0 && !/did not match any files/i.test(addResult.stderr)) {
          throw new Error(addResult.stderr || `Unable to stage ${affectedPath} for publish.`);
        }
      }

      const diffResult = await this.runGitDetailed(["diff", "--cached", "--quiet"], {
        GIT_INDEX_FILE: tempIndexPath,
      });

      if (diffResult.exitCode === 0) {
        throw new HttpError(400, "No publishable changes were found for this post.");
      }

      if (diffResult.exitCode !== 1) {
        throw new Error(diffResult.stderr || "Unable to inspect publish changes.");
      }

      const treeSha = await this.runGit(["write-tree"], {
        GIT_INDEX_FILE: tempIndexPath,
      });
      const commitSha = await this.runGit(["commit-tree", treeSha, "-p", baseSha, "-m", commitMessage], {
        GIT_INDEX_FILE: tempIndexPath,
      });

      await this.runGit(["update-ref", `refs/heads/${branchName}`, commitSha, baseSha]);

      const transaction: PendingPublishTransaction = {
        transactionId,
        commitSha,
        baseSha,
        branchName,
        upstreamBranch,
        pushAvailable: Boolean(upstreamBranch),
        commitMessage,
        affectedPaths,
      };

      this.transactions.set(transactionId, transaction);
      return this.toInfo(transaction);
    } finally {
      await fs.rm(tempIndexPath, { force: true });
    }
  }

  async pushTransaction(transactionId: string) {
    const transaction = this.getTransaction(transactionId);

    if (!transaction.pushAvailable || !transaction.upstreamBranch) {
      throw new HttpError(400, "This branch does not have an upstream configured. The commit was kept locally.");
    }

    const headSha = await this.runGit(["rev-parse", "HEAD"]);

    if (headSha !== transaction.commitSha) {
      throw new HttpError(409, "HEAD moved after the publish commit was created. Push it manually or create a new publish commit.");
    }

    await this.runGit(["push"]);
    this.transactions.delete(transactionId);

    return this.toInfo(transaction);
  }

  async cancelTransaction(transactionId: string) {
    const transaction = this.getTransaction(transactionId);
    const headSha = await this.runGit(["rev-parse", "HEAD"]);

    if (headSha !== transaction.commitSha) {
      throw new HttpError(409, "HEAD moved after the publish commit was created. Cancel it manually if you still need to undo it.");
    }

    await this.runGit(["update-ref", `refs/heads/${transaction.branchName}`, transaction.baseSha, transaction.commitSha]);
    this.transactions.delete(transactionId);

    return this.toInfo(transaction);
  }

  async keepTransaction(transactionId: string) {
    const transaction = this.getTransaction(transactionId);
    return this.toInfo(transaction);
  }

  async updateTransactionMessage(transactionId: string, commitMessage: string) {
    const transaction = this.getTransaction(transactionId);
    const nextMessage = commitMessage.trim();

    if (!nextMessage) {
      throw new HttpError(400, "Commit message is required.");
    }

    if (nextMessage === transaction.commitMessage) {
      return this.toInfo(transaction);
    }

    const headSha = await this.runGit(["rev-parse", "HEAD"]);

    if (headSha !== transaction.commitSha) {
      throw new HttpError(
        409,
        "HEAD moved after the publish commit was created. Update the commit message manually or create a new publish commit.",
      );
    }

    const treeSha = await this.runGit(["rev-parse", `${transaction.commitSha}^{tree}`]);
    const nextCommitSha = await this.runGit(["commit-tree", treeSha, "-p", transaction.baseSha, "-m", nextMessage]);

    await this.runGit([
      "update-ref",
      `refs/heads/${transaction.branchName}`,
      nextCommitSha,
      transaction.commitSha,
    ]);

    transaction.commitSha = nextCommitSha;
    transaction.commitMessage = nextMessage;

    return this.toInfo(transaction);
  }

  listTransactions() {
    return [...this.transactions.values()].map((transaction) => this.toInfo(transaction));
  }

  async discardPathToUpstream(relativePath: string) {
    const upstreamBranch = await this.getUpstreamBranch();

    if (!upstreamBranch) {
      throw new HttpError(400, "Discard requires an upstream branch. This branch is not tracking a remote.");
    }

    const currentBranch = await this.getCurrentBranch();
    const headSha = await this.runGit(["rev-parse", "HEAD"]);
    let cancelledPendingPublish = false;

    for (const transaction of [...this.transactions.values()]) {
      if (transaction.branchName !== currentBranch || !transaction.affectedPaths.includes(relativePath)) {
        continue;
      }

      if (transaction.commitSha !== headSha) {
        throw new HttpError(
          409,
          "This post has a pending local publish commit, but HEAD moved afterward. Resolve that publish state manually before discarding.",
        );
      }

      await this.runGit(["update-ref", `refs/heads/${transaction.branchName}`, transaction.baseSha, transaction.commitSha]);
      this.transactions.delete(transaction.transactionId);
      cancelledPendingPublish = true;
    }

    const existsUpstream = await this.pathExistsInRevision(upstreamBranch, relativePath);

    if (existsUpstream) {
      await this.runGit(["restore", "--source", upstreamBranch, "--staged", "--worktree", "--", relativePath]);
    } else {
      await fs.rm(path.join(this.repoRoot, relativePath), { force: true });
      const removeResult = await this.runGitDetailed(["rm", "-f", "--cached", "--ignore-unmatch", "--", relativePath]);

      if (removeResult.exitCode !== 0) {
        throw new Error(removeResult.stderr || `Unable to remove ${relativePath} while discarding local changes.`);
      }
    }

    return {
      cancelledPendingPublish,
      restoredPath: relativePath,
    };
  }

  private getTransaction(transactionId: string) {
    const transaction = this.transactions.get(transactionId);

    if (!transaction) {
      throw new HttpError(404, `Publish transaction "${transactionId}" was not found.`);
    }

    return transaction;
  }

  private async getCurrentBranch() {
    const branchName = await this.runGit(["branch", "--show-current"]);

    if (!branchName) {
      throw new HttpError(400, "Publish requires a checked-out local branch. Detached HEAD is not supported.");
    }

    return branchName;
  }

  private async getUpstreamBranch() {
    try {
      return await this.runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    } catch {
      return null;
    }
  }

  private async runGit(args: string[], extraEnv?: NodeJS.ProcessEnv) {
    const result = await this.runGitDetailed(args, extraEnv);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `git ${args.join(" ")} failed with code ${result.exitCode}.`);
    }

    return result.stdout.trim();
  }

  private async pathExistsInRevision(revision: string, relativePath: string) {
    const result = await this.runGitDetailed(["cat-file", "-e", `${revision}:${relativePath}`]);
    return result.exitCode === 0;
  }

  private async runGitDetailed(args: string[], extraEnv?: NodeJS.ProcessEnv) {
    return await new Promise<GitResult>((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd: this.repoRoot,
          env: {
            ...process.env,
            ...(extraEnv ?? {}),
          },
        },
        (error, stdout, stderr) => {
          const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number((error as NodeJS.ErrnoException).code) : 0;

          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode,
          });
        },
      );
    });
  }

  private toInfo(transaction: PendingPublishTransaction): PublishTransactionInfo {
    return {
      transactionId: transaction.transactionId,
      commitSha: transaction.commitSha,
      branchName: transaction.branchName,
      upstreamBranch: transaction.upstreamBranch,
      pushAvailable: transaction.pushAvailable,
      commitMessage: transaction.commitMessage,
      affectedPaths: transaction.affectedPaths,
    };
  }
}
