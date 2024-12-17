/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as os from 'os'
import * as codeWhisperer from '../../client/codewhisperer'
import * as crypto from 'crypto'
import * as CodeWhispererConstants from '../../models/constants'
import * as localizedText from '../../../shared/localizedText'
import {
    BuildSystem,
    FolderInfo,
    HilZipManifest,
    IHilZipManifestParams,
    jobPlanProgress,
    sessionJobHistory,
    StepProgress,
    transformByQState,
    TransformByQStatus,
    TransformByQStoppedError,
    ZipManifest,
} from '../../models/model'
import { getLogger } from '../../../shared/logger'
import {
    CreateUploadUrlResponse,
    ProgressUpdates,
    TransformationProgressUpdate,
    TransformationSteps,
    TransformationUserActionStatus,
    UploadContext,
} from '../../client/codewhispereruserclient'
import { sleep } from '../../../shared/utilities/timeoutUtils'
import AdmZip from 'adm-zip'
import globals from '../../../shared/extensionGlobals'
import { CredentialSourceId, telemetry } from '../../../shared/telemetry/telemetry'
import { CodeTransformTelemetryState } from '../../../amazonqGumby/telemetry/codeTransformTelemetryState'
import { calculateTotalLatency, CancelActionPositions } from '../../../amazonqGumby/telemetry/codeTransformTelemetry'
import { MetadataResult } from '../../../shared/telemetry/telemetryClient'
import request from '../../../common/request'
import { JobStoppedError, ZipExceedsSizeLimitError } from '../../../amazonqGumby/errors'
import { shouldIncludeDirectoryInZip, writeLogs } from './transformFileHandler'
import { AuthUtil } from '../../util/authUtil'
import { createCodeWhispererChatStreamingClient } from '../../../shared/clients/codewhispererChatClient'
import { downloadExportResultArchive } from '../../../shared/utilities/download'
import { ExportIntent, TransformationDownloadArtifactType } from '@amzn/codewhisperer-streaming'
import { fsCommon } from '../../../srcShared/fs'
import { ChatSessionManager } from '../../../amazonqGumby/chat/storages/chatSession'
import { convertToTimeString, encodeHTML } from '../../../shared/utilities/textUtilities'
import { spawnSync } from 'child_process'
import { stopTransformByQ } from '../../commands/startTransformByQ'
import { DiffModel } from './transformationResultsViewProvider'

export function getSha256(buffer: Buffer) {
    const hasher = crypto.createHash('sha256')
    hasher.update(buffer)
    return hasher.digest('base64')
}

export async function getAuthType() {
    let authType: CredentialSourceId | undefined = undefined
    if (AuthUtil.instance.isEnterpriseSsoInUse() && AuthUtil.instance.isConnectionValid()) {
        authType = 'iamIdentityCenter'
    } else if (AuthUtil.instance.isBuilderIdInUse() && AuthUtil.instance.isConnectionValid()) {
        authType = 'awsId'
    }
    return authType
}

export function throwIfCancelled() {
    if (transformByQState.isCancelled()) {
        throw new TransformByQStoppedError()
    }
}

export function updateJobHistory() {
    if (transformByQState.getJobId() !== '') {
        sessionJobHistory[transformByQState.getJobId()] = {
            startTime: transformByQState.getStartTime(),
            projectName: transformByQState.getProjectName(),
            status: transformByQState.getPolledJobStatus(),
            duration: convertToTimeString(calculateTotalLatency(CodeTransformTelemetryState.instance.getStartTime())),
        }
    }
    return sessionJobHistory
}

export function getHeadersObj(sha256: string, kmsKeyArn: string | undefined) {
    let headersObj = {}
    if (kmsKeyArn === undefined || kmsKeyArn.length === 0) {
        headersObj = {
            'x-amz-checksum-sha256': sha256,
            'Content-Type': 'application/zip',
        }
    } else {
        headersObj = {
            'x-amz-checksum-sha256': sha256,
            'Content-Type': 'application/zip',
            'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': kmsKeyArn,
        }
    }
    return headersObj
}

// Consider enhancing the S3 client to include this functionality
export async function uploadArtifactToS3(
    fileName: string,
    resp: CreateUploadUrlResponse,
    sha256: string,
    buffer: Buffer
) {
    throwIfCancelled()
    try {
        const uploadFileByteSize = (await fs.promises.stat(fileName)).size
        getLogger().info(
            `Uploading zip at %s with checksum %s using uploadId: %s and size %s kB`,
            fileName,
            sha256,
            resp.uploadId,
            Math.round(uploadFileByteSize / 1000)
        )

        const response = await request.fetch('PUT', resp.uploadUrl, {
            body: buffer,
            headers: getHeadersObj(sha256, resp.kmsKeyArn),
        }).response
        getLogger().info(`CodeTransformation: Status from S3 Upload = ${response.status}`)
    } catch (e: any) {
        let errorMessage = `The upload failed due to: ${(e as Error).message}`
        if (errorMessage.includes('Request has expired')) {
            errorMessage = CodeWhispererConstants.errorUploadingWithExpiredUrl
        } else if (errorMessage.includes('Failed to establish a socket connection')) {
            errorMessage = CodeWhispererConstants.socketConnectionFailed
        } else if (errorMessage.includes('self signed certificate in certificate chain')) {
            errorMessage = CodeWhispererConstants.selfSignedCertificateError
        }
        getLogger().error(`CodeTransformation: UploadZip error = ${e}`)
        throw new Error(errorMessage)
    }
}

