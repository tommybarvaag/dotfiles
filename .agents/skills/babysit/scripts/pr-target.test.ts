import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePrArgument, parsePrNumber, parsePrUrl, parseRemoteUrl, redactUrl, stateKey, type PrTarget } from "./pr-target.ts";

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
  for (const [remote, forge, path] of cases) {
    it(`detects ${forge} from ${remote}`, () => {
      const repo = parseRemoteUrl(remote, null);
      assert.equal(repo._tag, "ok");
      if (repo._tag !== "ok") return;
      assert.equal(repo.value._tag, forge);
      const actual =
        repo.value._tag === "github"
          ? `${repo.value.owner}/${repo.value.name}`
          : `${repo.value.organization}/${repo.value.project}/${repo.value.name}`;
      assert.equal(actual, path);
    });
  }

  it("needs --forge github for an SSH host alias", () => {
    assert.equal(parseRemoteUrl("git@github-work:acme/widgets.git", null)._tag, "err");
    const forced = parseRemoteUrl("git@github-work:acme/widgets.git", "github");
    assert.deepEqual(forced, { _tag: "ok", value: { _tag: "github", owner: "acme", name: "widgets" } });
  });

  it("refuses a forge override that contradicts an Azure DevOps remote", () => {
    assert.equal(parseRemoteUrl("https://dev.azure.com/acme/Platform/_git/widgets", "github")._tag, "err");
  });
});

describe("parsePrArgument", () => {
  it("accepts auto, numbers and URLs", () => {
    assert.deepEqual(parsePrArgument("auto"), { _tag: "ok", value: { _tag: "auto" } });
    assert.deepEqual(parsePrArgument("12"), { _tag: "ok", value: { _tag: "number", number: 12 } });
    const url = parsePrArgument("https://github.com/acme/widgets/pull/3");
    assert.equal(url._tag === "ok" ? url.value._tag : null, "url");
  });

  it("rejects zero, negatives and junk", () => {
    for (const input of ["0", "-3", "1.5", "pr-12", ""]) assert.equal(parsePrArgument(input)._tag, "err", input);
    assert.equal(parsePrNumber(0), null);
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
    const remote = "https://bob:PAT_SECRET_123@dev.azure.com/acme/Platform/_git/widgets";
    const rejected = parseRemoteUrl(remote, "github");
    assert.equal(rejected._tag, "err");
    if (rejected._tag !== "err") return;
    assert.doesNotMatch(rejected.error.message, /PAT_SECRET_123|bob/);
    assert.doesNotMatch(rejected.error.remote, /PAT_SECRET_123/);
  });

  it("never echoes credentials from a rejected --pr value", () => {
    const rejected = parsePrArgument("https://bob:PAT_SECRET_123@gitlab.com/acme/widgets/-/merge_requests/1");
    assert.equal(rejected._tag, "err");
    assert.doesNotMatch(rejected._tag === "err" ? rejected.error.message : "", /PAT_SECRET_123/);
  });
});
