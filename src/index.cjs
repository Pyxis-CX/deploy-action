const core = require('@actions/core')
const github = require('@actions/github')
const { HttpClient } = require('@actions/http-client')

const { getCurrentVersions } = require('./phases/current-versions.cjs')
const { uploadArtifact } = require('./phases/upload.cjs')
const { terminateOldestVersion } = require('./phases/terminate-oldest.cjs')
const { promoteNewVersion } = require('./phases/promote-version.cjs')
const { deployLatestVersion } = require('./phases/deploy-version.cjs')
const {
  verifyMinimumRunningVersions,
  verifyArcHost,
} = require('./validation.cjs')

const runContext = {
  context: github.context,
  orgId: core.getInput('org-id'),
  apiKey: core.getInput('api-key'),
  apiHostname: core.getInput('api-hostname'),
  bundlePrefix: core.getInput('bundle-prefix'),
  artifact: core.getInput('artifact'),
  retryCount: core.getInput('retry-count'),
  retryDelay: core.getInput('retry-delay'),
  minimumRunningVersions: core.getInput('minimum-running-versions'),
  client: new HttpClient('nodejs - GitHub Actions - arcxp/deploy-action', [], {
    headers: { Authorization: `Bearer ${core.getInput('api-key')}` },
  }),

  core,
}
runContext.bundleName = [
  runContext.bundlePrefix,
  new Date().getTime(),
  runContext.context.ref_name,
  runContext.context.sha,
].join('-')

const retryDelayWait = () =>
  new Promise((res) => setTimeout(() => res(), runContext.retryDelay * 1000))

const main = async () => {
  // A little validation
  verifyMinimumRunningVersions(runContext)
  verifyArcHost(runContext)

  const currentVersions = await getCurrentVersions(runContext)
  core.debug('currentVersions', JSON.stringify(currentVersions, undefined, 2))

  if (!Array.isArray(currentVersions) || !currentVersions.length) {
    return core.setFailed('Unable to determine current versions.')
  }

  const oldestVersion = currentVersions[0]
  const latestVersion = currentVersions[currentVersions.length - 1]

  await uploadArtifact(runContext)
  await deployLatestVersion(runContext)

  // Don't terminate if there aren't more versions than one.
  if (currentVersions.length > runContext.minimumRunningVersions) {
    const termResults = terminateOldestVersion(runContext, oldestVersion)
    core.debug(
      'terminateOldestVersionResults',
      JSON.stringify(termResults, undefined, 2),
    )
  }

  let retriesRemaining = runContext.retryCount

  let newestVersion = undefined
  // Wait for the internal deployer to do its thing.
  while (retriesRemaining >= 0) {
    const newVersions = await getCurrentVersions(runContext)
    core.debug(`New versions: ${JSON.stringify(newVersions, undefined, 2)}`)
    if (newVersions[newVersions.length - 1] !== latestVersion) {
      newestVersion = newVersions[newVersions.length - 1]
      break
    }
    await retryDelayWait()
    retriesRemaining -= 1
  }

  // If we didn't identify the new version, that means we timed out. Boo.
  if (!newestVersion) {
    return core.setFailed(
      `We retried ${runContext.retryCount} times with ${runContext.retryDelay} seconds between retries. Unfortunately, the new version does not appear to have deployed successfully. Please check logs, and contact support if this problem continues.\n\nYou may wish to retry this action again, but with debugging enabled.`,
    )
  } else {
    await promoteNewVersion(runContext, newestVersion)
  }
}

main()