export async function resumeTransformationJob(jobId: string, userActionStatus: TransformationUserActionStatus) {
    try {
        const response = await codeWhisperer.codeWhispererClient.codeModernizerResumeTransformation({
            transformationJobId: jobId,
            userActionStatus, // can be "COMPLETED" or "REJECTED"
        })
        if (response) {
            // always store request ID, but it will only show up in a notification if an error occurs
            return response.transformationStatus
        }
    } catch (e: any) {
        const errorMessage = `Resuming the job failed due to: ${(e as Error).message}`
        getLogger().error(`CodeTransformation: ResumeTransformation error = ${errorMessage}`)
        throw new Error(errorMessage)
    }
}

export async function stopJob(jobId: string) {
    if (!jobId) {
        return
    }

    try {
        const response = await codeWhisperer.codeWhispererClient.codeModernizerStopCodeTransformation({
            transformationJobId: jobId,
        })
        if (response !== undefined) {
            // always store request ID, but it will only show up in a notification if an error occurs
            if (response.$response.requestId) {
                transformByQState.setJobFailureMetadata(` (request ID: ${response.$response.requestId})`)
            }
        }
    } catch (e: any) {
        const errorMessage = (e as Error).message
        getLogger().error(`CodeTransformation: StopTransformation error = ${errorMessage}`)
        throw new Error('Stop job failed')
    }
}

export async function uploadPayload(payloadFileName: string, uploadContext?: UploadContext) {
    const buffer = fs.readFileSync(payloadFileName)
    const sha256 = getSha256(buffer)

    throwIfCancelled()
    let response = undefined
    try {
        response = await codeWhisperer.codeWhispererClient.createUploadUrl({
            contentChecksum: sha256,
            contentChecksumType: CodeWhispererConstants.contentChecksumType,
            uploadIntent: CodeWhispererConstants.uploadIntent,
            uploadContext,
        })
        if (response.$response.requestId) {
            transformByQState.setJobFailureMetadata(` (request ID: ${response.$response.requestId})`)
        }
    } catch (e: any) {
        const errorMessage = `The upload failed due to: ${(e as Error).message}`
        getLogger().error(`CodeTransformation: CreateUploadUrl error: = ${e}`)
        throw new Error(errorMessage)
    }
    try {
        await uploadArtifactToS3(payloadFileName, response, sha256, buffer)
    } catch (e: any) {
        const errorMessage = (e as Error).message
        getLogger().error(`CodeTransformation: UploadArtifactToS3 error: = ${errorMessage}`)
        throw new Error(errorMessage)
    }

    // UploadContext only exists for subsequent uploads, and they will return a uploadId that is NOT
    // the jobId. Only the initial call will uploadId be the jobId
    if (!uploadContext) {
        transformByQState.setJobId(encodeHTML(response.uploadId))
    }
    jobPlanProgress['uploadCode'] = StepProgress.Succeeded
    updateJobHistory()
    return response.uploadId
}

const excludedFiles = ['.repositories', '.sha1', '.lock', 'gc.properties', '.dll']

// exclude these files from ZIP as they may interfere with backend build
function isExcludedFile(path: string): boolean {
    return excludedFiles.some(extension => path.endsWith(extension))
}

/**
 * Get all files in dir. If zipping the dependencies, include everything.
 * If zipping source code, exclude folders with large JARs as our backend can't handle them.
 * isDependenciesFolder will always be false for Gradle projects since we include the
 * dependencies in the same parent directory as the source code.
 */
function getFilesRecursively(dir: string, isDependenciesFolder: boolean): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const files = entries.flatMap((entry: { name: string; isDirectory: () => any }) => {
        const res = path.resolve(dir, entry.name)
        if (entry.isDirectory()) {
            if (isDependenciesFolder || shouldIncludeDirectoryInZip(entry.name)) {
                return getFilesRecursively(res, isDependenciesFolder)
            } else {
                return []
            }
        } else {
            return [res]
        }
    })
    return files
}

interface IZipManifestParams {
    hilZipParams?: IHilZipManifestParams
}
export function createZipManifest({ hilZipParams }: IZipManifestParams) {
    const zipManifest = hilZipParams ? new HilZipManifest(hilZipParams) : new ZipManifest()
    return zipManifest
}

interface IZipCodeParams {
    dependenciesFolder: FolderInfo | undefined // will be undefined for Gradle projects
    humanInTheLoopFlag?: boolean
    modulePath?: string
    zipManifest: ZipManifest | HilZipManifest
}

