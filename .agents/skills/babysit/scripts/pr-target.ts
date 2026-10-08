import { createHash } from "node:crypto";
import { err, ok, type Result } from "./result.ts";

/** A repository hosted on github.com (or a host forced to GitHub with `--forge github`). */
export type GitHubRepo = {
  readonly _tag: "github";
  readonly owner: string;
  readonly name: string;
};

/** A repository hosted on Azure DevOps (dev.azure.com or legacy *.visualstudio.com). */
export type AzureRepo = {
  readonly _tag: "azdo";
  readonly organization: string;
  /** Base URL passed to `az --org`, e.g. `https://dev.azure.com/contoso`. */
  readonly organizationUrl: string;
  readonly project: string;
  readonly name: string;
};

/** A repository on a supported forge. */
export type RepoRef = GitHubRepo | AzureRepo;

/** The forge a repository lives on. */
export type Forge = RepoRef["_tag"];

/** A positive pull request number. Construct with {@link parsePrNumber}. */
export type PrNumber = number & { readonly __brand: "PrNumber" };

/** A specific pull request on a specific repository. */
export type PrTarget = { readonly repo: RepoRef; readonly number: PrNumber };

/** The `--pr` argument after parsing. */
export type PrArgument =
  | { readonly _tag: "auto" }
  | { readonly _tag: "number"; readonly number: PrNumber }
  | { readonly _tag: "url"; readonly target: PrTarget };

/** Raised when a `--pr` value is neither `auto`, a positive integer, nor a recognized PR URL. */
export class InvalidPrArgument extends Error {
  readonly _tag = "InvalidPrArgument" as const;
  /** The rejected argument, with any credentials redacted. */
  readonly input: string;

  /** @param input - The rejected argument. */
  constructor(input: string) {
    const safe = redactUrl(input);
    super(`--pr must be "auto", a PR number, or a GitHub / Azure DevOps PR URL; got "${safe}"`);
    this.input = safe;
  }
}

/** Raised when a git remote URL does not point at a supported forge. */
export class UnrecognizedRemote extends Error {
  readonly _tag = "UnrecognizedRemote" as const;
  /** The rejected remote URL, with any credentials redacted. */
  readonly remote: string;

  /** @param remote - The rejected remote URL; credentials in it are redacted before storing. */
  constructor(remote: string) {
    const safe = redactUrl(remote);
    super(`Cannot tell the forge from remote "${safe}"; pass --forge github|azdo or a PR URL`);
    this.remote = safe;
  }
}

/**
 * Remove credentials from a URL before it is stored in an error or printed: the user name and
 * password of a `scheme://user:secret@host` URL and any query string (where tokens also travel).
 * Parsed with the WHATWG URL parser, which splits userinfo at the last `@` of the authority. Input
 * it cannot parse loses everything between `://` and the last `@`. SCP-style `git@host:path`
 * remotes carry a user name, not a secret, and are kept.
 *
 * @param url - A remote or PR URL as the user or git supplied it.
 * @returns The URL without userinfo, and with `***` in place of a query.
 */
