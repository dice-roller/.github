# Dice Roller organisation GitHub configuration

Reusable GitHub Actions workflows and workflow templates for the Dice Roller organisation.

## npm publishing

The shared publishing workflow is at `.github/workflows/npm-publish.yml`. It **stages** the calling repository's package from its `package.json` using npm Trusted Publishing (OIDC). A maintainer then reviews and approves the staged release with 2FA on npmjs.com before it becomes publicly available. No npm access token is stored.

- `main` stages an unpublished version with the npm `latest` dist-tag.
- `next` stages an unpublished version with the npm `next` dist-tag.
- Other branches never stage; already-published versions are skipped.
- Prerelease versions are blocked from the `latest` channel.
- An unexpected registry response fails the workflow instead of treating the package as unpublished.
- Optional caller inputs `test-command` and `build-command` override the default `npm test --if-present` and `npm run build --if-present`.

**Important:** A staged release does not become publicly installable until a maintainer approves it. Once staged, its dist-tag is fixed. Staged versions are **not visible** through the public registry lookup used by this workflow; rerunning before approval may fail because the same version is already staged. Check **Staged Packages** on npmjs.com before retrying. Publishing an existing version again is not possible. Promoting an already-published version from `next` to `latest` requires `npm dist-tag add` separately; this workflow doesn't manage existing tags.

## Add a caller workflow to a package

Copy `workflow-templates/npm-publish.yml` to `.github/workflows/publish.yml` in each package repository, or choose the organisation's **Dice Roller npm publishing** workflow template from GitHub Actions.

By default it references `dice-roller/.github/.github/workflows/npm-publish.yml@main`. Once the central workflow is established, pin the reference to a protected release tag or an immutable commit SHA for stronger supply-chain protection.

### Configure npm Trusted Publishing

In each npm package's npmjs.com settings, create a GitHub Actions Trusted Publisher with:

- **Organisation:** `dice-roller`
- **Repository:** the package's own repository (for example `vitepress-plugin`)
- **Workflow filename:** `publish.yml` (the **calling** workflow, not `npm-publish.yml`)
- **Allowed actions:** leave **Allow npm publish** and **Allow npm dist-tag** unchecked. `npm stage publish` is always permitted.

Do not configure the central `.github` repository as the npm package's Trusted Publisher. Both workflows declare `id-token: write`. GitHub-hosted runners and a compatible Node/npm version are required.

A new Trusted Publisher must complete its first successful release within two days or be recreated. Staged publishing supports new packages too (npm creates a temporary `0.0.0-stage` placeholder), but the release is not complete until you approve the staged version.

### Run manually from GitHub

With the caller workflow on a package's **default branch**, open **Actions → Publish to npm → Run workflow** and choose `main` or `next`. Pushing a new version to either branch also triggers staging automatically. Afterwards, sign in to npmjs.com, open **Staged Packages**, review the artefact and choose **Approve** (2FA required).

### Security and setup notes

- This repository must be **public** for public package repositories to use its reusable workflow and workflow templates.
- Protect `main` and `next` in package repositories, and protect the central workflow's release references.
- The workflow expects one public npm package at the repository root and a committed `package-lock.json`.
- Package-specific test/build commands and `prepublishOnly` scripts may duplicate work; adapt the caller inputs as needed.
- Check that each package's `repository.url` matches its GitHub repository.

## References

- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub organisation workflow templates](https://docs.github.com/en/actions/how-tos/reuse-automations/create-workflow-templates)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