export async function zipCode({ dependenciesFolder, humanInTheLoopFlag, modulePath, zipManifest }: IZipCodeParams) {
    let tempFilePath = undefined
    let logFilePath = undefined
    try {
        throwIfCancelled()
        const zip = new AdmZip()

        // If no modulePath is passed in, we are not uploading the source folder.
        // For HIL, only dependencies are uploaded
        if (modulePath) {
            const sourceFiles = getFilesRecursively(modulePath, false)
            let sourceFilesSize = 0
            for (const file of sourceFiles) {
                if ((await fs.stat(file)).isDirectory()) {
                    getLogger().info(`CodeTransformation: Skipping directory: ${file}, likely a symlink`)
                    continue
                }
                if (isExcludedFile(file)) {
                    getLogger().info(`CodeTransformation: Skipping excluded file: ${file}`)
                    continue
                }
                const relativePath = path.relative(modulePath, file)
                const paddedPath = path.join('sources', relativePath)
                zip.addLocalFile(file, path.dirname(paddedPath))
                sourceFilesSize += (await fs.promises.stat(file)).size
            }
            getLogger().info(`CodeTransformation: source code files size = ${sourceFilesSize}`)
        }

        throwIfCancelled()

        if (dependenciesFolder) {
            // must be a Maven project
            let dependencyFiles: string[] = []
            if (fs.existsSync(dependenciesFolder.path)) {
                dependencyFiles = getFilesRecursively(dependenciesFolder.path, true)
            }

            if (dependencyFiles.length > 0) {
                let dependencyFilesSize = 0
                for (const file of dependencyFiles) {
                    if (isExcludedFile(file)) {
                        continue
                    }
                    const relativePath = path.relative(dependenciesFolder.path, file)
                    const paddedPath = path.join(`dependencies/`, relativePath)
                    zip.addLocalFile(file, path.dirname(paddedPath))
                    dependencyFilesSize += (await fs.promises.stat(file)).size
                }
                getLogger().info(`CodeTransformation: dependency files size = ${dependencyFilesSize}`)
            } else {
                if (zipManifest instanceof ZipManifest) {
                    zipManifest.dependenciesRoot = undefined
                }
            }
        }

        if (zipManifest instanceof ZipManifest) {
            // buildSystem must be defined at this point
            zipManifest.buildTool = transformByQState.getBuildSystem()
            // not including the "dependencies/" directory for Gradle projects, so omit this key from the manifest.json
            // also, for now, disable HIL for Gradle projects; this is enforced in the backend too
            if (transformByQState.getBuildSystem() === BuildSystem.Gradle) {
                zipManifest.dependenciesRoot = undefined
                zipManifest.hilCapabilities = undefined
            }
        }

        zip.addFile('manifest.json', Buffer.from(JSON.stringify(zipManifest)), 'utf-8')

        throwIfCancelled()

        // add text file with logs from mvn clean install and mvn copy-dependencies / Gradle script
        logFilePath = await writeLogs()
        // We don't add build-logs.txt file to the manifest if we are uploading HIL artifacts
        if (!humanInTheLoopFlag) {
            zip.addLocalFile(logFilePath)
        }

        tempFilePath = path.join(os.tmpdir(), 'zipped-code.zip')
        fs.writeFileSync(tempFilePath, zip.toBuffer())
        if (dependenciesFolder && fs.existsSync(dependenciesFolder.path)) {
            fs.rmSync(dependenciesFolder.path, { recursive: true, force: true })
        }
    } catch (e: any) {
        throw Error('Failed to zip project due to: ' + (e as Error).message)
    } finally {
        if (logFilePath) {
            fs.rmSync(logFilePath)
        }
    }

    const zipSize = (await fs.promises.stat(tempFilePath)).size

    const exceedsLimit = zipSize > CodeWhispererConstants.uploadZipSizeLimitInBytes

    getLogger().info(`CodeTransformation: created ZIP of size ${zipSize} at ${tempFilePath}`)

    if (exceedsLimit) {
        void vscode.window.showErrorMessage(CodeWhispererConstants.projectSizeTooLargeNotification)
        transformByQState.getChatControllers()?.transformationFinished.fire({
            message: CodeWhispererConstants.projectSizeTooLargeChatMessage,
            tabID: ChatSessionManager.Instance.getSession().tabID,
        })
        throw new ZipExceedsSizeLimitError()
    }
    getLogger().info(`CodeTransformation: zip path = ${tempFilePath}`)
    return tempFilePath
}

export async function startJob(uploadId: string) {
    const sourceLanguageVersion = `JAVA_${transformByQState.getSourceJDKVersion()}`
    const targetLanguageVersion = `JAVA_${transformByQState.getTargetJDKVersion()}`
    try {
        const response = await codeWhisperer.codeWhispererClient.codeModernizerStartCodeTransformation({
            workspaceState: {
                uploadId: uploadId,
                programmingLanguage: { languageName: CodeWhispererConstants.defaultLanguage.toLowerCase() },
            },
            transformationSpec: {
                transformationType: CodeWhispererConstants.transformationType,
                source: { language: sourceLanguageVersion },
                target: { language: targetLanguageVersion },
            },
        })
        if (response.$response.requestId) {
            transformByQState.setJobFailureMetadata(` (request ID: ${response.$response.requestId})`)
        }
        return response.transformationJobId
    } catch (e: any) {
        const errorMessage = `Starting the job failed due to: ${(e as Error).message}`
        getLogger().error(`CodeTransformation: StartTransformation error = ${errorMessage}`)
        throw new Error(errorMessage)
    }
}

export function getImageAsBase64(filePath: string) {
    const fileContents = fs.readFileSync(filePath, { encoding: 'base64' })
    return `data:image/svg+xml;base64,${fileContents}`
}

/*
 * Given the icon name from core/resources/icons/aws/amazonq, get the appropriate icon according to the user's theme.
 * ex. getIcon('transform-file') returns the 'transform-file-light.svg' icon if user has a light theme enabled,
 * otherwise 'transform-file-dark.svg' is returned.
 */
