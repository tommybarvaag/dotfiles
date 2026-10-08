import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Redacted, Result, Schema } from "effect";
import {
  parsePrArgument,
  parsePrNumber,
  parsePrUrl,
  parseRemoteUrl,
  redactUrl,
  stateKey,
  type Forge,
  type PrTarget,
} from "./pr-target.ts";

const remote = (url: string) => Redacted.make(url);
const repoOf = (url: string, force: Forge | null = null) => Result.getOrThrow(parseRemoteUrl(remote(url), force));

/** Owner and repository names as both forges allow them in URLs, mixed case included. */
const Slug = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/));
const Secret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{8,24}$/));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(1_000_000));

describe("parsePrUrl", () => {
  it("reads GitHub PR URLs, including sub-pages", () => {
    assert.deepEqual(parsePrUrl("https://github.com/acme/widgets/pull/42/files"), {
      repo: { _tag: "github", owner: "acme", name: "widgets" },
      number: 42,
    });
  });

  it("reads dev.azure.com PR URLs and decodes encoded project names", () => {
    assert.deepEqual(parsePrUrl("https://dev.azure.com/acme/Acme%20Platform/_git/widgets/pullrequest/77?_a=files"), {
      repo: {
        _tag: "azdo",
        organization: "acme",
        organizationUrl: "https://dev.azure.com/acme",
        project: "Acme Platform",
        name: "widgets",
      },
      number: 77,
    });
  });

  it("reads legacy visualstudio.com PR URLs with DefaultCollection", () => {
    const target = parsePrUrl("https://acme.visualstudio.com/DefaultCollection/Platform/_git/widgets/pullrequest/5");
    assert.equal(target?.repo._tag, "azdo");
    assert.equal(target?.repo._tag === "azdo" ? target.repo.organizationUrl : null, "https://acme.visualstudio.com");
    assert.equal(target?.number, 5);
  });

  it("rejects non-PR URLs", () => {
    assert.equal(parsePrUrl("https://github.com/acme/widgets/issues/42"), null);
    assert.equal(parsePrUrl("https://gitlab.com/acme/widgets/-/merge_requests/1"), null);
  });

  it.prop(
    "reads back the owner, repository and number of any GitHub PR URL",
    { owner: Slug, name: Slug, number: PositiveInt },
    ({ owner, name, number }) => {
      assert.deepEqual(parsePrUrl(`https://github.com/${owner}/${name}/pull/${number}`), {
        repo: { _tag: "github", owner, name: name.endsWith(".git") ? name.slice(0, -4) : name },
        number,
      });
    },
  );
});

describe("parseRemoteUrl", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["https://github.com/acme/widgets.git", "github", "acme/widgets"],
    ["git@github.com:acme/widgets.git", "github", "acme/widgets"],
    ["ssh://git@github.com/acme/widgets", "github", "acme/widgets"],
    ["https://acme@dev.azure.com/acme/Acme%20Platform/_git/widgets", "azdo", "acme/Acme Platform/widgets"],
    ["git@ssh.dev.azure.com:v3/acme/Acme%20Platform/widgets", "azdo", "acme/Acme Platform/widgets"],
    ["https://acme.visualstudio.com/Platform/_git/widgets", "azdo", "acme/Platform/widgets"],
    ["acme@vs-ssh.visualstudio.com:v3/acme/Platform/widgets", "azdo", "acme/Platform/widgets"],
  ];
  for (const [url, forge, path] of cases) {
    it(`detects ${forge} from ${url}`, () => {
      const repo = repoOf(url);
      assert.equal(repo._tag, forge);
      const actual = repo._tag === "github" ? `${repo.owner}/${repo.name}` : `${repo.organization}/${repo.project}/${repo.name}`;
      assert.equal(actual, path);
    });
  }

  it("needs --forge github for an SSH host alias", () => {
    assert.ok(Result.isFailure(parseRemoteUrl(remote("git@github-work:acme/widgets.git"), null)));
    assert.deepEqual(repoOf("git@github-work:acme/widgets.git", "github"), { _tag: "github", owner: "acme", name: "widgets" });
  });

  it("refuses a forge override that contradicts an Azure DevOps remote", () => {
    assert.ok(Result.isFailure(parseRemoteUrl(remote("https://dev.azure.com/acme/Platform/_git/widgets"), "github")));
  });

  it.prop(
    "reads the same GitHub repository from every remote form",
    { owner: Slug, name: Slug.check(Schema.isPattern(/[^.]$/)) },
    ({ owner, name }) => {
      for (const url of [
        `https://github.com/${owner}/${name}.git`,
        `git@github.com:${owner}/${name}.git`,
        `ssh://git@github.com/${owner}/${name}`,
      ]) {
        assert.deepEqual(repoOf(url), { _tag: "github", owner, name });
      }
    },
  );
});