export function redactUrl(url: string): string {
  const input = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  if (URL.canParse(input)) {
    const parsed = new URL(input);
    parsed.username = "";
    parsed.password = "";
    if (parsed.search !== "") parsed.search = "***";
    return parsed.toString();
  }
  return input.replace(/^([a-z][a-z0-9+.-]*:\/\/).*@/i, "$1***@").replace(/\?[^#]*/, "?***");
}

/**
 * Parse a pull request number.
 *
 * @param input - Decimal text or a number.
 * @returns The branded number, or `null` when it is not a positive integer.
 */
export function parsePrNumber(input: string | number): PrNumber | null {
  const value = typeof input === "number" ? input : /^\d+$/.test(input) ? Number(input) : Number.NaN;
  // SAFETY: the brand is applied only after the positive-integer check on the same value.
  return Number.isSafeInteger(value) && value > 0 ? (value as PrNumber) : null;
}

const GITHUB_PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const AZDO_PR_URL = /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)(?:[/?#].*)?$/i;
const VSTS_PR_URL =
  /^https:\/\/([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)(?:[/?#].*)?$/i;

/**
 * Parse a `--pr` argument.
 *
 * @param input - `auto`, a PR number, or a PR URL.
 * @returns The parsed argument, or `InvalidPrArgument`.
 */
export function parsePrArgument(input: string): Result<PrArgument, InvalidPrArgument> {
  const trimmed = input.trim();
  if (trimmed === "auto") return ok({ _tag: "auto" });
  const number = parsePrNumber(trimmed);
  if (number !== null) return ok({ _tag: "number", number });
  const target = parsePrUrl(trimmed);
  return target === null ? err(new InvalidPrArgument(input)) : ok({ _tag: "url", target });
}

/**
 * Parse a pull request web URL on either forge.
 *
 * @param url - A GitHub `/pull/<n>` or Azure DevOps `/pullrequest/<n>` URL.
 * @returns The target, or `null` when the URL is not a recognized PR URL.
 */
export function parsePrUrl(url: string): PrTarget | null {
  const github = GITHUB_PR_URL.exec(url);
  if (github !== null) {
    const [, owner = "", name = "", digits = ""] = github;
    return withNumber({ _tag: "github", owner, name: stripGitSuffix(name) }, digits);
  }
  const azdo = AZDO_PR_URL.exec(url);
  if (azdo !== null) {
    const [, organization = "", project = "", name = "", digits = ""] = azdo;
    return withNumber(azureRepo(organization, `https://dev.azure.com/${organization}`, project, name), digits);
  }
  const vsts = VSTS_PR_URL.exec(url);
  if (vsts !== null) {
    const [, organization = "", project = "", name = "", digits = ""] = vsts;
    return withNumber(azureRepo(organization, `https://${organization}.visualstudio.com`, project, name), digits);
  }
  return null;
}

/**
 * Parse a git remote URL into a repository on a supported forge.
 *
 * @param remote - Output of `git remote get-url origin` (HTTPS or SSH form).
 * @param forceForge - Interpret the remote as this forge, for SSH host aliases and similar.
 * @returns The repository, or `UnrecognizedRemote`.
 */
export function parseRemoteUrl(remote: string, forceForge: Forge | null): Result<RepoRef, UnrecognizedRemote> {
  const url = remote.trim();
  const azure = parseAzureRemote(url);
  if (azure !== null && forceForge !== "github") return ok(azure);
  const github = parseGitHubRemote(url, forceForge === "github" ? "any" : "github.com");
  if (github !== null && forceForge !== "azdo") return ok(github);
  return err(new UnrecognizedRemote(remote));
}

/**
 * The state-file stem for a pull request: a readable `<forge>-<owner-or-org>-<repo>-<pr>` prefix
 * plus a hash of the canonical identity. The prefix is lossy (`a-b/c` and `a/b-c` both read
 * `a-b-c`); the hash keeps distinct pull requests in distinct files.
 *
 * @param target - The pull request.
 * @returns A filesystem-safe, collision-resistant key.
 */
export function stateKey(target: PrTarget): string {
  const repo = target.repo;
  // Both forges treat these names case-insensitively, so one lowercased identity feeds both parts.
  const [owner, project, name] = [
    repo._tag === "github" ? repo.owner : repo.organization,
    repo._tag === "github" ? "" : repo.project,
    repo.name,
  ].map((part) => part.toLowerCase());
  const prefix = [repo._tag, owner, name, String(target.number)].map((part) => part?.replace(/[^a-z0-9._]/g, "_")).join("-");
  const canonical = JSON.stringify([repo._tag, owner, project, name, target.number]);
  return `${prefix}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/**
 * Format a pull request for messages, e.g. `github owner/repo#12`.
 *
 * @param target - The pull request.
 * @returns A short human-readable label.
 */
export function describeTarget(target: PrTarget): string {
  const repo = target.repo;
  return repo._tag === "github"
    ? `github ${repo.owner}/${repo.name}#${target.number}`
    : `azdo ${repo.organization}/${repo.project}/${repo.name}!${target.number}`;
}

function parseGitHubRemote(url: string, hosts: "github.com" | "any"): GitHubRepo | null {
  const host = hosts === "any" ? "[^/:@]+" : "(?:www\\.)?github\\.com";
  const patterns = [
    new RegExp(`^https?://(?:[^@/]+@)?${host}/([^/]+)/([^/]+?)/?$`, "i"),
    new RegExp(`^(?:ssh://)?[^@/]+@${host}[:/]([^/]+)/([^/]+?)/?$`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (match !== null) {
      const [, owner = "", name = ""] = match;
      return { _tag: "github", owner, name: stripGitSuffix(name) };
    }
  }
  return null;
}

function parseAzureRemote(url: string): AzureRepo | null {
  const https = /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/i.exec(url);
  if (https !== null) {
    const [, organization = "", project = "", name = ""] = https;
    return azureRepo(organization, `https://dev.azure.com/${organization}`, project, name);
  }
  const ssh = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com(?::v3|\/v3)\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(url);
  if (ssh !== null) {
    const [, organization = "", project = "", name = ""] = ssh;
    return azureRepo(organization, `https://dev.azure.com/${organization}`, project, name);
  }
  const vsts = /^https:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/i.exec(
    url,
  );
  if (vsts !== null) {
    const [, organization = "", project = "", name = ""] = vsts;
    return azureRepo(organization, `https://${organization}.visualstudio.com`, project, name);
  }
  const vstsSsh = /^(?:ssh:\/\/)?[^@/]+@vs-ssh\.visualstudio\.com(?::v3|\/v3)\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(url);
  if (vstsSsh !== null) {
    const [, organization = "", project = "", name = ""] = vstsSsh;
    return azureRepo(organization, `https://${organization}.visualstudio.com`, project, name);
  }
  return null;
}

function azureRepo(organization: string, organizationUrl: string, project: string, name: string): AzureRepo {
  return {
    _tag: "azdo",
    organization: safeDecode(organization),
    organizationUrl,
    project: safeDecode(project),
    name: safeDecode(stripGitSuffix(name)),
  };
}

function withNumber(repo: RepoRef, digits: string): PrTarget | null {
  const number = parsePrNumber(digits);
  return number === null ? null : { repo, number };
}

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