export function getTransformationIcon(name: string) {
    let iconPath = ''
    switch (name) {
        case 'linesOfCode':
            iconPath = 'transform-variables'
            break
        case 'plannedDependencyChanges':
            iconPath = 'transform-dependencies'
            break
        case 'plannedDeprecatedApiChanges':
            iconPath = 'transform-step-into'
            break
        case 'plannedFileChanges':
            iconPath = 'transform-file'
            break
        case 'upArrow':
            iconPath = 'transform-arrow'
            break
        case 'transformLogo':
            return getImageAsBase64(globals.context.asAbsolutePath('resources/icons/aws/amazonq/transform-logo.svg'))
        default:
            iconPath = 'transform-default'
            break
    }
    const themeColor = vscode.window.activeColorTheme.kind
    if (themeColor === vscode.ColorThemeKind.Light || themeColor === vscode.ColorThemeKind.HighContrastLight) {
        iconPath += '-light.svg'
    } else {
        iconPath += '-dark.svg'
    }
    return getImageAsBase64(globals.context.asAbsolutePath(path.join('resources/icons/aws/amazonq', iconPath)))
}

export function getFormattedString(s: string) {
    return CodeWhispererConstants.formattedStringMap.get(s) ?? s
}

export function addTableMarkdown(plan: string, stepId: string, tableMapping: { [key: string]: string }) {
    const tableObj = tableMapping[stepId]
    if (!tableObj) {
        // no table present for this step
        return plan
    }
    const table = JSON.parse(tableObj)
    plan += `\n\n\n${table.name}\n|`
    const columns = table.columnNames
    columns.forEach((columnName: string) => {
        plan += ` ${getFormattedString(columnName)} |`
    })
    plan += '\n|'
    columns.forEach((_: any) => {
        plan += '-----|'
    })
    table.rows.forEach((row: any) => {
        plan += '\n|'
        columns.forEach((columnName: string) => {
            if (columnName === 'relativePath') {
                plan += ` [${row[columnName]}](${row[columnName]}) |` // add MD link only for files
            } else {
                plan += ` ${row[columnName]} |`
            }
        })
    })
    plan += '\n\n'
    return plan
}

export function getTableMapping(stepZeroProgressUpdates: ProgressUpdates) {
    const map: { [key: string]: string } = {}
    stepZeroProgressUpdates.forEach(update => {
        // description should never be undefined since even if no data we show an empty table
        // but just in case, empty string allows us to skip this table without errors when rendering
        map[update.name] = update.description ?? ''
    })
    return map
}

export function getJobStatisticsHtml(jobStatistics: any) {
    let htmlString = ''
    if (jobStatistics.length === 0) {
        return htmlString
    }
    htmlString += `<div style="flex: 1; margin-left: 20px; border: 1px solid #424750; border-radius: 8px; padding: 10px;">`
    jobStatistics.forEach((stat: { name: string; value: string }) => {
        htmlString += `<p style="margin-bottom: 4px"><img src="${getTransformationIcon(
            stat.name
        )}" style="vertical-align: middle;"> ${getFormattedString(stat.name)}: ${stat.value}</p>`
    })
    htmlString += `</div>`
    return htmlString
}

export async function getTransformationPlan(jobId: string) {
    let response = undefined
    try {
        response = await codeWhisperer.codeWhispererClient.codeModernizerGetCodeTransformationPlan({
            transformationJobId: jobId,
        })
        if (response.$response.requestId) {
            transformByQState.setJobFailureMetadata(` (request ID: ${response.$response.requestId})`)
        }

        // TO-DO: remove this once Gradle plan becomes dynamic, and don't forget to un-comment EXPLAINABILITY in manifest
        if (transformByQState.getBuildSystem() === BuildSystem.Gradle) {
            const logoIcon = getTransformationIcon('transformLogo')
            let plan = `![Transform by Q](${logoIcon}) \n # Code Transformation Plan by Amazon Q \n\n`
            plan += `${CodeWhispererConstants.planIntroductionMessage}\n\n`
            plan += `\n\n${CodeWhispererConstants.planDisclaimerMessage}\n\n\n\n`
            for (const step of response.transformationPlan.transformationSteps) {
                plan += `**${step.name}**\n\n- ${step.description}\n\n\n`
            }
            return plan
        }

        const stepZeroProgressUpdates = response.transformationPlan.transformationSteps[0].progressUpdates

        if (!stepZeroProgressUpdates || stepZeroProgressUpdates.length === 0) {
            // means backend API response wrong and table data is missing
            throw new Error('No progress updates found in step 0')
        }

        // gets a mapping between the ID ('name' field) of each progressUpdate (substep) and the associated table
        const tableMapping = getTableMapping(stepZeroProgressUpdates)

        const jobStatistics = JSON.parse(tableMapping['0']).rows // ID of '0' reserved for job statistics table

        // get logo directly since we only use one logo regardless of color theme
        const logoIcon = getTransformationIcon('transformLogo')

        const arrowIcon = getTransformationIcon('upArrow')

        let plan = `<style>table {border: 1px solid #424750;}</style>\n\n<a id="top"></a><br><p style="font-size: 24px;"><img src="${logoIcon}" style="margin-right: 15px; vertical-align: middle;"></img><b>${CodeWhispererConstants.planTitle}</b></p><br>`
        plan += `<div style="display: flex;"><div style="flex: 1; border: 1px solid #424750; border-radius: 8px; padding: 10px;"><p>${
            CodeWhispererConstants.planIntroductionMessage
        }</p></div>${getJobStatisticsHtml(jobStatistics)}</div>`
        plan += `<div style="margin-top: 32px; border: 1px solid #424750; border-radius: 8px; padding: 10px;"><p style="font-size: 18px; margin-bottom: 4px;"><b>${CodeWhispererConstants.planHeaderMessage}</b></p><i>${CodeWhispererConstants.planDisclaimerMessage} <a href="https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/code-transformation.html">Read more.</a></i><br><br>`
        response.transformationPlan.transformationSteps.slice(1).forEach(step => {
            plan += `<div style="border: 1px solid #424750; border-radius: 8px; padding: 20px;"><div style="display:flex; justify-content:space-between; align-items:center;"><p style="font-size: 16px; margin-bottom: 4px;">${step.name}</p><a href="#top">Scroll to top <img src="${arrowIcon}" style="vertical-align: middle"></a></div><p>${step.description}</p>`
            plan = addTableMarkdown(plan, step.id, tableMapping)
            plan += `</div><br>`
        })
        plan += `</div><br>`
        plan += `<p style="font-size: 18px; margin-bottom: 4px;"><b>Appendix</b><br><a href="#top" style="float: right; font-size: 14px;">Scroll to top <img src="${arrowIcon}" style="vertical-align: middle;"></a></p><br>`
        plan = addTableMarkdown(plan, '-1', tableMapping) // ID of '-1' reserved for appendix table
        return plan
    } catch (e: any) {
        const errorMessage = (e as Error).message
        getLogger().error(`CodeTransformation: GetTransformationPlan error = ${errorMessage}`)

        /* Means API call failed
         * If response is defined, means a display/parsing error occurred, so continue transformation
         */
        if (response === undefined) {
            throw new Error('Get plan API call failed')
        }
    }
}