describe("parsePrArgument", () => {
  it("accepts auto, numbers and URLs", () => {
    assert.deepEqual(parsePrArgument("auto"), Result.succeed({ _tag: "auto" }));
    assert.deepEqual(parsePrArgument("12"), Result.succeed({ _tag: "number", number: 12 }));
    const url = parsePrArgument("https://github.com/acme/widgets/pull/3");
    assert.equal(Result.isSuccess(url) ? url.success._tag : null, "url");
  });

  it("rejects zero, negatives and junk", () => {
    for (const input of ["0", "-3", "1.5", "pr-12", ""]) assert.ok(Result.isFailure(parsePrArgument(input)), input);
    assert.equal(parsePrNumber(0), null);
  });

  it.prop("accepts every positive integer and nothing that is not one", { n: Schema.Finite }, ({ n }) => {
    const parsed = parsePrNumber(n);
    assert.equal(parsed, Number.isSafeInteger(n) && n > 0 ? n : null);
  });
});

describe("stateKey", () => {
  const target = (url: string): PrTarget => parsePrUrl(url) ?? assert.fail(`${url} is a PR URL`);

  it("starts with a readable <forge>-<owner-or-org>-<repo>-<pr> prefix", () => {
    assert.match(stateKey(target("https://github.com/acme/widgets/pull/42")), /^github-acme-widgets-42-[0-9a-f]{16}$/);
    assert.match(
      stateKey(target("https://dev.azure.com/acme/Acme%20Platform/_git/my%20repo/pullrequest/7")),
      /^azdo-acme-my_repo-7-[0-9a-f]{16}$/,
    );
  });

  it("keeps a-b/c and a/b-c in separate files", () => {
    assert.notEqual(stateKey(target("https://github.com/a-b/c/pull/1")), stateKey(target("https://github.com/a/b-c/pull/1")));
  });

  it("keeps pull requests whose readable prefixes collide in separate files", () => {
    const spaced = stateKey(target("https://dev.azure.com/acme/p/_git/my%20repo/pullrequest/1"));
    const underscored = stateKey(target("https://dev.azure.com/acme/p/_git/my_repo/pullrequest/1"));
    assert.equal(spaced.slice(0, -17), underscored.slice(0, -17), "same readable prefix");
    assert.notEqual(spaced, underscored);
  });

  it("is the same complete key across letter case, which the forges ignore", () => {
    assert.equal(stateKey(target("https://github.com/Acme/Widgets/pull/42")), stateKey(target("https://github.com/acme/widgets/pull/42")));
    assert.equal(
      stateKey(target("https://dev.azure.com/ACME/Platform/_git/Widgets/pullrequest/7")),
      stateKey(target("https://dev.azure.com/acme/platform/_git/widgets/pullrequest/7")),
    );
  });

  it.prop(
    "is filesystem-safe and ignores letter case for any pull request",
    { owner: Slug, name: Slug, number: PositiveInt },
    ({ owner, name, number }) => {
      const key = stateKey(target(`https://github.com/${owner}/${name}/pull/${number}`));
      assert.match(key, /^[a-z0-9._-]+$/);
      assert.equal(key, stateKey(target(`https://github.com/${owner.toUpperCase()}/${name.toUpperCase()}/pull/${number}`)));
    },
  );
});

describe("credential redaction", () => {
  it("strips userinfo and query strings from URLs", () => {
    assert.equal(
      redactUrl("https://bob:ghp_SECRET@dev.azure.com/acme/p/_git/r?token=SECRET2"),
      "https://dev.azure.com/acme/p/_git/r?***",
    );
    assert.equal(redactUrl("git@github.com:acme/widgets.git"), "git@github.com:acme/widgets.git");
  });

  it("strips userinfo containing several @ signs, parsable or not", () => {
    const multiple = redactUrl("https://bob@example.com:PAT_SECRET@dev.azure.com/o/p/_git/r");
    assert.equal(multiple, "https://dev.azure.com/o/p/_git/r");
    const unparsable = redactUrl("https://a@b:PAT_SECRET@[not-a-host/x");
    assert.doesNotMatch(unparsable, /PAT_SECRET|a@b/);
  });

  it("never echoes a credential-bearing remote in an UnrecognizedRemote error", () => {
    const rejected = parseRemoteUrl(remote("https://bob:PAT_SECRET_123@dev.azure.com/acme/Platform/_git/widgets"), "github");
    assert.ok(Result.isFailure(rejected));
    assert.doesNotMatch(rejected.failure.message, /PAT_SECRET_123|bob/);
    assert.doesNotMatch(rejected.failure.remote, /PAT_SECRET_123/);
  });

  it("never echoes credentials from a rejected --pr value", () => {
    const rejected = parsePrArgument("https://bob:PAT_SECRET_123@gitlab.com/acme/widgets/-/merge_requests/1");
    assert.ok(Result.isFailure(rejected));
    assert.doesNotMatch(rejected.failure.message, /PAT_SECRET_123/);
  });

  it("keeps a remote redacted when it is printed or serialized", () => {
    const secret = remote("https://bob:PAT_SECRET_123@dev.azure.com/acme/Platform/_git/widgets");
    assert.doesNotMatch(`${String(secret)} ${JSON.stringify({ secret })}`, /PAT_SECRET_123/);
  });

  it.prop(
    "never leaks a token from an unrecognized HTTPS remote",
    { user: Slug, token: Secret, host: Slug },
    ({ user, token, host }) => {
      const rejected = parseRemoteUrl(remote(`https://${user}:${token}@${host}.example/acme/widgets`), "azdo");
      assert.ok(Result.isFailure(rejected));
      assert.ok(!rejected.failure.message.includes(token) && !rejected.failure.remote.includes(token));
    },
  );
});