export async function getTransformationSteps(jobId: string, handleThrottleFlag: boolean) {
    try {
        // prevent ThrottlingException
        if (handleThrottleFlag) {
            await sleep(2000)
        }
        const response = await codeWhisperer.codeWhispererClient.codeModernizerGetCodeTransformationPlan({
            transformationJobId: jobId,
        })
        if (response.$response.requestId) {
            transformByQState.setJobFailureMetadata(` (request ID: ${response.$response.requestId})`)
        }
        // TO-DO: add back the .slice(1) once Gradle plan becomes dynamic
        return response.transformationPlan.transformationSteps // skip step 0 (contains supplemental info)
    } catch (e: any) {
        const errorMessage = (e as Error).message
        getLogger().error(`CodeTransformation: GetTransformationPlan error = ${errorMessage}`)
        throw e
    }
}

export async function pollTransformationJob(jobId: string, validStates: string[]) {
    let status: string = ''
    let timer: number = 0
    while (true) {
        throwIfCancelled()
        try {
            const response = await codeWhisperer.codeWhispererClient.codeModernizerGetCodeTransformation({
                transformationJobId: jobId,
            })
            status = response.transformationJob.status!
            if (CodeWhispererConstants.validStatesForBuildSucceeded.includes(status)) {
                jobPlanProgress['buildCode'] = StepProgress.Succeeded
            }
            // emit metric when job status changes
            if (status !== transformByQState.getPolledJobStatus()) {
                telemetry.codeTransform_jobStatusChanged.emit({
                    codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
                    codeTransformJobId: jobId,
                    codeTransformStatus: status,
                    result: MetadataResult.Pass,
                    codeTransformPreviousStatus: transformByQState.getPolledJobStatus(),
                })
            }
            transformByQState.setPolledJobStatus(status)

            const errorMessage = response.transformationJob.reason
            if (errorMessage !== undefined) {
                if (errorMessage.includes('Monthly aggregated Lines of Code limit breached')) {
                    transformByQState.setJobFailureErrorNotification(
                        CodeWhispererConstants.failedToStartJobMonthlyLimitNotification
                    )
                    transformByQState.setJobFailureErrorChatMessage(
                        CodeWhispererConstants.failedToStartJobMonthlyLimitChatMessage
                    )
                } else if (errorMessage.includes('Lines of Code limit breached for job')) {
                    transformByQState.setJobFailureErrorNotification(
                        CodeWhispererConstants.failedToStartJobLinesLimitNotification
                    )
                    transformByQState.setJobFailureErrorChatMessage(
                        CodeWhispererConstants.failedToStartJobLinesLimitChatMessage
                    )
                } else {
                    transformByQState.setJobFailureErrorChatMessage(
                        `${CodeWhispererConstants.failedToCompleteJobGenericChatMessage} ${errorMessage}`
                    )
                    transformByQState.setJobFailureErrorNotification(
                        `${CodeWhispererConstants.failedToCompleteJobGenericNotification} ${errorMessage}`
                    )
                }
                transformByQState.setJobFailureMetadata(` (request ID: ${response.$response.requestId})`)
            }
            if (validStates.includes(status)) {
                break
            }

            if (
                CodeWhispererConstants.validStatesForPlanGenerated.includes(status) &&
                !transformByQState.getWaitingForClientSideBuildAuthorization()
            ) {
                // only process awaiting client action when plan is generated (status = transforming)
                await sleep(CodeWhispererConstants.transformationJobPollingIntervalSeconds * 1000)
                await processAwaitingClientActionStatus(jobId)
            }
            /**
             * If we find a paused state, we need the user to take action. We will set the global
             * state for polling status and early exit.
             */
            if (CodeWhispererConstants.pausedStates.includes(status)) {
                transformByQState.setPolledJobStatus(TransformByQStatus.WaitingUserInput)
                break
            }
            /*
             * Below IF is only relevant for pollTransformationStatusUntilPlanReady, when pollTransformationStatusUntilComplete
             * is called, we break above on validStatesForCheckingDownloadUrl and check final status in finalizeTransformationJob
             */
            if (CodeWhispererConstants.failureStates.includes(status)) {
                transformByQState.setJobFailureMetadata(` (request ID: ${response.$response.requestId})`)
                throw new JobStoppedError(response.$response.requestId)
            }
            await sleep(CodeWhispererConstants.transformationJobPollingIntervalSeconds * 1000)
            timer += CodeWhispererConstants.transformationJobPollingIntervalSeconds
            if (timer > CodeWhispererConstants.transformationJobTimeoutSeconds) {
                throw new Error('Job timed out')
            }
        } catch (e: any) {
            let errorMessage = (e as Error).message
            errorMessage += ` -- ${transformByQState.getJobFailureMetadata()}`
            getLogger().error(`CodeTransformation: GetTransformation error = ${errorMessage}`)
            throw e
        }
    }
    return status
}

export function getArtifactsFromProgressUpdate(progressUpdate?: TransformationProgressUpdate) {
    const artifactType = progressUpdate?.downloadArtifacts?.[0]?.downloadArtifactType
    const artifactId = progressUpdate?.downloadArtifacts?.[0]?.downloadArtifactId
    return {
        artifactId,
        artifactType,
    }
}

export function findDownloadArtifactStep(transformationSteps: TransformationSteps) {
    for (let i = 0; i < transformationSteps.length; i++) {
        const progressUpdates = transformationSteps[i].progressUpdates
        if (progressUpdates?.length) {
            for (let j = 0; j < progressUpdates.length; j++) {
                if (
                    progressUpdates[j].downloadArtifacts?.[0]?.downloadArtifactType ||
                    (progressUpdates[j].downloadArtifacts?.[0]?.downloadArtifactId &&
                        progressUpdates[j].status === 'AWAITING_CLIENT_ACTION')
                ) {
                    return {
                        transformationStep: transformationSteps[i],
                        progressUpdate: progressUpdates[j],
                    }
                }
            }
        }
    }
    return {
        transformationStep: undefined,
        progressUpdate: undefined,
    }
}

export async function downloadResultArchive(
    jobId: string,
    downloadArtifactId: string | undefined,
    pathToArchive: string,
    downloadArtifactType: TransformationDownloadArtifactType
) {
    const cwStreamingClient = await createCodeWhispererChatStreamingClient()
    try {
        await downloadExportResultArchive(
            cwStreamingClient,
            {
                exportId: jobId,
                exportIntent: ExportIntent.TRANSFORMATION,
                ...(downloadArtifactId !== undefined && {
                    exportContext: { transformationExportContext: { downloadArtifactId, downloadArtifactType } },
                }),
            },
            pathToArchive
        )
    } catch (e: any) {
        const downloadErrorMessage = (e as Error).message
        getLogger().error(`CodeTransformation: ExportResultArchive error = ${downloadErrorMessage}`)
        throw e
    } finally {
        cwStreamingClient.destroy()
    }
}

export async function downloadAndExtractResultArchive(
    jobId: string,
    downloadArtifactId: string | undefined,
    pathToArchiveDir: string,
    downloadArtifactType: TransformationDownloadArtifactType
) {
    const archivePathExists = await fsCommon.existsDir(pathToArchiveDir)
    if (!archivePathExists) {
        await fsCommon.mkdir(pathToArchiveDir)
    }
    const pathToArchive = path.join(pathToArchiveDir, 'ExportResultsArchive.zip')

    let downloadErrorMessage = undefined
    try {
        // Download and deserialize the zip
        await downloadResultArchive(jobId, downloadArtifactId, pathToArchive, downloadArtifactType)
        const zip = new AdmZip(pathToArchive)
        zip.extractAllTo(pathToArchiveDir)
    } catch (e) {
        downloadErrorMessage = (e as Error).message
        getLogger().error(`CodeTransformation: ExportResultArchive error = ${downloadErrorMessage}`)
        throw new Error('Error downloading transformation result artifacts: ' + downloadErrorMessage)
    }
}

export async function downloadHilResultArchive(jobId: string, downloadArtifactId: string, pathToArchiveDir: string) {
    await downloadAndExtractResultArchive(
        jobId,
        downloadArtifactId,
        pathToArchiveDir,
        TransformationDownloadArtifactType.CLIENT_INSTRUCTIONS
    )

    // manifest.json
    // pomFolder/pom.xml or manifest has pomFolderName path
    const manifestFileVirtualFileReference = vscode.Uri.file(path.join(pathToArchiveDir, 'manifest.json'))
    const pomFileVirtualFileReference = vscode.Uri.file(path.join(pathToArchiveDir, 'pomFolder', 'pom.xml'))
    return { manifestFileVirtualFileReference, pomFileVirtualFileReference }
}

export async function processAwaitingClientActionStatus(jobId: string) {
    // process client-side build results
    throwIfCancelled()
    await sleep(CodeWhispererConstants.transformationJobPollingIntervalSeconds * 1000)
    // get client instructions artifact ID
    let transformationStatus = await getClientInstructionArtifactId(jobId)
    if (transformationStatus === undefined) {
        getLogger().error('Client Instruction Artifact ID is undefined')
        return
    }
    if (transformationStatus?.IsWaitingForClientAction) {
        // extract client instructions
        if (!transformationStatus.ClientInstructionArtifactId) {
            throw new Error('Failed to get client instruction artifact ID')
        }
        await sleep(CodeWhispererConstants.transformationJobPollingIntervalSeconds * 1000)
        let clientInstructions = await extractClientInstructions(
            jobId,
            transformationStatus.ClientInstructionArtifactId
        )
        // process client instructions
        try {
            await sleep(CodeWhispererConstants.transformationJobPollingIntervalSeconds * 1000)
            await processClientInstructions(jobId, clientInstructions, transformationStatus.ClientInstructionArtifactId)
        } catch (err) {
            throw new Error('process client instructions failed: ' + err)
        }
    }
}

async function getClientInstructionArtifactId(jobId: string) {
    // Service call 2) GetTransformationPlan for step-by-step status
    await sleep(CodeWhispererConstants.transformationJobPollingIntervalSeconds * 1000)
    const plan_status = await getTransformationSteps(jobId, false)
    const { transformationStep, progressUpdate } = findDownloadArtifactStep(plan_status)
    getLogger().info(`transformationStep: ${transformationStep}, progressUpdate: ${progressUpdate}`)
    getLogger().info(
        `current progressUpdate: name = ${progressUpdate?.name}, status = ${progressUpdate?.status}, description = ${progressUpdate?.description}`
    )
    if (progressUpdate?.status === 'AWAITING_CLIENT_ACTION') {
        let artifact = progressUpdate.downloadArtifacts?.[0]
        let download_artifact_type = artifact?.downloadArtifactType
        getLogger().info(`download_artifact_type: ${download_artifact_type}`)
        if (download_artifact_type !== 'CLIENT_INSTRUCTIONS') {
            throw new Error(
                'Received unexpected downloadArtifactType: ' + download_artifact_type + 'for jobId: ' + jobId
            )
        }
        let clientInstructionArtifactId = artifact?.downloadArtifactId
        getLogger().info(`clientInstructionArtifactId: ${clientInstructionArtifactId}`)
        return {
            IsTransformationCompleted: false,
            IsWaitingForClientAction: true,
            ClientInstructionArtifactId: clientInstructionArtifactId,
        }
    }
}
async function loadManifestFile(directory: string): Promise<any> {
    try {
        const manifestPath = path.join(directory, 'manifest.json')
        const data = await fs.readFile(manifestPath, 'utf8')
        const manifest = JSON.parse(data)
        return manifest
    } catch (err) {
        throw new Error(`Error reading manifest file: ${err}`)
    }
}
function copyDirectory(sourcePath: string, destinationPath: string): void {
    // Create the destination directory if it doesn't exist
    fs.mkdirSync(destinationPath, { recursive: true })
    // Read the contents of the source directory
    const files = fs.readdirSync(sourcePath)
    // Loop through each item in the source directory
    for (const file of files) {
        const sourceFilePath = path.join(sourcePath, file)
        const destinationFilePath = path.join(destinationPath, file)
        // Check if the item is a directory or a file
        const stats = fs.statSync(sourceFilePath)
        // Skip hidden directories and files
        if (file.startsWith('.')) {
            continue
        }
        if (stats.isDirectory()) {
            // If the item is a directory, recursively copy it
            const destinationFilePath = path.join(destinationPath, path.relative(sourcePath, sourceFilePath))
            copyDirectory(sourceFilePath, destinationFilePath)
        } else {
            // If the item is a file, copy its contents
            fs.copyFileSync(sourceFilePath, destinationFilePath)
        }
    }
}

async function extractClientInstructions(jobId: string, clientInstructionsArtifactId: string) {
    const operationName = 'client_instructions' // only used for logging and file naming purposes
    let exportDestination = `${operationName}_${clientInstructionsArtifactId}`
    let exportZipPath: string = path.join(os.tmpdir(), `${exportDestination}.zip`)
    getLogger().info(`Downloading client instructions`)
    await downloadAndExtractResultArchive(
        jobId,
        clientInstructionsArtifactId,
        exportZipPath,
        TransformationDownloadArtifactType.CLIENT_INSTRUCTIONS
    )
    let clientInstructionsManifest = await loadManifestFile(exportZipPath)
    return {
        capability: clientInstructionsManifest.capability,
        buildCommand: clientInstructionsManifest.build_command,
        patchFilePath: path.join(exportZipPath, clientInstructionsManifest.diffFileName),
    }
}

async function processClientInstructions(jobid: string, clientInstructions: any, clientInstructionArtifactId: string) {
    // create temp branch or copy of original code
    let sourcePath = transformByQState.getProjectPath()
    // let destinationPath = path.join(os.tmpdir(), buildOutputDirName)
    const destinationPath = path.join(os.tmpdir(), 'originalCopy')
    copyDirectory(sourcePath, destinationPath)
    // apply changes to temp branch or copy
    const diffModel = new DiffModel()
    diffModel.parseDiff(clientInstructions.patchFilePath, destinationPath)
    const doc = await vscode.workspace.openTextDocument(clientInstructions.patchFilePath)
    await vscode.window.showTextDocument(doc)
    // build
    try {
        // run client side build on the temp directory with the changes applied -> transformByQState.getProjectCopyFilePath
        await runClientSideBuild(transformByQState.getProjectCopyFilePath(), clientInstructionArtifactId)
    } catch (err) {
        throw new Error('Client-side build failed: ' + err)
    }
}

async function runClientSideBuild(modulePath: string, clientInstructionArtifactId: string) {
    try {
        telemetry.codeTransform_localBuildProject.run(async () => {
            telemetry.record({ codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId() })
            // baseCommand will be one of: '.\mvnw.cmd', './mvnw', 'mvn', '.\gradlew.cmd'. './gradlew', 'gradle'
            const baseCommand = transformByQState.getBuildSystemCommand()
            transformByQState.appendToLocalBuildErrorLog(`Running local build with ${baseCommand}`)
            const args =
                transformByQState.getBuildSystem() === BuildSystem.Maven ? ['test'] : ['TO-DO:something-for-gradle']
            let environment = process.env
            // set java home to target java version for intermediate builds
            environment = { ...process.env, JAVA_HOME: transformByQState.getJavaTargetPath() }
            getLogger().info(`JAVA_HOME: ${environment.JAVA_HOME}`)
            let userChoice: string | undefined = undefined
            if (
                transformByQState.getClientSideBuildSelection() === 'Verify Each Iteration' &&
                !transformByQState.getWaitingForClientSideBuildAuthorization()
            ) {
                if (userChoice === undefined) {
                    transformByQState.setWaitingForClientSideBuildAuthorization(true)
                    userChoice = await vscode.window.showInformationMessage(
                        'Do you authorize Amazon Q to perform an intermediate build on this machine?',
                        { modal: true },
                        localizedText.yes,
                        localizedText.no
                    )
                }
                if (userChoice === localizedText.no) {
                    // undefined -> dialog dismissed or closed
                    transformByQState.setWaitingForClientSideBuildAuthorization(false)
                    await stopTransformByQ(transformByQState.getJobId(), CancelActionPositions.Chat)
                    throw new Error(
                        'Cannot perform intermediate client-side build since intermediate verification prompt was rejected'
                    )
                }
                if (userChoice === undefined) {
                    transformByQState.setWaitingForClientSideBuildAuthorization(true)
                    return
                }
            }
            transformByQState.setWaitingForClientSideBuildAuthorization(false)
            const argString = args.join(' ')
            const spawnResult = spawnSync(baseCommand, args, {
                cwd: modulePath,
                shell: true,
                encoding: 'utf-8',
                env: environment,
                maxBuffer: CodeWhispererConstants.maxBufferSize,
            })
            if (spawnResult.status !== 0) {
                let errorLog = ''
                errorLog += spawnResult.error ? JSON.stringify(spawnResult.error) : ''
                errorLog += `${spawnResult.stderr}\n${spawnResult.stdout}`
                transformByQState.appendToLocalBuildErrorLog(`${baseCommand} ${argString} failed: \n ${errorLog}`)
                getLogger().error(
                    `CodeTransformation: Error in running Maven ${argString} command ${baseCommand}. status = ${spawnResult.status}`
                )
                getLogger().error(`Maven ${argString} error`, { code: 'MavenExecutionError' })
            }
            let buildlogs = spawnResult.stdout
            let buildLogsDir = await writeAndShowBuildLogs(clientInstructionArtifactId, buildlogs)
            getLogger().info(`spawnResult.status: ${spawnResult.status}`)
            if (spawnResult.status !== null) {
                let buildLogFileName = 'build-output.log'
                let manifestFilePath = path.join(buildLogsDir, 'manifest.json')
                await updateManifestFile(spawnResult.status, buildLogFileName, manifestFilePath)
                // create zip directory of build logs directory
                const zip = new AdmZip()
                zip.addLocalFile(`${buildLogsDir}/build-output.log`)
                zip.addLocalFile(`${buildLogsDir}/manifest.json`)
                // Write the ZIP file to disk
                zip.writeZip(`${buildLogsDir}.zip`)
                getLogger().info(`ZIP file created and files added successfully`)
                // upload payload
                const uploadContext: UploadContext = {
                    transformationUploadContext: {
                        jobId: transformByQState.getJobId(),
                        uploadArtifactType: 'ClientBuildResult',
                    },
                }
                await uploadPayload(`${buildLogsDir}.zip`, uploadContext)
                await resumeTransformationJob(transformByQState.getJobId(), 'COMPLETED')
            } else {
                throw new Error(`${baseCommand} ${argString}  exit code is null`)
            }
        })
    } catch (err) {
        getLogger().error('Caught error in runClientSideBuild')
        throw new Error('Client-side build failed: ' + err)
    }
}

async function writeAndShowBuildLogs(clientInstructionArtifactId: string, buildLogs: string) {
    const buildOutputDirName = `build_output_${clientInstructionArtifactId}`
    const buildLogsDir = path.join(os.tmpdir(), buildOutputDirName)
    // create build logs directory if it doesn't exist
    try {
        fs.mkdirSync(buildLogsDir, { recursive: true })
        getLogger().info(`Directory created successfully!`)
    } catch (err) {
        getLogger().error(`Error creating directory`, err)
    }
    let buildLogFilePath = path.join(buildLogsDir, 'build-output.log')
    buildLogFilePath = await writeLogs(buildLogFilePath, buildLogs)
    const doc = await vscode.workspace.openTextDocument(buildLogFilePath)
    await vscode.window.showTextDocument(doc)
    getLogger().info(`buildLogsDir: ${buildLogsDir}`)
    return buildLogsDir
}

async function updateManifestFile(exitCode: number, buildLogFileName: string, manifestFilePath: string) {
    try {
        const build_output_manifest = {
            capability: 'CLIENT_SIDE_BUILD',
            exitCode: exitCode,
            commandLogFileName: buildLogFileName,
        }
        getLogger().info(`build_output_manifest: ${JSON.stringify(build_output_manifest)}`)
        const updatedData = JSON.stringify(build_output_manifest, null, 2)
        getLogger().info(`writing updatedData to manifestFilePath`)
        await fs.writeFile(manifestFilePath, updatedData, 'utf8')
        console.log('Manifest file created successfully')
    } catch (err) {
        console.error('Error writing manifest file:', err)
    }
}
